// 쉐보레 전산(ERP)이 GET /api/erp/carts로 올려둔 "결제 전 장바구니"를 POS 장바구니로 옮기는 화면.
// app.js와 분리한 이유는 단순히 코드 줄 수 때문이다 — 대기열 폴링/토큰 화면 로직과는 관심사가
// 달라서 굳이 한 파일에 욱여넣지 않았다. 초기화는 app.js가 initErpCarts() 한 번만 부르고,
// 실제 조회는 기존 대기열 폴링 타이머 안에서 refreshErpCarts()를 통해 함께 실행된다(타이머를
// 두 개 만들면 정지/재개 로직이 갈라지므로 절대 새 타이머를 만들지 않는다).
import { posPluginSdk } from '@tossplace/pos-plugin-sdk'
// lineItem을 만드는 규칙은 실단말기에서 알아낸 것이라 한 곳에만 둔다(lineItem.js 상단 주석).
import { buildLineItem, makeLineItemKey } from './lineItem.js'

const draftOrder = posPluginSdk.draftOrder

const listEl = document.getElementById('erp-cart-list')

// app.js가 가진 apiGet/apiPost(X-Store-Token 포함), notify(토스트), escapeHtml, 401 처리 콜백을
// 주입받는다. 이 모듈이 직접 fetch를 새로 만들면 토큰 헤더·API_BASE 처리 로직이 두 곳에 생겨
// 나중에 한쪽만 고쳐질 위험이 있다 — 기존 헬퍼를 그대로 재사용한다.
let deps = null

