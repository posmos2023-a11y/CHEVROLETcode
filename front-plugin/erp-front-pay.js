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

  // 서버가 이 요청을 받아 주지 않는다고 확정된 응답(지금 다시 보내도 같은 답). 재시도를 그만둘지 판단할 때 쓴다.
  // 기록을 지워도 되는지는 이것만으로 정하지 않는다 -- 결과 종류마다 규칙이 다르다(reportPaid·reportReleased 주석).
  function isFinalRejection(res) {
    return res.status >= 400 && res.status < 500 && !RETRYABLE_4XX.includes(res.status)
  }

  // 401(토큰이 틀림·재발급됨)·403(매장 비활성)은 이 주문이 아니라 이 단말기의 인증 문제다. 직원이 토큰을 바로잡으면 같은 보고가
  // 통과하므로 기록을 지우지 않고 남겨 둔다(호출부는 'auth'를 받아 토큰 안내를 띄우고, 다음 복구가 다시 보고한다). 예전엔 복구가
  // 이것까지 확정 거절로 보고 승인 기록을 지워서, 토큰을 고친 뒤에도 보고할 근거가 없었다(받은 돈이 전산에서 영구 누락).
  function isAuthProblem(res) {
    return res.status === 401 || res.status === 403
  }

  // '결제 안 됨'(cancelled·failed) 보고를 더 보낼 필요가 없다고 볼 응답. 돈이 나가지 않은 시도라 주문이 이미 다른 상태(409)거나
  // 없어졌어도(404) 기록을 지워도 된다. 인증 문제만 빼고 남긴다.
  function isSettledRejection(res) {
    return isFinalRejection(res) && !isAuthProblem(res)
  }

  // 완료 보고('paid'·'refunded')가 409를 받았을 때 한 번 더 보내 보기 전에 기다리는 시간(reportPaid 주석).
  const CONFLICT_RECHECK_MS = 1500

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
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
  // 영영 확인하지 못했다(받은 돈을 전산이 모르는 채로 남는다). 맵은 건별로 따로 남아 서로 덮어쓰지 않는다 -- 같은 주문도
  // 앞 시도의 기록이 정리된 뒤에야 새 시도의 기록을 남긴다(claimInflight).
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

  // 저장소 읽고-고치고-쓰기를 한 줄로 세운다. 결과 보고가 백그라운드로 돌기 때문에(erp-pay.html) 한 건이 기록을 지우는 사이에 다른 건이
  // 기록을 저장하면, 둘이 같은 맵을 읽고 각자 써서 나중에 쓴 쪽이 앞쪽 변경을 덮어쓴다. 판단에 쓰는 읽기(hasInflight 등)도 이 줄에
  // 세워, 앞에 걸린 쓰기가 끝난 뒤의 값을 보게 한다.
  let storageLock = Promise.resolve()

  function serialized(task) {
    const run = storageLock.then(() => task())
    storageLock = run.catch(() => {})
    return run
  }

  // mutate가 돌려준 값을 그대로 돌려준다(claim의 성공 여부 등).
  function updateInflightMap(key, mutate) {
    return serialized(async () => {
      const map = await loadInflightMap(key)
      const result = mutate(map)
      if (Object.keys(map).length) await storageSet(key, JSON.stringify(map))
      else await storageRemove(key)
      return result
    })
  }

  // 없는 값(undefined·null·'')끼리는 같다고 본다 -- 키 없이 남은 옛 기록도 키 없이 지울 수 있게.
  function sameValue(a, b) {
    return (a || null) === (b || null)
  }

  // 같은 칸의 기존 기록에 새 값을 덮는다. undefined인 값은 기존 값을 지우지 않는다(단계만 바꿀 때 금액 등이 사라지지 않게).
  function mergeRecord(existing, record) {
    const next = { ...existing }
    for (const [k, v] of Object.entries(record)) if (v !== undefined) next[k] = v
    next.at = Date.now()
    return next
  }

  // 시도 기록을 남긴다. 주문 하나에 기록은 한 칸이다. 그 칸에 **다른** paymentKey의 기록이 남아 있으면(앞 시도의 보고가 아직 안
  // 끝남) 덮어쓰지 않고 false를 돌려준다 -- 예전엔 [다시 결제하기]·연타가 앞 시도 기록을 덮어써서, 앞 시도를 되돌리거나 승인을
  // 보고할 근거가 사라졌다. 같은 paymentKey면(같은 시도의 단계 변경: starting → paying) 고쳐 쓴다. false면 새 시도를 시작하지 않는다.
  // record: { cartId, paymentKey, phase, amount?, sentKey? } -- amount·sentKey는 미기록 목록(saveOrphan)에 옮길 때 쓴다.
  function claimInflight(record) {
    return updateInflightMap(INFLIGHT_KEY, (map) => {
      const id = String(record.cartId)
      const existing = map[id]
      if (existing && !sameValue(existing.paymentKey, record.paymentKey)) return false
      map[id] = mergeRecord(existing, record)
      return true
    })
  }

  // 지우는 쪽이 "자기" paymentKey를 넘긴다. 칸에 다른 시도의 기록이 들어 있으면 지우지 않는다(compare-and-delete) -- 늦게 끝난
  // 옛 시도(예: 시작 409)가 새 시도의 기록을 지우면, 새 시도가 승인된 뒤 보고까지 실패했을 때 복구할 근거가 없다.
  function clearInflight(cartId, paymentKey) {
    return updateInflightMap(INFLIGHT_KEY, (map) => {
      const id = String(cartId)
      if (map[id] && sameValue(map[id].paymentKey, paymentKey)) delete map[id]
    })
  }

  function hasInflight(cartId) {
    return serialized(async () => Boolean((await loadInflightMap(INFLIGHT_KEY))[String(cartId)]))
  }

  // 여러 건을 한 번에 복구했을 때의 대표 결과. 확인이 안 끝난 건이 하나라도 있으면 'auth'(토큰 문제) 또는 'pending'(호출부가
  // 새 결제를 막는다). 아니면 'orphan'(승인됐는데 전산이 받지 않음) > 성공(paid/refunded) > 'released' 순이다.
  function mergeOutcomes(outcomes, successOutcome) {
    const real = outcomes.filter((o) => o !== 'none')
    if (!real.length) return 'none'
    if (real.includes('auth')) return 'auth'
    if (real.includes('pending')) return 'pending'
    if (real.includes('orphan')) return 'orphan'
    if (real.includes(successOutcome)) return successOutcome
    return 'released'
  }

  // 승인된 결제의 'paid' 보고. 결과: 'paid'(서버가 기록함) | 'orphan'(서버가 끝내 받지 않음) | 'auth' | 'pending'
  // 성공은 res.ok뿐이다(같은 키로 이미 기록된 건은 서버가 200 alreadyProcessed로 준다). 409(코드와 상관없이)·404 같은 확정 거절은
  // "돈은 받았는데 전산이 모르는" 건이라 성공으로 치지 않는다. 기록을 그냥 지우지 않고 미기록 목록(saveOrphan)에 옮긴 뒤 지운다 --
  // 그 주문의 결제창 자동 시작을 한동안 막고(filterStartableCarts) 직원 안내 화면을 띄우는 근거가 된다. 예전엔 409를 성공처럼 지우고
  // '지난 결제 완료를 전산에 알렸습니다'를 띄운 뒤 같은 주문의 결제창을 다시 열었다(이중결제). 401·403은 기록을 남긴다(isAuthProblem).
  // 409는 한 번 더 보내 본다: 시간 초과 뒤 재시도가 서버에서 앞 보고와 겹치면, 앞 보고가 기록하는 사이 뒤 보고가 옛 상태를 읽어
  // 409를 받을 수 있다. 다시 보내면 앞 보고가 반영된 경우 200(alreadyProcessed)이 온다.
  // record: { cartId, paymentKey, amount?, sentKey? }  payment: extractPayment 결과
  async function reportPaid(token, record, payment) {
    const body = { result: 'paid', paymentKey: record.paymentKey, payment }
    let res = await reportResult(token, record.cartId, body)
    if (res.status === 409) {
      await sleep(CONFLICT_RECHECK_MS)
      res = await reportResult(token, record.cartId, body)
    }
    if (res.ok) {
      await clearInflight(record.cartId, record.paymentKey)
      return 'paid'
    }
    if (isAuthProblem(res)) return 'auth'
    if (isFinalRejection(res)) {
      console.error('[erp-front-pay] 승인된 결제를 서버가 기록하지 않았습니다. 승인번호로 대사가 필요합니다.', {
        cartId: record.cartId, approvalNumber: payment?.approvalNumber, httpStatus: res.status, code: res.body?.code, cartStatus: res.body?.status,
      })
      // 미기록 목록에 먼저 남기고 나서 지운다. 그 사이 꺼지면 기록이 남아 다음 복구가 같은 보고를 다시 하고 같은 결론에 이른다.
      await saveOrphan({
        kind: 'payment',
        cartId: record.cartId,
        paymentKey: record.paymentKey,
        approvalNumber: payment?.approvalNumber,
        amount: record.amount,
        sentKey: record.sentKey,
        httpStatus: res.status,
        code: res.body?.code,
        cartStatus: res.body?.status,
      })
      await clearInflight(record.cartId, record.paymentKey)
      return 'orphan'
    }
    return 'pending'
  }

  // 돈이 나가지 않은 시도의 보고('cancelled' 기본, extra로 'failed'·errorMessage). 결과: 'released' | 'auth' | 'pending'
  // 서버가 받았거나 확정적으로 거절했으면(404 포함, 401·403 제외 -- isSettledRejection) 이 시도의 기록만 지운다.
  // 그 밖(네트워크 오류·5xx·429·인증 문제)은 남겨 둬 다음 복구가 같은 키로 다시 보고한다.
  async function reportReleased(token, cartId, paymentKey, extra) {
    const res = await reportResult(token, cartId, { result: 'cancelled', ...extra, paymentKey })
    if (res.ok || isSettledRejection(res)) {
      await clearInflight(cartId, paymentKey)
      return 'released'
    }
    return isAuthProblem(res) ? 'auth' : 'pending'
  }

  // 기록 한 건을 확인하고 마저 보고한다. 'none' | 'paid' | 'orphan' | 'released' | 'auth' | 'pending'
  // 승인된 건(SUCCESS)은 서버가 기록했을 때만 지우고, 서버가 끝내 받지 않으면 미기록 목록으로 옮긴다(reportPaid) -- 승인 증거를
  // 그냥 버리는 길은 없다. 승인이 없는 건은 reportReleased 규칙대로 지운다.
  async function recoverOnePayment(token, record) {
    if (!record.paymentKey) {
      await clearInflight(record.cartId, record.paymentKey)
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
        return reportReleased(token, record.cartId, record.paymentKey)
      }
      // 확인 자체가 안 된다. 기록을 지우면 승인된 결제를 잃을 수 있으므로 남겨두고 다음에 다시 본다.
      console.warn('[erp-front-pay] 지난 결제 확인 실패, 다음에 다시 확인합니다.', e)
      return 'pending'
    }

    if (result?.type === 'SUCCESS') return reportPaid(token, record, extractPayment(result.response))
    return reportReleased(token, record.cartId, record.paymentKey)
  }

  // 지난번 결제가 보고 없이 끝났는지 확인하고, 끝났다면 결과를 마저 보고한다. 남아 있는 기록 전부를 처리한다.
  // onlyCartId를 주면 그 주문의 기록만 본다(결제창이 예외로 끝난 직후 "이 건"의 승인 여부만 알고 싶을 때).
  // 반환: 'none'(복구할 것 없음) | 'paid' | 'orphan'(승인됐는데 전산이 받지 않음 -- 직원 안내 필요) | 'released'
  //       | 'auth'(토큰 문제, 기록 남김) | 'pending'(아직 확인 불가, 다음에 다시)
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

  // 결제 기록과 같은 맵 구조·규칙이다(claimInflight·clearInflight 주석). 시도 구분은 attemptId로 한다 -- 같은 주문에 다른 시도의
  // 기록이 남아 있으면 덮어쓰지 않고(false), 지울 때도 자기 attemptId의 기록만 지운다. 기록의 attemptId는 보고에도 그대로 실린다.
  // record: { cartId, paymentKey, attemptId, approvalNumber?, amount? } -- approvalNumber(원결제)·amount는 미기록 안내에 쓴다.
  function claimRefundInflight(record) {
    return updateInflightMap(REFUND_INFLIGHT_KEY, (map) => {
      const id = String(record.cartId)
      const existing = map[id]
      if (existing && !sameValue(existing.attemptId, record.attemptId)) return false
      map[id] = mergeRecord(existing, record)
      return true
    })
  }

  function clearRefundInflight(cartId, attemptId) {
    return updateInflightMap(REFUND_INFLIGHT_KEY, (map) => {
      const id = String(cartId)
      if (map[id] && sameValue(map[id].attemptId, attemptId)) delete map[id]
    })
  }

  function hasRefundInflight(cartId) {
    return serialized(async () => Boolean((await loadInflightMap(REFUND_INFLIGHT_KEY))[String(cartId)]))
  }

  function refundBody(record, body) {
    return record.attemptId ? { ...body, attemptId: record.attemptId } : body
  }

  // 취소가 안 된 시도의 보고('cancelled' 기본, extra로 'failed'·errorMessage). 결과: 'released' | 'auth' | 'pending'
  // 지우는 규칙은 reportReleased와 같다. 409 { stale:true }(그 사이 다른 시도가 이 주문을 가져갔다)도 확정 거절이라 지운다.
  async function reportRefundReleased(token, record, extra) {
    const res = await reportRefund(token, record.cartId, refundBody(record, { result: 'cancelled', ...extra }))
    if (res.ok || isSettledRejection(res)) {
      await clearRefundInflight(record.cartId, record.attemptId)
      return 'released'
    }
    return isAuthProblem(res) ? 'auth' : 'pending'
  }

  // 끝난 취소의 'refunded' 보고. 결과: 'refunded' | 'orphan' | 'auth' | 'pending' -- reportPaid와 같은 규칙이다. 손님 돈은 이미
  // 돌려줬으므로, 서버가 끝내 받지 않으면(409 stale 포함) 그냥 지우지 않고 미기록 목록에 옮겨 직원 안내 화면을 띄운다. 예전엔
  // 거절된 보고도 지우고 '지난 결제 취소 완료를 전산에 알렸습니다'를 띄웠다.
  async function reportRefunded(token, record) {
    const body = refundBody(record, { result: 'refunded' })
    let res = await reportRefund(token, record.cartId, body)
    if (res.status === 409 && !res.body?.stale) {
      // 같은 시도의 보고가 겹쳤을 수 있다(reportPaid 주석). stale은 다른 시도가 쥐고 있다는 확정 답이라 다시 보내지 않는다.
      await sleep(CONFLICT_RECHECK_MS)
      res = await reportRefund(token, record.cartId, body)
    }
    if (res.ok) {
      await clearRefundInflight(record.cartId, record.attemptId)
      return 'refunded'
    }
    if (isAuthProblem(res)) return 'auth'
    if (isFinalRejection(res)) {
      console.error('[erp-front-pay] 끝난 결제 취소를 서버가 기록하지 않았습니다. 토스 취소 내역과 대사가 필요합니다.', {
        cartId: record.cartId, approvalNumber: record.approvalNumber, httpStatus: res.status, cartStatus: res.body?.status, stale: Boolean(res.body?.stale),
      })
      await saveOrphan({
        kind: 'refund',
        cartId: record.cartId,
        paymentKey: record.paymentKey,
        attemptId: record.attemptId,
        approvalNumber: record.approvalNumber,
        amount: record.amount,
        httpStatus: res.status,
        cartStatus: res.body?.status,
      })
      await clearRefundInflight(record.cartId, record.attemptId)
      return 'orphan'
    }
    return 'pending'
  }

  // 기록 한 건. 'none' | 'refunded' | 'orphan' | 'released' | 'auth' | 'pending'
  async function recoverOneRefund(token, record) {
    if (!record.paymentKey) {
      // refund-start 응답을 받기 전에 끊긴 기록이다. 이 단말기는 아직 취소를 시작한 적이 없으므로(취소창은 start가 성공하고
      // paymentKey를 다시 저장한 뒤에야 뜬다) 안전하게 되돌린다.
      return reportRefundReleased(token, record)
    }

    let result
    try {
      result = await sdk.payment.getPaymentCancel({ paymentKey: record.paymentKey })
    } catch (e) {
      if (String(e?.message || e).includes('PAYMENT_NOT_FOUND')) return reportRefundReleased(token, record)
      console.warn('[erp-front-pay] 지난 결제 취소 확인 실패, 다음에 다시 확인합니다.', e)
      return 'pending'
    }
    if (result?.type === 'SUCCESS') return reportRefunded(token, record)
    return reportRefundReleased(token, record)
  }

  // 반환: 'none' | 'refunded' | 'orphan' | 'released' | 'auth' | 'pending' (여러 건이면 recoverInflight와 같은 규칙으로 합친다)
  async function recoverRefundInflight(token, onlyCartId) {
    const map = await loadInflightMap(REFUND_INFLIGHT_KEY)
    const records = Object.values(map).filter((r) => onlyCartId === undefined || String(r.cartId) === String(onlyCartId))
    const outcomes = []
    for (const record of records) outcomes.push(await recoverOneRefund(token, record))
    return mergeOutcomes(outcomes, 'refunded')
  }

  // --- 전산 미기록 목록 ---------------------------------------------------------------
  // 단말기에서는 승인(또는 취소)이 끝났는데 서버가 그 보고를 끝내 받지 않은 건(reportPaid·reportRefunded의 'orphan').
  // 예: 손님 결제가 승인된 직후 보고를 못 했는데, 그 사이 직원이 [결제 중 풀기]나 [POS로 되돌리기]를 했다.
  // inflight 기록은 "아직 보고할 것"이라 계속 남겨 둘 수 없으므로(남기면 새 결제를 영구히 막는다) 여기에 옮겨 둔다. 쓰임은 셋이다.
  //   1) 직원 안내 화면(erp-pay.html showOrphanNotice) -- 승인번호·금액으로 토스 결제내역과 맞춰 보게 한다. 한 건당 한 번 띄운다.
  //   2) 같은 주문의 결제창 자동 시작을 막는다(filterStartableCarts) -- 받은 돈을 전산이 모르는 주문을 손님에게 또 결제시키지 않게.
  //      막는 기간은 ORPHAN_BLOCK_MS다. 그 전에 직원이 주문을 다시 보내면(frontSentAt이 바뀌어 cartSnoozeKey가 달라짐) 바로 풀린다 --
  //      직원이 확인하고 다시 보낸 것으로 본다.
  //   3) 대사 근거. ORPHAN_KEEP_MS(7일) 동안 단말기에 남긴다.
  const ORPHAN_KEY = 'chevrolet_front_pay_orphans'
  const ORPHAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000
  const ORPHAN_BLOCK_MS = 30 * 60 * 1000

  // { [id]: { kind:'payment'|'refund', cartId, paymentKey, attemptId?, approvalNumber, amount, sentKey?, at, noticeShown, ... } }
  // 보관 기간이 지난 건은 읽을 때 뺀다(다음 쓰기 때 저장소에서도 빠진다).
  async function loadOrphanMap() {
    const raw = await storageGet(ORPHAN_KEY)
    if (!raw) return {}
    let parsed
    try { parsed = JSON.parse(raw) } catch { return {} }
    if (!parsed || typeof parsed !== 'object') return {}
    const now = Date.now()
    const map = {}
    for (const [id, o] of Object.entries(parsed)) {
      if (o && typeof o === 'object' && o.cartId && now - Number(o.at) < ORPHAN_KEEP_MS) map[id] = o
    }
    return map
  }

  function updateOrphanMap(mutate) {
    return serialized(async () => {
      const map = await loadOrphanMap()
      const result = mutate(map)
      if (Object.keys(map).length) await storageSet(ORPHAN_KEY, JSON.stringify(map))
      else await storageRemove(ORPHAN_KEY)
      return result
    })
  }

  function orphanId(o) {
    return o.kind === 'refund' ? `refund:${o.attemptId || `${o.cartId}:${o.paymentKey || ''}`}` : `payment:${o.paymentKey}`
  }

  // 같은 건(같은 paymentKey·attemptId)을 다시 남기면 처음 기록을 그대로 둔다 -- 복구가 같은 보고를 되풀이해도 안내가 다시 뜨거나
  // 막는 기간이 늘어나지 않게.
  function saveOrphan(orphan) {
    return updateOrphanMap((map) => {
      const id = orphanId(orphan)
      if (!map[id]) map[id] = { ...orphan, at: Date.now(), noticeShown: false }
    })
  }

  // 아직 안내하지 않은 건을 꺼내고 "안내함"으로 표시한다(오래된 것부터). 호출부가 바로 안내 화면을 띄운다.
  function takeOrphanNotices() {
    return updateOrphanMap((map) => {
      const notices = Object.values(map).filter((o) => !o.noticeShown).sort((a, b) => Number(a.at) - Number(b.at))
      for (const o of notices) o.noticeShown = true
      return notices.map((o) => ({ ...o }))
    })
  }

  async function hasOrphanNotices() {
    const map = await serialized(loadOrphanMap)
    return Object.values(map).some((o) => !o.noticeShown)
  }

  function blockingOrphan(cart, orphans) {
    const now = Date.now()
    return orphans.find((o) => o.kind === 'payment'
      && String(o.cartId) === String(cart.id)
      && now - Number(o.at) < ORPHAN_BLOCK_MS
      && (!o.sentKey || o.sentKey === cartSnoozeKey(cart))) || null
  }

  // 이 주문의 결제를 막고 있는 미기록 건(없으면 null).
  async function findOrphanBlock(cart) {
    return blockingOrphan(cart, Object.values(await serialized(loadOrphanMap)))
  }

  // 결제창을 띄워도 되는 주문만 남긴다: 손님이 방금 닫아 쉬는 주문(snooze)과 미기록 건이 걸린 주문을 뺀다.
  async function filterStartableCarts(carts) {
    const list = (carts || []).filter((c) => !isSnoozed(cartSnoozeKey(c)))
    if (!list.length) return list
    const orphans = Object.values(await serialized(loadOrphanMap))
    return list.filter((c) => !blockingOrphan(c, orphans))
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
    isAuthProblem,
    extractPayment,
    claimInflight,
    clearInflight,
    hasInflight,
    reportPaid,
    reportReleased,
    recoverInflight,
    startRefund,
    reportRefund,
    requestRefund,
    claimRefundInflight,
    clearRefundInflight,
    hasRefundInflight,
    reportRefunded,
    reportRefundReleased,
    recoverRefundInflight,
    takeOrphanNotices,
    hasOrphanNotices,
    findOrphanBlock,
    filterStartableCarts,
    snooze,
    isSnoozed,
    cartSnoozeKey,
    refundSnoozeKey,
    formatWon,
  }
})()
