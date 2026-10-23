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
// 실제 결제라 분쟁·대사 근거가 남아야 한다). [영수증 보내기]는 이어진 접수 손님 번호로 전자영수증을 (다시) 보낸다.
//
// POS에 담김(결제 전) 카드:
//   - [POS에서 결제했어요]: 결제는 했는데 탭앱이 전산 주문과 맞추지 못한 경우(다른 POS 상품을 함께 결제, 같은 내용의
//     주문이 둘, 할인 등). 이 단말기에 남겨 둔 '맞추지 못한 POS 결제'(erpCarts.js) 중 하나를 골라 결제 완료로 기록한다.
//     한 결제로 여러 주문을 함께 계산했을 수 있어, 기록한 결제도 다른 주문의 고르기 칸에 "이미 OO에 기록한 결제"로 남는다.
//   - [담기 취소]: 잘못 담았을 때 전산 주문 목록으로 되돌린다. 서버는 담은 단말기에서만 받는다.
// POS에서 취소된 카드(24시간 안):
//   - [POS에서 다시 결제했어요]: 직원이 POS [주문]에서 결제를 취소하고 다른 카드로 다시 결제한 경우. 같은 고르기 칸으로 새 결제를
//     골라 기록하면 서버가 결제 완료로 되살린다(restored).
// 프론트 승인 경고(frontOrphan)가 있는 카드는 빨간 경고를 띄우고 [POS에서 결제했어요]·[POS에서 다시 결제했어요] 앞에서 한 번 더 확인받는다.
// 담김 카드에는 [프론트 결제로 완료 처리]를 둔다(그 승인이 이 주문의 결제인 경우). 매장이 확인한 경고(ackAt)는 접어서 보여준다.
import { posPluginSdk } from '@tossplace/pos-plugin-sdk'
import {
  canRecordFrontOrphan,
  clearFrontOrphan,
  forgetLoadedCart,
  frontOrphanAckedText,
  frontOrphanText,
  hasFrontOrphan,
  isFrontOrphanOpen,
  isRecentPosCancel,
  listUnmatchedPayments,
  noteManualPaid,
  noteRecentCarts,
  noteSelfCancel,
  openRepayWindow,
  ORPHAN_ACK_CONFIRM,
  ORPHAN_RECORD_LABEL,
  orphanRecordConfirmText,
  peekLoadedRecord,
  recordFrontOrphan,
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
// SDK 취소는 됐는데 서버 기록(/refunded)만 실패한 POS 결제(429·5xx·연결 끊김). sdkCancelFailed와 따로 둔다 -- 그쪽 카드 안내('여기서는
// 취소할 수 없는 결제예요. POS [주문]에서 직접 취소한 뒤…')를 따르면 이미 취소된 결제를 다시 취소하려 하거나, 그 사이 다른 카드로 다시
// 결제한 새 결제를 POS [주문]에서 취소해 받은 돈을 돌려줄 수 있다. 이 카드에는 [POS에서 취소했어요](기록만)만 보여준다.
const refundRecordFailed = new Set()
// 세 상태의 키는 주문과 결제의 짝이다. 예전에는 주문 ID만 써서, 옛 결제의 취소가 막힌 뒤 [POS에서 다시 결제했어요]로 새 결제가 복원돼도
// 상태가 남았다 -- 복원된 카드에 [결제 취소] 없이 [POS에서 취소했어요]만 보여, 직원이 옛 결제를 보고 누르면 받은 새 결제가 환불로 기록됐다.
// 결제가 바뀌면 키도 바뀌어 상태가 풀린다(서버도 /refunded에 실은 결제 ID가 다르면 PAYMENT_CHANGED로 막는다).
function cancelKey(cart) {
  return `${cart.id}:${cart.tossPaymentId || ''}`
}
// 프론트 취소(refunding)가 이 시간보다 오래 갇혀 있으면 [취소 중 풀기]를 보여준다. 서버가 같은 10분을 다시 확인한다.
const STUCK_REFUND_MS = 10 * 60 * 1000
// [POS에서 결제했어요]·[POS에서 다시 결제했어요]로 결제를 고르는 중인 카드와 고른 결제. 폴링이 목록을 다시 그려도 고르던 상태가 남아야 한다.
//   mode: 'loaded'(담김 주문의 결제) | 'repay'(POS에서 취소된 주문의 다시 결제)
//   sharedArmed: 다른 주문에 이미 기록한 결제를 고르고 [이 결제로 기록]을 한 번 누른 상태(한 번 더 눌러야 보낸다)
//   amountArmed: 고른 결제의 남은 금액이 주문 합계보다 적거나 모르는 결제를 고르고 [이 결제로 기록]을 한 번 누른 상태(두 금액을 보여 주고
//                한 번 더 눌러야 보낸다). 할인해서 적게 받았을 수는 있지만, 다른 손님의 작은 결제를 고르면 받지 않은 정비가 결제 완료가 된다.
let paidPicker = null // { cartId, selected: paymentId | null, mode, sharedArmed, amountArmed }
let sharedArmTimer = null
// 다른 주문에 이미 기록한 결제를 또 기록할 때(·금액이 모자란 결제를 기록할 때)의 확인 시간. 문구를 읽고 POS [주문]을 볼 시간을 준다.
const SHARED_CONFIRM_MS = 10 * 1000
// 다시 결제 후보는 원래 결제 뒤, 그리고 취소 시각보다 이만큼 앞선 때 뒤의 결제만 보여준다. 취소 웹훅이 다시 결제보다 늦게 올 수 있어
// 여유를 둔다. 예전에는 원래 결제 시각만 봐서, 며칠 전 결제를 오늘 환불한 주문에도 그 사이의 남의 판매가 다 후보로 나왔다.
const REPAY_LOOKBACK_MS = 30 * 60 * 1000
// 프론트 승인 경고가 있는 카드에서 결제를 기록하기 전에 한 번 더 확인받는 동작과 그 문구(handleClick).
const ORPHAN_GATED = new Set(['pos-paid', 'pos-repaid'])
// '프론트 승인 건'만으로는 왜 멈추는지(이중 결제 위험) 알 수 없어서 결과를 말로 적는다(erpCarts의 담기·넘기기 확인과 같은 표현).
const ORPHAN_STAGE_LABEL = '손님이 프론트에서 이미 결제했을 수 있어요. 그래도 POS 결제를 고를까요?'
const ORPHAN_CONFIRM_MS = 10 * 1000
// 확인 문구를 읽을 시간이 더 필요한 동작(프론트 승인 경고의 [확인했어요]·[프론트 결제로 완료 처리]).
const LONG_CONFIRM = new Set(['orphan-ack', 'orphan-record'])
// 서버가 "다른 단말기에서 담은 주문"이라며 담기 취소를 거절했지만, 이제는 여기서 되돌려도 된다고(canForceAfterSec 0)
// 답한 카드. 이 카드에만 [그래도 되돌리기]를 따로 보여준다.
const forceUnloadAllowed = new Set()
// 단말기 시계와 서버 시계(loadedAt)가 어긋날 수 있어서, "담은 뒤의 결제"를 가를 때 이만큼 앞선 결제까지 넣는다.
const CLOCK_SKEW_MS = 5 * 60 * 1000
const NO_UNMATCHED_MESSAGE =
  '이 단말기에는 전산 주문과 맞추지 못한 POS 결제가 없습니다. POS [주문]에서 이 주문이 결제됐는지 확인해주세요. ' +
  '다른 단말기에서 결제했다면 그 단말기의 [최근 결제]에서 [POS에서 결제했어요]를 눌러주세요.'
const NO_REPAY_MESSAGE =
  'POS에서 취소된 뒤 이 단말기에 전산 주문과 맞추지 못한 POS 결제가 없습니다. POS [주문]에서 다시 결제했는지 확인해주세요. ' +
  '다른 단말기에서 결제했다면 그 단말기의 [최근 결제]에서 [POS에서 다시 결제했어요]를 눌러주세요.'
const DOUBLE_PAID_MESSAGE = '이 주문은 이미 다른 결제로 결제됐습니다. 이중 결제인지 POS [주문]에서 확인하세요.'
// 여기서 취소는 됐는데 서버 기록만 실패한 결제의 카드 안내(refundRecordFailed).
const REFUND_RECORD_FAILED_HINT = '취소는 됐어요. [POS에서 취소했어요]로 기록해주세요.'
// 프론트 간편결제(BARCODE -- 페이스페이도 여기로 온다)의 취소 요청 안내. 플러그인 모드 프론트의 '페이스페이로 취소' 버튼은 토스 프론트 앱
// 업데이트(2026-10-26~30 예정, 늦어질 수 있음)부터 생긴다. 그 전에는 업데이트할 버전이 없어서 '앱을 업데이트하라'는 안내는 막다른 길이었다 --
// 지금 실제로 되는 방법은 플러그인을 끈 기본 프론트에서 얼굴 인식으로 취소하는 것뿐이다. 그 취소는 이 탭앱에 기록할 길이 없다(프론트 결제
// 카드에는 [POS에서 취소했어요]가 없다) -- 본사에 기록을 요청하게 한다. 앱 배포를 확인하면 이 문구를 바꾼다.
const FACEPAY_REFUND_HINT = '페이스페이 취소 버튼이 아직 없으면 프론트에서 플러그인을 끄고 기본 화면에서 얼굴 인식으로 취소해주세요. 취소 뒤 기록은 본사에 요청해주세요.'
// POS 화면은 카드 결제를 되돌리는 일을 '결제 취소'라 부른다(버튼 [결제 취소], 상태 '취소됨'). '환불'은 현금에만 쓴다.
const CLOSED_LABEL = { dismissed: '지워진', failed: '실패 처리된', cancelled: '취소된', refunded: '결제 취소된', expired: '만료된' }

export function initSettledCarts(injected) {
  deps = injected
  if (listEl) listEl.addEventListener('click', handleClick)
}

export function applySettledCarts(carts) {
  if (!deps) return
  lastCarts = Array.isArray(carts) ? carts : []
  // 이 매장에 결제 전(POS에 담김)·POS에서 취소된 전산 주문이 있는지 결제 대조 쪽에 알린다 -- 이 단말기에 기록이 없는 POS 결제를
  // 맞추지 못한 결제로 남길지 그걸로 정한다(erpCarts.handleUnrecordedPaid).
  noteRecentCarts(lastCarts)
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

// 모르는 값(서버가 새 결제수단을 보낸 경우)은 영문 내부 값을 그대로 보이지 않고 '기타'로 쓴다.
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
    // 이 목록에 올 일이 거의 없는 상태들(기록 직후 서버가 다른 상태로 답한 경우 등). 영문 내부 값('dismissed' 등)을
    // 직원에게 그대로 보이지 않는다.
    default: return { text: OTHER_STATUS_LABEL[cart.status] || '확인 필요', cls: '' }
  }
}