export function initErpCarts(injected) {
  deps = injected
  initPaymentWatch()
  initDraftWatch()

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

  if (frontListEl) frontListEl.addEventListener('click', handleFrontListClick)
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

// ⚠️ 폴링과 담기가 겹칠 때의 사고를 막는 방어막들이다.
//
// inFlight: 담는 중인 cart. addLineItem을 품목 수만큼 순차로 기다리는 동안 5초 폴링이 끼어들어 카드를
//   다시 그리면 (1) "담는 중..."인 비활성 버튼이 새 버튼으로 되살아나고 (2) 서버는 아직 pending이라 그
//   카드도 그대로 돌아온다. 직원이 한 번 더 누르면 같은 품목이 두 번 담기고, autoPay면 결제까지 두 번
//   뜬다. 그래서 inFlight인 카드의 article 노드는 다시 만들지 않고 그대로 보존한다.
//   예전에는 안전하게 가려고 목록 전체의 렌더링을 막았다. 그랬더니 한 건을 담는 동안 (1) 다른 카드의
//   "정말 지울까요?" 확인이 화면에 안 나타나 눌러도 반응이 없는 것처럼 보였고 (2) 그 사이 들어온 새 전산
//   주문도 안 떴다. 지금은 처리 중인 한 건만 보존하고 나머지는 그린다. 그 대신 처리 중에 다른 카드를
//   새로 담기·넘기기·지우기 시작하는 것은 막는다(cardActionBlocked).
//
// consumed: 이미 처리를 마친 cart → 처리한 시각. consume 직전에 출발한 폴링 요청의 응답이 뒤늦게 도착하면
//   서버는 그때까지 pending으로 알고 있었으므로 그 카드를 되살려버린다. 그런 응답은 길어야 GET 타임아웃
//   (8초) 안에 도착하므로 60초만 기억한다. 예전에는 영구 Set이었는데, 전산이 주문을 취소했다가 같은
//   referenceId로 다시 보내 같은 주문이 pending으로 돌아와도 화면이 영영 걸러내서 새 주문이 안 보였다.
const inFlight = new Set()
const CONSUMED_TTL_MS = 60 * 1000
const consumed = new Map()

function isConsumed(cartId) {
  const at = consumed.get(cartId)
  if (at === undefined) return false
  if (Date.now() - at > CONSUMED_TTL_MS) {
    consumed.delete(cartId)
    return false
  }
  return true
}

// erpGeneration: 상태를 바꾸는 요청(담기 보고·지우기·프론트로 넘기기·되돌리기·결제 중 풀기·담김 취소)이
//   성공할 때마다 올린다. 폴링은 출발할 때의 세대를 들고 있다가(app.js loadQueue, 아래 refreshErpCarts),
//   응답이 왔을 때 세대가 달라졌으면 전산 주문·프론트 결제 목록을 반영하지 않는다. 그 응답은 요청이 서버에서
//   처리되기 전에 만들어진 옛 상태라서, 반영하면 방금 되돌린 카드가 다시 사라지거나 방금 넘긴 카드가
//   되살아난다. 버린 응답 몫은 다음 폴링이 채운다.
let erpGeneration = 0

export function getErpGeneration() {
  return erpGeneration
}

// 상태를 바꾸는 요청이 서버에서 성공한 직후에 부른다. 세대를 올리고, 직원이 방금 뭔가 했다는 뜻이므로
// 폴링을 다시 빠르게 되돌린다(app.js noteActivity).
function afterMutation() {
  erpGeneration += 1
  try {
    if (deps && typeof deps.noteActivity === 'function') deps.noteActivity()
  } catch {
    // 폴링 간격 조정이 실패해도 요청 결과 처리는 이어져야 한다.
  }
}

// sentToFront: 방금 [프론트 결제]로 넘긴 cart → 넘긴 시각. 넘기기 직전에 출발한 폴링 응답이 그 카드를
//   POS 목록에 되살리면 직원이 [담기]를 눌러 프론트와 양쪽에서 결제될 수 있다(서버도 막지만 화면에서
//   먼저 막는다). consumed와 달리 영구가 아니다 -- [POS로 되돌리기]를 하면 다시 POS 목록에 나와야 한다.
const sentToFront = new Map()

function formatWon(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`
}

// 품목을 한 줄씩(이름 ×수량 ……… 금액) 보여준다. 직원이 담거나 프론트로 넘기기 전에 무엇을
// 얼마에 결제하는지 확인할 수 있어야 한다 -- 예전에는 "엔진오일 ×1 외 3건"으로만 보여서 무엇이
// 들어 있는지 [주문] 탭에 담아보기 전에는 알 수 없었다. 품목이 아주 많으면 카드가 화면을
// 다 차지하므로 앞의 몇 줄만 보이고 나머지는 건수로 줄인다.
const MAX_ITEM_LINES = 8

function renderItemList(items) {
  if (!items || items.length === 0) return '<div class="erp-cart-summary">품목 없음</div>'
  const shown = items.slice(0, MAX_ITEM_LINES)
  const hidden = items.slice(MAX_ITEM_LINES)
  const hiddenAmount = hidden.reduce((sum, i) => sum + (Number(i.unitPrice) || 0) * (Number(i.quantity) || 0), 0)
  return `
    <ul class="erp-cart-items">
      ${shown.map((i) => `
        <li>
          <span class="erp-item-name">${deps.escapeHtml(i.name)}</span>
          <span class="erp-item-qty">×${Number(i.quantity) || 0}</span>
          <span class="erp-item-amount">${formatWon((Number(i.unitPrice) || 0) * (Number(i.quantity) || 0))}</span>
        </li>`).join('')}
      ${hidden.length ? `
        <li class="erp-item-more">
          <span class="erp-item-name">외 ${hidden.length}건</span>
          <span class="erp-item-qty"></span>
          <span class="erp-item-amount">${formatWon(hiddenAmount)}</span>
        </li>` : ''}
    </ul>
  `
}

function cartHtml(cart) {
  const buttonLabel = cart.autoPay ? '담고 결제 시작' : 'POS에 담기'
  const dismissing = dismissConfirm.has(cart.id)
  const sendingToFront = frontConfirm.has(cart.id)
  return `
    <article class="erp-cart-item" data-cart-id="${deps.escapeHtml(cart.id)}">
      <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')}</div>
      <div class="erp-cart-head">
        <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
        ${cart.linkedReservation ? '<span class="erp-cart-linked">예약 연결됨</span>' : ''}
      </div>
      ${cart.carNumber && cart.memo ? `<div class="erp-cart-memo">${deps.escapeHtml(cart.memo)}</div>` : ''}
      ${renderItemList(cart.items)}
      <div class="erp-cart-total">${formatWon(cart.totalAmount)}</div>
      <div class="erp-cart-actions">
        <button class="erp-cart-button" type="button" data-cart-id="${deps.escapeHtml(cart.id)}">${buttonLabel}</button>
        <button class="erp-cart-front${sendingToFront ? ' confirming' : ''}" type="button"
                data-cart-id="${deps.escapeHtml(cart.id)}">${sendingToFront ? '프론트로 넘길까요?' : '프론트 결제'}</button>
        <button class="erp-cart-dismiss${dismissing ? ' confirming' : ''}" type="button"
                data-cart-id="${deps.escapeHtml(cart.id)}">${dismissing ? '정말 지울까요?' : '지우기'}</button>
      </div>
    </article>
  `
}

// 목록을 문자열로 한 번에 갈아끼우지 않고 카드 노드 단위로 다루는 이유는 담는 중인 카드의 노드만
// 그대로 두기 위해서다(inFlight 주석 참고).
function buildCartNode(cart) {
  const holder = document.createElement('div')
  holder.innerHTML = cartHtml(cart).trim()
  return holder.firstElementChild
}

function findCartNode(cartId) {
  if (!listEl) return null
  return Array.from(listEl.children).find((node) => node.dataset && node.dataset.cartId === cartId) || null
}

function renderErpCarts(incoming) {
  // 이미 처리한 건은 폴링 응답에 남아 있더라도 화면에 다시 세우지 않는다(consumed 주석 참고).
  const carts = incoming.filter((c) => !isConsumed(c.id) && !sentToFront.has(c.id))
  lastCarts = carts
  if (!listEl) return

  // 담는 중인 카드는 지금 화면에 있는 노드를 그대로 쓴다. 버튼의 "담는 중... 2/5" 같은 글자와 비활성
  // 상태가 노드에 들어 있고, runLoadCartToPos가 그 노드를 손에 쥐고 계속 글자를 바꾸기 때문이다.
  const kept = new Map()
  for (const id of inFlight) {
    const node = findCartNode(id)
    if (node) kept.set(id, node)
  }
  const nodes = carts.map((cart) => {
    const node = kept.get(cart.id)
    if (!node) return buildCartNode(cart)
    kept.delete(cart.id)
    return node
  })
  // 서버 목록에는 이미 없어도(방금 loaded로 보고했다) 처리가 끝나기 전에 카드를 치우면 결제 화면이
  // 열리는 몇 초 동안 화면에 아무 표시도 없는 빈 구간이 생긴다(loadCartToPos의 startPayment 주석 참고).
  nodes.push(...kept.values())

  if (!nodes.length) {
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
  const fragment = document.createDocumentFragment()
  nodes.forEach((node) => fragment.appendChild(node))
  listEl.textContent = ''
  listEl.appendChild(fragment)
}

// 대기열 응답(/api/pos/queue)에 함께 실려 온 전산 주문을 화면에 반영한다.
// 폴링 요청을 매장당 절반으로 줄이려고 서버가 두 결과를 한 응답에 담아주기 때문에, 평소에는
// 이 함수만 쓰인다(아래 refreshErpCarts는 그 필드를 아직 안 주는 서버용 폴백).
export function applyErpCarts(carts) {
  if (!deps) return
  const list = Array.isArray(carts) ? carts : []
  renderErpCarts(list)
  stampUpdated(list.filter((c) => !isConsumed(c.id)).length)
  // 통보가 밀린 결제 건이 있으면 이 기회에 다시 보낸다(retryPendingPaid 주석 참고).
  retryPendingPaid()
}

// 서버가 erpCarts 필드를 아직 안 내려주는 경우(배포 과도기)의 폴백이자, [POS로 되돌리기] 직후처럼
// 다음 폴링을 기다리지 않고 바로 목록을 맞추고 싶을 때 쓰는 새로고침.
//
// 실패했을 때는 아무것도 하지 않는다. 예전에는 renderErpCarts([])로 목록을 비웠는데, 일시적인 네트워크
// 오류·타임아웃·5xx 한 번에 아직 담지 않은 전산 주문 카드가 통째로 사라졌다 -- 직원은 전산이 주문을
// 취소한 줄 안다. 목록을 못 받았으면 마지막으로 받은 목록이 가장 정확한 정보다.
export async function refreshErpCarts() {
  if (!deps) return
  const generation = erpGeneration
  try {
    const { ok, status, body } = await deps.apiGet('/api/pos/erp-carts')
    if (!ok) {
      if (status === 401) {
        // 기존 대기열(loadQueue)과 동일한 401 처리 — 토큰을 지우고 재입력 화면으로 보낸다.
        deps.onUnauthorized(body.error)
      }
      return
    }
    // 이 요청이 가는 사이 상태를 바꾸는 요청이 성공했다면 이 응답은 옛 상태다(erpGeneration 주석 참고).
    if (generation !== erpGeneration) return
    const list = body.carts || []
    renderErpCarts(list)
    stampUpdated(list.filter((c) => !isConsumed(c.id)).length)
  } catch {
    // 위 주석대로 목록은 그대로 둔다. 다음 폴링이 다시 시도한다.
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

// 확인 상태가 바뀔 때는 목록을 다시 그리지 않고 해당 버튼의 class·글자만 바꾼다. 다시 그리면 담는 중인
// 카드 말고는 전부 새 노드로 바뀌어 눌려 있던 버튼의 터치가 끊긴다. 담는 중인 카드는 건드리지 않는다
// (그 카드의 버튼 글자는 담기 흐름이 정한다).
function setConfirmButton(button, active, confirmLabel, idleLabel) {
  if (!button) return
  button.classList.toggle('confirming', active)
  button.textContent = active ? confirmLabel : idleLabel
}

function syncConfirmButtons() {
  if (!listEl) return
  for (const node of Array.from(listEl.children)) {
    const id = node.dataset && node.dataset.cartId
    if (!id || inFlight.has(id)) continue
    setConfirmButton(node.querySelector('button.erp-cart-dismiss'), dismissConfirm.has(id), '정말 지울까요?', '지우기')
    setConfirmButton(node.querySelector('button.erp-cart-front'), frontConfirm.has(id), '프론트로 넘길까요?', '프론트 결제')
  }
}

function clearDismissConfirm(cartId) {
  const timeoutId = dismissConfirm.get(cartId)
  if (timeoutId) clearTimeout(timeoutId)
  dismissConfirm.delete(cartId)
}

function handleDismissClick(cartId) {
  if (dismissConfirm.has(cartId)) {
    clearDismissConfirm(cartId)
    syncConfirmButtons()
    dismissCart(cartId)
    return
  }
  // 다른 카드에 걸려 있던 확인 상태는 취소한다 — 화면에 "정말?"이 여러 개 떠 있으면 헷갈린다.
  Array.from(dismissConfirm.keys()).forEach(clearDismissConfirm)
  dismissConfirm.set(cartId, setTimeout(() => {
    dismissConfirm.delete(cartId)
    syncConfirmButtons()
  }, 3000))
  syncConfirmButtons()
}

async function dismissCart(cartId) {
  const cart = lastCarts.find((c) => c.id === cartId)
  inFlight.add(cartId)
  try {
    const { ok } = await reportConsume(cartId, { result: 'dismissed', errorMessage: '매장에서 지움' })
    if (!ok) return // reportConsume이 이미 안내했다. 카드는 그대로 둬서 다시 시도할 수 있게 한다.
    // 지운 주문에 대기 중인 결제 기록이 남아 있으면 나중에 엉뚱한 결제와 맞아 "결제완료"로 보고될 수 있다.
    forgetPendingPaid(cartId)
    removeCartFromView(cartId)
    deps.notify('success', `전산 주문을 지웠습니다${cart ? ` (${cart.referenceId})` : ''}. 전산에는 "매장에서 지움"으로 남습니다.`)
  } finally {
    inFlight.delete(cartId)
    renderErpCarts(lastCarts)
  }
}

// ── 프론트로 결제 넘기기 ──────────────────────────────────────────────────────
// 토스는 프론트 플러그인과 토스 POS 동시 연결을 지원하지 않는다. 플러그인 모드 프론트는 POS와
// 페어링되지 않으므로, 넘기기는 서버의 주문 상태(payTarget)를 바꾸는 것으로 한다 -- 프론트 플러그인이
// 서버를 폴링하다가 그 주문을 가져가 결제한다(front-plugin/erp-pay.html).
// [지우기]와 같은 2단계 확인(3초 안에 한 번 더)을 쓴다. 잘못 넘겨도 [POS로 되돌리기]로 돌릴 수 있지만,
// 손님이 그 사이 프론트에서 결제를 시작하면 되돌릴 수 없다.
const frontConfirm = new Map()

function clearFrontConfirm(cartId) {
  const timeoutId = frontConfirm.get(cartId)
  if (timeoutId) clearTimeout(timeoutId)
  frontConfirm.delete(cartId)
}

function handleFrontClick(cartId) {
  if (frontConfirm.has(cartId)) {
    clearFrontConfirm(cartId)
    syncConfirmButtons()
    sendCartToFront(cartId)
    return
  }
  Array.from(frontConfirm.keys()).forEach(clearFrontConfirm)
  Array.from(dismissConfirm.keys()).forEach(clearDismissConfirm)
  frontConfirm.set(cartId, setTimeout(() => {
    frontConfirm.delete(cartId)
    syncConfirmButtons()
  }, 3000))
  syncConfirmButtons()
}

async function sendCartToFront(cartId) {
  const cart = lastCarts.find((c) => c.id === cartId)
  inFlight.add(cartId)
  try {
    let ok, status, body
    try {
      ;({ ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/send-to-front`))
    } catch {
      deps.notify('error', '서버에 연결하지 못해 프론트로 넘기지 못했습니다. 잠시 후 다시 시도해주세요.')
      return
    }
    if (!ok) {
      if (status === 401) {
        deps.onUnauthorized(body.error)
        return
      }
      deps.notify('error', body.error || '프론트로 넘기지 못했습니다.')
      return
    }
    afterMutation()
    sentToFront.set(cartId, Date.now())
    lastCarts = lastCarts.filter((c) => c.id !== cartId)
    deps.notify('success', `프론트로 넘겼습니다${cart?.carNumber ? ` (${cart.carNumber})` : ''}. 손님이 프론트에서 결제하면 됩니다.`)
  } finally {
    inFlight.delete(cartId)
    renderErpCarts(lastCarts)
  }
}

