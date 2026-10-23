// 최근 7일 결제된 전산 주문과 결제 취소.
//
// 결제한 곳에서만 취소할 수 있다:
//   - POS 결제: posPluginSdk.payment.cancel로 직접 취소를 시도한다. SDK 문서에는 카드·현금 결제 취소를
//     "Toss POS를 통해 처리"한다고만 되어 있어 탭앱에서 바로 되는지는 실단말기에서 확인해야 한다.
//     실패하면 POS [주문]에서 직접 취소하게 안내하고, 직원이 [POS에서 취소했어요]로 기록한다.
//   - 프론트 결제: POS는 플러그인 모드 프론트와 페어링되지 않으므로 직접 취소할 수 없다. 취소를 요청하면
//     프론트 플러그인이 가져가 손님 카드로 취소한다(front-plugin/erp-pay.html).
//   - 현금영수증 없는 현금: 토스 쪽에 취소할 대상이 없다. 현금을 돌려주고 기록만 한다.
// 어느 경우든 토스 결제 취소 웹훅이 오면 서버가 refunded로 확정한다.
//
// 돈이 나가는 동작이라 모든 버튼은 대기열 호출·완료와 같은 2단계 확인(3초 안에 한 번 더)을 쓴다.
//
// 정리 기능(리허설·테스트 기록용): [숨기기]는 이 목록과 정비 이력에서만 감춘다(맨 위 '숨긴 N건 보기'로 다시
// 꺼낼 수 있다). [삭제]는 탭앱·오늘 현황·관리자 웹 어디에도 안 보이게 한다(서버는 행을 지우지 않는다 --
// 실제 결제라 분쟁·대사 근거가 남아야 한다). [영수증 보내기]는 예약 손님 번호로 전자영수증을 (다시) 보낸다.
import { posPluginSdk } from '@tossplace/pos-plugin-sdk'
import { forgetLoadedCart, peekLoadedCartKeys } from './erpCarts.js'

const listEl = document.getElementById('settled-cart-list')

let deps = null
let lastCarts = []
const confirming = new Map() // `${action}:${cartId}` -> timeoutId
const busy = new Set()
let showHidden = false
// 한 번 눌러 바로 실행해도 되는 동작(되돌릴 수 있고 손님에게 아무것도 안 간다).
const ONE_TAP = new Set(['hide', 'unhide'])
// SDK로 취소를 시도했다가 실패한 POS 결제. 이 카드에는 [POS에서 취소했어요] 버튼을 보여준다.
const sdkCancelFailed = new Set()
// SDK 30초 시간 제한("지연되고 있습니다")에 걸린 POS 결제. 취소가 실패한 게 아니라 결과를 모르는 상태라서
// sdkCancelFailed와 따로 둔다 -- 그쪽에 넣으면 [결제 취소]가 사라져, 실제로는 취소 안 된 결제를 여기서 다시 못 취소한다.
const sdkCancelTimedOut = new Set()
// 프론트 취소(refunding)가 이 시간보다 오래 갇혀 있으면 [취소 중 풀기]를 보여준다. 서버가 같은 10분을 다시 확인한다.
const STUCK_REFUND_MS = 10 * 60 * 1000

export function initSettledCarts(injected) {
  deps = injected
  if (listEl) listEl.addEventListener('click', handleClick)
}

export function applySettledCarts(carts) {
  if (!deps) return
  lastCarts = Array.isArray(carts) ? carts : []
  // 동작이 진행 중이어도 다시 그린다. 예전에는 busy가 하나라도 있으면 그리지 않았는데, 결제 취소는 SDK 응답을
  // 최대 30초 기다리므로 그 사이 다른 카드의 변화(프론트 취소 완료 등)가 화면에 안 떴다. 눌린 카드의 버튼은
  // button()이 busy를 보고 disabled로 그리고, 두 번 누르기 확인(confirming)은 render와 별개로 들고 있어 유지된다.
  render()
}

