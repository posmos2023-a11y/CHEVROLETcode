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
  if (!listEl) return
  listEl.addEventListener('click', handleListClick)
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
          <strong class="erp-cart-memo">${deps.escapeHtml(cart.memo || '-')}</strong>
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
  renderErpCarts(Array.isArray(carts) ? carts : [])
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
    renderErpCarts(body.carts || [])
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
  loadCartToPos(cart)
}

// consume이 서버에 닿지 못하면 그 장바구니는 계속 pending으로 남아, 다음 폴링이나 단말기 재시작
// 뒤에 같은 카드가 되살아난다 — 이미 POS에 담아둔 걸 또 담게 되는 경로다. 일시적 네트워크
// 오류가 흔한 매장 환경이라 한 번은 재시도하고, 그래도 실패하면 조용히 넘기지 않고 직원에게
// 알린다(자동으로 더 손쓸 방법이 없으므로 사람이 알아야 한다).
async function reportConsume(cartId, resultBody) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/consume`, resultBody)
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
    for (const item of cart.items || []) {
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
    }

    let payError = null
    if (cart.autoPay) {
      try {
        await draftOrder.startPayment()
      } catch (e) {
        payError = e
      }
    }

    if (payError) {
      // 판단 지점: 품목은 이미 전부 정확히 담겼다(절반만 담긴 상태가 아니다) — 여기서 되돌리면
      // 방금 정상적으로 담은 항목까지 지워버리는 것이라 오히려 손해다. 그래서 결제 자동 시작
      // 실패는 "담기 자체는 성공"으로 서버에 보고하고, 직원에게는 결제를 직접 눌러야 한다고
      // 안내한다. 서버 계약상 result는 loaded/failed 둘뿐이라 "부분 성공"을 표현할 방법이
      // 없다는 한계는 있다.
      await reportConsume(cart.id, { result: 'loaded' })
      removeCartFromView(cart.id)
      deps.notify('error', `담기는 완료됐지만 결제 화면 자동 실행에 실패했습니다. 직접 결제를 눌러주세요. (${payError.message || payError})`)
      return
    }

    await reportConsume(cart.id, { result: 'loaded' })
    // 성공하면 다음 폴링(5초)을 기다리지 않고 즉시 화면에서 지운다 — 그 사이 직원이 같은
    // 카드를 다시 눌러 중복으로 담는 것을 막기 위해서다.
    removeCartFromView(cart.id)
    deps.notify('success', cart.autoPay ? '담고 결제를 시작했습니다.' : 'POS 장바구니에 담았습니다.')
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
  await reportConsume(cart.id, { result: 'failed', errorMessage: error?.message || String(error) })
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
