// 쉐보레 전산(ERP)이 GET /api/erp/carts로 올려둔 "결제 전 장바구니"를 POS 장바구니로 옮기는 화면.
// app.js와 분리한 이유는 단순히 코드 줄 수 때문이다 — 대기열 폴링/토큰 화면 로직과는 관심사가
// 달라서 굳이 한 파일에 욱여넣지 않았다. 초기화는 app.js가 initErpCarts() 한 번만 부르고,
// 실제 조회는 기존 대기열 폴링 타이머 안에서 refreshErpCarts()를 통해 함께 실행된다(타이머를
// 두 개 만들면 정지/재개 로직이 갈라지므로 절대 새 타이머를 만들지 않는다).
import { posPluginSdk } from '@tossplace/pos-plugin-sdk'
// lineItem을 만드는 규칙은 실단말기에서 알아낸 것이라 한 곳에만 둔다(lineItem.js 상단 주석).
import { buildLineItem } from './lineItem.js'

const draftOrder = posPluginSdk.draftOrder

const listEl = document.getElementById('erp-cart-list')

// app.js가 가진 apiGet/apiPost(X-Store-Token 포함), notify(토스트), escapeHtml, 401 처리 콜백을
// 주입받는다. 이 모듈이 직접 fetch를 새로 만들면 토큰 헤더·API_BASE 처리 로직이 두 곳에 생겨
// 나중에 한쪽만 고쳐질 위험이 있다 — 기존 헬퍼를 그대로 재사용한다.
let deps = null

export function initErpCarts(injected) {
  deps = injected
  initPaymentWatch()

  // 직원이 직접 다시 확인할 수단. 폴링이 최대 15초까지 늘어나므로, "지금 서버는 뭐라고
  // 하는지"를 바로 보고 싶을 때가 있다 — 특히 카드가 안 사라진다고 느낄 때.
  const refresh = document.getElementById('erp-refresh')
  if (refresh) {
    refresh.addEventListener('click', async () => {
      refresh.disabled = true
      try {
        await refreshErpCarts()
      } finally {
        refresh.disabled = false
      }
    })
  }

  if (!listEl) return
  listEl.addEventListener('click', handleListClick)
}

// 마지막으로 서버 응답을 받은 시각과 건수. 화면이 멈춘 건지 서버가 그렇게 답하는 건지
// 직원이 구분할 수 있어야 한다 — "안 사라져요"의 원인이 둘 중 어느 쪽인지 바로 갈린다.
function stampUpdated(count) {
  const el = document.getElementById('erp-cart-updated')
  if (!el) return
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())
  el.textContent = count
    ? `${time} 기준 · 서버에 ${count}건 남아 있습니다`
    : `${time} 기준 · 대기 중인 주문 없음`
}

// 전산 품목은 POS 카탈로그에 등록돼 있지 않다. POS가 요구하는 item.id/category는 "이미 있는
// 상품"을 빌려 쓰는 수밖에 없어(근거는 lineItem.js 상단 주석), 카탈로그의
// 아무 상품이나 하나를 기준으로 삼아 모든 라인아이템에 재사용한다.
async function getBaseCatalogItem() {
  const catalogs = await posPluginSdk.catalog.getCatalogs()
  if (!catalogs || catalogs.length === 0) return null
  return catalogs.find((c) => c.state === 'ON_SALE') || catalogs[0]
}

let lastCarts = []

// ⚠️ 폴링과 담기가 겹칠 때의 사고를 막는 두 개의 방어막이다.
//
// inFlight: 담는 중인 cart. addLineItem을 품목 수만큼 순차로 기다리는 동안 5초 폴링이 끼어들면
//   renderErpCarts가 listEl.innerHTML을 통째로 갈아엎어서 (1) "담는 중..."인 비활성 버튼이 새
//   버튼으로 되살아나고 (2) 서버는 아직 pending이라 그 카드도 그대로 돌아온다. 직원이 한 번 더
//   누르면 같은 품목이 두 번 담기고, autoPay면 결제까지 두 번 뜬다. 담는 동안에는 아예 다시
//   그리지 않는다 — 새 전산 주문이 몇 초 늦게 보이는 것보다 중복 결제를 막는 쪽이 훨씬 중요하다.
//
// consumed: 이미 처리를 마친 cart. consume 직전에 출발한 폴링 요청의 응답이 뒤늦게 도착하면
//   서버는 그때까지 pending으로 알고 있었으므로 그 카드를 되살려버린다. 한 번 처리한 id는
//   렌더링 단계에서 영구히 걸러낸다.
const inFlight = new Set()
const consumed = new Set()