// ── 프론트 결제 대기 목록 ─────────────────────────────────────────────────────
// 넘긴 주문이 화면에서 그냥 사라지면 직원은 그 주문이 어디 있는지 모르고 되돌릴 수도 없다.
// 프론트에서 결제 대기(pending)·진행(paying) 중인 주문을 따로 보여주고, 대기 중이면 되돌릴 수 있게 한다.
const frontListEl = document.getElementById('front-cart-list')
const frontSectionEl = document.getElementById('front-cart-section')
const returnConfirm = new Map()
// [지우기] 2단계 확인. 리허설·테스트 주문이 프론트 결제 목록(손님 화면)에 남지 않게 바로 지운다.
const frontDismissConfirm = new Map()
let lastFrontCarts = []

// 손님이 프론트에서 결제 중('paying')인 채로 이 시간이 지나면 [결제 중 풀기]를 보여준다. 손님이 결제
// 화면을 닫고 가버리거나 프론트 단말기가 꺼지면 주문이 영영 'paying'에 갇혀, [POS로 되돌리기]도
// [지우기]도 안 되기 때문이다. 서버도 같은 10분을 기준으로 409를 돌려준다(frontPayingAt 기준).
const FORCE_RELEASE_AFTER_MS = 10 * 60 * 1000
// 풀기는 "토스 결제내역에서 승인 여부를 확인했나요?"를 읽고 실제로 확인할 시간이 필요해서 일반 확인(3초)
// 보다 길게 준다. 풀고 나서 손님 결제가 승인되면 같은 주문이 두 번 결제될 수 있는 동작이다.
const FORCE_RELEASE_CONFIRM_MS = 10 * 1000
const forceReleaseConfirm = new Map()
const forceReleaseBusy = new Set()

// 프론트 결제가 시작된 뒤 흐른 시간(ms). 서버가 frontPayingAt을 안 주는 옛 서버면 null.
function payingElapsedMs(cart) {
  const at = cart.frontPayingAt ? Date.parse(cart.frontPayingAt) : NaN
  if (!Number.isFinite(at)) return null
  return Math.max(0, Date.now() - at)
}

// 넘긴 직후에는 서버의 frontCarts에 아직 안 실린 응답이 올 수 있어 잠깐은 기억해 둔다.
const SENT_TO_FRONT_GRACE_MS = 15 * 1000

function renderFrontCarts() {
  if (!frontListEl) return
  if (frontSectionEl) frontSectionEl.hidden = lastFrontCarts.length === 0
  frontListEl.innerHTML = lastFrontCarts
    .map((cart) => {
      const paying = cart.status === 'paying'
      const confirming = returnConfirm.has(cart.id)
      const dismissing = frontDismissConfirm.has(cart.id)
      const elapsed = paying ? payingElapsedMs(cart) : null
      const overdue = elapsed !== null && elapsed > FORCE_RELEASE_AFTER_MS
      const releasing = forceReleaseConfirm.has(cart.id)
      const statusText = !paying
        ? '프론트 결제 대기'
        : elapsed === null ? '손님 결제 중' : `손님 결제 중 · ${Math.max(1, Math.floor(elapsed / 60000))}분째`
      let actions = ''
      if (!paying) {
        actions = `
          <div class="erp-cart-actions">
            <button class="erp-cart-return${confirming ? ' confirming' : ''}" type="button"
                    data-cart-id="${deps.escapeHtml(cart.id)}">${confirming ? '정말 되돌릴까요?' : 'POS로 되돌리기'}</button>
            <button class="erp-cart-dismiss erp-cart-front-dismiss${dismissing ? ' confirming' : ''}" type="button"
                    data-cart-id="${deps.escapeHtml(cart.id)}">${dismissing ? '정말 지울까요?' : '지우기'}</button>
          </div>`
      } else if (overdue) {
        // 결제 중에는 되돌리기·지우기가 서버에서 막힌다. 10분이 넘은 건만 풀 수 있게 한다.
        actions = `
          <div class="erp-cart-actions">
            <button class="erp-cart-return erp-cart-force-release${releasing ? ' confirming' : ''}" type="button"
                    data-cart-id="${deps.escapeHtml(cart.id)}" ${forceReleaseBusy.has(cart.id) ? 'disabled' : ''}>${releasing ? '토스 결제내역에서 이 결제가 승인되지 않았는지 확인했나요?' : '결제 중 풀기'}</button>
          </div>`
      }
      return `
        <article class="erp-cart-item front-cart-item" data-cart-id="${deps.escapeHtml(cart.id)}">
          <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')}</div>
          <div class="erp-cart-head">
            <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
            <span class="front-cart-status${paying ? ' paying' : ''}">${statusText}</span>
          </div>
          ${renderItemList(cart.items)}
          <div class="erp-cart-total">${formatWon(cart.totalAmount)}</div>
          ${actions}
        </article>
      `
    })
    .join('')
}

export function applyFrontCarts(carts) {
  if (!deps) return
  lastFrontCarts = Array.isArray(carts) ? carts : []
  // 서버 목록에서 사라진 건(결제 끝남/되돌려짐/취소)은 잠깐의 유예 뒤 잊는다.
  const ids = new Set(lastFrontCarts.map((c) => c.id))
  const now = Date.now()
  for (const [id, at] of sentToFront) {
    if (!ids.has(id) && now - at > SENT_TO_FRONT_GRACE_MS) sentToFront.delete(id)
  }
  renderFrontCarts()
}

function handleReturnClick(cartId) {
  if (returnConfirm.has(cartId)) {
    clearTimeout(returnConfirm.get(cartId))
    returnConfirm.delete(cartId)
    returnCartToPos(cartId)
    return
  }
  Array.from(returnConfirm.values()).forEach(clearTimeout)
  returnConfirm.clear()
  returnConfirm.set(cartId, setTimeout(() => {
    returnConfirm.delete(cartId)
    renderFrontCarts()
  }, 3000))
  renderFrontCarts()
}

