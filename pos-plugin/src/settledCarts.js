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

export function initSettledCarts(injected) {
  deps = injected
  if (listEl) listEl.addEventListener('click', handleClick)
}

export function applySettledCarts(carts) {
  if (!deps) return
  lastCarts = Array.isArray(carts) ? carts : []
  // 진행 중인 동작이 있으면 버튼이 되살아나지 않게 다시 그리지 않는다(erpCarts.js inFlight와 같은 이유).
  if (busy.size === 0) render()
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

function statusLabel(cart) {
  switch (cart.status) {
    case 'paid': return { text: '결제 완료', cls: 'paid' }
    case 'refund_requested': return { text: '프론트 취소 대기', cls: 'pending' }
    case 'refunding': return { text: '프론트에서 취소 중', cls: 'paying' }
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
  const parts = []
  if (cart.status === 'paid') {
    parts.push(button('receipt', cart, cart.receiptStatus === 'sent' ? '영수증 다시 보내기' : '영수증 보내기', '손님께 영수증 보낼까요?'))
  }
  parts.push(cart.hidden ? button('unhide', cart, '다시 보이기', '') : button('hide', cart, '숨기기', ''))
  if (cart.status === 'paid' || cart.status === 'refunded') {
    parts.push(button('delete', cart, '삭제', '정말 삭제할까요?', 'danger'))
  }
  return parts.join('')
}

function actionsFor(cart) {
  if (cart.status === 'refunded' || cart.status === 'refunding') return ''

  if (cart.payTarget === 'pos' && cart.status === 'paid') {
    const shared = cart.sharedPaymentCount > 1
    const cancelConfirm = shared ? `함께 결제된 ${cart.sharedPaymentCount}건 모두 취소?` : '정말 결제 취소할까요?'
    const parts = []
    if (cart.tossPaymentId && cart.tossOrderId && !sdkCancelFailed.has(cart.id)) {
      parts.push(button('pos-cancel', cart, '결제 취소', cancelConfirm, 'danger'))
    }
    if (!cart.tossPaymentId || !cart.tossOrderId || sdkCancelFailed.has(cart.id)) {
      parts.push(button('pos-recorded', cart, 'POS에서 취소했어요', '취소 완료로 기록할까요?'))
    }
    return parts.join('')
  }

  if (cart.payTarget === 'front' && cart.status === 'paid') {
    if (cart.cashWithoutReceipt) return button('cash-refund', cart, '현금 환불 처리', '현금을 돌려줬나요?', 'danger')
    const parts = [button('front-request', cart, '프론트에서 취소', '프론트로 취소 요청할까요?', 'danger')]
    // 실험: 페이스페이(간편결제) 건을 카드 취소 화면으로 띄워 얼굴 취소가 되는지 시험한다(서버 refundMode 참고).
    if (cart.paymentMethod === 'BARCODE') {
      parts.push(button('front-request-card', cart, '카드 취소 화면으로 시도(실험)', '실험으로 보낼까요?'))
    }
    return parts.join('')
  }

  if (cart.status === 'refund_requested') return button('front-withdraw', cart, '취소 요청 철회', '요청을 철회할까요?')
  return ''
}

function render() {
  if (!listEl) return
  const hiddenCount = lastCarts.filter((c) => c.hidden).length
  const visible = showHidden ? lastCarts : lastCarts.filter((c) => !c.hidden)
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
          <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')} · ${formatTime(cart.paidAt)} 결제</div>
          <div class="erp-cart-head">
            <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
            <span class="settled-status ${s.cls}">${s.text}</span>
            ${cart.tossVerified ? '<span class="settled-verified" title="토스 결제내역에서 같은 결제를 확인했습니다">토스 확인</span>' : ''}
          </div>
          <div class="erp-cart-summary">${where}${items ? ` · ${items}` : ''}</div>
          <div class="erp-cart-total">${formatWon(cart.totalAmount)}</div>
          ${cart.status === 'refunded' && cart.refundNote ? `<div class="erp-cart-memo">${deps.escapeHtml(cart.refundNote)} · ${formatTime(cart.refundedAt)}</div>` : ''}
          ${cart.errorMessage && cart.status !== 'refunded' ? `<div class="erp-cart-memo settled-error">${deps.escapeHtml(cart.errorMessage)}</div>` : ''}
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
    if (action === 'front-request-card') {
      const res = await post(`/api/pos/erp-carts/${cartId}/refund-request`, { mode: 'card' })
      if (!res.ok) return deps.notify('error', res.body.error || '취소를 요청하지 못했습니다.')
      markLocal([cartId], { status: 'refund_requested' })
      return deps.notify('success', '실험: 프론트에 카드 취소 화면이 뜹니다. 얼굴 취소 버튼이 보이는지 확인하고, 성공해도 손님 토스 앱에서 실제 환불을 꼭 확인하세요.')
    }
    if (action === 'front-withdraw') {
      const res = await post(`/api/pos/erp-carts/${cartId}/refund-withdraw`)
      if (!res.ok) return deps.notify('error', res.body.error || '철회하지 못했습니다.')
      markLocal([cartId], { status: 'paid' })
      return deps.notify('success', '취소 요청을 철회했습니다.')
    }
  } finally {
    busy.delete(cartId)
    render()
  }
}

async function cancelOnPos(cart) {
  try {
    await posPluginSdk.payment.cancel({ id: cart.tossOrderId }, { id: cart.tossPaymentId })
  } catch (e) {
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