function formatWon(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`
}

function summarizeItems(items) {
  if (!items || items.length === 0) return '품목 없음'
  const first = items[0]
  const rest = items.length - 1
  const base = `${deps.escapeHtml(first.name)} ×${first.quantity}`
  return rest > 0 ? `${base} 외 ${rest}건` : base
}

function renderErpCarts(incoming) {
  // 이미 처리한 건은 폴링 응답에 남아 있더라도 화면에 다시 세우지 않는다(consumed 주석 참고).
  const carts = incoming.filter((c) => !consumed.has(c.id))
  lastCarts = carts
  if (!listEl) return
  // 담는 중에는 DOM을 건드리지 않는다(inFlight 주석 참고). lastCarts는 위에서 갱신해뒀으므로
  // 담기가 끝난 뒤의 렌더링에는 최신 목록이 반영된다.
  if (inFlight.size > 0) return

  if (!carts.length) {
    // 기존 대기열 빈 상태 카드와 같은 모양(.empty/.empty-mark/.empty-title/.empty-copy)을
    // 그대로 재사용한다 — 새 디자인 언어를 만들지 않는다.
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">✓</div>
        <div class="empty-title">전산에서 보낸 주문이 없습니다</div>
        <div class="empty-copy">전산에서 물건을 담으면 이곳에 표시됩니다.</div>
      </div>
    `
    return
  }

  listEl.innerHTML = carts
    .map((cart) => {
      const buttonLabel = cart.autoPay ? '담고 결제 시작' : 'POS에 담기'
      const dismissing = dismissConfirm.has(cart.id)
      return `
        <article class="erp-cart-item" data-cart-id="${deps.escapeHtml(cart.id)}">
          <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')}</div>
          <div class="erp-cart-head">
            <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
            ${cart.linkedReservation ? '<span class="erp-cart-linked">예약 연결됨</span>' : ''}
          </div>
          ${cart.carNumber && cart.memo ? `<div class="erp-cart-memo">${deps.escapeHtml(cart.memo)}</div>` : ''}
          <div class="erp-cart-summary">${summarizeItems(cart.items)}</div>
          <div class="erp-cart-total">${formatWon(cart.totalAmount)}</div>
          <div class="erp-cart-actions">
            <button class="erp-cart-button" type="button" data-cart-id="${deps.escapeHtml(cart.id)}">${buttonLabel}</button>
            <button class="erp-cart-dismiss${dismissing ? ' confirming' : ''}" type="button"
                    data-cart-id="${deps.escapeHtml(cart.id)}">${dismissing ? '정말 지울까요?' : '지우기'}</button>
          </div>
        </article>
      `
    })
    .join('')
}

// 대기열 응답(/api/pos/queue)에 함께 실려 온 전산 주문을 화면에 반영한다.
// 폴링 요청을 매장당 절반으로 줄이려고 서버가 두 결과를 한 응답에 담아주기 때문에, 평소에는
// 이 함수만 쓰인다(아래 refreshErpCarts는 그 필드를 아직 안 주는 서버용 폴백).
export function applyErpCarts(carts) {
  if (!deps) return
  const list = Array.isArray(carts) ? carts : []
  renderErpCarts(list)
  stampUpdated(list.filter((c) => !consumed.has(c.id)).length)
  // 통보가 밀린 결제 건이 있으면 이 기회에 다시 보낸다(retryPendingPaid 주석 참고).
  retryPendingPaid()
}

