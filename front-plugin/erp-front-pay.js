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

  // --- 단말기 저장소 ---------------------------------------------------------------
  // 저장소는 하나로 고정한다: sdk.storage가 있으면 그것만 쓰고, 없을 때(일반 브라우저 미리보기)만 localStorage를 쓴다.
  // 예전엔 sdk.storage.get이 한 번 실패하면 localStorage를 대신 읽었는데, 평소 쓰기는 sdk.storage로 가서 그 값은 대개 비어 있다.
  // 기록 맵은 읽고-고치고-쓰기라서, 그 빈 값을 바탕으로 쓰면 다른 주문의 승인 기록과 미기록 목록까지 지워졌다(2026-10-23 점검).
  // 그래서 "값이 없음"(value null)과 "읽기 실패"(ok false)를 나눠 돌려주고, 읽기에 실패하면 쓰지 않는다 -- 호출부는 메모리의 값을
  // 그대로 둔 채 다음 복구에서 다시 한다(updateInflightMap·updateOrphanMap).
  // 읽기에는 시간 제한을 둔다(SDK 호출은 응답이 없으면 끝나지 않는다). 쓰기에는 두지 않는다 -- 끝난 줄 알고 다음 쓰기를 했는데 늦게
  // 끝난 앞 쓰기가 그 위를 덮으면 기록이 사라질 수 있다. 쓰기가 멈추면 뒤의 저장소 작업은 줄(serialized)에서 기다린다. 화면 쪽은 기다리기만
  // 그만둔다(줄은 그대로라 늦게 끝난 쓰기가 뒤의 새 쓰기를 덮지 못한다): 결제 화면은 결제·취소창 전 단계마다 시간 제한을 두고 실패로 보며
  // (erp-pay.html STORAGE_STEP_TIMEOUT_MS), 보고를 기다리는 "처음 화면으로"에도 상한이 있다(goHomeWhenIdle). 대기화면은 폴링마다 시간
  // 제한을 둬 다음 폴링을 늘 예약한다(index.html startableCarts).
  const STORAGE_READ_TIMEOUT_MS = 5000

  // 실단말기의 sdk.storage.get은 네이티브가 처리해서, 한 번도 쓴 적 없는 키를 읽을 때 null을 주는지 예외를 던지는지 확인되지
  // 않았다(CDN SDK의 개발용 가짜 구현은 null). 예외를 던지는 단말기라면 "읽기 실패면 쓰지 않는다" 규칙 때문에 첫 기록을 영영
  // 못 남기고 프론트 결제가 전부 막힌다. 그래서 이 단말기에서 그 키를 한 번이라도 쓴 적이 있는지 localStorage에 표시해 두고,
  // 쓴 적이 없는 키의 읽기 예외는 "값 없음"으로 본다(한 번 다시 읽어 본 뒤). 시간 초과는 늘 읽기 실패다 -- 값이 있는데 늦는 것일 수 있다.
  const STORAGE_WRITTEN_PREFIX = 'chevrolet_front_storage_written:'

  function markWritten(key) {
    try { localStorage.setItem(STORAGE_WRITTEN_PREFIX + key, '1') } catch { /* 표시를 못 남기면 다음 예외도 "값 없음"으로 본다 */ }
  }

  function wasWritten(key) {
    try { return localStorage.getItem(STORAGE_WRITTEN_PREFIX + key) === '1' } catch { return false }
  }

  function usesSdkStorage() {
    return Boolean(window.sdk?.storage?.get)
  }

  // 반환: { ok: true, value: string | null } | { ok: false }
  async function storageRead(key) {
    if (!usesSdkStorage()) {
      try {
        return { ok: true, value: localStorage.getItem(key) }
      } catch (e) {
        console.warn('[erp-front-pay] 저장소 읽기 실패', key, e)
        return { ok: false }
      }
    }
    const first = await sdkStorageRead(key)
    // 값이 있는 키를 읽었으면 그 키는 있는 것이다 -- 업데이트 전 버전이 남긴 기록도 여기서 표시된다.
    if (first.ok && first.value !== null) markWritten(key)
    if (first.ok || first.timedOut || wasWritten(key)) return first.ok ? first : { ok: false }
    // 쓴 적 없는 키에서 예외가 났다. 한 번 더 읽어 보고 그래도 예외면 "값 없음"으로 본다(위 STORAGE_WRITTEN_PREFIX 주석).
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = await sdkStorageRead(key)
    if (second.ok) return second
    if (second.timedOut) return { ok: false }
    console.warn('[erp-front-pay] 한 번도 쓰지 않은 키의 읽기 예외를 "값 없음"으로 봅니다.', key)
    return { ok: true, value: null }
  }

  // 반환: { ok: true, value } | { ok: false, timedOut: boolean }
  async function sdkStorageRead(key) {
    let timer
    try {
      const item = await Promise.race([
        sdk.storage.get({ key }),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('STORAGE_READ_TIMEOUT')), STORAGE_READ_TIMEOUT_MS) }),
      ])
      const value = item?.value
      if (value === undefined || value === null) return { ok: true, value: null }
      if (typeof value !== 'string') {
        // 형식이 다른 값은 "쓴 적 없음" 예외로 보지 않는다(timedOut과 같이 늘 읽기 실패) -- 값이 있기는 한 것이다.
        console.warn('[erp-front-pay] 저장소 값의 형식이 예상과 다릅니다. 읽기 실패로 봅니다.', key, typeof value)
        return { ok: false, timedOut: true }
      }
      return { ok: true, value }
    } catch (e) {
      console.warn('[erp-front-pay] 저장소 읽기 실패 -- 이번에는 기록을 고치지 않고 다음에 다시 합니다.', key, e)
      return { ok: false, timedOut: e?.message === 'STORAGE_READ_TIMEOUT' }
    } finally {
      clearTimeout(timer)
    }
  }

  // 읽기 실패는 null(값 없음)과 같게 돌려준다. 토큰처럼 "없으면 안내만 하는" 값에만 쓴다 -- 기록 맵은 storageRead로 읽는다.
  async function storageGet(key) {
    const read = await storageRead(key)
    return read.ok ? read.value : null
  }

  // 반환: 저장했으면 true. sdk.storage가 있는데 실패하면 localStorage로 대신하지 않는다(읽는 곳과 쓰는 곳이 갈라진다).
  async function storageSet(key, value) {
    try {
      if (usesSdkStorage()) {
        await sdk.storage.set({ key, value })
        markWritten(key)
      } else {
        localStorage.setItem(key, value)
      }
      return true
    } catch (e) {
      console.warn('[erp-front-pay] 저장소 쓰기 실패', key, e)
      return false
    }
  }

  async function storageRemove(key) {
    try {
      if (!usesSdkStorage()) localStorage.removeItem(key)
      else if (typeof sdk.storage.remove === 'function') await sdk.storage.remove({ key })
      else await sdk.storage.set({ key, value: '' }) // remove가 없는 SDK -- 빈 값은 "없음"으로 읽힌다
      return true
    } catch (e) {
      console.warn('[erp-front-pay] 저장소 지우기 실패', key, e)
      return false
    }
  }

  // 저장된 맵(JSON 객체)을 읽는다. 반환: { parsed, raw } | null(읽기 실패). 값이 없으면 parsed는 {}, raw는 null.
  // 해석할 수 없는 값도 읽기 실패로 본다 -- 이 코드는 늘 JSON.stringify한 객체만 쓰므로, 해석이 안 되면 값이 덜 읽혔을 가능성이
  // 크다. 그걸 {}로 보고 쓰면 남아 있던 기록이 지워진다.
  async function readStoredObject(key) {
    const read = await storageRead(key)
    if (!read.ok) return null
    if (!read.value) return { parsed: {}, raw: null }
    let parsed
    try { parsed = JSON.parse(read.value) } catch { parsed = null }
    if (!parsed || typeof parsed !== 'object') {
      console.error('[erp-front-pay] 저장된 기록을 해석하지 못했습니다. 덮어쓰지 않고 그대로 둡니다.', key)
      return null
    }
    return { parsed, raw: read.value }
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
  // 반환: { map, raw } | null(저장소를 읽지 못함 -- 호출부는 기록이 있는지 모르는 것으로 다룬다. 빈 맵으로 보면 안 된다).
  async function readInflightMap(key) {
    const stored = await readStoredObject(key)
    if (!stored) return null
    const { parsed, raw } = stored
    // 맵에서 'cartId'라는 이름의 주문은 값이 객체라서, 값이 문자열 등인 경우만 옛 한 건짜리로 본다.
    const legacy = parsed.cartId && typeof parsed.cartId !== 'object'
    const map = {}
    for (const record of legacy ? [parsed] : Object.values(parsed)) {
      if (record && typeof record === 'object' && record.cartId && typeof record.cartId !== 'object') {
        map[String(record.cartId)] = record
      }
    }
    return { map, raw }
  }

  // 반환: 맵 | null(읽기 실패)
  async function loadInflightMap(key) {
    return (await readInflightMap(key))?.map ?? null
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

  // 반환: { ok, result } -- result는 mutate가 돌려준 값(claim의 성공 여부 등), ok는 저장소에 반영됐는지(저장된 값과 같으면 쓰지 않고 true).
  // 읽기에 실패하면 mutate를 부르지 않고 쓰지도 않는다({ ok:false }). 맵이 비어도 지우지 않고 '{}'를 쓴다 -- 읽는 곳과 같은 저장소에
  // 반영된다(예전엔 remove를 불렀는데, 그것만 실패하면 지운 기록이 계속 되살아났다).
  function updateMap(read, key, mutate) {
    return serialized(async () => {
      const loaded = await read()
      if (!loaded) return { ok: false }
      const result = mutate(loaded.map)
      const next = JSON.stringify(loaded.map)
      if (next === loaded.raw || (loaded.raw === null && next === '{}')) return { ok: true, result }
      return { ok: await storageSet(key, next), result }
    })
  }

  function updateInflightMap(key, mutate) {
    return updateMap(() => readInflightMap(key), key, mutate)
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
  // 저장소를 읽지 못했거나 쓰지 못해도 false다 -- 기록 없이 결제창을 띄우면 결과를 복구할 근거가 없다.
  async function claimInflight(record) {
    const { ok, result } = await updateInflightMap(INFLIGHT_KEY, (map) => {
      const id = String(record.cartId)
      const existing = map[id]
      if (existing && !sameValue(existing.paymentKey, record.paymentKey)) return false
      map[id] = mergeRecord(existing, record)
      return true
    })
    return ok && result === true
  }

  // 지우는 쪽이 "자기" paymentKey를 넘긴다. 칸에 다른 시도의 기록이 들어 있으면 지우지 않는다(compare-and-delete) -- 늦게 끝난
  // 옛 시도(예: 시작 409)가 새 시도의 기록을 지우면, 새 시도가 승인된 뒤 보고까지 실패했을 때 복구할 근거가 없다.
  // 반환: 지웠거나 지울 게 없으면 true. 저장소를 읽지/쓰지 못하면 false -- 기록은 남고 다음 복구가 같은 보고를 다시 한다(서버는 같은
  // 보고를 멱등하게 받는다). 지우면 그 주문의 쉬기(holdStuck)도 푼다.
  async function clearInflight(cartId, paymentKey) {
    const { ok, result } = await updateInflightMap(INFLIGHT_KEY, (map) => {
      const id = String(cartId)
      if (!map[id] || !sameValue(map[id].paymentKey, paymentKey)) return false
      delete map[id]
      return true
    })
    if (ok && result) releaseHold('payment', cartId)
    return ok
  }

  // 저장소를 읽지 못하면 true(있을 수 있다) -- 기록이 있는지 모르는 주문에 새 결제를 띄우지 않는다.
  function hasInflight(cartId) {
    return serialized(async () => {
      const map = await loadInflightMap(INFLIGHT_KEY)
      return !map || Boolean(map[String(cartId)])
    })
  }

  // 기록이 남은 주문 id 목록(Set). 저장소를 읽지 못하면 null -- 호출부는 모든 주문에 기록이 있을 수 있는 것으로 다룬다.
  function inflightCartIds() {
    return serialized(async () => {
      const map = await loadInflightMap(INFLIGHT_KEY)
      return map ? new Set(Object.keys(map)) : null
    })
  }

  // 단말기 SDK 확인 호출(getPayment·getPaymentCancel)의 시간 제한. 이 호출은 응답이 없으면 끝나지 않아서, 예전엔 기록 한 건 때문에
  // 결제 화면 시작이 통째로 멈췄다. 시간이 지나면 '확인 못 함'(pending)으로 보고 기록은 남긴다. 늦게 온 응답은 버린다(다음 복구가 다시 본다).
  const SDK_CHECK_TIMEOUT_MS = 10000

  function callSdkWithTimeout(fn) {
    let timer
    return Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('SDK_CHECK_TIMEOUT')), SDK_CHECK_TIMEOUT_MS) }),
    ]).finally(() => clearTimeout(timer))
  }

  // 같은 기록의 복구가 이미 돌고 있으면 그 결과를 같이 기다린다. 결제 화면 시작 때의 복구는 시간 제한이 지나도 뒤에서 계속 돌 수
  // 있는데, 그 사이 같은 주문의 [다시 결제하기] 등이 같은 기록을 또 확인하면 같은 보고가 두 번 나간다(서버는 멱등하게 받지만 쓸데없다).
  const recoveriesInProgress = new Map()

  function recoverOnce(id, run) {
    if (recoveriesInProgress.has(id)) return recoveriesInProgress.get(id)
    const running = Promise.resolve()
      .then(run)
      .catch((e) => {
        console.error('[erp-front-pay] 지난 기록 확인 중 오류, 다음에 다시 확인합니다.', e)
        return 'pending'
      })
      .finally(() => recoveriesInProgress.delete(id))
    recoveriesInProgress.set(id, running)
    return running
  }

  // 여러 건을 한 번에 복구했을 때의 대표 결과. 확인이 안 끝난 건이 하나라도 있으면 'auth'(토큰 문제) 또는 'pending'(호출부는 그 건이
  // 걸린 주문만 막는다 -- inflightCartIds). 아니면 'orphan'(승인됐는데 전산이 받지 않음) > 성공(paid/refunded) > 'released' 순이다.
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
      // 미기록 목록에 남기지 못했으면(저장소 읽기·쓰기 실패) 지우지 않는다 -- 승인 증거가 어디에도 남지 않게 된다. 'pending'으로
      // 돌려주고 다음 복구가 같은 보고부터 다시 한다.
      const saved = await saveOrphan({
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
      if (!saved) return 'pending'
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
      // 단말기 로컬 캐시에서 승인 결과를 다시 읽는다(성공 건만 14일간 보관된다). 시간 제한이 지나면 아래 catch로 간다(pending).
      result = await callSdkWithTimeout(() => sdk.payment.getPayment({ paymentKey: record.paymentKey }))
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
  // 건마다 나란히 확인한다 -- 예전엔 차례로 돌아서, 앞 건의 확인이 멈추면 뒤 건(다른 주문)도 끝나지 않았다.
  // 저장소를 읽지 못하면 기록이 있는지 모르므로 'pending'이다(기록을 건드리지 않는다).
  async function recoverInflight(token, onlyCartId) {
    const map = await serialized(() => loadInflightMap(INFLIGHT_KEY))
    if (!map) return 'pending'
    const records = Object.values(map).filter((r) => onlyCartId === undefined || String(r.cartId) === String(onlyCartId))
    const outcomes = await Promise.all(records.map((record) => recoverOnce(
      `payment:${record.cartId}:${record.paymentKey || ''}`,
      () => recoverOnePayment(token, record),
    )))
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
  // 저장소를 읽지/쓰지 못하면 false(claimInflight와 같다).
  async function claimRefundInflight(record) {
    const { ok, result } = await updateInflightMap(REFUND_INFLIGHT_KEY, (map) => {
      const id = String(record.cartId)
      const existing = map[id]
      if (existing && !sameValue(existing.attemptId, record.attemptId)) return false
      map[id] = mergeRecord(existing, record)
      return true
    })
    return ok && result === true
  }

  // 반환·규칙은 clearInflight와 같다.
  async function clearRefundInflight(cartId, attemptId) {
    const { ok, result } = await updateInflightMap(REFUND_INFLIGHT_KEY, (map) => {
      const id = String(cartId)
      if (!map[id] || !sameValue(map[id].attemptId, attemptId)) return false
      delete map[id]
      return true
    })
    if (ok && result) releaseHold('refund', cartId)
    return ok
  }

  // 저장소를 읽지 못하면 true(hasInflight와 같다).
  function hasRefundInflight(cartId) {
    return serialized(async () => {
      const map = await loadInflightMap(REFUND_INFLIGHT_KEY)
      return !map || Boolean(map[String(cartId)])
    })
  }

  function refundInflightCartIds() {
    return serialized(async () => {
      const map = await loadInflightMap(REFUND_INFLIGHT_KEY)
      return map ? new Set(Object.keys(map)) : null
    })
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
  // 직원이 [취소 중 풀기]로 이 시도를 푼 뒤에 도착한 완료 보고도 서버가 200 { status:'refunded' }로 받는다(풀린 시도 목록에 있는
  // 시도일 때). 그것도 res.ok라 정상 기록으로 지운다 -- 예전 서버는 409로 거절해 미기록 건으로만 남았다.
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
      // 미기록 목록에 남기지 못했으면 지우지 않는다(reportPaid와 같다).
      const saved = await saveOrphan({
        kind: 'refund',
        cartId: record.cartId,
        paymentKey: record.paymentKey,
        attemptId: record.attemptId,
        approvalNumber: record.approvalNumber,
        amount: record.amount,
        httpStatus: res.status,
        cartStatus: res.body?.status,
      })
      if (!saved) return 'pending'
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
      result = await callSdkWithTimeout(() => sdk.payment.getPaymentCancel({ paymentKey: record.paymentKey }))
    } catch (e) {
      if (String(e?.message || e).includes('PAYMENT_NOT_FOUND')) return reportRefundReleased(token, record)
      console.warn('[erp-front-pay] 지난 결제 취소 확인 실패, 다음에 다시 확인합니다.', e)
      return 'pending'
    }
    if (result?.type === 'SUCCESS') return reportRefunded(token, record)
    return reportRefundReleased(token, record)
  }

  // 반환: 'none' | 'refunded' | 'orphan' | 'released' | 'auth' | 'pending' (여러 건이면 recoverInflight와 같은 규칙으로 합친다)
  // 건마다 나란히 확인하고, 저장소를 읽지 못하면 'pending'이다(recoverInflight와 같다).
  async function recoverRefundInflight(token, onlyCartId) {
    const map = await serialized(() => loadInflightMap(REFUND_INFLIGHT_KEY))
    if (!map) return 'pending'
    const records = Object.values(map).filter((r) => onlyCartId === undefined || String(r.cartId) === String(onlyCartId))
    const outcomes = await Promise.all(records.map((record) => recoverOnce(
      `refund:${record.cartId}:${record.attemptId || ''}`,
      () => recoverOneRefund(token, record),
    )))
    return mergeOutcomes(outcomes, 'refunded')
  }

  // --- 전산 미기록 목록 ---------------------------------------------------------------
  // 단말기에서는 승인(또는 취소)이 끝났는데 서버가 그 보고를 끝내 받지 않은 건(reportPaid·reportRefunded의 'orphan').
  // 예: 손님 결제가 승인된 직후 보고를 못 했는데, 그 사이 직원이 [결제 중 풀기]나 [POS로 되돌리기]를 했다.
  // inflight 기록은 "아직 보고할 것"이라 계속 남겨 둘 수 없으므로(남기면 새 결제를 영구히 막는다) 여기에 옮겨 둔다. 쓰임은 셋이다.
  //   1) 직원 안내 화면(erp-pay.html showOrphanNotice) -- 승인번호·금액으로 토스 결제내역과 맞춰 보게 한다. 한 건당 한 번 띄운다.
  //   2) 같은 주문의 결제창 자동 시작을 막는다(filterStartableCarts) -- 받은 돈을 전산이 모르는 주문을 손님에게 또 결제시키지 않게.
  //      막는 기간은 ORPHAN_BLOCK_MS다. 그 전에 직원이 주문을 다시 보내면(frontSentAt이 바뀌어 cartSnoozeKey가 달라짐) 바로 풀린다 --
  //      직원이 확인하고 다시 보낸 것으로 본다. 그 뒤로는(다른 프론트도) 서버의 frontOrphan이 직원 확인 전까지 막는다(serverOrphanOf).
  //   3) 대사 근거. ORPHAN_KEEP_MS(7일) 동안 단말기에 남긴다.
  const ORPHAN_KEY = 'chevrolet_front_pay_orphans'
  const ORPHAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000
  const ORPHAN_BLOCK_MS = 30 * 60 * 1000

  // { [id]: { kind:'payment'|'refund', cartId, paymentKey, attemptId?, approvalNumber, amount, sentKey?, at, noticeShown, ... } }
  // 보관 기간이 지난 건은 읽을 때 뺀다(다음 쓰기 때 저장소에서도 빠진다).
  // 반환: { map, raw } | null(저장소를 읽지 못함 -- 빈 목록으로 보면 안 된다. 그걸 바탕으로 쓰면 미기록 목록이 지워진다).
  async function readOrphanMap() {
    const stored = await readStoredObject(ORPHAN_KEY)
    if (!stored) return null
    const now = Date.now()
    const map = {}
    for (const [id, o] of Object.entries(stored.parsed)) {
      if (o && typeof o === 'object' && o.cartId && now - Number(o.at) < ORPHAN_KEEP_MS) map[id] = o
    }
    return { map, raw: stored.raw }
  }

  async function loadOrphanMap() {
    return (await readOrphanMap())?.map ?? null
  }

  // 반환: { ok, result } (updateMap)
  function updateOrphanMap(mutate) {
    return updateMap(readOrphanMap, ORPHAN_KEY, mutate)
  }

  function orphanId(o) {
    return o.kind === 'refund' ? `refund:${o.attemptId || `${o.cartId}:${o.paymentKey || ''}`}` : `payment:${o.paymentKey}`
  }

  // 같은 건(같은 paymentKey·attemptId)을 다시 남기면 처음 기록을 그대로 둔다 -- 복구가 같은 보고를 되풀이해도 안내가 다시 뜨거나
  // 막는 기간이 늘어나지 않게. 반환: 목록에 남아 있으면 true(이미 있던 건 포함). 저장소를 읽지/쓰지 못하면 false -- 호출부는
  // 그 건의 inflight 기록을 지우지 않는다(reportPaid·reportRefunded).
  async function saveOrphan(orphan) {
    const { ok } = await updateOrphanMap((map) => {
      const id = orphanId(orphan)
      if (!map[id]) map[id] = { ...orphan, at: Date.now(), noticeShown: false }
    })
    return ok
  }

  // 아직 안내하지 않은 건을 꺼내고 "안내함"으로 표시한다(오래된 것부터). 호출부가 바로 안내 화면을 띄운다.
  // 저장소를 읽지 못하면 빈 목록이다(안내는 다음에 띄운다). "안내함"을 쓰지 못했으면 이번에 띄우고 다음에 한 번 더 뜬다.
  async function takeOrphanNotices() {
    const { result } = await updateOrphanMap((map) => {
      const notices = Object.values(map).filter((o) => !o.noticeShown).sort((a, b) => Number(a.at) - Number(b.at))
      for (const o of notices) o.noticeShown = true
      return notices.map((o) => ({ ...o }))
    })
    return result || []
  }

  // 저장소를 읽지 못하면 false -- 대기화면이 안내하러 결제 화면으로 넘어갔다가 거기서도 못 읽고 돌아오는 반복을 만들지 않는다.
  async function hasOrphanNotices() {
    const map = await serialized(loadOrphanMap)
    return Boolean(map) && Object.values(map).some((o) => !o.noticeShown)
  }

  function blockingOrphan(cart, orphans) {
    const now = Date.now()
    return orphans.find((o) => o.kind === 'payment'
      && String(o.cartId) === String(cart.id)
      && now - Number(o.at) < ORPHAN_BLOCK_MS
      && (!o.sentKey || o.sentKey === cartSnoozeKey(cart))) || null
  }

  // 미기록 목록을 읽지 못했을 때 findOrphanBlock이 돌려주는 값. 막는 건이 있는지 모르므로 결제를 띄우지 않는다(이중결제 방지).
  const ORPHANS_UNREADABLE = Object.freeze({ unreadable: true })

  // 이 주문의 결제를 막고 있는 미기록 건(없으면 null, 목록을 읽지 못하면 ORPHANS_UNREADABLE).
  async function findOrphanBlock(cart) {
    const map = await serialized(loadOrphanMap)
    if (!map) return ORPHANS_UNREADABLE
    return blockingOrphan(cart, Object.values(map))
  }

  // 서버가 알려 준 "이 주문에는 이미 승인된 결제가 있다"(GET /api/front/erp-carts의 cart.frontOrphan {at, approvalNo, amount, ackAt}).
  // 어느 프론트에서든 승인됐는데 서버가 주문에 기록하지 못한 결제다(/result의 PAID_AFTER_RELEASE). 위의 로컬 미기록 목록은 그 승인을 받은
  // 단말기에만 있고 30분만, 같은 frontSentAt일 때만 막는다 -- 다른 프론트, 30분 뒤, 전산이 같은 참조번호로 다시 보낸 주문은 막지 못해
  // 이미 결제한 손님에게 결제창이 다시 떴다(2026-10-23 점검). 직원이 POS에서 확인하기 전(ackAt 없음)에는 어느 프론트도 이 주문의 결제창을
  // 띄우지 않는다. 확인했으면(ackAt) 막지 않는다. 값의 형식이 예상과 달라도(객체가 아님) 막는다.
  // 반환: 막는 frontOrphan 객체(형식이 다르면 {}) | null
  function serverOrphanOf(cart) {
    const orphan = cart?.frontOrphan
    if (!orphan) return null
    if (typeof orphan !== 'object') return {}
    return orphan.ackAt ? null : orphan
  }

  // 결제창을 띄워도 되는 주문만 남긴다: 손님이 방금 닫아 쉬는 주문(snooze), 지난 기록 확인이 안 끝나 쉬는 주문(holdStuck),
  // 서버가 확인 전 승인(frontOrphan)을 알려 온 주문, 미기록 건이 걸린 주문을 뺀다. 미기록 목록을 읽지 못하면 하나도 남기지 않는다 --
  // 어느 주문이 막혀야 하는지 모른다.
  async function filterStartableCarts(carts) {
    const list = (carts || []).filter((c) => !isSnoozed(cartSnoozeKey(c)) && !isHeld('payment', c.id) && !serverOrphanOf(c))
    if (!list.length) return list
    const map = await serialized(loadOrphanMap)
    if (!map) return []
    const orphans = Object.values(map)
    return list.filter((c) => !blockingOrphan(c, orphans))
  }

  // 취소창을 띄워도 되는 취소 요청만 남긴다: 쉬는 건(snooze)과 지난 취소 기록 확인이 안 끝나 쉬는 건(holdStuck)을 뺀다.
  function filterStartableRefunds(refunds) {
    return (refunds || []).filter((r) => !isSnoozed(refundSnoozeKey(r)) && !isHeld('refund', r.id))
  }

  // --- 확인이 안 끝난 지난 기록이 걸린 주문 쉬게 하기 ----------------------------------
  // 지난 시도 기록이 확인되지 않은 주문은 결제·취소창을 띄울 수 없다(그 기록을 덮으면 승인 여부를 영영 모른다). 그런데 대기화면은
  // 그 주문을 보면 곧바로 결제 화면으로 넘기고, 결제 화면은 또 확인하지 못해 돌아오는 일을 쉬지 않고 되풀이했다(그동안 다른 손님은
  // [예약하기]도 못 쓴다). 그래서 그 주문(그 취소 건)만 1분 쉬게 하고, 다시 막히면 2분·4분·8분, 최대 10분으로 늘린다. 다른 주문과
  // 취소는 그대로 진행한다. 쉬는 동안에도 대기화면의 뒤 복구(index.html)가 기록을 계속 확인하고, 기록이 정리되면
  // (clearInflight·clearRefundInflight) 바로 풀린다. 직원이 주문을 다시 보내도 풀리지 않는다 -- 기록은 그대로 남아 있다.
  // 페이지를 옮겨도 남아야 해서 sessionStorage에 둔다(snooze와 같다).
  const HOLD_KEY = 'chevrolet_front_pay_hold'
  const HOLD_BASE_MS = 60 * 1000
  const HOLD_MAX_MS = 10 * 60 * 1000
  const HOLD_FORGET_MS = 30 * 60 * 1000 // 쉬기가 끝난 뒤 이만큼 다시 막히지 않으면 간격을 1분부터 다시 센다

  function holdKey(kind, cartId) {
    return `${kind}:${cartId}`
  }

  function readHolds() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(HOLD_KEY) || '{}')
      const now = Date.now()
      return Object.fromEntries(Object.entries(parsed).filter(([, h]) => h && now < Number(h.until) + HOLD_FORGET_MS))
    } catch {
      return {}
    }
  }

  function writeHolds(all) {
    try { sessionStorage.setItem(HOLD_KEY, JSON.stringify(all)) } catch { /* 저장 불가 환경 */ }
  }

  // kind: 'payment' | 'refund'. 반환: 이번에 쉬는 시간(ms)
  function holdStuck(kind, cartId) {
    const all = readHolds()
    const key = holdKey(kind, cartId)
    const count = (Number(all[key]?.count) || 0) + 1
    const ms = Math.min(HOLD_BASE_MS * 2 ** (count - 1), HOLD_MAX_MS)
    all[key] = { until: Date.now() + ms, count }
    writeHolds(all)
    return ms
  }

  function isHeld(kind, cartId) {
    const hold = readHolds()[holdKey(kind, cartId)]
    return Boolean(hold && Number(hold.until) > Date.now())
  }

  function releaseHold(kind, cartId) {
    const all = readHolds()
    const key = holdKey(kind, cartId)
    if (!all[key]) return
    delete all[key]
    writeHolds(all)
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
    inflightCartIds,
    reportPaid,
    reportReleased,
    recoverInflight,
    startRefund,
    reportRefund,
    requestRefund,
    claimRefundInflight,
    clearRefundInflight,
    hasRefundInflight,
    refundInflightCartIds,
    reportRefunded,
    reportRefundReleased,
    recoverRefundInflight,
    takeOrphanNotices,
    hasOrphanNotices,
    findOrphanBlock,
    ORPHANS_UNREADABLE,
    serverOrphanOf,
    filterStartableCarts,
    filterStartableRefunds,
    holdStuck,
    isHeld,
    snooze,
    isSnoozed,
    cartSnoozeKey,
    refundSnoozeKey,
    formatWon,
  }
})()