function formatWon(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`
}

// 오늘이면 시각만, 그 전이면 날짜까지 보여준다(최근 7일 목록이라 날짜가 섞인다).
function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  const sameDay = d.toDateString() === new Date().toDateString()
  const opts = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  return new Intl.DateTimeFormat('ko-KR', opts).format(d)
}

const METHOD_LABEL = { CARD: '카드', CASH: '현금', BARCODE: '간편결제' }

// 진행 중인 프론트 취소. 서버가 숨기기를 거부(409)하므로 숨김 상태와 관계없이 늘 목록에 보이고 [숨기기]도 없다.
function isRefundInProgress(cart) {
  return cart.status === 'refund_requested' || cart.status === 'refunding'
}

// 'refunding'이 10분 넘게 풀리지 않았으면 갇힌 분(分) 수, 아니면 null. 프론트 플러그인이 카드 취소 도중 꺼지면
// 서버는 그 주문을 계속 'refunding'으로 둔다. 시작 시각은 refundStartedAt, 옛 서버에는 없어 refundRequestedAt으로 대신한다.
function stuckRefundMinutes(cart) {
  if (cart.status !== 'refunding') return null
  const since = Date.parse(cart.refundStartedAt || cart.refundRequestedAt || '')
  if (!Number.isFinite(since)) return null
  const elapsed = Date.now() - since
  return elapsed > STUCK_REFUND_MS ? Math.floor(elapsed / 60000) : null
}

function statusLabel(cart) {
  switch (cart.status) {
    case 'loaded': return { text: 'POS에 담김 · 결제 전', cls: 'pending' }
    case 'paid': return { text: '결제 완료', cls: 'paid' }
    case 'refund_requested': return { text: '프론트 취소 대기', cls: 'pending' }
    case 'refunding': {
      const minutes = stuckRefundMinutes(cart)
      return minutes === null
        ? { text: '프론트에서 취소 중', cls: 'paying' }
        : { text: `프론트에서 취소 중 · ${minutes}분째`, cls: 'paying stuck' }
    }
    case 'refunded': return { text: '취소됨', cls: 'refunded' }
    default: return { text: cart.status, cls: '' }
  }
}

function button(action, cart, label, confirmLabel, extraClass = '') {
  const key = `${action}:${cart.id}`
  const isConfirming = confirming.has(key)
  return `<button class="settled-action ${extraClass}${isConfirming ? ' confirming' : ''}" type="button"
            data-action="${action}" data-cart-id="${deps.escapeHtml(cart.id)}"
            ${busy.has(cart.id) ? 'disabled' : ''}>${isConfirming ? confirmLabel : label}</button>`
}

// 정리·영수증 버튼(결제 취소 버튼과 줄을 나눠 실수로 누르지 않게 한다).
const RECEIPT_LABEL = { sent: '영수증 보냄', failed: '영수증 발송 실패', no_reservation: '예약 없음 · 영수증 못 보냄', no_phone: '연락처 없음' }

function toolsFor(cart) {
  // 결제 전(POS에 담김) 건은 POS에서 결제하거나 비우면 된다 -- 여기서 숨기거나 지울 대상이 아니다.
  if (cart.status === 'loaded') return ''
  const parts = []
  if (cart.status === 'paid') {
    parts.push(button('receipt', cart, cart.receiptStatus === 'sent' ? '영수증 다시 보내기' : '영수증 보내기', '손님께 영수증 보낼까요?'))
  }
  if (isRefundInProgress(cart)) {
    // 진행 중인 취소는 숨길 수 없다. 숨긴 채 진행 중이 된 건만 다시 보이게 할 수 있다.
    if (cart.hidden) parts.push(button('unhide', cart, '다시 보이기', ''))
  } else {
    parts.push(cart.hidden ? button('unhide', cart, '다시 보이기', '') : button('hide', cart, '숨기기', ''))
  }
  if (cart.status === 'paid' || cart.status === 'refunded') {
    parts.push(button('delete', cart, '삭제', '정말 삭제할까요?', 'danger'))
  }
  return parts.join('')
}

function actionsFor(cart) {
  if (cart.status === 'refunded') return ''

  // POS에 담았지만 아직 결제하지 않은 주문. 잘못 담았을 때 전산 주문 목록으로 되돌린다. 이 탭앱이 담은
  // 품목(기록에 남은 key)은 POS [주문]에서도 함께 지운다(unloadCart).
  if (cart.status === 'loaded') {
    return button('unload', cart, '담기 취소(다시 대기로)', '정말 되돌릴까요? POS [주문]의 품목도 함께 지웁니다', 'wrap')
  }

  // 'refunding'은 프론트 플러그인이 카드를 취소하는 중이라 손댈 게 없다. 10분 넘게 갇힌 경우만 풀 수 있다.
  if (cart.status === 'refunding') {
    return stuckRefundMinutes(cart) === null
      ? ''
      : button('force-release', cart, '취소 중 풀기', '손님 카드가 실제로 취소되지 않았는지 확인했나요?', 'danger wrap')
  }

  if (cart.payTarget === 'pos' && cart.status === 'paid') {
    const shared = cart.sharedPaymentCount > 1
    const cancelConfirm = shared ? `함께 결제된 ${cart.sharedPaymentCount}건 모두 취소?` : '정말 결제 취소할까요?'
    const hasIds = Boolean(cart.tossPaymentId && cart.tossOrderId)
    const parts = []
    if (hasIds && !sdkCancelFailed.has(cart.id)) {
      parts.push(button('pos-cancel', cart, '결제 취소', cancelConfirm, 'danger'))
    }
    // 시간 초과는 두 버튼을 함께 둔다: 취소가 됐을 수도 안 됐을 수도 있어서, 안 됐으면 다시 취소하고 됐으면 기록한다.
    if (!hasIds || sdkCancelFailed.has(cart.id) || sdkCancelTimedOut.has(cart.id)) {
      parts.push(button('pos-recorded', cart, 'POS에서 취소했어요', '취소 완료로 기록할까요?'))
    }
    return parts.join('')
  }

  if (cart.payTarget === 'front' && cart.status === 'paid') {
    if (cart.cashWithoutReceipt) return button('cash-refund', cart, '현금 환불 처리', '현금을 돌려줬나요?', 'danger')
    return button('front-request', cart, '프론트에서 취소', '프론트로 취소 요청할까요?', 'danger')
  }

  if (cart.status === 'refund_requested') return button('front-withdraw', cart, '취소 요청 철회', '요청을 철회할까요?')
  return ''
}

function render() {
  if (!listEl) return
  // 진행 중인 취소는 숨겨 둔 건이라도 보여준다 -- 갇혀도 [취소 중 풀기]를 누를 카드가 안 보이면 풀 방법이 없다.
  const isHiddenAway = (c) => c.hidden && !isRefundInProgress(c)
  const hiddenCount = lastCarts.filter(isHiddenAway).length
  const visible = showHidden ? lastCarts : lastCarts.filter((c) => !isHiddenAway(c))
  const hiddenBar = hiddenCount
    ? `<button class="settled-hidden-toggle" type="button" data-toggle-hidden="1">${showHidden ? '숨긴 결제 감추기' : `숨긴 결제 ${hiddenCount}건 보기`}</button>`
    : ''
  // 비어 있어도 칸은 남긴다 -- 숨기면 결제 취소를 어디서 하는지 찾을 수 없다.
  if (!visible.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">✓</div>
        <div class="empty-title">최근 결제한 전산 주문이 없습니다</div>
        <div class="empty-copy">전산 주문을 결제하면 이곳에 표시되고, 여기서 취소할 수 있습니다.</div>
      </div>
    ` + hiddenBar
    return
  }
  listEl.innerHTML = hiddenBar + visible
    .map((cart) => {
      const s = statusLabel(cart)
      const where = cart.payTarget === 'front'
        ? `프론트${cart.paymentMethod ? ` · ${METHOD_LABEL[cart.paymentMethod] || cart.paymentMethod}` : ''}`
        : 'POS'
      const items = (cart.items || [])
        .map((i) => `${deps.escapeHtml(i.name)} ×${Number(i.quantity) || 0}`)
        .join(', ')
      const actions = actionsFor(cart)
      const tools = toolsFor(cart)
      const receipt = cart.receiptStatus ? RECEIPT_LABEL[cart.receiptStatus] || '' : ''
      return `
        <article class="erp-cart-item settled-cart-item${cart.status === 'refunded' ? ' is-refunded' : ''}${cart.hidden ? ' is-hidden' : ''}">
          <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')} · ${cart.paidAt ? `${formatTime(cart.paidAt)} 결제` : `${formatTime(cart.loadedAt)} POS에 담음`}</div>
          <div class="erp-cart-head">
            <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
            <span class="settled-status ${s.cls}">${s.text}</span>
            ${cart.tossVerified ? '<span class="settled-verified" title="토스 결제내역에서 같은 결제를 확인했습니다">토스 확인</span>' : ''}
          </div>
          <div class="erp-cart-summary">${where}${items ? ` · ${items}` : ''}</div>
          <div class="erp-cart-total">${formatWon(cart.totalAmount)}</div>
          ${cart.status === 'refunded' && cart.refundNote ? `<div class="erp-cart-memo">${deps.escapeHtml(cart.refundNote)} · ${formatTime(cart.refundedAt)}</div>` : ''}
          ${cart.errorMessage && cart.status !== 'refunded' ? `<div class="erp-cart-memo settled-error">${deps.escapeHtml(cart.errorMessage)}</div>` : ''}
          ${sdkCancelTimedOut.has(cart.id) && cart.status === 'paid' ? '<div class="erp-cart-memo settled-warn">POS [주문]에서 이 결제가 취소됐는지 확인해주세요. 취소됐으면 [POS에서 취소했어요]를, 아니면 [결제 취소]를 다시 눌러주세요.</div>' : ''}
          ${receipt ? `<div class="erp-cart-memo">${deps.escapeHtml(receipt)}</div>` : ''}
          ${actions ? `<div class="erp-cart-actions">${actions}</div>` : ''}
          ${tools ? `<div class="erp-cart-actions settled-tools">${tools}</div>` : ''}
        </article>
      `
    })
    .join('')
}