// 서버가 erpCarts 필드를 아직 안 내려주는 경우(배포 과도기)의 폴백. 이 API가 없거나 실패해도
// 대기열 화면은 멀쩡해야 하므로 오류를 밖으로 던지지 않고 "전산 주문 없음"으로 조용히 처리한다.
export async function refreshErpCarts() {
  if (!deps) return
  try {
    const { ok, status, body } = await deps.apiGet('/api/pos/erp-carts')
    if (!ok) {
      if (status === 401) {
        // 기존 대기열(loadQueue)과 동일한 401 처리 — 토큰을 지우고 재입력 화면으로 보낸다.
        deps.onUnauthorized(body.error)
        return
      }
      // 404 등 그 외 실패는 아직 배포 전이거나 일시적 오류일 수 있다. 대기열 화면에는 영향을
      // 주지 않고 이 섹션만 "없음"으로 비워둔다.
      renderErpCarts([])
      return
    }
    const list = body.carts || []
    renderErpCarts(list)
    stampUpdated(list.filter((c) => !consumed.has(c.id)).length)
  } catch {
    renderErpCarts([])
  }
}

function findButton(cartId) {
  if (!listEl) return null
  return Array.from(listEl.querySelectorAll('button.erp-cart-button')).find((b) => b.dataset.cartId === cartId) || null
}

// [지우기]는 되돌릴 수 없다(전산이 다시 보내야 한다). 그래서 대기열의 호출/완료/취소와 같은
// 방식으로, 한 번 누르면 "정말 지울까요?"로 바뀌고 3초 안에 한 번 더 눌러야 실제로 지운다.
// 정비소 POS는 터치라 스쳐 눌리는 일이 잦다.
const dismissConfirm = new Map()

function clearDismissConfirm(cartId) {
  const timeoutId = dismissConfirm.get(cartId)
  if (timeoutId) clearTimeout(timeoutId)
  dismissConfirm.delete(cartId)
}

function handleDismissClick(cartId) {
  if (dismissConfirm.has(cartId)) {
    clearDismissConfirm(cartId)
    dismissCart(cartId)
    return
  }
  // 다른 카드에 걸려 있던 확인 상태는 취소한다 — 화면에 "정말?"이 여러 개 떠 있으면 헷갈린다.
  Array.from(dismissConfirm.keys()).forEach(clearDismissConfirm)
  dismissConfirm.set(cartId, setTimeout(() => {
    dismissConfirm.delete(cartId)
    renderErpCarts(lastCarts)
  }, 3000))
  renderErpCarts(lastCarts)
}

async function dismissCart(cartId) {
  const cart = lastCarts.find((c) => c.id === cartId)
  inFlight.add(cartId)
  try {
    const { ok } = await reportConsume(cartId, { result: 'dismissed', errorMessage: '매장에서 지움' })
    if (!ok) return // reportConsume이 이미 안내했다. 카드는 그대로 둬서 다시 시도할 수 있게 한다.
    removeCartFromView(cartId)
    deps.notify('success', `전산 주문을 지웠습니다${cart ? ` (${cart.referenceId})` : ''}. 전산에는 "매장에서 지움"으로 남습니다.`)
  } finally {
    inFlight.delete(cartId)
    renderErpCarts(lastCarts)
  }
}

function handleListClick(e) {
  const dismissBtn = e.target.closest('button.erp-cart-dismiss')
  if (dismissBtn && !dismissBtn.disabled) {
    const id = dismissBtn.dataset.cartId
    if (!inFlight.has(id) && !consumed.has(id)) handleDismissClick(id)
    return
  }

  const btn = e.target.closest('button.erp-cart-button')
  if (!btn || btn.disabled) return
  const cartId = btn.dataset.cartId
  // disabled 검사만으로는 부족하다 — 버튼이 다시 그려졌거나 더블탭으로 두 이벤트가 거의 동시에
  // 들어오면 둘 다 통과할 수 있다. 진행 중 여부는 DOM이 아니라 inFlight로 판정한다.
  if (inFlight.has(cartId) || consumed.has(cartId)) return
  const cart = lastCarts.find((c) => c.id === cartId)
  if (!cart) return
  // 담기 도중 어떤 예외가 나든 화면까지 죽이지 않는다. 여기서 새면 처리되지 않은 거부가 되어
  // 원인을 알 수 없는 상태로 남는다.
  loadCartToPos(cart).catch((e) => {
    deps.notify('error', `처리 중 오류가 발생했습니다: ${e?.message || e}`)
  })
}

