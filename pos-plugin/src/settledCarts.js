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
//
// POS에 담김(결제 전) 카드:
//   - [POS에서 결제했어요]: 결제는 했는데 탭앱이 전산 주문과 맞추지 못한 경우(다른 POS 상품을 함께 결제, 같은 내용의
//     주문이 둘, 할인 등). 이 단말기에 남겨 둔 '맞추지 못한 POS 결제'(erpCarts.js) 중 하나를 골라 결제 완료로 기록한다.
//   - [담기 취소]: 잘못 담았을 때 전산 주문 목록으로 되돌린다. 서버는 담은 단말기에서만 받는다.
import { posPluginSdk } from '@tossplace/pos-plugin-sdk'
import {
  forgetLoadedCart,
  forgetPaidCart,
  listUnmatchedPayments,
  peekLoadedRecord,
  removeUnmatchedPayment,
} from './erpCarts.js'

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
// [POS에서 결제했어요]로 결제를 고르는 중인 카드와 고른 결제. 폴링이 목록을 다시 그려도 고르던 상태가 남아야 한다.
let paidPicker = null // { cartId, selected: paymentId | null }
// 서버가 "다른 단말기에서 담은 주문"이라며 담기 취소를 거절했지만, 이제는 여기서 되돌려도 된다고(canForceAfterSec 0)
// 답한 카드. 이 카드에만 [그래도 되돌리기]를 따로 보여준다.
const forceUnloadAllowed = new Set()
// 단말기 시계와 서버 시계(loadedAt)가 어긋날 수 있어서, "담은 뒤의 결제"를 가를 때 이만큼 앞선 결제까지 넣는다.
const CLOCK_SKEW_MS = 5 * 60 * 1000
const NO_UNMATCHED_MESSAGE =
  '이 단말기에는 전산 주문과 맞추지 못한 POS 결제가 없습니다. POS [주문]에서 이 주문이 결제됐는지 확인해주세요. ' +
  '다른 단말기에서 결제했다면 그 단말기의 [최근 결제]에서 눌러주세요.'
const DOUBLE_PAID_MESSAGE = '이 주문은 이미 다른 결제로 결제됐습니다. 이중 결제인지 POS [주문]에서 확인하세요.'
const CLOSED_LABEL = { dismissed: '지워진', failed: '실패 처리된', cancelled: '취소된', refunded: '환불된', expired: '만료된' }

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

// 이 카드를 담은 뒤 이 단말기에서 생긴, 전산 주문과 맞추지 못한 POS 결제(최근 것부터). 담은 시각을 모르면 전부 보여준다.
function unmatchedAfterLoad(cart) {
  const since = Date.parse(cart.loadedAt || '')
  const list = listUnmatchedPayments()
  const after = Number.isFinite(since) ? list.filter((p) => p.at >= since - CLOCK_SKEW_MS) : list
  return after.slice().sort((a, b) => b.at - a.at)
}

// 담기 취소 전에 "이미 결제됐을 수 있다"고 경고할지. 담은 뒤 맞추지 못한 결제가 있거나, 이 단말기 기록의 품목이
// POS 장바구니에서 사라졌으면(결제로 비워졌을 수 있다) 경고한다. 결제된 주문을 되돌리면 다시 결제 대기가 되어
// 두 번 결제될 수 있다.
function mayAlreadyBePaid(cart) {
  if (unmatchedAfterLoad(cart).length) return true
  const record = peekLoadedRecord(cart.id)
  return Boolean(record && record.goneAt)
}