async function returnCartToPos(cartId) {
  let ok, status, body
  try {
    ;({ ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/return-to-pos`))
  } catch {
    deps.notify('error', '서버에 연결하지 못해 되돌리지 못했습니다. 잠시 후 다시 시도해주세요.')
    return
  }
  if (!ok) {
    if (status === 401) {
      deps.onUnauthorized(body.error)
      return
    }
    deps.notify('error', body.error || '되돌리지 못했습니다.')
    return
  }
  // refreshErpCarts보다 먼저 세대를 올려야 아래 새로고침이 새 세대로 출발하고, 되돌리기 전에 출발한
  // 폴링 응답(이 카드가 아직 프론트 목록에 있다고 말하는)이 두 목록을 옛 상태로 덮지 못한다.
  afterMutation()
  sentToFront.delete(cartId)
  lastFrontCarts = lastFrontCarts.filter((c) => c.id !== cartId)
  renderFrontCarts()
  deps.notify('success', 'POS로 되돌렸습니다. 전산 주문 목록에서 담을 수 있습니다.')
  // 다음 폴링을 기다리지 않고 바로 POS 목록에 다시 보이게 한다.
  refreshErpCarts()
}

function handleFrontListClick(e) {
  // [결제 중 풀기]는 .erp-cart-return 클래스를 재사용(CSS)하므로 아래 되돌리기 검사보다 먼저 가른다.
  const releaseBtn = e.target.closest('button.erp-cart-force-release')
  if (releaseBtn && !releaseBtn.disabled) {
    handleForceReleaseClick(releaseBtn.dataset.cartId)
    return
  }
  const dismissBtn = e.target.closest('button.erp-cart-front-dismiss')
  if (dismissBtn && !dismissBtn.disabled) {
    handleFrontDismissClick(dismissBtn.dataset.cartId)
    return
  }
  const btn = e.target.closest('button.erp-cart-return')
  if (!btn || btn.disabled) return
  handleReturnClick(btn.dataset.cartId)
}

function handleFrontDismissClick(cartId) {
  if (frontDismissConfirm.has(cartId)) {
    clearTimeout(frontDismissConfirm.get(cartId))
    frontDismissConfirm.delete(cartId)
    dismissFrontCart(cartId)
    return
  }
  Array.from(frontDismissConfirm.values()).forEach(clearTimeout)
  frontDismissConfirm.clear()
  frontDismissConfirm.set(cartId, setTimeout(() => {
    frontDismissConfirm.delete(cartId)
    renderFrontCarts()
  }, 3000))
  renderFrontCarts()
}

async function dismissFrontCart(cartId) {
  let ok, status, body
  try {
    ;({ ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/dismiss-front`))
  } catch {
    deps.notify('error', '서버에 연결하지 못해 지우지 못했습니다. 잠시 후 다시 시도해주세요.')
    return
  }
  if (!ok) {
    if (status === 401) {
      deps.onUnauthorized(body.error)
      return
    }
    deps.notify('error', body.error || '지우지 못했습니다.')
    return
  }
  afterMutation()
  sentToFront.delete(cartId)
  lastFrontCarts = lastFrontCarts.filter((c) => c.id !== cartId)
  renderFrontCarts()
  deps.notify('success', '프론트 결제 대기에서 지웠습니다.')
}

function handleForceReleaseClick(cartId) {
  if (forceReleaseConfirm.has(cartId)) {
    clearTimeout(forceReleaseConfirm.get(cartId))
    forceReleaseConfirm.delete(cartId)
    forceReleaseCart(cartId)
    return
  }
  Array.from(forceReleaseConfirm.values()).forEach(clearTimeout)
  forceReleaseConfirm.clear()
  forceReleaseConfirm.set(cartId, setTimeout(() => {
    forceReleaseConfirm.delete(cartId)
    renderFrontCarts()
  }, FORCE_RELEASE_CONFIRM_MS))
  renderFrontCarts()
}