// ── 결제 완료 감지 ──────────────────────────────────────────────────────────
// POS에서 결제가 끝나면 posPluginSdk.payment.on('paid')가 불린다. 그때 "방금 담았던 전산 주문"이
// 무엇이었는지 알아야 서버에 결제됐다고 알릴 수 있다.
//
// 담기와 결제 사이에 시간이 뜬다(직원이 카드를 받으러 가는 등). 그 사이 탭앱이 다시 로드될 수도
// 있어서 메모리에만 두면 잃는다 — localStorage에 남긴다. 결제가 끝나면 지운다.
//
// 여러 건을 연달아 담고 한 번에 결제할 수도 있으므로 배열로 들고 있다가 전부 보고한다.
const PENDING_PAID_KEY = 'chevrolet_erp_pending_paid'

// 결제 대기 기록의 유효 시간. 결제 화면으로 넘어가면서 탭앱이 다시 로드되면 'paid' 이벤트를
// 놓치는데, 그때 이 기록이 지워지지 않고 남는다. 유효 시간이 없으면 그 찌꺼기가 계속 쌓였다가
// 한참 뒤 엉뚱한 결제가 일어났을 때 옛날 건까지 몽땅 "결제완료"로 보고돼버린다.
const PENDING_PAID_TTL_MS = 10 * 60 * 1000