function handleClick(e) {
  if (e.target.closest('[data-toggle-hidden]')) {
    showHidden = !showHidden
    render()
    return
  }
  const btn = e.target.closest('button.settled-action')
  if (!btn || btn.disabled) return
  const { action, cartId } = btn.dataset
  if (ONE_TAP.has(action)) {
    run(action, cartId)
    return
  }
  const key = `${action}:${cartId}`
  if (confirming.has(key)) {
    clearTimeout(confirming.get(key))
    confirming.delete(key)
    run(action, cartId)
    return
  }
  // 화면에 "정말?"이 여러 개 떠 있으면 헷갈린다 -- 다른 확인 상태는 취소한다.
  for (const t of confirming.values()) clearTimeout(t)
  confirming.clear()
  confirming.set(key, setTimeout(() => {
    confirming.delete(key)
    render()
  }, 3000))
  render()
}

async function post(path, body) {
  try {
    const res = await deps.apiPost(path, body)
    if (!res.ok && res.status === 401) deps.onUnauthorized(res.body.error)
    return res
  } catch {
    return { ok: false, status: 0, body: { error: '서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.' } }
  }
}

function markLocal(cartIds, patch) {
  const ids = new Set(cartIds)
  lastCarts = lastCarts.map((c) => (ids.has(c.id) ? { ...c, ...patch } : c))
}

