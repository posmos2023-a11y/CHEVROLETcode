// 전산 주문을 이 프론트에서 직접 결제하는 기능의 공통 코드.
//
// 왜 POS를 거치지 않는가: 토스는 프론트 플러그인과 토스 POS 동시 연결을 지원하지 않는다(연동 가이드
// FAQ). 플러그인 모드 프론트는 POS와 페어링되지 않으므로, 전산이 payTarget:'front'로 보낸 주문은
// 이 플러그인이 서버(GET /api/front/erp-carts)에서 바로 가져가 sdk.payment.requestPayment로 결제한다.
//
// 인증은 POS 탭앱과 같은 매장 토큰(X-Store-Token)이다. 직원이 [플러그인 설정](settings.html)에서
// 한 번 넣으면 단말기 저장소(sdk.storage)에 남는다.
//
// 이 파일은 api-config.js 다음에 로드해야 한다(window.CHEVROLET_API_BASE_URL을 쓴다).
;(() => {
  const TOKEN_KEY = 'chevrolet_store_token'
  // 결제창을 띄우기 직전에 "지금 이 주문을 이 paymentKey로 결제 중"이라고 남겨두는 키.
  // 결제 도중 플러그인이 다시 로드되면(프론트 재시작, 화면 이동) 결과 보고를 못 한 채 끝나는데,
  // 다음에 켜질 때 이 기록으로 sdk.payment.getPayment를 불러 승인 여부를 확인하고 보고를 마저 한다.
  // 서버에 시작 요청(start)을 보내기 전에도 남긴다(phase 'starting') -- 시작 요청이 시간 초과로 끝났을 때 서버가 그 키로
  // 주문을 '결제 중'으로 잡았는지 알 수 없는데, 기록이 있어야 다음에 같은 키로 되돌릴 수 있다.
  const INFLIGHT_KEY = 'chevrolet_front_pay_inflight'

  // sdk.storage가 없는 환경(일반 브라우저 미리보기)에서는 localStorage로 대신한다.
  async function storageGet(key) {
    try {
      if (window.sdk?.storage?.get) {
        const item = await sdk.storage.get({ key })
        return item?.value ?? null
      }
    } catch (e) {
      console.warn('[erp-front-pay] sdk.storage.get 실패, localStorage로 대신합니다.', e)
    }
    try { return localStorage.getItem(key) } catch { return null }
  }

  async function storageSet(key, value) {
    try {
      if (window.sdk?.storage?.set) {
        await sdk.storage.set({ key, value })
        return
      }
    } catch (e) {
      console.warn('[erp-front-pay] sdk.storage.set 실패, localStorage로 대신합니다.', e)
    }
    try { localStorage.setItem(key, value) } catch { /* 저장 불가 환경 */ }
  }

  async function storageRemove(key) {
    try {
      if (window.sdk?.storage?.remove) {
        await sdk.storage.remove({ key })
        return
      }
    } catch (e) {
      console.warn('[erp-front-pay] sdk.storage.remove 실패, localStorage로 대신합니다.', e)
    }
    try { localStorage.removeItem(key) } catch { /* 저장 불가 환경 */ }
  }

  function getToken() {
    return storageGet(TOKEN_KEY)
  }

  function setToken(token) {
    return storageSet(TOKEN_KEY, token)
  }

  function clearToken() {
    return storageRemove(TOKEN_KEY)
  }

  // 서버 호출. 네트워크 오류는 throw하지 않고 { ok:false, status:0 }으로 돌려준다 -- 호출부가
  // 결제 흐름 한가운데서 예외 처리를 빠뜨려도 화면이 멈추지 않게 하기 위해서다.
  // 시간 제한(API_TIMEOUT_MS)을 둔다: 응답이 안 오면 결제 화면이 아무것도 못 그린 흰 화면으로 계속 기다리게 된다.
  // 시간 초과도 status 0이다 -- 서버는 처리했을 수 있으므로 호출부가 그 경우를 따로 다룬다(startPayment 참고).
  const API_TIMEOUT_MS = 12000

  // 429 등에 실려 오는 Retry-After(초 단위 숫자 또는 날짜)를 밀리초로 바꾼다. 서버가 아무리 오래 기다리라고 해도 결제 직후의
  // 결과 보고를 그만큼 붙잡아 둘 수 없어서 5초를 넘기지 않는다. 헤더가 없거나 해석이 안 되면 null(호출부가 기본 간격을 쓴다).
  // 주의: 이 플러그인은 서버와 출처가 달라서(CORS) 서버가 Access-Control-Expose-Headers에 Retry-After를 넣지 않으면
  // 브라우저가 이 헤더를 숨긴다 -- 그때는 항상 null이고 기본 간격으로 재시도한다.
  const RETRY_AFTER_MAX_MS = 5000

  function parseRetryAfter(value) {
    if (!value) return null
    const seconds = Number(value)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
    if (!Number.isFinite(ms) || ms <= 0) return null
    return Math.min(ms, RETRY_AFTER_MAX_MS)
  }

  async function api(method, path, token, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), API_TIMEOUT_MS) : null
    try {
      const res = await fetch(`${window.CHEVROLET_API_BASE_URL}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Store-Token': token || '',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      })
      const json = await res.json().catch(() => ({}))
      return {
        ok: res.ok && json.ok !== false,
        status: res.status,
        body: json,
        retryAfterMs: parseRetryAfter(res.headers?.get?.('Retry-After')),
      }
    } catch (e) {
      return { ok: false, status: 0, body: { error: '서버에 연결할 수 없습니다.' } }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function listCarts(token) {
    return api('GET', '/api/front/erp-carts', token)
  }

  function startCart(token, cartId, paymentKey) {
    return api('POST', `/api/front/erp-carts/${encodeURIComponent(cartId)}/start`, token, { paymentKey })
  }

  // 재시도해도 되는 4xx. 429(요청 과다)·408(요청 시간 초과)·425(너무 이른 요청)는 잠시 뒤 같은 요청을 다시 보내면 통과한다.
  // 예전엔 4xx를 전부 "서버가 거절했다"로 보고 바로 돌려줘서 호출부가 inflight 기록을 지웠다 -- 속도 제한(429)에 걸린 결제
  // 보고가 그대로 버려져 "돈은 받았는데 전산은 모르는" 건이 생길 수 있었다.
  const RETRYABLE_4XX = [408, 425, 429]

  // 서버가 이 요청을 받아 주지 않는다고 확정된 응답(다시 보내도 같은 답). 호출부가 "이 기록은 더 보고할 필요 없다"를 판단할 때 쓴다.
  function isFinalRejection(res) {
    return res.status >= 400 && res.status < 500 && !RETRYABLE_4XX.includes(res.status)
  }

  // 결과 보고. 결제가 이미 끝난 뒤라 보고가 유실되면 "돈은 받았는데 전산은 모르는" 상태가 된다.
  // 그래서 5xx/네트워크 오류/재시도 가능한 4xx는 몇 번 다시 시도한다(Retry-After가 있으면 최대 5초까지 따른다).
  // 그 밖의 4xx는 다시 보내도 같은 답이라 바로 돌려준다.
  async function postWithRetry(path, token, body) {
    let last = { ok: false, status: 0, body: {} }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await api('POST', path, token, body)
      if (last.ok || isFinalRejection(last)) return last
      if (attempt === 2) break // 마지막 시도 뒤에는 기다릴 이유가 없다
      await new Promise((r) => setTimeout(r, last.retryAfterMs ?? 1000 * (attempt + 1)))
    }
    return last
  }

  function reportResult(token, cartId, body) {
    return postWithRetry(`/api/front/erp-carts/${encodeURIComponent(cartId)}/result`, token, body)
  }

  // requestPayment/getPayment의 SUCCESS 응답에서 서버에 남길 값만 뽑는다. 카드번호는 보내지 않는다.
  function extractPayment(response) {
    const r = response || {}
    const method = r.paymentMethod
    const detail = method === 'CARD' ? r.card : method === 'BARCODE' ? r.barcode : null
    const cashReceipt = method === 'CASH' ? r.cash?.cashReceipt : null
    const source = detail || cashReceipt || {}
    return {
      paymentMethod: method,
      approvalNumber: source.approvalNumber,
      timestamp: source.timestamp,
      installment: detail?.installment ?? 0,
      vanTransactionKey: r.vanTransactionKey,
      // VAN은 취소 방식을 고르는 데 쓴다(NICE 카드는 카드 없이 취소 가능).
      van: source.van,
      tid: r.tid,
      isCashReceipt: method === 'CASH' ? Boolean(r.cash?.isCashReceipt) : undefined,
      // 현금영수증 자진발급 건은 취소할 때 같은 값을 넘겨야 번호 입력 없이 취소된다.
      isSelfIssuance: cashReceipt ? Boolean(cashReceipt.isSelfIssuance) : undefined,
      easyPayProvider: r.easyPay?.provider,
    }
  }

  // inflight 기록은 cartId를 키로 한 맵 { [cartId]: { cartId, paymentKey, ..., at } } 한 덩어리로 저장한다.
  // 예전엔 칸이 하나뿐이라 보고를 못 한 이전 건이 남아 있는데 다음 건을 시작하면 이전 건 기록을 덮어써서, 그 건의 결제 여부를
  // 영영 확인하지 못했다(받은 돈을 전산이 모르는 채로 남는다). 맵은 건별로 따로 남아 서로 덮어쓰지 않는다 -- 같은 주문을
  // 다시 시도할 때만 그 주문의 기록을 갈아 끼운다.
  // 옛 형식(맵이 아니라 { cartId, paymentKey, at } 한 건)이 남아 있으면 읽을 때 맵으로 바꾼다.
  async function loadInflightMap(key) {
    const raw = await storageGet(key)
    if (!raw) return {}
    let parsed
    try { parsed = JSON.parse(raw) } catch { return {} }
    if (!parsed || typeof parsed !== 'object') return {}
    // 맵에서 'cartId'라는 이름의 주문은 값이 객체라서, 값이 문자열 등인 경우만 옛 한 건짜리로 본다.
    const legacy = parsed.cartId && typeof parsed.cartId !== 'object'
    const map = {}
    for (const record of legacy ? [parsed] : Object.values(parsed)) {
      if (record && typeof record === 'object' && record.cartId && typeof record.cartId !== 'object') {
        map[String(record.cartId)] = record
      }
    }
    return map
  }

  // 읽고-고치고-쓰기를 한 줄로 세운다. 결과 보고가 백그라운드로 돌기 때문에(erp-pay.html) 한 건이 기록을 지우는 사이에 다른 건이
  // 기록을 저장하면, 둘이 같은 맵을 읽고 각자 써서 나중에 쓴 쪽이 앞쪽 변경을 덮어쓴다.
  let inflightLock = Promise.resolve()

  function updateInflightMap(key, mutate) {
    const run = inflightLock.then(async () => {
      const map = await loadInflightMap(key)
      mutate(map)
      if (Object.keys(map).length) await storageSet(key, JSON.stringify(map))
      else await storageRemove(key)
    })
    inflightLock = run.catch(() => {})
    return run
  }

  function saveInflight(record) {
    return updateInflightMap(INFLIGHT_KEY, (map) => {
      map[String(record.cartId)] = { ...record, at: Date.now() }
    })
  }

  function clearInflight(cartId) {
    return updateInflightMap(INFLIGHT_KEY, (map) => {
      delete map[String(cartId)]
    })
  }

  // 여러 건을 한 번에 복구했을 때의 대표 결과. 하나라도 확인이 안 끝났으면 'pending'(호출부가 새 결제를 막는다),
  // 아니면 성공 쪽(paid/refunded)이 하나라도 있으면 그것, 아니면 'released'.
  function mergeOutcomes(outcomes, successOutcome) {
    const real = outcomes.filter((o) => o !== 'none')
    if (!real.length) return 'none'
    if (real.includes('pending')) return 'pending'
    if (real.includes(successOutcome)) return successOutcome
    return 'released'
  }

  // 기록 한 건을 확인하고 마저 보고한다. 'none' | 'paid' | 'released' | 'pending'
  // 서버가 받아 주지 않는 4xx(주문 상태가 다름, 이미 처리됨 등)는 계속 재시도해도 같은 답이라 기록을 지운다 -- 남겨 두면
  // 'pending'이 영구히 새 결제를 막는다. 결제가 있었다는 사실은 'paid'로 돌려줘 호출부가 화면으로 알린다.
  // (429 같은 재시도 가능한 4xx는 reportResult가 이미 몇 번 재시도했고, 그래도 안 되면 'pending'으로 남긴다.)
  async function recoverOnePayment(token, record) {
    if (!record.paymentKey) {
      await clearInflight(record.cartId)
      return 'none'
    }

    let result
    try {
      // 단말기 로컬 캐시에서 승인 결과를 다시 읽는다(성공 건만 14일간 보관된다).
      result = await sdk.payment.getPayment({ paymentKey: record.paymentKey })
    } catch (e) {
      const message = String(e?.message || e)
      if (message.includes('PAYMENT_NOT_FOUND')) {
        // 승인 기록이 없다 = 결제가 일어나지 않았다. 다시 결제할 수 있게 되돌린다.
        // 시작 요청이 시간 초과로 끝나 서버에 닿았는지 모르는 건(phase 'starting')도 여기로 온다 -- 서버는 아직 시작 안 된
        // 키로 이 보고를 받으면 그 키를 기억해 두고 늦게 도착하는 시작 요청을 거절한다(주문이 '결제 중'에 갇히지 않게).
        const res = await reportResult(token, record.cartId, { result: 'cancelled', paymentKey: record.paymentKey })
        if (res.ok || isFinalRejection(res)) {
          await clearInflight(record.cartId)
          return 'released'
        }
        return 'pending'
      }
      // 확인 자체가 안 된다. 기록을 지우면 승인된 결제를 잃을 수 있으므로 남겨두고 다음에 다시 본다.
      console.warn('[erp-front-pay] 지난 결제 확인 실패, 다음에 다시 확인합니다.', e)
      return 'pending'
    }

    if (result?.type === 'SUCCESS') {
      const res = await reportResult(token, record.cartId, {
        result: 'paid',
        paymentKey: record.paymentKey,
        payment: extractPayment(result.response),
      })
      if (res.ok || isFinalRejection(res)) {
        await clearInflight(record.cartId)
        return 'paid'
      }
      return 'pending'
    }

    const res = await reportResult(token, record.cartId, { result: 'cancelled', paymentKey: record.paymentKey })
    if (res.ok || isFinalRejection(res)) {
      await clearInflight(record.cartId)
      return 'released'
    }
    return 'pending'
  }

  // 지난번 결제가 보고 없이 끝났는지 확인하고, 끝났다면 결과를 마저 보고한다. 남아 있는 기록 전부를 처리한다.
  // onlyCartId를 주면 그 주문의 기록만 본다(결제창이 예외로 끝난 직후 "이 건"의 승인 여부만 알고 싶을 때).
  // 반환: 'none'(복구할 것 없음) | 'paid' | 'released' | 'pending'(아직 확인 불가, 다음에 다시)
  async function recoverInflight(token, onlyCartId) {
    const map = await loadInflightMap(INFLIGHT_KEY)
    const records = Object.values(map).filter((r) => onlyCartId === undefined || String(r.cartId) === String(onlyCartId))
    const outcomes = []
    for (const record of records) outcomes.push(await recoverOnePayment(token, record))
    return mergeOutcomes(outcomes, 'paid')
  }

  // --- 결제 취소(정비 대기열에서 [프론트에서 취소]를 누른 건) ---------------------------
  // 결제와 같은 구조다: 서버가 취소 요청을 내려주고, 이 프론트가 잡은 뒤(refund-start) SDK로 취소하고
  // 결과를 보고한다. 취소 도중 재시작되면 sdk.payment.getPaymentCancel로 결과를 다시 읽어 보고한다.
  const REFUND_INFLIGHT_KEY = 'chevrolet_front_refund_inflight'

  // attemptId는 이 취소 "시도" 하나를 가리키는 값이다(erp-pay.html runRefund가 시도마다 새로 만든다). 서버는 refund-start·
  // refund-result에서 이 값이 지금 진행 중인 시도와 다르면 409 { stale:true }로 거절한다 -- 시간 초과로 늦게 도착한 옛 시도의
  // 요청이 새 시도를 망가뜨리지 못하게 하려는 것이다. 옛 서버는 이 값을 무시하므로 없어도(또는 있어도) 깨지지 않는다.
  function startRefund(token, cartId, attemptId) {
    return api('POST', `/api/front/erp-carts/${encodeURIComponent(cartId)}/refund-start`, token, attemptId ? { attemptId } : undefined)
  }

  // body에 attemptId를 함께 실어 보낸다. 재시도 규칙은 reportResult와 같다.
  function reportRefund(token, cartId, body) {
    return postWithRetry(`/api/front/erp-carts/${encodeURIComponent(cartId)}/refund-result`, token, body)
  }

  // 원거래와 같은 값으로 취소를 요청한다. NICE VAN 카드 결제는 카드 없이(무카드) 취소할 수 있다.
  function requestRefund(refund) {
    const base = {
      paymentKey: refund.paymentKey,
      tax: refund.tax,
      supplyValue: refund.supplyValue,
      tip: 0,
      timestamp: refund.timestamp,
      approvalNumber: refund.approvalNumber,
      installment: refund.installment || 0,
      timeoutMs: 60000,
      localeCode: 'ko',
    }
    if (refund.paymentMethod === 'CARD' && refund.van === 'NICE' && refund.vanTransactionKey && sdk.payment.requestCardlessPaymentCancel) {
      return sdk.payment.requestCardlessPaymentCancel({ ...base, paymentMethod: 'CARD', vanTransactionKey: refund.vanTransactionKey })
    }
    const params = { ...base, paymentMethod: refund.paymentMethod }
    if (refund.paymentMethod === 'CASH') params.isSelfIssuance = Boolean(refund.isSelfIssuance)
    return sdk.payment.requestPaymentCancel(params)
  }

  // 결제 기록과 같은 맵 구조다(위 saveInflight 주석 참고). 기록에는 attemptId가 들어 있어 보고에도 그대로 실린다.
  function saveRefundInflight(record) {
    return updateInflightMap(REFUND_INFLIGHT_KEY, (map) => {
      map[String(record.cartId)] = { ...record, at: Date.now() }
    })
  }

  function clearRefundInflight(cartId) {
    return updateInflightMap(REFUND_INFLIGHT_KEY, (map) => {
      delete map[String(cartId)]
    })
  }

  // 기록 한 건. 'none' | 'refunded' | 'released' | 'pending' -- 4xx를 지우는 이유는 recoverOnePayment 주석과 같다.
  // 409 { stale:true }(그 사이 다른 시도가 이 주문을 가져갔다)도 최종 거절이라 기록을 지운다.
  async function recoverOneRefund(token, record) {
    const withAttempt = (body) => (record.attemptId ? { ...body, attemptId: record.attemptId } : body)

    if (!record.paymentKey) {
      // refund-start 응답을 받기 전에 끊긴 기록이다. 이 단말기는 아직 취소를 시작한 적이 없으므로(취소창은 start가 성공하고
      // paymentKey를 다시 저장한 뒤에야 뜬다) 안전하게 되돌린다.
      const res = await reportRefund(token, record.cartId, withAttempt({ result: 'cancelled' }))
      if (res.ok || isFinalRejection(res)) { await clearRefundInflight(record.cartId); return 'released' }
      return 'pending'
    }

    let result
    try {
      result = await sdk.payment.getPaymentCancel({ paymentKey: record.paymentKey })
    } catch (e) {
      if (String(e?.message || e).includes('PAYMENT_NOT_FOUND')) {
        const res = await reportRefund(token, record.cartId, withAttempt({ result: 'cancelled' }))
        if (res.ok || isFinalRejection(res)) { await clearRefundInflight(record.cartId); return 'released' }
        return 'pending'
      }
      console.warn('[erp-front-pay] 지난 결제 취소 확인 실패, 다음에 다시 확인합니다.', e)
      return 'pending'
    }
    const refunded = result?.type === 'SUCCESS'
    const res = await reportRefund(token, record.cartId, withAttempt({ result: refunded ? 'refunded' : 'cancelled' }))
    if (res.ok || isFinalRejection(res)) {
      await clearRefundInflight(record.cartId)
      return refunded ? 'refunded' : 'released'
    }
    return 'pending'
  }

  // 반환: 'none' | 'refunded' | 'released' | 'pending' (여러 건이면 recoverInflight와 같은 규칙으로 합친다)
  async function recoverRefundInflight(token, onlyCartId) {
    const map = await loadInflightMap(REFUND_INFLIGHT_KEY)
    const records = Object.values(map).filter((r) => onlyCartId === undefined || String(r.cartId) === String(onlyCartId))
    const outcomes = []
    for (const record of records) outcomes.push(await recoverOneRefund(token, record))
    return mergeOutcomes(outcomes, 'refunded')
  }

  // 손님이 "처음 화면으로"를 고른 주문은 잠시 대기화면에서 다시 띄우지 않는다. 안 그러면 대기화면이
  // 폴링하자마자 같은 주문 화면으로 되돌아가 빠져나갈 수 없다.
  const SNOOZE_KEY = 'chevrolet_front_pay_snooze'
  const SNOOZE_MS = 2 * 60 * 1000

  function readSnoozes() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(SNOOZE_KEY) || '{}')
      const now = Date.now()
      return Object.fromEntries(Object.entries(parsed).filter(([, until]) => Number(until) > now))
    } catch {
      return {}
    }
  }

  function snooze(cartId) {
    const all = readSnoozes()
    all[cartId] = Date.now() + SNOOZE_MS
    try { sessionStorage.setItem(SNOOZE_KEY, JSON.stringify(all)) } catch { /* 저장 불가 환경 */ }
  }

  function isSnoozed(cartId) {
    return Boolean(readSnoozes()[cartId])
  }

  // 쉬기 열쇠. 같은 주문이라도 직원이 다시 보냈으면(frontSentAt) 또는 취소를 다시 요청했으면(requestedAt) 다른 열쇠가
  // 되어 바로 뜬다. 손님이 결제창을 닫은 직후 같은 주문이 곧바로 다시 뜨는 것만 막는다.
  function cartSnoozeKey(cart) {
    return `${cart.id}:${cart.frontSentAt || ''}`
  }

  function refundSnoozeKey(item) {
    return `refund:${item.id}:${item.requestedAt || ''}`
  }

  function formatWon(amount) {
    return `${Number(amount || 0).toLocaleString('ko-KR')}원`
  }

  window.ErpFrontPay = {
    getToken,
    setToken,
    clearToken,
    listCarts,
    startCart,
    reportResult,
    isFinalRejection,
    extractPayment,
    saveInflight,
    clearInflight,
    recoverInflight,
    startRefund,
    reportRefund,
    requestRefund,
    saveRefundInflight,
    clearRefundInflight,
    recoverRefundInflight,
    snooze,
    isSnoozed,
    cartSnoozeKey,
    refundSnoozeKey,
    formatWon,
  }
})()