function loadPendingPaid() {
  try {
    const raw = localStorage.getItem(PENDING_PAID_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed
      // 예전 버전은 문자열 배열로 저장했다. 시각을 모르니 만료된 것으로 본다 — 남겨두면
      // 위에 적은 오보고 위험이 그대로다.
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
      .filter((entry) => now - Number(entry.at || 0) < PENDING_PAID_TTL_MS)
  } catch {
    return []
  }
}

function savePendingPaid(ids) {
  try {
    if (ids.length) localStorage.setItem(PENDING_PAID_KEY, JSON.stringify(ids))
    else localStorage.removeItem(PENDING_PAID_KEY)
  } catch {
    // 저장이 막힌 환경이면 결제 통보만 못 하고 나머지는 정상 동작한다(전산에는 loaded로 남는다).
  }
}

function rememberLoadedCart(cartId) {
  const entries = loadPendingPaid()
  if (entries.some((e) => e.id === cartId)) return
  savePendingPaid([...entries, { id: cartId, at: Date.now() }])
}

// 결제를 시작하지도 못한 채 끝난 주문(다른 단말기가 이미 처리/거부한 경우)의 대기 기록을
// 지운다. 남겨두면 이 단말기에서 나중에 벌어지는 아무 결제에나 이 주문이 딸려가서
// "결제완료"로 잘못 보고된다 — 실제로는 여기서 결제한 적이 없는데도.
function forgetPendingPaid(cartId) {
  savePendingPaid(loadPendingPaid().filter((e) => e.id !== cartId))
}

// 결제 완료 통보. reportConsume과 같은 수준(2회 재시도, 4xx는 재시도 안 함, 401 처리,
// 네트워크 예외를 값으로 변환)으로 맞춘다 — 담기(consume)만 재시도하고 이쪽은 안 하면,
// 결제는 끝났는데 전산만 모르는 상태가 조용히 남는다. 여러 건을 한 번에 보고할 수 있어
// (initPaymentWatch가 Promise.all로 묶는다) 실패를 여기서 개별 notify하지 않고 결과값만
// 돌려준다 — 그래야 호출부가 여러 건의 실패를 한 번의 안내로 모을 수 있다.
async function reportPaid(cartId, paymentId, orderId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let ok, status, body
    try {
      ;({ ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/paid`, { paymentId, orderId }))
    } catch {
      continue
    }
    if (ok) return { ok, status, body }
    if (status === 401) {
      deps.onUnauthorized(body.error)
      return { ok, status, body }
    }
    // 4xx는 재시도해도 같은 답이 온다. 5xx/네트워크 오류만 한 번 더 시도한다.
    if (status && status < 500) return { ok, status, body }
  }
  return { ok: false }
}

// 통보에 실패해 남아 있는 결제 건을 다시 보낸다. 폴링(applyErpCarts)이 부르므로 5~15초마다
// 기회가 온다.
//
// 'paid' 이벤트가 날 때만 재시도하면, 한산한 매장에서는 10분 유효시간 안에 다음 결제가 없어서
// 그대로 만료된다 - 직원에게 "다시 시도합니다"라고 안내해놓고 실제로는 안 하는 것이다.
// 여기서 재시도해야 그 안내가 사실이 된다.
//
// 대상은 paymentId가 이미 붙은 항목뿐이다. 그게 없는 항목은 아직 결제가 끝나지 않은 건이라
// 보고할 것 자체가 없다.
let retryingPaid = false

async function retryPendingPaid() {
  if (retryingPaid) return
  const pending = loadPendingPaid().filter((e) => e.paymentId)
  if (!pending.length) return

  retryingPaid = true
  try {
    const results = await Promise.all(
      pending.map((e) => reportPaid(e.id, e.paymentId, e.orderId).then((r) => ({ id: e.id, ok: r.ok })))
    )
    const done = new Set(results.filter((r) => r.ok).map((r) => r.id))
    if (!done.size) return
    // 기다리는 동안 새 항목이 생겼을 수 있으니 지금 시점 기록을 다시 읽는다.
    savePendingPaid(loadPendingPaid().filter((e) => !done.has(e.id)))
    deps.notify('success', `결제 완료를 전산에 알렸습니다 (${done.size}건).`)
  } catch {
    // 재시도는 실패해도 조용히 넘어간다 - 폴링마다 오류를 띄우면 화면이 안내로 뒤덮인다.
    // 유효시간이 지나면 어차피 만료되고, 그 전에 직원은 이미 한 번 안내를 받았다.
  } finally {
    retryingPaid = false
  }
}

function initPaymentWatch() {
  try {
    posPluginSdk.payment.on('paid', (paymentId, orderId) => {
      const entries = loadPendingPaid()
      if (!entries.length) return
      // 이번 결제로 막 담긴 항목(paymentId가 아직 없다)은 방금 받은 paymentId/orderId를 쓴다.
      // 예전에 통보가 실패해 남아 있던 항목(paymentId가 이미 있다)은 그때 확정된 자기 값을
      // 그대로 다시 써야 한다 — 지금 결제와는 다른 건이라, 새 값을 붙이면 전산에 엉뚱한
      // 결제 건으로 기록된다.
      const tasks = entries.map((e) => {
        const usePaymentId = e.paymentId || paymentId
        const useOrderId = e.orderId || orderId
        return reportPaid(e.id, usePaymentId, useOrderId).then((r) => ({ entry: e, paymentId: usePaymentId, orderId: useOrderId, ...r }))
      })
      Promise.all(tasks)
        .then((results) => {
          const succeededIds = new Set(results.filter((r) => r.ok).map((r) => r.entry.id))
          const failed = results.filter((r) => !r.ok)
          // 대기하는 동안 새로 담긴 항목이 있을 수 있으니 지금 시점 기록을 다시 읽는다.
          // 성공한 것은 지우고, 실패한 것은 이번에 확정된 paymentId/orderId를 붙여 남긴다 —
          // 그래야 다음 결제 때 같은 건을 같은 결제 참조로 다시 보고할 수 있다. 기록에는
          // 10분 유효시간(PENDING_PAID_TTL_MS)이 있어 계속 실패해도 무한히 쌓이지는 않는다.
          const failedById = new Map(failed.map((r) => [r.entry.id, r]))
          const current = loadPendingPaid()
          const remaining = current
            .filter((e) => !succeededIds.has(e.id))
            .map((e) => {
              const f = failedById.get(e.id)
              return f ? { id: e.id, at: e.at, paymentId: f.paymentId, orderId: f.orderId } : e
            })
          savePendingPaid(remaining)
          if (succeededIds.size) deps.notify('success', '결제 완료를 전산에 알렸습니다.')
          if (failed.length) {
            // 결제 자체는 이미 끝났다 — 취소하라는 뜻이 아니라, 전산이 아직 모른다는 뜻이다.
            deps.notify(
              'error',
              `결제는 완료됐지만 전산에는 알리지 못했습니다 (${failed.length}건). 결제를 취소하지 마세요 — ` +
              '잠시 후 자동으로 다시 시도합니다. 계속 실패하면 [주문] 탭 내역과 대조해 전산에 직접 확인해주세요.'
            )
          }
        })
        .catch(() => {})
    })
  } catch (e) {
    // SDK 버전에 따라 이 이벤트가 없을 수 있다. 없으면 결제 통보만 빠지고 나머지는 그대로 돈다.
    console.error('[erp-cart] 결제 이벤트를 구독하지 못했습니다.', e?.message)
  }
}

// consume이 서버에 닿지 못하면 그 장바구니는 계속 pending으로 남아, 다음 폴링이나 단말기 재시작
// 뒤에 같은 카드가 되살아난다 — 이미 POS에 담아둔 걸 또 담게 되는 경로다. 일시적 네트워크
// 오류가 흔한 매장 환경이라 한 번은 재시도하고, 그래도 실패하면 조용히 넘기지 않고 직원에게
// 알린다(자동으로 더 손쓸 방법이 없으므로 사람이 알아야 한다).
async function reportConsume(cartId, resultBody) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // apiPost 안의 fetch는 네트워크가 끊기면 거부한다. 여기서 던지면 호출부의 catch를 타고
    // 되돌리기·안내가 꼬이므로, 통신 실패도 "보고 실패"라는 값으로 바꿔서 돌려준다.
    let ok, status, body
    try {
      ;({ ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/consume`, resultBody))
    } catch {
      continue
    }
    if (ok) return { ok, status, body }
    if (status === 401) {
      deps.onUnauthorized(body.error)
      return { ok, status, body }
    }
    // 4xx는 재시도해도 같은 답이 온다(잘못된 id 등). 5xx/네트워크 오류만 한 번 더 시도한다.
    if (status && status < 500) return { ok, status, body }
  }
  deps.notify('error', '처리 결과를 서버에 알리지 못했습니다. 같은 주문이 다시 뜨면 이미 담긴 것인지 [주문] 탭에서 확인해주세요.')
  return { ok: false }
}