function actionsFor(cart) {
  if (cart.status === 'refunded') return ''

  // POS에 담았지만 결제 통보가 없는 주문. [POS에서 결제했어요]는 결제했는데 맞추지 못한 경우, [담기 취소]는 잘못 담았을 때
  // 전산 주문 목록으로 되돌린다(이 탭앱이 담은 품목은 POS [주문]에서도 함께 지운다, unloadCart).
  if (cart.status === 'loaded') {
    const unloadConfirm = mayAlreadyBePaid(cart)
      ? '이미 결제됐을 수 있습니다. 결제했다면 [POS에서 결제했어요]를 누르세요. 그래도 되돌릴까요?'
      : '정말 되돌릴까요? POS [주문]의 품목도 함께 지웁니다'
    const parts = [
      button('pos-paid', cart, 'POS에서 결제했어요', '결제한 내역을 고를까요?', 'wrap'),
      button('unload', cart, '담기 취소(다시 대기로)', unloadConfirm, 'wrap'),
    ]
    if (forceUnloadAllowed.has(cart.id)) {
      // 담은 단말기의 장바구니에는 품목이 그대로 남는다. 거기서 결제되면 이중 결제라 따로, 더 분명하게 묻는다.
      parts.push(button('unload-force', cart, '그래도 되돌리기', '담은 단말기에서 결제하지 않았고 품목도 지웠나요?', 'danger wrap'))
    }
    return parts.join('')
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

// [POS에서 결제했어요]를 확인한 뒤 카드 안에 펼치는 고르기 칸. 직원이 POS [주문]의 결제 내역과 시각·금액·품목을
// 맞춰 보고 고른다. 하나뿐이면 미리 골라 둔다(openPaidPicker).
function pickerHtml(cart) {
  if (!paidPicker || paidPicker.cartId !== cart.id || cart.status !== 'loaded') return ''
  const id = deps.escapeHtml(cart.id)
  const close = `<button class="settled-action paid-pick-close" type="button" data-cart-id="${id}">닫기</button>`
  const options = unmatchedAfterLoad(cart)
  if (!options.length) {
    return `<div class="paid-picker"><div class="erp-cart-memo settled-warn">${deps.escapeHtml(NO_UNMATCHED_MESSAGE)}</div><div class="erp-cart-actions">${close}</div></div>`
  }
  const rows = options.map((p) => {
    const selected = paidPicker.selected === p.paymentId
    const titles = (p.titles || []).join(', ')
    return `<button class="paid-pick-option${selected ? ' selected' : ''}" type="button" aria-pressed="${selected}"
              data-cart-id="${id}" data-payment-id="${deps.escapeHtml(p.paymentId)}">
              <span class="paid-pick-time">${formatTime(p.at)}</span>
              <span class="paid-pick-amount">${p.amount === null ? '금액 확인 불가' : formatWon(p.amount)}</span>
              <span class="paid-pick-titles">${titles ? deps.escapeHtml(titles) : '품목 확인 불가'}</span>
            </button>`
  }).join('')
  const canSubmit = Boolean(paidPicker.selected) && options.some((p) => p.paymentId === paidPicker.selected) && !busy.has(cart.id)
  return `
    <div class="paid-picker">
      <div class="paid-picker-title">이 단말기에서 전산 주문과 맞추지 못한 결제입니다. POS [주문]의 결제 시각·금액·품목과 맞춰 보고 이 주문의 결제를 골라주세요.</div>
      ${rows}
      <div class="erp-cart-actions">
        <button class="settled-action paid-pick-submit" type="button" data-cart-id="${id}" ${canSubmit ? '' : 'disabled'}>이 결제로 기록</button>
        ${close}
      </div>
    </div>`
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
          ${cart.status === 'loaded' && paidPicker?.cartId !== cart.id && unmatchedAfterLoad(cart).length ? '<div class="erp-cart-memo settled-warn">담은 뒤 이 단말기에서 전산 주문과 맞추지 못한 POS 결제가 있습니다. 이 주문을 결제했다면 [POS에서 결제했어요]를 눌러주세요.</div>' : ''}
          ${receipt ? `<div class="erp-cart-memo">${deps.escapeHtml(receipt)}</div>` : ''}
          ${actions ? `<div class="erp-cart-actions">${actions}</div>` : ''}
          ${pickerHtml(cart)}
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
  // [POS에서 결제했어요]의 고르기 칸. 결제를 고르는 것과 닫는 것은 한 번에 된다(되돌릴 수 있고 아무것도 보내지 않는다).
  // 기록은 이미 두 번 눌러 확인한 뒤에 펼친 칸이라 [이 결제로 기록]은 한 번에 보낸다.
  const option = e.target.closest('button.paid-pick-option')
  if (option) {
    const { cartId, paymentId } = option.dataset
    if (paidPicker && paidPicker.cartId === cartId && !busy.has(cartId)) {
      paidPicker = { cartId, selected: paymentId }
      render()
    }
    return
  }
  const closeBtn = e.target.closest('button.paid-pick-close')
  if (closeBtn) {
    paidPicker = null
    render()
    return
  }
  const submitBtn = e.target.closest('button.paid-pick-submit')
  if (submitBtn) {
    if (!submitBtn.disabled) run('pos-paid-submit', submitBtn.dataset.cartId)
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
    if (action === 'pos-paid') return openPaidPicker(cart)
    if (action === 'pos-paid-submit') return await submitManualPaid(cart)
    if (action === 'unload') return await unloadCart(cartId)
    if (action === 'unload-force') return await unloadCart(cartId, { force: true })
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

// [POS에서 결제했어요]를 두 번 눌러 확인한 뒤 부른다. 고를 결제가 없으면 칸을 펼치지 않고 안내한다.
function openPaidPicker(cart) {
  const record = peekLoadedRecord(cart.id)
  if (record && record.paymentId) {
    // 이 단말기가 이미 이 주문의 결제를 맞췄고 전산 통보만 밀려 있다. 다른 결제를 골라 기록하면 엉뚱한 결제로 남는다.
    paidPicker = null
    return deps.notify('error', '이 단말기에서 이 주문의 결제를 이미 확인했고 전산에 알리는 중입니다. 따로 기록하지 말고 잠시 기다려주세요.')
  }
  const options = unmatchedAfterLoad(cart)
  if (!options.length) {
    paidPicker = null
    return deps.notify('error', NO_UNMATCHED_MESSAGE)
  }
  paidPicker = { cartId: cart.id, selected: options.length === 1 ? options[0].paymentId : null }
}

// 고른 POS 결제로 이 주문을 결제 완료로 기록한다(/paid, manual). 서버가 이미 다른 결제로 결제된 주문이라고 하면
// 이중 결제를 확인하게 하고, 그 결제는 다른 주문에 쓸 수 있게 목록에 남긴다.
async function submitManualPaid(cart) {
  const picker = paidPicker && paidPicker.cartId === cart.id ? paidPicker : null
  const payment = picker && unmatchedAfterLoad(cart).find((p) => p.paymentId === picker.selected)
  if (!payment) return deps.notify('error', '기록할 결제를 먼저 골라주세요.')
  // 고르는 사이 이 단말기가 그 주문의 결제를 자동으로 맞췄다면 그쪽이 맞다(openPaidPicker와 같은 이유).
  const record = peekLoadedRecord(cart.id)
  if (record && record.paymentId) {
    paidPicker = null
    return deps.notify('error', '이 단말기에서 이 주문의 결제를 이미 확인했고 전산에 알리는 중입니다. 따로 기록하지 말고 잠시 기다려주세요.')
  }
  const res = await post(`/api/pos/erp-carts/${cart.id}/paid`, { paymentId: payment.paymentId, orderId: payment.orderId, manual: true })
  if (!res.ok) {
    if (res.status === 401) return
    const code = res.body && res.body.code
    if (res.status === 409 && code === 'ALREADY_PAID_OTHER') {
      paidPicker = null
      return deps.notify('error', DOUBLE_PAID_MESSAGE)
    }
    if (res.status === 409 && code === 'ALREADY_CLOSED') {
      paidPicker = null
      const label = CLOSED_LABEL[res.body.status] || '닫힌'
      return deps.notify('error', `전산에서 이미 ${label} 주문이라 기록하지 않았습니다. 실제로 결제했다면 POS [주문] 내역과 전산을 대조해주세요.`)
    }
    return deps.notify('error', res.body.error || '결제 완료로 기록하지 못했습니다. 잠시 후 다시 시도해주세요.')
  }
  removeUnmatchedPayment(payment.paymentId)
  // 이 단말기에 남은 결제 대기 기록을 지운다 -- 남겨 두면 나중의 다른 결제와 또 맞을 수 있다.
  forgetPaidCart(cart.id)
  paidPicker = null
  markLocal([cart.id], { status: 'paid', paidAt: new Date().toISOString(), tossPaymentId: payment.paymentId, tossOrderId: payment.orderId })
  return deps.notify('success', '고른 POS 결제로 결제 완료를 기록했습니다.')
}

// 서버를 먼저 되돌리고(실패하면 POS 장바구니는 그대로 둔다) 그다음 이 탭앱이 담은 품목만 지운다. 지우기 전에
// 장바구니를 읽어 아직 남아 있는 key만 지운다 -- 직원이 이미 지웠거나 결제로 비워진 품목을 다시 건드리지 않는다.
//
// 막는 경우와 서버가 거절하는 경우:
//   - 이 단말기 기록에 결제(paymentId)가 붙어 있으면 요청하지 않는다. 결제는 끝났고 전산 통보만 밀린 건이라, 되돌리면
//     받은 돈이 기록에서 사라지고 주문이 다시 결제 대기가 된다(다시 결제하면 이중 청구).
//   - 담을 때의 표식(attemptId)을 함께 보낸다. 다른 단말기가 담은 주문이면 서버가 LOADED_ON_OTHER_DEVICE로 거절한다 --
//     그 단말기의 장바구니와 결제 대기 기록은 그대로라서 거기서 결제되면 이중 결제다. 담은 단말기를 쓸 수 없어 충분히
//     시간이 지났으면(canForceAfterSec 0) [그래도 되돌리기](force)를 따로 두 번 눌러 되돌릴 수 있다.
//   - 담긴 지 24시간이 지난 주문은 되돌려도 전산 주문 목록에 다시 뜨지 않는다. 서버는 대신 주문을 닫고 status
//     'dismissed'로 답한다. 이 단말기의 POS 품목은 그대로 지운다.
async function unloadCart(cartId, { force = false } = {}) {
  const record = peekLoadedRecord(cartId)
  if (record && record.paymentId) {
    return deps.notify('error', '이 단말기에서 이미 결제된 주문입니다. 전산에 결제 완료를 다시 알리는 중이니 담기 취소하지 마세요.')
  }
  const keys = record ? record.keys : []
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
  const body = {}
  if (record && record.attemptId) body.attemptId = record.attemptId
  if (force) body.force = true
  const res = await post(`/api/pos/erp-carts/${cartId}/unload`, body)
  if (!res.ok && res.status === 409 && res.body?.code === 'LOADED_ON_OTHER_DEVICE') {
    const wait = Number(res.body.canForceAfterSec)
    if (wait === 0) {
      forceUnloadAllowed.add(cartId)
      return deps.notify(
        'error',
        '다른 단말기에서 담은 주문입니다. 담은 단말기의 [최근 결제]에서 담기 취소하는 게 안전합니다. ' +
        '그 단말기를 쓸 수 없으면, 거기서 결제하지 않았는지 확인하고 그 단말기의 품목을 지운 뒤 [그래도 되돌리기]를 눌러주세요.'
      )
    }
    forceUnloadAllowed.delete(cartId)
    const minutes = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait / 60) : null
    return deps.notify(
      'error',
      `다른 단말기에서 담은 주문입니다. 담은 단말기의 [최근 결제]에서 담기 취소해주세요.` +
      (minutes ? ` 그 단말기를 쓸 수 없으면 약 ${minutes}분 뒤에 여기서도 되돌릴 수 있습니다.` : '')
    )
  }
  // 409인데 이미 pending이면 다른 단말기가 먼저 되돌린 것이다 -- 완료로 보고 이 단말기의 품목만 정리한다.
  const alreadyPending = res.status === 409 && res.body?.status === 'pending'
  if (!res.ok && !alreadyPending) {
    if (res.status === 401) return
    return deps.notify('error', res.body.error || '전산 주문 목록으로 되돌리지 못했습니다.')
  }
  const closedStale = res.ok && res.body?.status === 'dismissed'
  forceUnloadAllowed.delete(cartId)
  if (paidPicker && paidPicker.cartId === cartId) paidPicker = null
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
  const head = closedStale
    ? '담긴 지 24시간이 지나 주문을 닫았습니다. 다시 결제하려면 전산에서 다시 보내주세요.'
    : '전산 주문 목록으로 되돌렸습니다.'
  const kind = closedStale ? 'warn' : 'success'
  if (!present.length) {
    const where = force ? '담은 단말기의 POS [주문]에 품목이 남아 있으면 그 단말기에서 지워주세요.' : 'POS [주문]에 이 품목이 남아 있으면 지워주세요.'
    return deps.notify(kind, `${head} ${where}`)
  }
  if (failed) {
    return deps.notify('error', `${head} 다만 POS 품목 ${failed}개를 지우지 못했습니다. POS [주문]에서 직접 지워주세요.`)
  }
  return deps.notify(kind, `${head} POS [주문]의 품목도 지웠습니다.`)
}

// 결제 취소 전에 POS 주문의 결제를 읽어 본다. 'paid' 이벤트는 결제 한 건마다 오고 payment.cancel도 결제 한 건만 취소한다.
// 카드 여러 장으로 나눠 결제한 주문을 여기서 취소하면 한 장만 취소되는데 전산에는 전액 환불로 기록된다 -- 나머지 카드는
// 청구된 채 남는다. 그래서 취소되지 않은 결제가 둘 이상이면 SDK 취소를 부르지 않고 POS [주문]에서 각각 취소하게 한다.
// 결제를 읽지 못해도 같은 쪽(직접 취소)으로 보낸다 -- 확인 없이 한 장만 취소하는 것보다 직원이 한 번 더 하는 쪽이 싸다.
async function readOrderPayments(orderId) {
  try {
    const order = await posPluginSdk.order.getOrder(orderId)
    return Array.isArray(order && order.payments) ? order.payments : null
  } catch (e) {
    console.error('[settled-cart] 취소 전에 POS 주문을 읽지 못했습니다.', e?.message)
    return null
  }
}

async function cancelOnPos(cart) {
  sdkCancelTimedOut.delete(cart.id)
  const payments = await readOrderPayments(cart.tossOrderId)
  const live = payments ? payments.filter((p) => p && p.state !== 'CANCELLED') : null
  if (!live) {
    sdkCancelFailed.add(cart.id)
    deps.notify('error', 'POS 주문의 결제 내역을 확인하지 못해 여기서 취소하지 않았습니다. POS [주문]에서 이 결제를 직접 취소한 뒤 [POS에서 취소했어요]를 눌러주세요.')
    return
  }
  if (live.length > 1) {
    sdkCancelFailed.add(cart.id)
    deps.notify('error', '카드 여러 장으로 나눠 결제한 건입니다. POS [주문]에서 각각 취소한 뒤 [POS에서 취소했어요]를 눌러주세요.')
    return
  }
  if (live.length === 0 || String(live[0].id) !== String(cart.tossPaymentId)) {
    // 이미 취소됐거나, 남은 결제가 전산이 아는 결제와 다르다. 여기서 엉뚱한 결제를 취소하지 않는다.
    sdkCancelFailed.add(cart.id)
    deps.notify('error', 'POS의 결제 내역이 전산 기록과 다릅니다(이미 취소됐을 수 있습니다). POS [주문]에서 확인하고 취소한 뒤 [POS에서 취소했어요]를 눌러주세요.')
    return
  }
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