async function run(action, cartId) {
  const cart = lastCarts.find((c) => c.id === cartId)
  if (!cart) return
  busy.add(cartId)
  render()
  try {
    if (action === 'pos-cancel') return await cancelOnPos(cart)
    if (action === 'pos-recorded') return await recordRefund(cart, 'pos', 'POS 결제 취소를 기록했습니다.')
    if (action === 'cash-refund') return await recordRefund(cart, 'cash', '현금 환불로 기록했습니다.')
    if (action === 'front-request') {
      const res = await post(`/api/pos/erp-carts/${cartId}/refund-request`)
      if (!res.ok) return deps.notify('error', res.body.error || '취소를 요청하지 못했습니다.')
      markLocal([cartId], { status: 'refund_requested' })
      return deps.notify('success', '프론트로 취소를 요청했습니다. 손님이 프론트에서 결제한 카드를 꽂으면 취소됩니다.')
    }
    if (action === 'hide' || action === 'unhide') {
      const res = await post(`/api/pos/erp-carts/${cartId}/hide`, { hidden: action === 'hide' })
      if (!res.ok) return deps.notify('error', res.body.error || '처리하지 못했습니다.')
      markLocal([cartId], { hidden: action === 'hide' })
      return deps.notify('success', action === 'hide' ? '숨겼습니다. 맨 위 [숨긴 결제 보기]로 다시 볼 수 있습니다.' : '다시 보이게 했습니다.')
    }
    if (action === 'delete') {
      const res = await post(`/api/pos/erp-carts/${cartId}/delete`)
      if (!res.ok) return deps.notify('error', res.body.error || '삭제하지 못했습니다.')
      lastCarts = lastCarts.filter((c) => c.id !== cartId)
      return deps.notify('success', '삭제했습니다.')
    }
    if (action === 'receipt') {
      const res = await post(`/api/pos/erp-carts/${cartId}/resend-receipt`)
      if (res.body?.receipt) markLocal([cartId], { receiptStatus: res.body.receipt })
      if (!res.ok) return deps.notify('error', res.body.error || '영수증을 보내지 못했습니다.')
      return deps.notify('success', '손님께 영수증을 보냈습니다.')
    }
    if (action === 'front-withdraw') {
      const res = await post(`/api/pos/erp-carts/${cartId}/refund-withdraw`)
      if (!res.ok) return deps.notify('error', res.body.error || '철회하지 못했습니다.')
      markLocal([cartId], { status: 'paid' })
      return deps.notify('success', '취소 요청을 철회했습니다.')
    }
    if (action === 'unload') return await unloadCart(cartId)
    if (action === 'force-release') {
      // 409(10분이 안 됐거나 이미 풀림)는 서버 문구를 그대로 보여준다.
      const res = await post(`/api/pos/erp-carts/${cartId}/force-release`)
      if (!res.ok) return deps.notify('error', res.body.error || '취소 중 상태를 풀지 못했습니다.')
      markLocal([cartId], { status: 'paid', refundStartedAt: null })
      return deps.notify('success', '취소 중 상태를 풀었습니다. 다시 취소하려면 [프론트에서 취소]를 눌러주세요.')
    }
  } finally {
    busy.delete(cartId)
    render()
  }
}