// [POS에 담기] 버튼을 눌렀을 때의 전체 흐름. 실패 시 되돌리기(⑦)가 핵심이라 순서가 중요하다:
// 1) 담기 전 상태를 기억 → 2) 순차로 addLineItem → 3) (autoPay) 결제 시작 → 4) 서버에 결과 보고
// → 5) 실패하면 방금 추가한 항목만 지운다. draftOrder.clear()는 직원이 이미 담아둔 것까지
// 날려버리므로 절대 쓰지 않는다.
async function loadCartToPos(cart) {
  // 담는 동안에는 폴링이 화면을 다시 그리지 못하게 막는다. 어떤 경로로 끝나든(성공/실패/예외)
  // 반드시 풀어야 해서 finally로 감싼다 — 여기서 새면 전산 주문 목록이 영영 갱신되지 않는다.
  inFlight.add(cart.id)
  try {
    await runLoadCartToPos(cart)
  } finally {
    inFlight.delete(cart.id)
    // 담는 동안 폴링이 가져온 최신 목록(lastCarts)을 이제 화면에 반영한다.
    renderErpCarts(lastCarts)
  }
}

async function runLoadCartToPos(cart) {
  const button = findButton(cart.id)
  if (button) {
    button.disabled = true
    button.textContent = '담는 중...'
  }

  // 되돌릴 대상은 우리가 만든 key다. 예전에는 담기 전후 key를 비교해 새로 생긴 것을 찾았는데,
  // 포스는 key를 자동으로 만들어주지 않아(lineItem.js (1) 참고) 그 비교로는 아무것도 못 찾았다.
  // 지금은 buildLineItem이 key를 직접 발급하므로 그 값을 그대로 들고 있으면 된다 — 담기 전
  // 장바구니를 조회할 이유도 없어졌다.
  const addedKeys = []
  try {
    const base = await getBaseCatalogItem()
    if (!base) throw new Error('POS 카탈로그에 등록된 상품이 없습니다. POS에서 상품을 하나 이상 등록해주세요.')

    // POS 장바구니는 순서가 있는 상태라 동시에 여러 addLineItem을 던졌을 때 어떤 순서로
    // 반영되는지 보장이 없다. 그래서 Promise.all이 아니라 for...of + await로 하나씩 순차 처리한다.
    const total = (cart.items || []).length
    let done = 0
    for (const item of cart.items || []) {
      // 품목이 많으면(부품 열 개 넘는 경우가 있다) 순차 담기만으로도 몇 초가 걸린다.
      // 몇 개 중 몇 개인지 보여야 직원이 멈춘 줄 알고 다시 누르지 않는다.
      if (button) button.textContent = `담는 중... ${done}/${total}`
      const lineItem = buildLineItem({
        baseItem: base,
        title: item.name,
        priceValue: item.unitPrice,
        quantity: item.quantity,
        memo: cart.memo,
      })
      // addLineItem이 던지면 이 항목은 안 담긴 것이므로, 성공한 뒤에 되돌리기 목록에 넣는다.
      await draftOrder.addLineItem(lineItem)
      addedKeys.push(lineItem.key)
      done += 1
    }
    if (button) button.textContent = '서버에 알리는 중...'

    // ── 여기가 분기점이다 ──
    // 품목은 이미 POS 장바구니에 전부 들어갔다. 전산 입장에서 "옮기기"는 이 시점에 끝났다.
    //
    // startPayment()는 POS를 결제 화면으로 넘긴다. 그 순간 이 탭앱(iframe)은 가려지거나 통째로
    // 다시 로드된다 — 실제로 "담고 결제 시작을 누르면 화면이 하얘진다"는 신고가 있었다.
    // 그러면 startPayment() 뒤에 있는 코드는 영영 실행되지 않는다. 서버 보고도, 결제 감시
    // 등록(rememberLoadedCart)도 같이 날아간다. "결제는 됐는데 전산 주문에 그대로 남아 있다"가
    // 정확히 이 증상이다.
    //
    // 그래서 결제를 시작하기 **전에** 보고하고 기억해 둔다. 순서를 뒤집는 것만으로 그 뒤에
    // 화면이 죽든 말든 상태는 남는다.
    rememberLoadedCart(cart.id)
    const reported = await reportConsume(cart.id, { result: 'loaded' })

    if (!reported.ok) {
      // 아직 결제는 시작하지 않았다. 서버가 어떤 상태인지 모르는 채로 결제까지 자동으로
      // 밀어붙이면, 나중에 이 카드가 되살아났을 때 결제된 건인지 아닌지 아무도 모른다.
      // 담긴 것은 사실이므로 카드는 남겨두고, 결제는 직원이 직접 누르게 한다.
      deps.notify(
        'error',
        '담기는 됐지만 서버에 알리지 못했습니다. [주문] 탭에 품목이 들어가 있으니 거기서 결제해주세요. ' +
        '이 주문은 목록에 남습니다 — 다시 누르지 마시고, 결제 후 [지우기]로 정리해주세요.'
      )
      return
    }

    // ── 단말기가 2대 이상일 때의 분기 ──
    // consume은 원자적 updateMany라 딱 한 단말기만 인정된다. 진 쪽에도 ok:true가 오지만
    // body.alreadyProcessed가 true로 붙는다 — 이걸 안 보면 이 단말기도 그대로 결제까지
    // 밀어붙여서 같은 주문이 두 번 결제된다(치명적). 방금 이 화면에서 담은 품목은 이 주문
    // 몫이 아니게 됐으니 결제를 시작하면 안 되고, 방금 담아버린 것만 되돌린다
    // (handleLoadFailure와 같은 방식 — addedKeys만 지운다, 원래 있던 항목은 그대로 둔다).
    if (reported.body && reported.body.alreadyProcessed) {
      for (const key of addedKeys) {
        try {
          await draftOrder.deleteLineItem(key)
        } catch {
          console.error('[erp-cart] 되돌리기 실패 — POS 장바구니를 직접 확인해주세요.', key)
        }
      }
      // 이 단말기에서는 결제를 시작하지 않으므로 결제 대기 기록도 지운다 — 남겨두면 나중에
      // 이 단말기에서 벌어지는 다른 결제에 이 주문이 딸려가 "결제완료"로 잘못 보고된다.
      forgetPendingPaid(cart.id)
      removeCartFromView(cart.id)
      if (reported.body.status === 'dismissed') {
        // status가 dismissed라는 건 다른 단말기가 이 주문을 "지우기"로 거부했다는 뜻이다.
        // 거부된 주문을 결제하면 전산과 어긋난다 — 별도 문구로 확실히 구분해서 안내한다.
        deps.notify(
          'error',
          `다른 단말기에서 이미 거부한 주문입니다 (${cart.referenceId || cart.id}). ` +
          '방금 담은 품목은 되돌렸습니다. 이 주문은 결제하지 말고 전산에서 다시 확인해주세요.'
        )
      } else {
        deps.notify(
          'error',
          `다른 단말기에서 이미 처리한 주문입니다 (${cart.referenceId || cart.id}). ` +
          '방금 담은 품목은 되돌렸습니다. 이 주문은 결제하지 마세요 — 이미 다른 단말기에서 처리됐습니다.'
        )
      }
      return
    }

    if (!cart.autoPay) {
      removeCartFromView(cart.id)
      deps.notify('success', 'POS 장바구니에 담았습니다.')
      return
    }

    // 이 아래 startPayment()는 POS가 결제 화면을 여는 동안 붙잡고 있어서 눈에 띄게 느리다.
    // 그 시간 동안 카드를 미리 지워버리면 화면에 아무 표시도 없는 빈 구간이 생겨서 멈춘 것처럼
    // 보인다. 버튼이 계속 무슨 일이 일어나는지 말하게 두고, 카드는 결제 화면이 열린 뒤에 지운다.
    //
    // 늦게 지워도 되살아나지 않는다 — 서버에는 이미 loaded로 보고돼서 다음 폴링에 안 실린다.
    if (button) button.textContent = '결제 화면 여는 중...'
    try {
      await draftOrder.startPayment()
      removeCartFromView(cart.id)
      deps.notify('success', '담고 결제를 시작했습니다.')
    } catch (payError) {
      // 담기와 보고는 이미 끝난 뒤다. 되돌릴 것은 없고, 직접 결제하라고 알리기만 하면 된다.
      removeCartFromView(cart.id)
      deps.notify('error', `결제 화면을 열지 못했습니다. [주문] 탭에서 직접 결제해주세요. (${payError.message || payError})`)
    }
  } catch (e) {
    await handleLoadFailure(cart, e, addedKeys)
  }
}