const OTHER_STATUS_LABEL = {
  pending: '결제 전',
  paying: '프론트 결제 중',
  dismissed: '지워짐',
  failed: '담기 실패',
  cancelled: '전산 취소',
  expired: '만료됨',
}

function button(action, cart, label, confirmLabel, extraClass = '') {
  const key = `${action}:${cart.id}`
  // 프론트 승인 경고 확인 단계(handleClick)에 들어가 있으면 그 문구를 보여준다.
  const orphanArmed = confirming.has(`orphan-${key}`)
  const isConfirming = confirming.has(key) || orphanArmed
  const text = orphanArmed ? ORPHAN_STAGE_LABEL : isConfirming ? confirmLabel : label
  return `<button class="settled-action ${extraClass}${isConfirming ? ' confirming' : ''}" type="button"
            data-action="${action}" data-cart-id="${deps.escapeHtml(cart.id)}"
            ${busy.has(cart.id) ? 'disabled' : ''}>${text}</button>`
}

// 정리·영수증 버튼(결제 취소 버튼과 줄을 나눠 실수로 누르지 않게 한다).
// 키(no_reservation 등)는 서버가 주는 receiptStatus 값이라 그대로 둔다. no_reservation은 같은 차량의 오늘 접수와 이어지지 않았다는 뜻이다.
const RECEIPT_LABEL = { sent: '영수증 보냄', failed: '영수증 발송 실패', no_reservation: '접수 연결 안 됨 · 영수증 못 보냄', no_phone: '연락처 없음 · 영수증 못 보냄' }

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
    // [숨기기]와 무엇이 다른지 확인 문구에 적는다: 삭제는 정비 이력·오늘 현황에서도 빠지고 되돌릴 수 없다(서버 소프트 삭제).
    parts.push(button('delete', cart, '삭제', '정비 이력·오늘 현황에서도 빠지고 되돌릴 수 없어요. 삭제할까요?', 'danger wrap'))
  }
  return parts.join('')
}