// 서버를 먼저 되돌리고(실패하면 POS 장바구니는 그대로 둔다) 그다음 이 탭앱이 담은 품목만 지운다. 지우기 전에
// 장바구니를 읽어 아직 남아 있는 key만 지운다 -- 직원이 이미 지웠거나 결제로 비워진 품목을 다시 건드리지 않는다.
async function unloadCart(cartId) {
  const keys = peekLoadedCartKeys(cartId)
  let present = []
  if (keys.length) {
    try {
      const draft = await posPluginSdk.draftOrder.get()
      const inDraft = new Set((draft?.lineItems || []).map((li) => li && li.key).filter(Boolean))
      present = keys.filter((key) => inDraft.has(key))
    } catch {
      present = []
    }
  }
  const res = await post(`/api/pos/erp-carts/${cartId}/unload`)
  // 409인데 이미 pending이면 다른 단말기가 먼저 되돌린 것이다 -- 완료로 보고 이 단말기의 품목만 정리한다.
  const alreadyPending = res.status === 409 && res.body?.status === 'pending'
  if (!res.ok && !alreadyPending) return deps.notify('error', res.body.error || '전산 주문 목록으로 되돌리지 못했습니다.')
  lastCarts = lastCarts.filter((c) => c.id !== cartId)
  // 전산 주문 목록 쪽에 남은 "POS에 담는 중/결제 대기" 기록을 지우고 목록을 새로 불러온다(erpCarts.js).
  forgetLoadedCart(cartId)
  let failed = 0
  for (const key of present) {
    try {
      await posPluginSdk.draftOrder.deleteLineItem(key)
    } catch {
      failed += 1
    }
  }
  if (!present.length) {
    return deps.notify('success', '전산 주문 목록으로 되돌렸습니다. POS [주문]에 이 품목이 남아 있으면 지워주세요.')
  }
  if (failed) {
    return deps.notify('error', `전산 주문 목록으로 되돌렸지만 POS 품목 ${failed}개를 지우지 못했습니다. POS [주문]에서 직접 지워주세요.`)
  }
  return deps.notify('success', 'POS [주문]에서 품목을 지우고 전산 주문 목록으로 되돌렸습니다.')
}

