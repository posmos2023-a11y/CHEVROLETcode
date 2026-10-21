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
  async function api(method, path, token, body) {
    try {
      const res = await fetch(`${window.CHEVROLET_API_BASE_URL}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Store-Token': token || '',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      return { ok: res.ok && json.ok !== false, status: res.status, body: json }
    } catch (e) {
      return { ok: false, status: 0, body: { error: '서버에 연결할 수 없습니다.' } }
    }
  }

  function listCarts(token) {
    return api('GET', '/api/front/erp-carts', token)
  }

  function startCart(token, cartId, paymentKey) {
    return api('POST', `/api/front/erp-carts/${encodeURIComponent(cartId)}/start`, token, { paymentKey })
  }

  // 결과 보고. 결제가 이미 끝난 뒤라 보고가 유실되면 "돈은 받았는데 전산은 모르는" 상태가 된다.
  // 그래서 5xx/네트워크 오류는 몇 번 다시 시도한다. 4xx는 다시 보내도 같은 답이라 바로 돌려준다.
  async function reportResult(token, cartId, body) {
    let last = { ok: false, status: 0, body: {} }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await api('POST', `/api/front/erp-carts/${encodeURIComponent(cartId)}/result`, token, body)
      if (last.ok) return last
      if (last.status >= 400 && last.status < 500) return last
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
    return last
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
      tid: r.tid,
      isCashReceipt: method === 'CASH' ? Boolean(r.cash?.isCashReceipt) : undefined,
      easyPayProvider: r.easyPay?.provider,
    }
  }

  async function saveInflight(record) {
    await storageSet(INFLIGHT_KEY, JSON.stringify({ ...record, at: Date.now() }))
  }

  async function loadInflight() {
    const raw = await storageGet(INFLIGHT_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return parsed && parsed.cartId && parsed.paymentKey ? parsed : null
    } catch {
      return null
    }
  }

  function clearInflight() {
    return storageRemove(INFLIGHT_KEY)
  }

  // 지난번 결제가 보고 없이 끝났는지 확인하고, 끝났다면 결과를 마저 보고한다.
  // 반환: 'none'(복구할 것 없음) | 'paid' | 'released' | 'pending'(아직 확인 불가, 다음에 다시)
  async function recoverInflight(token) {
    const inflight = await loadInflight()
    if (!inflight) return 'none'

    let result
    try {
      // 단말기 로컬 캐시에서 승인 결과를 다시 읽는다(성공 건만 14일간 보관된다).
      result = await sdk.payment.getPayment({ paymentKey: inflight.paymentKey })
    } catch (e) {
      const message = String(e?.message || e)
      if (message.includes('PAYMENT_NOT_FOUND')) {
        // 승인 기록이 없다 = 결제가 일어나지 않았다. 다시 결제할 수 있게 되돌린다.
        const res = await reportResult(token, inflight.cartId, { result: 'cancelled', paymentKey: inflight.paymentKey })
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          await clearInflight()
          return 'released'
        }
        return 'pending'
      }
      // 확인 자체가 안 된다. 기록을 지우면 승인된 결제를 잃을 수 있으므로 남겨두고 다음에 다시 본다.
      console.warn('[erp-front-pay] 지난 결제 확인 실패, 다음에 다시 확인합니다.', e)
      return 'pending'
    }

    if (result?.type === 'SUCCESS') {
      const res = await reportResult(token, inflight.cartId, {
        result: 'paid',
        paymentKey: inflight.paymentKey,
        payment: extractPayment(result.response),
      })
      if (res.ok) {
        await clearInflight()
        return 'paid'
      }
      if (res.status >= 400 && res.status < 500) {
        // 서버가 받지 않는다(주문 상태가 다름). 서버 로그에 대사 필요 오류로 남는다. 계속 재시도해도
        // 같은 답이라 기록은 지우되, 결제가 있었다는 사실은 화면으로 알린다(호출부).
        await clearInflight()
        return 'paid'
      }
      return 'pending'
    }

    const res = await reportResult(token, inflight.cartId, { result: 'cancelled', paymentKey: inflight.paymentKey })
    if (res.ok || (res.status >= 400 && res.status < 500)) {
      await clearInflight()
      return 'released'
    }
    return 'pending'
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
    extractPayment,
    saveInflight,
    clearInflight,
    recoverInflight,
    snooze,
    isSnoozed,
    formatWon,
  }
})()