async function handleLoadFailure(cart, error, addedKeys) {
  // 절반만 담긴 장바구니가 남으면 직원이 잘못된 금액으로 결제할 수 있다 — 방금 우리가
  // 추가한 항목만 골라 지운다(원래 있던 항목은 절대 건드리지 않는다).
  for (const key of addedKeys) {
    try {
      await draftOrder.deleteLineItem(key)
    } catch {
      // 되돌리기 자체가 실패하면 POS 장바구니에 우리가 담다 만 항목이 남을 수 있다. 이 경우는
      // 자동으로 더 손쓸 방법이 없어 로그만 남기고, 직원이 [주문] 탭에서 직접 확인하게 한다.
      console.error('[erp-cart] 되돌리기 실패 — POS 장바구니를 직접 확인해주세요.', key)
    }
  }
  const reported = await reportConsume(cart.id, { result: 'failed', errorMessage: error?.message || String(error) })
  if (!reported.ok) {
    // 보고가 닿지 않았으면 서버는 여전히 pending이다. 카드를 지우면 되살아나서 직원이
    // 혼란스러우므로 그대로 두고, 되돌리기는 이미 했으니 다시 눌러도 안전하다.
    deps.notify('error', `POS에 담지 못했습니다: ${error?.message || error}`)
    return
  }
  // 실패를 보고한 순간 서버에서 이 장바구니는 failed로 끝난 상태다. 그런데도 카드를 남겨두고
  // 버튼을 되살리면, 직원이 다시 눌렀을 때 POS에는 품목이 또 담기지만 서버는 이미 종료된 건이라
  // alreadyProcessed로 흘려버린다 — 전산에는 계속 "실패"로 보이는데 실제로는 결제가 일어나는
  // 상태 불일치가 생긴다. 돈이 오가는 경로라 그 어긋남을 허용하지 않고, 카드를 치운 뒤 전산에서
  // 다시 보내게 안내한다.
  removeCartFromView(cart.id)
  deps.notify('error', `POS에 담지 못했습니다. 전산에서 다시 보내주세요. (${error?.message || error})`)
}

// 처리를 마친 cart는 consumed에 남겨 뒤늦게 도착한 폴링 응답이 되살리지 못하게 한다.
// (뒤이어 finally의 renderErpCarts가 실제 DOM을 갱신한다 — 여기서 그리면 inFlight가 아직 서 있어
//  어차피 무시되므로 목록만 손본다.)
function removeCartFromView(cartId) {
  consumed.add(cartId)
  renderErpCarts(lastCarts.filter((c) => c.id !== cartId))
}