async function cancelOnPos(cart) {
  sdkCancelTimedOut.delete(cart.id)
  try {
    await posPluginSdk.payment.cancel({ id: cart.tossOrderId }, { id: cart.tossPaymentId })
  } catch (e) {
    // SDK는 30초 안에 응답이 없으면 "지연되고 있습니다"라는 오류를 던진다. 취소가 거절된 게 아니라 결과를 모르는
    // 것이다 -- 실제로는 취소됐을 수 있다. 이걸 "탭앱에서 취소가 안 되는 결제"(아래)로 취급하면 [결제 취소]가 사라져
    // 취소 안 된 결제를 다시 못 취소하고, 반대로 [POS에서 취소했어요]만 보이면 확인 없이 취소 완료로 기록하기 쉽다.
    // 그래서 두 버튼을 모두 보여주고 POS [주문]에서 먼저 확인하게 한다.
    if (String(e?.message || e).includes('지연되고 있습니다')) {
      sdkCancelTimedOut.add(cart.id)
      deps.notify(
        'error',
        `POS [주문]에서 이 결제가 취소됐는지 확인해주세요. 취소됐으면 [POS에서 취소했어요]를 눌러주세요. (${e?.message || e})`
      )
      return
    }
    // 탭앱에서 바로 취소가 안 되는 결제다. 직원이 POS에서 직접 취소하고 기록하게 한다.
    sdkCancelFailed.add(cart.id)
    deps.notify(
      'error',
      `여기서 바로 취소하지 못했습니다. POS [주문]에서 이 결제를 직접 취소한 뒤 [POS에서 취소했어요]를 눌러주세요. (${e?.message || e})`
    )
    return
  }
  // 결제는 이미 취소됐다. 기록이 실패해도 토스 취소 웹훅이 오면 서버가 맞춘다.
  await recordRefund(cart, 'pos', '결제를 취소했습니다.')
}

async function recordRefund(cart, method, successMessage) {
  const res = await post(`/api/pos/erp-carts/${cart.id}/refunded`, { method })
  if (!res.ok) {
    deps.notify('error', res.body.error || '취소를 기록하지 못했습니다. 잠시 후 [POS에서 취소했어요]로 다시 기록해주세요.')
    if (method === 'pos') sdkCancelFailed.add(cart.id)
    return
  }
  markLocal(res.body.refundedCartIds || [cart.id], { status: 'refunded', refundNote: method === 'cash' ? '현금 환불(기록만)' : 'POS에서 결제 취소', refundedAt: new Date().toISOString() })
  const extra = (res.body.refundedCartIds || []).length > 1 ? ` 함께 결제된 ${res.body.refundedCartIds.length}건이 모두 취소로 기록됐습니다.` : ''
  deps.notify('success', `${successMessage}${extra}`)
}