function idsOf(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

// 이 결제를 이미 기록한 다른 주문의 참조번호(이 카드는 빼고).
function recordedElsewhere(p, cartId) {
  const ids = idsOf(p.recordedCartIds)
  const refs = Array.isArray(p.recordedRefs) ? p.recordedRefs : []
  return ids.map((id, i) => (id === cartId ? null : String(refs[i] || id))).filter(Boolean)
}

// 이 결제와 이어졌을 수 있다고 표시된 주문인지(erpCarts.js hintCartIds).
function hintedFor(p, cartId) {
  return idsOf(p.hintCartIds).includes(cartId)
}

// 이 결제에서 아직 다른 주문에 기록하지 않은 몫(한 결제로 여러 주문을 함께 계산한 경우 이미 기록한 주문 합계를 뺀다). 금액을 모르면 null.
function availableAmount(p) {
  if (!p || typeof p.amount !== 'number' || !Number.isFinite(p.amount)) return null
  return p.amount - Math.max(0, Number(p.recordedTotal) || 0)
}

function cartTotalOf(cart) {
  const total = Number(cart && cart.totalAmount)
  return Number.isFinite(total) ? total : null
}

// 남은 몫이 주문 합계와 꼭 같은 결제인지. 미리 고르기는 이때만 한다.
function amountMatches(p, cart) {
  const available = availableAmount(p)
  const total = cartTotalOf(cart)
  return available !== null && total !== null && available === total
}

// 기록 전에 금액을 한 번 더 확인받을 결제인지(남은 몫이 주문 합계보다 적거나 금액을 모른다).
function amountShort(p, cart) {
  const available = availableAmount(p)
  const total = cartTotalOf(cart)
  return available === null || (total !== null && available < total)
}

function amountConfirmLabel(p, cart) {
  const available = availableAmount(p)
  const total = formatWon(cartTotalOf(cart) || 0)
  if (available === null) return `결제 금액을 확인할 수 없습니다(주문 합계 ${total}). POS [주문]에서 금액을 확인했으면 한 번 더 눌러주세요`
  const recorded = Math.max(0, Number(p.recordedTotal) || 0)
  const pay = recorded ? `이 결제에서 남은 ${formatWon(available)}(다른 주문에 ${formatWon(recorded)} 기록)` : `결제 금액 ${formatWon(available)}`
  return `${pay}이 주문 합계 ${total}보다 적습니다. 할인 등으로 적게 받은 게 맞으면 한 번 더 눌러주세요`
}

// 이 카드를 담은 뒤 이 단말기에서 생긴, 전산 주문과 맞추지 못한 POS 결제(최근 것부터). 담은 시각을 모르면 전부 보여준다.
// 다른 주문에 이미 기록한 결제도 넣는다(한 결제로 함께 계산한 주문). 이 주문에 이미 기록한 결제만 뺀다.
function unmatchedAfterLoad(cart) {
  const since = Date.parse(cart.loadedAt || '')
  const list = listUnmatchedPayments().filter((p) => !idsOf(p.recordedCartIds).includes(cart.id))
  const after = Number.isFinite(since) ? list.filter((p) => p.at >= since - CLOCK_SKEW_MS || hintedFor(p, cart.id)) : list
  return after.slice().sort((a, b) => b.at - a.at)
}

// POS에서 취소된 주문을 다시 결제했을 때 고를 결제. 원래 결제 뒤이면서 취소 시각 30분 전 뒤에 이 단말기에서 생긴 맞추지 못한 결제이고
// (취소 웹훅이 다시 결제보다 늦게 올 수 있어 여유를 둔다, REPAY_LOOKBACK_MS), 이 주문과 이어진 결제(hint)를 맨 앞에 둔다. 이어진 결제는
// 시각과 관계없이 넣는다. 이미 취소된 원래 결제와 이 주문에 이미 기록한 결제는 뺀다.
function repayOptions(cart) {
  const paidAt = Date.parse(cart.paidAt || '')
  const refundedAt = Date.parse(cart.refundedAt || '')
  const bounds = [
    Number.isFinite(paidAt) ? paidAt - CLOCK_SKEW_MS : null,
    Number.isFinite(refundedAt) ? refundedAt - REPAY_LOOKBACK_MS : null,
  ].filter((v) => v !== null)
  const since = bounds.length ? Math.max(...bounds) : null
  return listUnmatchedPayments()
    .filter((p) => p.paymentId !== cart.tossPaymentId && !idsOf(p.recordedCartIds).includes(cart.id))
    .filter((p) => hintedFor(p, cart.id) || since === null || p.at >= since)
    .sort((a, b) => (Number(hintedFor(b, cart.id)) - Number(hintedFor(a, cart.id))) || b.at - a.at)
}

function pickerOptions(cart) {
  return cart.status === 'loaded' ? unmatchedAfterLoad(cart) : repayOptions(cart)
}

// 고르기 칸에서 한 줄 아래에 붙이는 설명: 이미 다른 주문에 기록한 결제이거나, 이 주문과 이어졌을 수 있는 결제.
function optionNote(p, cart) {
  const elsewhere = recordedElsewhere(p, cart.id)
  if (elsewhere.length) return `이미 ${elsewhere.join(', ')}에 기록한 결제입니다. 같은 결제로 함께 계산했나요?`
  const hintRefs = (Array.isArray(p.hintRefs) ? p.hintRefs : []).map(String)
  if (p.hintKind === 'repaid') {
    // 같은 POS 주문에 다시 들어온 결제와, 결제를 취소한 뒤 새 POS 주문으로 들어온 결제(erpCarts.js repay 창)를 가른다.
    if (hintedFor(p, cart.id)) {
      return p.orderId && cart.tossOrderId && String(p.orderId) === String(cart.tossOrderId)
        ? '이 주문을 결제했던 POS 주문에 다시 들어온 결제입니다.'
        : '이 주문의 POS 결제를 취소한 뒤 들어온 결제입니다. 금액·품목이 맞는지 확인해주세요.'
    }
    return `${hintRefs.join(', ')}의 POS 결제를 취소한 뒤 들어온 결제입니다.`
  }
  if (p.hintKind === 'match') {
    return hintedFor(p, cart.id)
      ? '이 주문의 품목이 들어 있는 결제입니다(이 단말기에 담기 기록 없음).'
      : `${hintRefs.join(', ')}의 품목이 들어 있는 결제입니다.`
  }
  if (p.hintKind === 'lost') {
    return hintedFor(p, cart.id)
      ? '이 주문의 결제로 맞췄지만 전산에 알리지 못한 결제입니다.'
      : `${hintRefs.join(', ')}의 결제로 맞췄지만 전산에 알리지 못한 결제입니다.`
  }
  return ''
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
  if (cart.status === 'refunded') {
    // POS·토스 쪽 취소로 환불된 지 24시간이 안 된 POS 결제: 직원이 취소하고 다른 카드로 다시 결제했을 수 있다.
    return isRecentPosCancel(cart)
      ? button('pos-repaid', cart, 'POS에서 다시 결제했어요', '다시 결제한 내역을 고를까요?', 'wrap')
      : ''
  }

  // POS에 담았지만 결제 통보가 없는 주문. [POS에서 결제했어요]는 결제했는데 맞추지 못한 경우, [담기 취소]는 잘못 담았을 때
  // 전산 주문 목록으로 되돌린다(이 탭앱이 담은 품목은 POS [주문]에서도 함께 지운다, unloadCart).
  if (cart.status === 'loaded') {
    const unloadConfirm = mayAlreadyBePaid(cart)
      ? '이미 결제됐을 수 있습니다. 결제했다면 [POS에서 결제했어요]를 누르세요. 그래도 되돌릴까요?'
      : '정말 되돌릴까요? POS [주문]의 품목도 함께 지웁니다'
    const parts = [
      button('pos-paid', cart, 'POS에서 결제했어요', '결제한 내역을 고를까요?', 'wrap'),
      button('unload', cart, '담기 취소', unloadConfirm, 'wrap'),
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
    const cancelConfirm = shared ? `함께 결제된 ${cart.sharedPaymentCount}건 모두 결제 취소할까요?` : '정말 결제 취소할까요?'
    const hasIds = Boolean(cart.tossPaymentId && cart.tossOrderId)
    const key = cancelKey(cart)
    const parts = []
    // 취소는 됐고 기록만 실패한 결제(refundRecordFailed)에는 [결제 취소]를 두지 않는다 -- 다시 취소할 결제가 없다.
    if (hasIds && !sdkCancelFailed.has(key) && !refundRecordFailed.has(key)) {
      parts.push(button('pos-cancel', cart, '결제 취소', cancelConfirm, 'danger'))
    }
    // 시간 초과는 두 버튼을 함께 둔다: 취소가 됐을 수도 안 됐을 수도 있어서, 안 됐으면 다시 취소하고 됐으면 기록한다.
    if (!hasIds || sdkCancelFailed.has(key) || refundRecordFailed.has(key) || sdkCancelTimedOut.has(key)) {
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
// 고르기 칸이 이 카드의 상태에 맞는지(담김 주문은 'loaded', 다시 결제는 POS에서 취소된 주문).
function pickerFits(cart) {
  if (!paidPicker || paidPicker.cartId !== cart.id) return false
  return paidPicker.mode === 'repay' ? isRecentPosCancel(cart) : cart.status === 'loaded'
}

function selectedPickerPayment(cart) {
  if (!pickerFits(cart) || !paidPicker.selected) return null
  return pickerOptions(cart).find((p) => p.paymentId === paidPicker.selected) || null
}

function pickerHtml(cart) {
  if (!pickerFits(cart)) return ''
  const repay = paidPicker.mode === 'repay'
  const id = deps.escapeHtml(cart.id)
  const close = `<button class="settled-action paid-pick-close" type="button" data-cart-id="${id}">닫기</button>`
  const options = pickerOptions(cart)
  if (!options.length) {
    return `<div class="paid-picker"><div class="erp-cart-memo settled-warn">${deps.escapeHtml(repay ? NO_REPAY_MESSAGE : NO_UNMATCHED_MESSAGE)}</div><div class="erp-cart-actions">${close}</div></div>`
  }
  const rows = options.map((p) => {
    const selected = paidPicker.selected === p.paymentId
    const titles = (p.titles || []).join(', ')
    const note = optionNote(p, cart)
    return `<button class="paid-pick-option${selected ? ' selected' : ''}" type="button" aria-pressed="${selected}"
              data-cart-id="${id}" data-payment-id="${deps.escapeHtml(p.paymentId)}">
              <span class="paid-pick-time">${formatTime(p.at)}</span>
              <span class="paid-pick-amount">${p.amount === null ? '금액 확인 불가' : formatWon(p.amount)}</span>
              <span class="paid-pick-titles">${titles ? deps.escapeHtml(titles) : '품목 확인 불가'}</span>
              ${note ? `<span class="paid-pick-note">${deps.escapeHtml(note)}</span>` : ''}
            </button>`
  }).join('')
  const canSubmit = Boolean(paidPicker.selected) && options.some((p) => p.paymentId === paidPicker.selected) && !busy.has(cart.id)
  const title = repay
    ? 'POS에서 취소된 뒤 이 단말기에서 전산 주문과 맞추지 못한 결제입니다. POS [주문]에서 다시 결제한 내역과 시각·금액·품목을 맞춰 보고 골라주세요.'
    : '이 단말기에서 전산 주문과 맞추지 못한 결제입니다. POS [주문]의 결제 시각·금액·품목과 맞춰 보고 이 주문의 결제를 골라주세요.'
  const chosen = options.find((p) => p.paymentId === paidPicker.selected) || null
  const submitLabel = paidPicker.amountArmed && chosen
    ? amountConfirmLabel(chosen, cart)
    : paidPicker.sharedArmed
      ? '같은 결제로 함께 계산한 게 맞으면 한 번 더 눌러주세요'
      : repay ? '이 결제로 다시 결제 기록' : '이 결제로 기록'
  const armed = paidPicker.sharedArmed || paidPicker.amountArmed
  return `
    <div class="paid-picker">
      <div class="paid-picker-title">${title}</div>
      ${rows}
      <div class="erp-cart-actions">
        <button class="settled-action paid-pick-submit${armed ? ' confirming wrap' : ''}" type="button" data-cart-id="${id}" ${canSubmit ? '' : 'disabled'}>${deps.escapeHtml(submitLabel)}</button>
        ${close}
      </div>
    </div>`
}

// 프론트 승인 경고. 문구는 주문 상태에 따라 다르다(결제 완료·취소 카드는 "두 번 냈을 수 있으니 한쪽을 환불하세요"). 담김 카드에는
// [프론트 결제로 완료 처리]를 둔다(erpCarts.recordFrontOrphan). 매장이 확인한 경고는 한 줄로 접고 버튼을 두지 않는다.
function orphanHtml(cart) {
  if (!hasFrontOrphan(cart)) return ''
  if (!isFrontOrphanOpen(cart)) {
    return `<div class="erp-cart-memo front-orphan-acked">${deps.escapeHtml(frontOrphanAckedText(cart.frontOrphan, cart.status))}</div>`
  }
  const record = canRecordFrontOrphan(cart)
    ? button('orphan-record', cart, ORPHAN_RECORD_LABEL, deps.escapeHtml(orphanRecordConfirmText(cart.frontOrphan)), 'orphan-ack wrap')
    : ''
  return `<div class="erp-cart-memo front-orphan-warn">${deps.escapeHtml(frontOrphanText(cart.frontOrphan, cart.status))}</div>
          <div class="erp-cart-actions">${record}${button('orphan-ack', cart, '확인했어요', ORPHAN_ACK_CONFIRM, 'orphan-ack wrap')}</div>`
}

function render() {
  if (!listEl) return
  // 진행 중인 취소는 숨겨 둔 건이라도 보여준다 -- 갇혀도 [취소 중 풀기]를 누를 카드가 안 보이면 풀 방법이 없다.
  const isHiddenAway = (c) => c.hidden && !isRefundInProgress(c)
  const hiddenCount = lastCarts.filter(isHiddenAway).length
  const visible = showHidden ? lastCarts : lastCarts.filter((c) => !isHiddenAway(c))
  const hiddenBar = hiddenCount
    ? `<button class="settled-hidden-toggle" type="button" data-toggle-hidden="1">${showHidden ? '숨긴 결제 접기' : `숨긴 결제 ${hiddenCount}건 보기`}</button>`
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
        ? `프론트${cart.paymentMethod ? ` · ${METHOD_LABEL[cart.paymentMethod] || '기타'}` : ''}`
        : 'POS'
      const items = (cart.items || [])
        .map((i) => `${deps.escapeHtml(i.name)} ×${Number(i.quantity) || 0}`)
        .join(', ')
      const actions = actionsFor(cart)
      const tools = toolsFor(cart)
      const receipt = cart.receiptStatus ? RECEIPT_LABEL[cart.receiptStatus] || '' : ''
      // 프론트에서 이미 승인된 결제가 있다(서버가 주문에 기록하지 못함). 다시 결제하면 손님이 두 번 낸다(erpCarts.js frontOrphan 주석).
      const orphan = orphanHtml(cart)
      const repayHint = isRecentPosCancel(cart) && paidPicker?.cartId !== cart.id && repayOptions(cart).length
        ? '<div class="erp-cart-memo settled-warn">POS에서 취소된 뒤 이 단말기에 전산 주문과 맞추지 못한 POS 결제가 있습니다. 다른 카드로 다시 결제했다면 [POS에서 다시 결제했어요]를 눌러주세요.</div>'
        : ''
      // 꼭 따라야 할 지시는 몇 초 뒤 사라지는 토스트에만 두지 않고 카드에도 남긴다(흐름 QA #11).
      //   - 여기서 취소할 수 없는 POS 결제(나눠 결제·금액 확인 불가 등): POS [주문]에서 직접 취소한 뒤 기록해야 한다.
      //   - 여기서 취소는 됐는데 기록만 실패한 결제: 다시 취소하지 말고 기록만 하면 된다(refundRecordFailed).
      //   - 다른 단말기가 담은 주문의 [그래도 되돌리기]: 그 단말기 장바구니를 먼저 정리해야 이중 결제가 안 난다.
      //   - 프론트 간편결제(페이스페이 포함)의 취소 요청: 페이스페이 취소 버튼이 없는 프론트에서 할 일(frontRefundHint).
      const key = cancelKey(cart)
      const cancelFailedHint = cart.status !== 'paid' || sdkCancelTimedOut.has(key)
        ? ''
        : refundRecordFailed.has(key)
          ? `<div class="erp-cart-memo settled-warn">${REFUND_RECORD_FAILED_HINT}</div>`
          : sdkCancelFailed.has(key)
            ? '<div class="erp-cart-memo settled-warn">여기서는 취소할 수 없는 결제예요. POS [주문]에서 직접 취소한 뒤 [POS에서 취소했어요]를 눌러주세요.</div>'
            : ''
      const frontRefundHint = cart.payTarget === 'front' && cart.paymentMethod === 'BARCODE' && isRefundInProgress(cart)
        ? `<div class="erp-cart-memo settled-warn">${FACEPAY_REFUND_HINT}</div>`
        : ''
      const forceUnloadHint = cart.status === 'loaded' && forceUnloadAllowed.has(cart.id)
        ? '<div class="erp-cart-memo settled-warn">다른 단말기에서 담은 주문이에요. 그 단말기에서 결제하지 않았는지 확인하고 그 단말기의 품목을 지운 뒤 [그래도 되돌리기]를 눌러주세요.</div>'
        : ''
      return `
        <article class="erp-cart-item settled-cart-item${cart.status === 'refunded' ? ' is-refunded' : ''}${cart.hidden ? ' is-hidden' : ''}${isFrontOrphanOpen(cart) ? ' has-front-orphan' : ''}">
          <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')} · ${cart.paidAt ? `${formatTime(cart.paidAt)} 결제` : `${formatTime(cart.loadedAt)} POS에 담음`}</div>
          <div class="erp-cart-head">
            <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
            <span class="settled-status ${s.cls}">${s.text}</span>
            ${cart.tossVerified ? '<span class="settled-verified" title="토스 결제내역에서 같은 결제를 확인했습니다">토스 내역 확인됨</span>' : ''}
          </div>
          ${orphan}
          <div class="erp-cart-summary">${where}${items ? ` · ${items}` : ''}</div>
          <div class="erp-cart-total">${formatWon(cart.totalAmount)}</div>
          ${cart.status === 'refunded' && cart.refundNote ? `<div class="erp-cart-memo">${deps.escapeHtml(cart.refundNote)} · ${formatTime(cart.refundedAt)}</div>` : ''}
          ${cart.errorMessage && cart.status !== 'refunded' ? `<div class="erp-cart-memo settled-error">${deps.escapeHtml(cart.errorMessage)}</div>` : ''}
          ${sdkCancelTimedOut.has(cancelKey(cart)) && cart.status === 'paid' ? '<div class="erp-cart-memo settled-warn">POS [주문]에서 이 결제가 취소됐는지 확인해주세요. 취소됐으면 [POS에서 취소했어요]를, 아니면 [결제 취소]를 다시 눌러주세요.</div>' : ''}
          ${cart.status === 'loaded' && paidPicker?.cartId !== cart.id && unmatchedAfterLoad(cart).length ? '<div class="erp-cart-memo settled-warn">담은 뒤 이 단말기에서 전산 주문과 맞추지 못한 POS 결제가 있습니다. 이 주문을 결제했다면 [POS에서 결제했어요]를 눌러주세요.</div>' : ''}
          ${repayHint}
          ${cancelFailedHint}
          ${frontRefundHint}
          ${forceUnloadHint}
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
      disarmShared()
      paidPicker = { ...paidPicker, selected: paymentId, sharedArmed: false, amountArmed: false }
      render()
    }
    return
  }
  const closeBtn = e.target.closest('button.paid-pick-close')
  if (closeBtn) {
    disarmShared()
    paidPicker = null
    render()
    return
  }
  const submitBtn = e.target.closest('button.paid-pick-submit')
  if (submitBtn) {
    if (submitBtn.disabled) return
    const cartId = submitBtn.dataset.cartId
    const cart = lastCarts.find((c) => c.id === cartId)
    const payment = cart ? selectedPickerPayment(cart) : null
    // 다른 주문에 이미 기록한 결제를 고르면 한 번 더 확인받는다. 한 결제로 여러 주문을 함께 계산한 게 아니면 같은 돈이 두 주문의
    // 결제로 기록된다. 남은 금액이 주문 합계보다 적거나 모르는 결제도 두 금액을 보여 주고 한 번 더 확인받는다.
    if (payment && recordedElsewhere(payment, cartId).length && !paidPicker.sharedArmed) {
      armPicker({ sharedArmed: true })
      return
    }
    if (payment && amountShort(payment, cart) && !paidPicker.amountArmed) {
      armPicker({ amountArmed: true })
      return
    }
    run('pos-paid-submit', cartId)
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
  const clearAll = () => {
    for (const t of confirming.values()) clearTimeout(t)
    confirming.clear()
  }
  const cart = lastCarts.find((c) => c.id === cartId)
  if (ORPHAN_GATED.has(action) && isFrontOrphanOpen(cart)) {
    // 프론트에서 이미 승인된 결제가 있는 주문: 평소 확인 앞에 경고 확인을 한 번 더 둔다. 한 번 누르면 경고 문구, 10초 안에 한 번 더
    // 누르면 평소 확인("결제한 내역을 고를까요?")으로 넘어가고, 그다음 한 번 더 눌러야 고르기 칸이 열린다.
    const orphanKey = `orphan-${key}`
    if (confirming.has(orphanKey)) {
      clearAll()
      confirming.set(key, setTimeout(() => {
        confirming.delete(key)
        render()
      }, 3000))
      render()
      return
    }
    clearAll()
    confirming.set(orphanKey, setTimeout(() => {
      confirming.delete(orphanKey)
      render()
    }, ORPHAN_CONFIRM_MS))
    render()
    return
  }
  clearAll()
  confirming.set(key, setTimeout(() => {
    confirming.delete(key)
    render()
  }, LONG_CONFIRM.has(action) ? ORPHAN_CONFIRM_MS : 3000))
  render()
}

function disarmShared() {
  if (sharedArmTimer) clearTimeout(sharedArmTimer)
  sharedArmTimer = null
}

// [이 결제로 기록] 앞의 추가 확인 단계를 건다(sharedArmed·amountArmed). 10초 안에 다시 누르지 않으면 둘 다 풀린다.
function armPicker(flags) {
  disarmShared()
  paidPicker = { ...paidPicker, ...flags }
  sharedArmTimer = setTimeout(() => {
    sharedArmTimer = null
    if (paidPicker) paidPicker = { ...paidPicker, sharedArmed: false, amountArmed: false }
    render()
  }, SHARED_CONFIRM_MS)
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
      // 간편결제에는 페이스페이도 있다(FACEPAY_REFUND_HINT -- 같은 안내를 카드에도 남긴다, render frontRefundHint).
      // 카드는 꽂는 손님도 대는(접촉) 손님도 있다.
      const howTo = cart.paymentMethod === 'BARCODE'
        ? `손님이 프론트에서 결제했던 앱 바코드로 취소합니다. ${FACEPAY_REFUND_HINT}`
        : '손님이 결제한 카드를 프론트에 꽂거나 대면 취소됩니다.'
      return deps.notify('success', `프론트로 취소를 요청했습니다. ${howTo}`)
    }
    if (action === 'hide' || action === 'unhide') {
      const res = await post(`/api/pos/erp-carts/${cartId}/hide`, { hidden: action === 'hide' })
      if (!res.ok) return deps.notify('error', res.body.error || '처리하지 못했습니다.')
      markLocal([cartId], { hidden: action === 'hide' })
      // 맨 위 버튼의 실제 글자('숨긴 결제 N건 보기')와 같게 안내한다.
      const hiddenNow = lastCarts.filter((c) => c.hidden && !isRefundInProgress(c)).length
      return deps.notify('success', action === 'hide' ? `숨겼어요. 맨 위 [숨긴 결제 ${hiddenNow}건 보기]에서 다시 볼 수 있어요.` : '다시 보이게 했어요.')
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
    if (action === 'pos-paid') return openPaidPicker(cart, 'loaded')
    if (action === 'pos-repaid') return openPaidPicker(cart, 'repay')
    if (action === 'pos-paid-submit') return await submitManualPaid(cart)
    if (action === 'orphan-ack') {
      // 서버에 매장 확인을 보내고 안내는 erpCarts.clearFrontOrphan이 한다(전산 주문·프론트 결제 목록도 함께 맞춘다). 경고는 접어서 남는다.
      const ackAt = await clearFrontOrphan(cartId)
      if (ackAt && hasFrontOrphan(cart)) markLocal([cartId], { frontOrphan: { ...cart.frontOrphan, ackAt } })
      return
    }
    if (action === 'orphan-record') {
      // 서버 기록·이 단말기가 담은 품목 지우기·안내는 erpCarts.recordFrontOrphan이 한다. 다음 폴링이 정확한 상태로 바꿀 때까지 결제 완료로 보여준다.
      if (await recordFrontOrphan(cart)) {
        if (paidPicker && paidPicker.cartId === cartId) paidPicker = null
        markLocal([cartId], { status: 'paid', payTarget: 'front', paidAt: new Date().toISOString(), frontOrphan: null, cashWithoutReceipt: false })
      }
      return
    }
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

// [POS에서 결제했어요]·[POS에서 다시 결제했어요]를 두 번 눌러 확인한 뒤 부른다. 고를 결제가 없으면 칸을 펼치지 않고 안내한다.
//   mode 'loaded': 담김 주문의 결제를 고른다. 'repay': POS에서 취소된 주문을 다시 결제한 결제를 고른다.
function openPaidPicker(cart, mode) {
  disarmShared()
  if (mode === 'loaded') {
    const record = peekLoadedRecord(cart.id)
    if (record && record.paymentId) {
      // 이 단말기가 이미 이 주문의 결제를 맞췄고 전산 통보만 밀려 있다. 다른 결제를 골라 기록하면 엉뚱한 결제로 남는다.
      paidPicker = null
      return deps.notify('error', '이 단말기에서 이 주문의 결제를 이미 확인했고 전산에 알리는 중입니다. 따로 기록하지 말고 잠시 기다려주세요.')
    }
  }
  const options = mode === 'repay' ? repayOptions(cart) : unmatchedAfterLoad(cart)
  if (!options.length) {
    paidPicker = null
    return deps.notify('error', mode === 'repay' ? NO_REPAY_MESSAGE : NO_UNMATCHED_MESSAGE)
  }
  // 이 주문과 이어진 결제가 하나면 그것을, 아니면 후보가 하나뿐일 때 그것을 미리 골라 둔다. 단 남은 금액이 주문 합계와 꼭 같을 때만 --
  // 금액이 다른 결제를 미리 골라 두면 직원이 확인 없이 누르기 쉽다(다른 손님의 작은 결제로 큰 주문이 결제 완료가 된다).
  const hinted = options.filter((p) => hintedFor(p, cart.id))
  const candidate = hinted.length === 1 ? hinted[0] : options.length === 1 ? options[0] : null
  const preselect = candidate && amountMatches(candidate, cart) ? candidate : null
  paidPicker = { cartId: cart.id, selected: preselect ? preselect.paymentId : null, mode, sharedArmed: false, amountArmed: false }
}

// 고른 POS 결제로 이 주문을 결제 완료로 기록한다(/paid, manual). 서버가 이미 다른 결제로 결제된 주문이라고 하면
// 이중 결제를 확인하게 하고, 그 결제는 다른 주문에 쓸 수 있게 목록에 남긴다.
// 성공한 결제는 목록에서 바로 지우지 않는다(erpCarts.noteManualPaid) -- 같은 결제로 함께 계산한 다른 주문도 기록할 수 있어야 한다.
// 다시 결제(repay)는 서버가 취소된 주문을 결제 완료로 되살린다(200 {status:'paid', restored:true}).
async function submitManualPaid(cart) {
  const picker = pickerFits(cart) ? paidPicker : null
  const payment = picker ? selectedPickerPayment(cart) : null
  if (!payment) return deps.notify('error', '기록할 결제를 먼저 골라주세요.')
  const repay = picker.mode === 'repay'
  // 다른 주문에 이미 기록한 결제·금액이 모자라거나 모르는 결제는 한 번 더 확인한 뒤에만 보낸다(handleClick의 sharedArmed·amountArmed).
  if (recordedElsewhere(payment, cart.id).length && !picker.sharedArmed) return
  if (amountShort(payment, cart) && !picker.amountArmed) return
  if (!repay) {
    // 고르는 사이 이 단말기가 그 주문의 결제를 자동으로 맞췄다면 그쪽이 맞다(openPaidPicker와 같은 이유).
    const record = peekLoadedRecord(cart.id)
    if (record && record.paymentId) {
      paidPicker = null
      return deps.notify('error', '이 단말기에서 이 주문의 결제를 이미 확인했고 전산에 알리는 중입니다. 따로 기록하지 말고 잠시 기다려주세요.')
    }
  }
  disarmShared()
  const res = await post(`/api/pos/erp-carts/${cart.id}/paid`, { paymentId: payment.paymentId, orderId: payment.orderId, manual: true })
  if (!res.ok) {
    if (res.status === 401) return
    const code = res.body && res.body.code
    if (paidPicker) paidPicker = { ...paidPicker, sharedArmed: false, amountArmed: false }
    if (res.status === 409 && code === 'AMOUNT_MISMATCH') {
      // 서버가 결제 금액과 주문 합계가 맞지 않는다고 거절했다(토스 결제내역의 금액 기준). 고르기 칸은 그대로 두어 다른 결제를 고르게 한다.
      const payAmount = typeof res.body.paymentAmount === 'number' ? res.body.paymentAmount : payment.amount
      const cartAmount = typeof res.body.cartAmount === 'number' ? res.body.cartAmount : cartTotalOf(cart)
      return deps.notify('error',
        `고른 결제 금액(${typeof payAmount === 'number' ? formatWon(payAmount) : '확인 불가'})이 주문 합계(${formatWon(cartAmount || 0)})와 맞지 않아 ` +
        '기록하지 않았습니다. POS [주문]에서 이 주문의 결제가 맞는지 확인하고 다른 결제를 골라주세요. 맞는 결제라면 전산(본사)에 확인해주세요.')
    }
    if (repay && res.status === 409) {
      // 되살릴 수 없는 주문이다(24시간이 지났거나 POS 취소가 아닌 환불, 서버가 아직 되살리기를 모름 등). 서버 문구를 그대로 보여준다.
      paidPicker = null
      return deps.notify('error', `${(res.body && res.body.error) || '다시 결제로 기록하지 못했습니다.'} POS [주문] 내역과 전산을 대조해주세요.`)
    }
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
  // 서버가 결제 완료가 아닌 상태로 답했다: 고른 결제가 토스에서 이미 취소된 결제라 기록 직후 다시 취소로 바뀐 경우 등. "되살렸습니다"라고
  // 하면 직원은 끝난 줄 알지만 다음 폴링에 다시 취소됨으로 돌아가고 실제 다시 결제는 기록되지 않는다. 실제 상태를 알리고, 이 결제는 기록한
  // 것으로 남기지 않는다(취소된 결제면 목록에서도 뺀다).
  const status = res.body && typeof res.body.status === 'string' ? res.body.status : null
  if (status && status !== 'paid') {
    paidPicker = null
    markLocal([cart.id], { status })
    if (status === 'refunded') {
      removeUnmatchedPayment(payment.paymentId)
      return deps.notify('error', '고른 결제는 토스에서 이미 취소된 결제라 주문이 다시 취소됨으로 남았습니다. POS [주문]에서 실제로 살아 있는 결제를 골라주세요.')
    }
    return deps.notify('error', `결제 완료로 기록되지 않았습니다(지금 상태: ${statusLabel({ ...cart, status }).text}). POS [주문] 내역과 전산을 대조해주세요.`)
  }
  // 결제 목록 표시(기록한 주문)·전산에 알린 POS 주문·이 단말기의 대기 기록과 담기 표식을 정리한다.
  noteManualPaid(cart, payment)
  paidPicker = null
  const restored = Boolean(res.body && res.body.restored)
  markLocal([cart.id], {
    status: 'paid',
    paidAt: new Date().toISOString(),
    tossPaymentId: payment.paymentId,
    tossOrderId: payment.orderId,
    ...(repay ? { refundNote: null, refundedAt: null } : {}),
  })
  if (repay) {
    return deps.notify('success', restored
      ? '다시 결제한 POS 결제로 결제 완료를 되살렸습니다.'
      : '고른 POS 결제로 결제 완료를 기록했습니다. 전산에서 이 주문이 결제 완료로 보이는지 확인해주세요.')
  }
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
  // attemptId는 대기 기록이 정리돼도 따로 남겨 둔 담기 표식에서 온다(erpCarts.js '담기 시도 표식', 이 단말기가 담지 않았거나 7일이
  // 지났으면 없다). checkDevice는 새 서버에 "담은 단말기인지 따져 달라"는 뜻이다 -- 서버는 이 값이나 attemptId가 있을 때만 단말기를
  // 확인한다(바디가 빈 옛 탭앱의 요청은 예전처럼 받는다).
  const body = { checkDevice: true }
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

// 취소하려는 POS 결제의 금액. 주문에 실린 결제에 금액이 없으면 결제를 따로 읽는다. 모르면 null.
async function readLiveAmount(payment) {
  if (payment && typeof payment.amountMoney === 'number' && Number.isFinite(payment.amountMoney)) return payment.amountMoney
  try {
    if (payment && posPluginSdk.payment && typeof posPluginSdk.payment.getPayment === 'function') {
      const read = await posPluginSdk.payment.getPayment(payment.id)
      if (read && typeof read.amountMoney === 'number' && Number.isFinite(read.amountMoney)) return read.amountMoney
    }
  } catch (e) {
    console.error('[settled-cart] 취소 전에 POS 결제 금액을 읽지 못했습니다.', e?.message)
  }
  return null
}

function fullCancelMessage(amount, erpTotal) {
  const tail = 'POS [주문]에서 처리한 뒤 [POS에서 취소했어요]를 눌러주세요.'
  if (amount === null) return `POS 결제 금액을 확인하지 못해 여기서 취소하지 않았습니다. ${tail}`
  if (erpTotal === null) {
    return `이 결제에 묶인 전산 주문 합계를 확인하지 못해 여기서 취소하지 않았습니다. 여기서 취소하면 결제 전액 ${formatWon(amount)}이 취소됩니다. ${tail}`
  }
  return `이 결제에는 전산 주문 외 품목 ${formatWon(amount - erpTotal)}이 함께 있어 여기서 취소하면 전액 ${formatWon(amount)}이 취소됩니다. ${tail}`
}

async function cancelOnPos(cart) {
  const key = cancelKey(cart)
  sdkCancelTimedOut.delete(key)
  const payments = await readOrderPayments(cart.tossOrderId)
  const live = payments ? payments.filter((p) => p && p.state !== 'CANCELLED') : null
  if (!live) {
    sdkCancelFailed.add(key)
    deps.notify('error', 'POS 주문의 결제 내역을 확인하지 못해 여기서 취소하지 않았습니다. POS [주문]에서 이 결제를 직접 취소한 뒤 [POS에서 취소했어요]를 눌러주세요.')
    return
  }
  if (live.length > 1) {
    sdkCancelFailed.add(key)
    deps.notify('error', '카드 여러 장으로 나눠 결제한 건입니다. POS [주문]에서 각각 취소한 뒤 [POS에서 취소했어요]를 눌러주세요.')
    return
  }
  if (live.length === 0 || String(live[0].id) !== String(cart.tossPaymentId)) {
    // 이미 취소됐거나, 남은 결제가 전산이 아는 결제와 다르다. 여기서 엉뚱한 결제를 취소하지 않는다.
    sdkCancelFailed.add(key)
    deps.notify('error', 'POS의 결제 내역이 전산 기록과 다릅니다(이미 취소됐을 수 있습니다). POS [주문]에서 확인하고 취소한 뒤 [POS에서 취소했어요]를 눌러주세요.')
    return
  }
  // payment.cancel에는 금액 인자가 없어 결제 한 건 전체가 취소된다. 전산 주문에 POS 상품(와이퍼 등)을 더해 한 번에 결제한 건도 자동
  // 대조가 맞춰 주므로(erpCarts.js tallyContains), 결제 금액이 이 결제에 묶인 전산 주문 합계(sharedPaymentTotal)보다 크면 여기서
  // 취소하지 않는다 -- 카드에는 전산 금액만 보여 직원은 전산 외 품목까지 환불되는 줄 모른다. 합계를 안 주는 옛 서버거나 결제 금액을
  // 읽지 못한 경우도 같은 쪽(POS [주문]에서 직접 처리)으로 보낸다.
  const paymentAmount = await readLiveAmount(live[0])
  const erpTotal = cart.sharedPaymentTotal !== undefined && cart.sharedPaymentTotal !== null && Number.isFinite(Number(cart.sharedPaymentTotal))
    ? Number(cart.sharedPaymentTotal)
    : null
  if (paymentAmount === null || erpTotal === null || paymentAmount > erpTotal) {
    sdkCancelFailed.add(key)
    deps.notify('error', fullCancelMessage(paymentAmount, erpTotal))
    return
  }
  try {
    // 이 취소의 'cancel' 이벤트에는 결제 대조 쪽이 따로 안내하지 않게 알려 둔다(erpCarts.handleCancelled).
    noteSelfCancel(cart.tossPaymentId)
    await posPluginSdk.payment.cancel({ id: cart.tossOrderId }, { id: cart.tossPaymentId })
  } catch (e) {
    // SDK는 30초 안에 응답이 없으면 "지연되고 있습니다"라는 오류를 던진다. 취소가 거절된 게 아니라 결과를 모르는
    // 것이다 -- 실제로는 취소됐을 수 있다. 이걸 "탭앱에서 취소가 안 되는 결제"(아래)로 취급하면 [결제 취소]가 사라져
    // 취소 안 된 결제를 다시 못 취소하고, 반대로 [POS에서 취소했어요]만 보이면 확인 없이 취소 완료로 기록하기 쉽다.
    // 그래서 두 버튼을 모두 보여주고 POS [주문]에서 먼저 확인하게 한다.
    if (String(e?.message || e).includes('지연되고 있습니다')) {
      sdkCancelTimedOut.add(key)
      deps.notify(
        'error',
        `POS [주문]에서 이 결제가 취소됐는지 확인해주세요. 취소됐으면 [POS에서 취소했어요]를 눌러주세요. (${e?.message || e})`
      )
      return
    }
    // 탭앱에서 바로 취소가 안 되는 결제다. 직원이 POS에서 직접 취소하고 기록하게 한다.
    sdkCancelFailed.add(key)
    deps.notify(
      'error',
      `여기서 바로 취소하지 못했습니다. POS [주문]에서 이 결제를 직접 취소한 뒤 [POS에서 취소했어요]를 눌러주세요. (${e?.message || e})`
    )
    return
  }
  // 결제는 이미 취소됐다. 손님이 다른 카드로 새 POS 주문을 찍어 다시 결제할 수 있으니 다시 결제를 기다리는 창을 먼저 연다 -- 아래 기록이
  // 실패해도 열려 있어야 한다(erpCarts.js repay 창 주석). 기록이 실패해도 토스 취소 웹훅이 오면 서버가 맞춘다.
  openRepayWindow(sharedCartsOf(cart, [cart.id]))
  await recordRefund(cart, 'pos', '결제를 취소했습니다.', { cancelled: true })
}

// 같은 결제로 함께 기록된 주문들(서버가 돌려준 ID)의 { id, ref }. 목록에 없는 ID는 ID를 참조번호 대신 쓴다.
function sharedCartsOf(cart, ids) {
  return ids.map((id) => {
    const c = id === cart.id ? cart : lastCarts.find((x) => x.id === id)
    return { id, ref: (c && c.referenceId) || id }
  })
}

// cancelled: 이 탭앱이 방금 SDK로 결제를 취소했다(cancelOnPos). 기록이 실패해도 결제는 이미 취소된 것이라 안내와 카드 상태를 따로 둔다.
async function recordRefund(cart, method, successMessage, { cancelled = false } = {}) {
  const key = cancelKey(cart)
  // POS 취소는 어느 결제를 취소했는지 함께 보낸다. 그 사이 [POS에서 다시 결제했어요]로 결제가 바뀌었으면 서버가 PAYMENT_CHANGED로 막는다 --
  // 막지 않으면 옛 결제의 취소 기록이 새로 받은 결제까지 환불로 바꾼다.
  const body = method === 'pos' && cart.tossPaymentId ? { method, paymentId: cart.tossPaymentId } : { method }
  const res = await post(`/api/pos/erp-carts/${cart.id}/refunded`, body)
  if (!res.ok) {
    if (res.status === 401) return
    if (res.status === 409 && res.body && res.body.code === 'PAYMENT_CHANGED') {
      // 카드의 결제가 낡았다. 이 상태로 [POS에서 취소했어요]를 다시 보여주면 같은 거절이 반복되니 상태를 남기지 않고 새 목록을 기다린다.
      sdkCancelFailed.delete(key)
      sdkCancelTimedOut.delete(key)
      refundRecordFailed.delete(key)
      try {
        if (typeof deps.noteActivity === 'function') deps.noteActivity()
      } catch {
        // 폴링 간격 조정이 실패해도 안내는 이어진다.
      }
      deps.notify('error', '결제가 바뀌었습니다(다시 결제 기록됨). 목록을 새로 불러온 뒤 다시 확인해주세요')
      return
    }
    // 이미 취소된 결제의 기록이 실패했다(방금 SDK로 취소했거나, 그 뒤의 기록 재시도가 또 실패). '여기서 취소할 수 없는 결제' 안내(sdkCancelFailed)를
    // 띄우면 직원이 이미 취소된 결제를 POS [주문]에서 다시 취소하려 한다 -- 결제는 취소됐다고 먼저 말하고 기록만 다시 하게 한다.
    if (method === 'pos' && (cancelled || refundRecordFailed.has(key))) {
      refundRecordFailed.add(key)
      sdkCancelFailed.delete(key)
      const reason = res.body && res.body.error ? ` (${res.body.error})` : ''
      deps.notify('error', `결제는 취소됐지만 기록하지 못했어요. 잠시 후 [POS에서 취소했어요]로 기록해주세요.${reason}`)
      return
    }
    deps.notify('error', res.body.error || '취소를 기록하지 못했습니다. 잠시 후 [POS에서 취소했어요]로 다시 기록해주세요.')
    if (method === 'pos') sdkCancelFailed.add(key)
    return
  }
  refundRecordFailed.delete(key)
  const ids = res.body.refundedCartIds || [cart.id]
  markLocal(ids, { status: 'refunded', refundNote: method === 'cash' ? '현금 환불(기록만)' : 'POS에서 결제 취소', refundedAt: new Date().toISOString() })
  if (method === 'pos') {
    // POS 결제가 취소됐다: 다시 결제를 기다리는 창을 열고(새 POS 주문으로 다시 결제해도 알아보게), 결제 대조 쪽 요약도 바로 고친다 -- 탭앱이
    // 가려지면 폴링이 멈춰 취소 전 요약이 남는다(erpCarts.noteRecentCarts).
    openRepayWindow(sharedCartsOf(cart, ids))
    noteRecentCarts(lastCarts)
  }
  const extra = ids.length > 1 ? ` 함께 결제된 ${ids.length}건이 모두 취소로 기록됐습니다.` : ''
  deps.notify('success', `${successMessage}${extra}`)
}