async function forceReleaseCart(cartId) {
  if (forceReleaseBusy.has(cartId)) return
  forceReleaseBusy.add(cartId)
  renderFrontCarts()
  try {
    let ok, status, body
    try {
      ;({ ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/force-release`))
    } catch {
      deps.notify('error', '서버에 연결하지 못해 결제 중 상태를 풀지 못했습니다. 잠시 후 다시 시도해주세요.')
      return
    }
    if (!ok) {
      if (status === 401) {
        deps.onUnauthorized(body.error)
        return
      }
      // 409는 서버가 아직 풀 수 없다고 한 것이다(결제 시작 뒤 시간이 덜 지났거나 그 사이 상태가 바뀜).
      // 이유는 서버가 가장 정확히 알고 있으니 그 문구를 그대로 보여준다.
      deps.notify('error', body.error || '결제 중 상태를 풀지 못했습니다.')
      return
    }
    afterMutation()
    lastFrontCarts = lastFrontCarts.map((c) => (c.id === cartId ? { ...c, status: 'pending', frontPayingAt: null } : c))
    deps.notify('success', '결제 중 상태를 풀었습니다. [POS로 되돌리기]나 [지우기]로 정리할 수 있습니다.')
    refreshErpCarts()
  } finally {
    forceReleaseBusy.delete(cartId)
    renderFrontCarts()
  }
}

// 카드의 버튼을 눌러도 되는지 가른다. true면 누른 동작을 시작하지 않는다.
//   - 같은 카드가 처리 중이거나 이미 처리를 마쳤으면 조용히 무시한다(더블탭).
//   - 다른 카드를 담는 중이면 안내한다. POS 장바구니는 하나뿐이라 두 주문을 동시에 담으면 품목이 섞이고,
//     실패해서 되돌릴 때 어느 쪽 품목인지 가릴 수 없다.
//   - consume 보고가 서버에 닿지 못한 채 이미 POS에 담겨 있는 주문이면 다시 담지 못하게 막는다. 서버는
//     아직 pending이라 카드가 남아 있는데, 다시 누르면 같은 품목이 장바구니에 두 번 들어간다.
function cardActionBlocked(cartId) {
  if (inFlight.has(cartId) || isConsumed(cartId)) return true
  if (inFlight.size > 0) {
    deps.notify('warn', '다른 주문을 담는 중입니다. 끝난 뒤에 다시 눌러주세요.')
    return true
  }
  if (loadPendingPaid().some((e) => e.id === cartId && e.needsConsume)) {
    deps.notify(
      'error',
      '이미 POS에 담겼지만 서버에 아직 알리지 못한 주문입니다. 다시 누르지 마시고 [주문] 탭에서 결제해주세요. 결제하면 자동으로 정리됩니다.'
    )
    return true
  }
  return false
}

function handleListClick(e) {
  const frontBtn = e.target.closest('button.erp-cart-front')
  if (frontBtn && !frontBtn.disabled) {
    const id = frontBtn.dataset.cartId
    if (!cardActionBlocked(id)) handleFrontClick(id)
    return
  }

  const dismissBtn = e.target.closest('button.erp-cart-dismiss')
  if (dismissBtn && !dismissBtn.disabled) {
    const id = dismissBtn.dataset.cartId
    if (!cardActionBlocked(id)) handleDismissClick(id)
    return
  }

  const btn = e.target.closest('button.erp-cart-button')
  if (!btn || btn.disabled) return
  const cartId = btn.dataset.cartId
  // disabled 검사만으로는 부족하다 — 버튼이 다시 그려졌거나 더블탭으로 두 이벤트가 거의 동시에
  // 들어오면 둘 다 통과할 수 있다. 진행 중 여부는 DOM이 아니라 inFlight로 판정한다.
  if (cardActionBlocked(cartId)) return
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
// 있어서 메모리에만 두면 잃는다 — localStorage에 남긴다. 결제가 확정되거나 주문이 정리되면 지운다.
//
// ⚠️ 'paid' 이벤트는 "어느 주문이 결제됐는지"를 알려주지 않는다. 예전에는 담은 지 10분 안의 기록을
// 전부 그 결제에 붙였다 -- 직원이 그 사이 다른 손님을 계산하면 아직 결제 안 된 전산 주문이 "결제완료"로
// 보고됐다(돈은 안 들어왔는데 전산은 결제완료). 그래서 기록에 주문 내용(품목 이름·수량·금액)을 함께
// 저장하고, 결제된 POS 주문을 order.getOrder로 읽어 내용이 맞는 기록만 보고한다. 맞는 기록이 없거나
// 둘 이상이면 추측하지 않는다 -- 잘못 보고하는 것보다 직원이 [최근 결제]에서 확인하는 쪽이 싸다.
// 판단 기준이 시간에서 내용으로 바뀌어서 10분 유효시간은 없앴다. 대신 기록이 영영 쌓이지 않도록
// 지우는 시점을 둔다: [지우기]·담기 취소(unload)·결제 확정·서버가 끝난 주문이라고 답했을 때, 그리고
// POS 장바구니에서 이 기록의 품목이 모두 사라졌을 때(reconcileWithDraft).
//
// 여러 건을 연달아 담고 한 번에 결제할 수도 있으므로 배열로 들고 있고, 결제된 주문이 기록 몇 건을
// 합친 내용과 맞으면 그 건들을 함께 보고한다(pickMatchingEntries).
//
// 기록의 모양: { id, ref, at, keys, totalAmount, items:[{title,quantity,unitPrice}], attemptId,
//   needsConsume?, goneAt?, paymentId?, orderId? }. paymentId는 'paid'가 확정된 뒤 통보가 실패해 남은
// 건에만 붙는다.
const PENDING_PAID_KEY = 'chevrolet_erp_pending_paid'

function loadPendingPaid() {
  try {
    const raw = localStorage.getItem(PENDING_PAID_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
      // 주문 내용(items)이 없는 예전 기록은 결제와 대조할 수 없다. 남겨두면 아무 결제에나 딸려가거나
      // 영영 맞지 않아 쌓인다. 다만 paymentId가 이미 붙은 건은 자기 결제가 확정된 것이라 대조가 필요 없다.
      .filter((entry) => entry.paymentId || Array.isArray(entry.items))
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

function rememberLoadedCart(cart, keys, attemptId) {
  const items = (cart.items || []).map((i) => ({
    title: String(i.name ?? ''),
    quantity: Number(i.quantity) || 0,
    unitPrice: Number(i.unitPrice) || 0,
  }))
  const totalAmount = Number(cart.totalAmount) || items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
  const entry = { id: cart.id, ref: cart.referenceId || '', at: Date.now(), keys, totalAmount, items, attemptId }
  // 같은 주문의 옛 기록은 키가 다르다(그 품목은 이미 지워졌거나 다른 시도의 것) -- 새 기록으로 바꾼다.
  savePendingPaid([...loadPendingPaid().filter((e) => e.id !== cart.id), entry])
}

function patchPendingEntry(cartId, patch) {
  savePendingPaid(loadPendingPaid().map((e) => (e.id === cartId ? { ...e, ...patch } : e)))
}

// 결제를 시작하지도 못한 채 끝난 주문(다른 단말기가 이미 처리/거부한 경우)의 대기 기록을
// 지운다. 남겨두면 이 단말기에서 나중에 벌어지는 결제와 내용이 우연히 맞아 "결제완료"로 잘못
// 보고될 수 있다 — 실제로는 여기서 결제한 적이 없는데도.
function forgetPendingPaid(cartId) {
  savePendingPaid(loadPendingPaid().filter((e) => e.id !== cartId))
}

// 담기 취소 전에 이 주문이 POS 장바구니에 넣은 품목 key를 본다(기록은 지우지 않는다).
export function peekLoadedCartKeys(cartId) {
  const entry = loadPendingPaid().find((e) => e.id === cartId)
  return entry && Array.isArray(entry.keys) ? entry.keys : []
}

// 최근 결제 목록의 [POS에서 비우기](서버 unload)가 성공한 뒤 부른다. 서버는 그 주문을 pending으로
// 되돌렸으므로 (1) 대기 중인 결제 기록을 지우고(안 지우면 이후 엉뚱한 결제와 맞을 수 있다) (2) 방금 처리했다고
// 기억해 둔 consumed에서 빼고(안 빼면 60초 동안 되살아난 카드를 화면이 걸러낸다) (3) POS 목록을 바로 맞춘다.
// POS 장바구니에 담겨 있던 품목은 건드리지 않는다 -- 이 주문을 다시 담으려면 먼저 그 품목을 지워야
// 같은 품목이 두 번 들어가지 않는다. 호출하는 쪽이 안내할 수 있게 지운 기록의 key들을 돌려준다.
export function forgetLoadedCart(cartId) {
  const forgotten = loadPendingPaid().find((e) => e.id === cartId)
  forgetPendingPaid(cartId)
  consumed.delete(cartId)
  // refreshErpCarts보다 먼저 올려야 새 세대로 출발한다(returnCartToPos와 같은 이유).
  afterMutation()
  refreshErpCarts()
  return forgotten && Array.isArray(forgotten.keys) ? forgotten.keys : []
}

// ── POS 장바구니와 대조해 기록 정리 ─────────────────────────────────────────
// 직원이 담은 품목을 POS에서 직접 지워 결제 없이 장바구니가 비면, 그 기록은 영영 결제되지 않는다. 남겨두면
// 나중의 결제와 내용이 우연히 맞아 오보고될 수 있어 draftOrder 'update' 이벤트로 지켜본다.
//
// 지우기를 바로 하지 않고 유예(goneAt)를 두는 이유: 결제가 끝나면 장바구니도 같이 비워진다. 'update'(비워짐)가
// 'paid'보다 먼저 오는 순서일 수 있고, 그때 기록을 바로 지우면 막 끝난 결제를 통보할 근거를 잃는다. 순서가
// 확인되지 않았으니(실단말기 미검증) 비워진 뒤에도 몇 분은 기록을 두고, 그 사이 'paid'가 오면 정상 처리한다.
// 품목이 다시 나타나면(되돌리기·재담기) 유예 표시를 걷는다.
const VANISHED_GRACE_MS = 5 * 60 * 1000

function reconcileWithDraft(draft) {
  // 이벤트 내용이 장바구니 모양이 아니면 판단하지 않는다 -- 비어 있다고 오해해서 기록을 잃는 쪽이 더 나쁘다.
  if (!draft || !Array.isArray(draft.lineItems)) return
  const present = new Set(draft.lineItems.map((li) => li && li.key).filter(Boolean))
  const entries = loadPendingPaid()
  const now = Date.now()
  let changed = false
  const next = entries.map((e) => {
    if (e.paymentId || !Array.isArray(e.keys) || e.keys.length === 0) return e
    const anyPresent = e.keys.some((k) => present.has(k))
    if (anyPresent && e.goneAt) {
      changed = true
      return { ...e, goneAt: undefined }
    }
    if (!anyPresent && !e.goneAt) {
      changed = true
      return { ...e, goneAt: now }
    }
    return e
  })
  if (changed) savePendingPaid(next)
}

// 품목이 사라진 지 유예가 지난 기록을 지운다. 이벤트가 더 오지 않아도 폴링(retryPendingPaid)이 불러서 정리된다.
// consume 보고가 아직 안 닿은 기록(needsConsume)은 남긴다 -- 서버가 loaded로 아는지부터 정리해야 한다.
function dropVanishedEntries() {
  const now = Date.now()
  const entries = loadPendingPaid()
  const kept = entries.filter((e) => e.paymentId || e.needsConsume || !e.goneAt || now - e.goneAt <= VANISHED_GRACE_MS)
  if (kept.length !== entries.length) savePendingPaid(kept)
}

function initDraftWatch() {
  try {
    draftOrder.on('update', (draft) => {
      try {
        reconcileWithDraft(draft)
      } catch (e) {
        console.error('[erp-cart] 장바구니 변경을 기록과 맞추지 못했습니다.', e?.message)
      }
    })
  } catch (e) {
    // 이 이벤트가 없으면 결제 없이 비워진 기록이 남을 뿐이다 -- 결제 때 내용 대조가 오보고는 막는다.
    console.error('[erp-cart] 장바구니 변경 이벤트를 구독하지 못했습니다.', e?.message)
  }
}

// ── 결제된 POS 주문과 기록 대조 ─────────────────────────────────────────────
function normalizeTitle(value) {
  return String(value ?? '').trim()
}

// 품목 이름별 수량 합. POS가 같은 이름의 줄을 합치든 따로 두든 같은 값이 나오게 줄 단위가 아니라 이름 단위로 센다.
function tallyByTitle(rows) {
  const tally = new Map()
  for (const row of rows) {
    const title = normalizeTitle(row.title)
    tally.set(title, (tally.get(title) || 0) + (Number(row.quantity) || 0))
  }
  return tally
}

function sameTally(a, b) {
  if (a.size !== b.size) return false
  for (const [title, quantity] of a) {
    if (b.get(title) !== quantity) return false
  }
  return true
}

function readLineQuantity(line) {
  const q = line && line.quantity
  return Number(q && typeof q === 'object' ? q.value : q)
}

// getOrder 결과에서 대조에 쓸 값만 뽑는다. 읽을 수 없는 값은 null -- "다르다"가 아니라 "알 수 없다"로 취급한다.
function readPaidOrder(order) {
  const lines = Array.isArray(order && order.lineItems) ? order.lineItems : []
  const readable = lines.length > 0 && lines.every((li) => typeof (li && li.item && li.item.title) === 'string' && Number.isFinite(readLineQuantity(li)))
  const tally = readable
    ? tallyByTitle(lines.map((li) => ({ title: li.item.title, quantity: readLineQuantity(li) })))
    : null
  const amount = order && order.chargePrice && typeof order.chargePrice.chargePriceValue === 'number'
    ? order.chargePrice.chargePriceValue
    : null
  return { tally, amount }
}

// 기록 몇 건(subset)이 결제된 주문과 얼마나 맞는지. 2 = 읽을 수 있는 값이 전부 맞음(품목·수량, 금액),
// 1 = 둘 중 하나만 맞음, 0 = 맞는 게 없거나 읽을 값이 없음.
function judgeSubset(subset, paid) {
  const titleMatch = paid.tally
    ? sameTally(tallyByTitle(subset.flatMap((e) => e.items || [])), paid.tally)
    : null
  const amountMatch = paid.amount !== null
    ? subset.reduce((sum, e) => sum + (Number(e.totalAmount) || 0), 0) === paid.amount
    : null
  if (titleMatch === null && amountMatch === null) return 0
  if (titleMatch !== false && amountMatch !== false) return 2
  if (titleMatch === true || amountMatch === true) return 1
  return 0
}

// 결제된 주문과 맞는 기록 묶음을 찾는다. 완전히 맞는 묶음(2)이 있으면 그것만, 없으면 한쪽만 맞는 묶음(1)을
// 본다. 후보가 정확히 하나일 때만 고르고, 없거나 둘 이상이면 고르지 않는다.
function pickMatchingEntries(fresh, paid) {
  const n = fresh.length
  // 묶음 수가 2^n이다. 현실의 n은 한두 건이고 그 이상은 어차피 사람이 확인해야 할 상황이다.
  if (n > 10) return { kind: 'ambiguous' }
  const strong = []
  const weak = []
  for (let mask = 1; mask < (1 << n); mask += 1) {
    const subset = fresh.filter((_, i) => mask & (1 << i))
    const score = judgeSubset(subset, paid)
    if (score === 2) strong.push(subset)
    else if (score === 1) weak.push(subset)
  }
  const pool = strong.length ? strong : weak
  if (pool.length === 1) return { kind: 'match', entries: pool[0] }
  return { kind: pool.length ? 'ambiguous' : 'none' }
}

async function matchFreshEntries(fresh, orderId) {
  let order = null
  try {
    // SDK 버전에 따라 없을 수 있다. 없으면 대조할 방법이 없으니 보고하지 않는다.
    if (posPluginSdk.order && typeof posPluginSdk.order.getOrder === 'function') {
      order = await posPluginSdk.order.getOrder(orderId)
    }
  } catch (e) {
    console.error('[erp-cart] 결제된 POS 주문을 읽지 못했습니다.', e?.message)
  }
  if (!order) return { kind: 'none' }
  return pickMatchingEntries(fresh, readPaidOrder(order))
}

// 결제 완료 통보. reportConsume과 같은 수준(2회 재시도, 4xx는 재시도 안 함, 401 처리,
// 네트워크 예외를 값으로 변환)으로 맞춘다 — 담기(consume)만 재시도하고 이쪽은 안 하면,
// 결제는 끝났는데 전산만 모르는 상태가 조용히 남는다. 여러 건을 한 번에 보고할 수 있어
// (settleReports가 Promise.all로 묶는다) 실패를 여기서 개별 notify하지 않고 결과값만
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

// 서버가 "이 주문은 더 이상 결제 통보를 받을 수 없다"고 답한 경우. 이 기록을 남겨 두면 폴링마다 같은
// 거절을 받으며 영영 재시도한다. 지우고 직원에게 한 번만 알린다.
const PAID_TERMINAL_LABEL = { dismissed: '지워진', failed: '실패 처리된', cancelled: '취소된', refunded: '환불된', expired: '만료된' }

function terminalPaidReason(r) {
  if (r.status === 404) return '전산에서 찾을 수 없는'
  if (r.status === 409 && PAID_TERMINAL_LABEL[r.body && r.body.status]) return `전산에서 이미 ${PAID_TERMINAL_LABEL[r.body.status]}`
  return null
}

function notifyTerminalPaid(r) {
  deps.notify(
    'error',
    `${terminalPaidReason(r)} 주문입니다 (${r.entry.ref || r.entry.id}). 결제 통보를 멈춥니다. ` +
    '실제로 결제가 이뤄졌다면 [주문] 탭 내역과 전산을 직접 대조해주세요.'
  )
}

// 같은 기록을 두 곳(결제 이벤트, 폴링 재시도)이 동시에 보고하지 않게 하는 표식.
const reportingIds = new Set()

// targets: [{ entry, paymentId, orderId }]를 보고하고 저장된 기록을 정리한다.
async function settleReports(targets) {
  const todo = targets.filter((t) => !reportingIds.has(t.entry.id))
  todo.forEach((t) => reportingIds.add(t.entry.id))
  try {
    const results = await Promise.all(
      todo.map((t) => reportPaid(t.entry.id, t.paymentId, t.orderId).then((r) => ({ ...t, ...r })))
    )
    const succeeded = results.filter((r) => r.ok)
    const terminal = results.filter((r) => !r.ok && terminalPaidReason(r))
    const failed = results.filter((r) => !r.ok && !terminalPaidReason(r))
    const gone = new Set([...succeeded, ...terminal].map((r) => r.entry.id))
    const failedById = new Map(failed.map((r) => [r.entry.id, r]))
    // 대기하는 동안 새로 담긴 항목이 있을 수 있으니 지금 시점 기록을 다시 읽는다.
    // 성공·종료된 것은 지우고, 실패한 것은 이번에 확정된 paymentId/orderId를 붙여 남긴다 —
    // 그래야 다음 폴링 때 같은 건을 같은 결제 참조로 다시 보고할 수 있다.
    savePendingPaid(
      loadPendingPaid()
        .filter((e) => !gone.has(e.id))
        .map((e) => {
          const f = failedById.get(e.id)
          return f ? { ...e, paymentId: f.paymentId, orderId: f.orderId } : e
        })
    )
    if (succeeded.length) afterMutation()
    return { succeeded, failed, terminal }
  } finally {
    todo.forEach((t) => reportingIds.delete(t.entry.id))
  }
}

const UNMATCHED_PAYMENT_MESSAGE = 'POS 결제를 전산 주문과 맞추지 못했습니다. 최근 결제에서 확인해주세요.'

async function handlePaid(paymentId, orderId) {
  const entries = loadPendingPaid()
  if (!entries.length) return
  // 예전에 통보가 실패해 남아 있던 항목(paymentId가 이미 있다)은 그때 확정된 자기 값을 그대로 다시 써야
  // 한다 — 지금 결제와는 다른 건이라, 새 값을 붙이면 전산에 엉뚱한 결제 건으로 기록된다.
  const targets = entries
    .filter((e) => e.paymentId)
    .map((e) => ({ entry: e, paymentId: e.paymentId, orderId: e.orderId }))
  // 아직 결제가 안 붙은 항목은 이번 결제가 정말 자기 것인지 주문 내용으로 확인한 것만 이번 값을 쓴다.
  const fresh = entries.filter((e) => !e.paymentId)
  if (fresh.length) {
    const picked = await matchFreshEntries(fresh, orderId)
    if (picked.kind === 'match') picked.entries.forEach((e) => targets.push({ entry: e, paymentId, orderId }))
    else deps.notify('warn', UNMATCHED_PAYMENT_MESSAGE)
  }
  if (!targets.length) return

  const { succeeded, failed, terminal } = await settleReports(targets)
  terminal.forEach(notifyTerminalPaid)
  if (succeeded.length) deps.notify('success', '결제 완료를 전산에 알렸습니다.')
  if (failed.length) {
    // 결제 자체는 이미 끝났다 — 취소하라는 뜻이 아니라, 전산이 아직 모른다는 뜻이다.
    deps.notify(
      'error',
      `결제는 완료됐지만 전산에는 알리지 못했습니다 (${failed.length}건). 결제를 취소하지 마세요 — ` +
      '잠시 후 자동으로 다시 시도합니다. 계속 실패하면 [주문] 탭 내역과 대조해 전산에 직접 확인해주세요.'
    )
  }
}

// consume 보고가 닿지 못한 기록(needsConsume)의 보고를 다시 보낸다. 같은 attemptId라서 서버가 이미 받았다면
// "이미 처리됨"과 함께 내 요청이었는지(ownAttempt)를 알려준다. 서버가 이 주문을 loaded로 모르는 채 결제만
// 통보하면 전산 화면에서 "결제됐는데 담기 기록이 없는" 상태가 되므로, 결제 통보보다 먼저 맞춘다.
async function resendConsume(entry) {
  const label = entry.ref || entry.id
  const r = await reportConsume(entry.id, { result: 'loaded', attemptId: entry.attemptId }, { silent: true })
  if (!r.ok) {
    if (r.status === 404 || r.status === 409) {
      forgetPendingPaid(entry.id)
      if (r.status === 409 && r.body && r.body.payTarget === 'front') {
        deps.notify('error', `프론트에서 결제하도록 넘어간 주문입니다 (${label}). POS에서는 결제하지 마세요. [주문] 탭에 담긴 품목을 직접 지워주세요.`)
      } else if (r.status === 404) {
        deps.notify('error', `전산에서 찾을 수 없는 주문입니다 (${label}). POS에 담긴 품목은 [주문] 탭에서 직접 확인해주세요.`)
      } else {
        deps.notify('error', `${(r.body && r.body.error) || '이미 처리된 주문입니다.'} (${label}) POS에서 결제하지 말고 [주문] 탭에 담긴 품목을 직접 확인해주세요.`)
      }
    }
    // 401은 reportConsume이 이미 처리했다. 5xx·네트워크 오류는 다음 폴링에서 다시 한다.
    return
  }
  const body = r.body || {}
  // ownAttempt를 모르는 옛 서버는 상태로만 본다: 이미 loaded(또는 결제까지 끝남)이면 처음 보냈던 내 요청이
  // 서버에서는 성공했던 것으로 본다. 그 외(지움·실패 등)는 다른 단말기 몫이다.
  const lostToOther = Boolean(body.alreadyProcessed) &&
    (body.ownAttempt === false || (body.ownAttempt === undefined && body.status !== 'loaded' && body.status !== 'paid'))
  if (lostToOther) {
    forgetPendingPaid(entry.id)
    deps.notify('error', `다른 단말기에서 이미 처리한 주문입니다 (${label}). POS에서 결제하지 말고 [주문] 탭에 담긴 품목을 직접 지워주세요.`)
    return
  }
  patchPendingEntry(entry.id, { needsConsume: undefined })
}

// 통보에 실패해 남아 있는 결제 건과 보고가 안 닿은 담기를 다시 보낸다. 폴링(applyErpCarts)이 부르므로
// 5~15초마다 기회가 온다.
//
// 'paid' 이벤트가 날 때만 재시도하면, 한산한 매장에서는 다음 결제가 없어서 그대로 방치된다 - 직원에게
// "다시 시도합니다"라고 안내해놓고 실제로는 안 하는 것이다. 여기서 재시도해야 그 안내가 사실이 된다.
//
// 결제 통보 대상은 paymentId가 이미 붙은 항목뿐이다. 그게 없는 항목은 아직 결제가 끝나지 않은 건이라
// 보고할 것 자체가 없다.
let retryingPaid = false

async function retryPendingPaid() {
  dropVanishedEntries()
  if (retryingPaid) return
  const candidates = loadPendingPaid().filter(
    (e) => (e.paymentId || e.needsConsume) && !inFlight.has(e.id) && !reportingIds.has(e.id)
  )
  if (!candidates.length) return

  retryingPaid = true
  try {
    for (const entry of candidates.filter((e) => e.needsConsume)) await resendConsume(entry)

    // consume 재전송에서 지워진 기록이 있을 수 있으니 지금 시점 기록을 다시 읽는다.
    const ids = new Set(candidates.map((e) => e.id))
    const targets = loadPendingPaid()
      .filter((e) => e.paymentId && ids.has(e.id))
      .map((e) => ({ entry: e, paymentId: e.paymentId, orderId: e.orderId }))
    if (!targets.length) return
    const { succeeded, terminal } = await settleReports(targets)
    terminal.forEach(notifyTerminalPaid)
    if (succeeded.length) deps.notify('success', `결제 완료를 전산에 알렸습니다 (${succeeded.length}건).`)
  } catch {
    // 재시도는 실패해도 조용히 넘어간다 - 폴링마다 오류를 띄우면 화면이 안내로 뒤덮인다.
    // 직원은 이미 한 번 안내를 받았고, 다음 폴링이 다시 시도한다.
  } finally {
    retryingPaid = false
  }
}

function initPaymentWatch() {
  try {
    posPluginSdk.payment.on('paid', (paymentId, orderId) => {
      handlePaid(paymentId, orderId).catch((e) => {
        console.error('[erp-cart] 결제 완료 처리 중 오류가 났습니다.', e?.message)
      })
    })
  } catch (e) {
    // SDK 버전에 따라 이 이벤트가 없을 수 있다. 없으면 결제 통보만 빠지고 나머지는 그대로 돈다.
    console.error('[erp-cart] 결제 이벤트를 구독하지 못했습니다.', e?.message)
  }
}

// 담기 시도 하나를 가리키는 표식. 서버 형식은 영문·숫자·_·-의 8~64자다.
function makeAttemptId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // 보안 컨텍스트가 아니면 없을 수 있다 -- 아래 대체 값을 쓴다.
  }
  return makeLineItemKey()
}

// consume이 서버에 닿지 못하면 그 장바구니는 계속 pending으로 남아, 다음 폴링이나 단말기 재시작
// 뒤에 같은 카드가 되살아난다 — 이미 POS에 담아둔 걸 또 담게 되는 경로다. 일시적 네트워크
// 오류가 흔한 매장 환경이라 한 번은 재시도하고, 그래도 실패하면 조용히 넘기지 않고 직원에게
// 알린다(자동으로 더 손쓸 방법이 없으므로 사람이 알아야 한다).
//
// priorUncertain: 이 호출 안에서 앞선 시도가 예외·시간 초과·5xx로 끝났었는지. 그런 시도는 서버에서 처리가
// 됐는지 알 수 없다. 재시도가 "이미 처리됨"을 받았을 때 그게 내 첫 요청의 성공인지 가리는 단서가 된다
// (ownAttempt를 안 주는 옛 서버용, runLoadCartToPos 참고).
//
// silent: 폴링에서 조용히 재전송할 때 쓴다. 실패 안내는 담기를 누른 그 순간 한 번이면 충분하다.
async function reportConsume(cartId, resultBody, { silent = false } = {}) {
  let priorUncertain = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // apiPost 안의 fetch는 네트워크가 끊기면 거부한다. 여기서 던지면 호출부의 catch를 타고
    // 되돌리기·안내가 꼬이므로, 통신 실패도 "보고 실패"라는 값으로 바꿔서 돌려준다.
    let ok, status, body
    try {
      ;({ ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/consume`, resultBody))
    } catch {
      priorUncertain = true
      continue
    }
    if (ok) {
      afterMutation()
      return { ok, status, body, priorUncertain }
    }
    if (status === 401) {
      deps.onUnauthorized(body.error)
      return { ok, status, body, priorUncertain }
    }
    // 4xx는 재시도해도 같은 답이 온다(잘못된 id 등). 5xx/네트워크 오류만 한 번 더 시도한다.
    if (status && status < 500) return { ok, status, body, priorUncertain }
    priorUncertain = true
  }
  if (!silent) {
    deps.notify('error', '처리 결과를 서버에 알리지 못했습니다. 같은 주문이 다시 뜨면 이미 담긴 것인지 [주문] 탭에서 확인해주세요.')
  }
  return { ok: false, priorUncertain }
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
  // alreadyProcessed/dismissed 분기에서 되돌리기 실패를 안내에 특정하기 위한 key→품목명 매핑.
  // addedKeys는 handleLoadFailure와도 공유하는 배열이라 구조를 바꾸지 않고 별도로 들고 있는다.
  const addedTitleByKey = new Map()
  // 이 담기 시도의 표식. reportConsume의 재시도와, 보고가 안 닿았을 때 폴링이 다시 보내는 consume이 모두
  // 같은 값을 보낸다. 서버가 "이미 처리됨"이라고 답할 때 그게 내 첫 요청이 성공한 것인지(ownAttempt)
  // 다른 단말기가 가져간 것인지 가리려면 요청마다 시도를 구분할 수 있어야 한다.
  const attemptId = makeAttemptId()
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
      addedTitleByKey.set(lineItem.key, item.name)
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
    rememberLoadedCart(cart, addedKeys, attemptId)
    const reported = await reportConsume(cart.id, { result: 'loaded', attemptId })

    // 이 주문은 그 사이 프론트로 넘어갔다(다른 단말기가 넘겼거나, 넘기기 직전 화면이 남아 있었다).
    // 아래 일반 실패 안내("[주문] 탭에서 결제해주세요")를 타면 POS와 프론트 양쪽에서 결제된다 --
    // 방금 담은 품목을 되돌리고 결제하지 말라고 분명히 알린다.
    if (!reported.ok && reported.status === 409 && reported.body?.payTarget === 'front') {
      const failedTitles = []
      for (const key of addedKeys) {
        try {
          await draftOrder.deleteLineItem(key)
        } catch {
          console.error('[erp-cart] 되돌리기 실패 — POS 장바구니를 직접 확인해주세요.', key)
          failedTitles.push(addedTitleByKey.get(key) || key)
        }
      }
      forgetPendingPaid(cart.id)
      sentToFront.set(cart.id, Date.now())
      lastCarts = lastCarts.filter((c) => c.id !== cart.id)
      const revertNote = failedTitles.length === 0
        ? '방금 담은 품목은 되돌렸습니다.'
        : `방금 담은 품목 중 되돌리기에 실패한 것이 있습니다(${failedTitles.join(', ')}). [주문] 탭에서 직접 지워주세요.`
      deps.notify('error', `프론트에서 결제하도록 넘긴 주문입니다. ${revertNote} POS에서는 결제하지 마세요.`)
      return
    }

    if (!reported.ok) {
      // 아직 결제는 시작하지 않았다. 서버가 어떤 상태인지 모르는 채로 결제까지 자동으로
      // 밀어붙이면, 나중에 이 카드가 되살아났을 때 결제된 건인지 아닌지 아무도 모른다.
      // 담긴 것은 사실이므로 카드는 남겨두고, 결제는 직원이 직접 누르게 한다.
      // 보고가 안 닿았다는 표시를 기록에 남겨 두면 폴링이 consume 'loaded'를 다시 보낸다(resendConsume).
      patchPendingEntry(cart.id, { needsConsume: true })
      deps.notify(
        'error',
        '담기는 됐지만 서버에 알리지 못했습니다. [주문] 탭에 품목이 들어가 있으니 거기서 결제해주세요. ' +
        '이 주문은 목록에 남습니다 — 다시 누르지 마시고, 결제하면 자동으로 정리됩니다.'
      )
      return
    }

    // ── 단말기가 2대 이상일 때의 분기 ──
    // consume은 원자적 updateMany라 딱 한 단말기만 인정된다. 진 쪽에도 ok:true가 오지만
    // body.alreadyProcessed가 true로 붙는다 — 이걸 안 보면 이 단말기도 그대로 결제까지
    // 밀어붙여서 같은 주문이 두 번 결제된다(치명적). 방금 이 화면에서 담은 품목은 이 주문
    // 몫이 아니게 됐으니 결제를 시작하면 안 되고, 방금 담아버린 것만 되돌린다
    // (handleLoadFailure와 같은 방식 — addedKeys만 지운다, 원래 있던 항목은 그대로 둔다).
    //
    // 다만 alreadyProcessed가 "내 첫 요청이 성공한 결과"일 수도 있다. reportConsume은 시간 초과·5xx면 같은
    // 요청을 한 번 더 보내는데, 첫 요청이 서버에서는 성공하고 응답만 못 받은 경우 재시도가 alreadyProcessed를
    // 받는다. 예전에는 이걸 무조건 "다른 단말기가 처리함"으로 읽어서 방금 담은 품목을 되돌리고 결제하지
    // 말라고 안내했다 -- 서버에는 loaded인데 POS 장바구니는 비어서, 주문이 loaded에 갇혀 결제할 수 없었다.
    // 서버가 attemptId로 구분해 ownAttempt를 실어 주므로 true면 정상 성공으로 이어간다(아래 분기를 타지 않는다).
    //
    // ownAttempt를 모르는 옛 서버: 앞선 시도가 예외·시간 초과·5xx로 끝났고 지금 status가 loaded면 내 첫
    // 요청이었을 가능성이 높다. 다만 단정할 수는 없다(다른 단말기 몫이면 이중 결제) -- 품목을 되돌리지도,
    // 자동 결제를 시작하지도 않고 직원이 [주문]에서 확인하게 한다.
    const alreadyBody = reported.body && reported.body.alreadyProcessed ? reported.body : null
    if (alreadyBody && alreadyBody.ownAttempt === undefined && reported.priorUncertain && alreadyBody.status === 'loaded') {
      removeCartFromView(cart.id)
      deps.notify(
        'error',
        `이미 담긴 것으로 보입니다 (${cart.referenceId || cart.id}). POS [주문]을 확인해주세요. ` +
        '같은 품목이 두 번 들어가 있으면 한쪽을 지워주세요. 자동 결제는 하지 않았습니다.'
      )
      return
    }
    if (alreadyBody && alreadyBody.ownAttempt !== true) {
      const failedTitles = []
      for (const key of addedKeys) {
        try {
          await draftOrder.deleteLineItem(key)
        } catch {
          // 콘솔은 매장에서 아무도 안 본다 — 로그는 남기되, 실제 안내는 아래 revertNote로
          // deps.notify에 실어서 직원 눈에 보이게 한다.
          console.error('[erp-cart] 되돌리기 실패 — POS 장바구니를 직접 확인해주세요.', key)
          failedTitles.push(addedTitleByKey.get(key) || key)
        }
      }
      // 되돌리기가 하나라도 실패했는데 "되돌렸습니다"라고 단정하면, 그 말을 믿은 직원이 다음
      // 결제를 그대로 진행해서 이미 다른 단말기가 처리한 품목이 함께 결제되는 사고로 이어진다
      // (돈이 잘못되는 경로). 전부 성공했을 때만 단정하고, 하나라도 남으면 무엇이 남았을 수
      // 있는지와 할 일을 알려준다.
      const revertNote = failedTitles.length === 0
        ? '방금 담은 품목은 되돌렸습니다.'
        : `방금 담은 품목 중 되돌리기에 실패한 것이 있습니다(${failedTitles.join(', ')}). POS 장바구니에 남아 있을 수 있으니 [주문] 탭에서 직접 확인 후 지워주세요.`
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
          `${revertNote} 이 주문은 결제하지 말고 전산에서 다시 확인해주세요.`
        )
      } else {
        deps.notify(
          'error',
          `다른 단말기에서 이미 처리한 주문입니다 (${cart.referenceId || cart.id}). ` +
          `${revertNote} 이 주문은 결제하지 마세요 — 이미 다른 단말기에서 처리됐습니다.`
        )
      }
      return
    }

    if (!cart.autoPay) {
      removeCartFromView(cart.id)
      deps.notify('success', 'POS 장바구니에 담았습니다.')
      return
    }

    // ── 자동 결제 전 장바구니 확인 ──
    // startPayment()는 POS 장바구니 **전체**를 결제 화면으로 넘긴다. 직원이 다른 손님 몫으로 먼저 담아둔
    // 품목이 있으면 그것까지 같이 결제돼 금액이 틀어진다. 우리가 방금 넣은 key 말고 다른 줄이 있으면
    // 결제를 시작하지 않는다. 장바구니를 읽지 못한 경우도 같은 쪽(멈춤)으로 간다 -- 확인 없이 밀어붙이는
    // 것보다 직원이 한 번 더 누르는 쪽이 싸다. 품목은 이미 담겼고 서버에도 보고됐으니 카드는 치운다.
    if (button) button.textContent = '장바구니 확인 중...'
    let draft = null
    try {
      draft = await draftOrder.get()
    } catch (e) {
      console.error('[erp-cart] 자동 결제 전 장바구니를 읽지 못했습니다.', e?.message)
    }
    const ours = new Set(addedKeys)
    const others = draft && Array.isArray(draft.lineItems) ? draft.lineItems.filter((li) => !ours.has(li && li.key)) : null
    if (!others || others.length > 0) {
      removeCartFromView(cart.id)
      if (!others) {
        deps.notify('error', '장바구니를 확인하지 못해 자동 결제를 멈췄습니다. 확인 후 POS에서 결제해주세요.')
      } else {
        const cartTotal = typeof (draft.price && draft.price.orderPriceValue) === 'number'
          ? draft.price.orderPriceValue
          : draft.lineItems.reduce((sum, li) => sum + (Number(li.itemPrice && li.itemPrice.priceValue) || 0) * (Number(li.quantity) || 0), 0)
        deps.notify(
          'error',
          `장바구니에 다른 품목이 있어 자동 결제를 멈췄습니다(장바구니 ${formatWon(cartTotal)} / 이번 주문 ${formatWon(cart.totalAmount)}). ` +
          '확인 후 POS에서 결제해주세요.'
        )
      }
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
      const reason = payError?.message || String(payError)
      if (String(reason).includes('지연되고 있습니다')) {
        // POS가 응답이 늦다고 거절한 것이지 결제 화면을 못 연 것이 아닐 수 있다. "열지 못했다"고 단정하면
        // 이미 열린 결제 화면 위에서 직원이 [주문] 탭 결제를 또 시작한다.
        deps.notify(
          'warn',
          `결제 화면 응답이 지연되고 있습니다. 결제 화면이 열렸는지 확인해주세요. 열려 있으면 그대로 진행하고, 열리지 않았으면 [주문] 탭에서 직접 결제해주세요. (${reason})`
        )
      } else {
        deps.notify('error', `결제 화면을 열지 못했습니다. [주문] 탭에서 직접 결제해주세요. (${reason})`)
      }
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
  consumed.set(cartId, Date.now())
  renderErpCarts(lastCarts.filter((c) => c.id !== cartId))
}
