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
  // 업그레이드 전에 담은 주문의 담기 표식을 결제 대기 기록에서 옮겨 둔다(preserveLoadAttempts 주석).
  try {
    preserveLoadAttempts(loadPendingPaid())
  } catch {
    // 옮기지 못해도 담기 취소가 '다른 단말기'로 한 번 더 확인받을 뿐이다.
  }
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
  if (orphanListEl) orphanListEl.addEventListener('click', handleOrphanListClick)
  if (!listEl) return
  listEl.addEventListener('click', handleListClick)
}

// 마지막으로 서버 응답을 받은 시각과 건수. 화면이 멈춘 건지 서버가 그렇게 답하는 건지
// 직원이 구분할 수 있어야 한다 — "안 사라져요"의 원인이 둘 중 어느 쪽인지 바로 갈린다.
// ('서버에 남아 있습니다'는 개발자 시점의 말이고, '대기'는 정비 대기열과 겹쳐서 쓰지 않는다.)
function stampUpdated(count) {
  const el = document.getElementById('erp-cart-updated')
  if (!el) return
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())
  el.textContent = count
    ? `${time} 기준 · 주문 ${count}건`
    : `${time} 기준 · 새 주문 없음`
}

// 서버 상태 값(영문 내부 값)을 직원에게 보여 줄 이름. 거절 안내에 '(상태: loaded)'처럼 내부 값이 그대로 보이던 것을 바꾼다.
const STATUS_NAME = {
  pending: '결제 전',
  loaded: 'POS에 담김',
  paying: '프론트 결제 중',
  paid: '결제 완료',
  refund_requested: '프론트 취소 대기',
  refunding: '프론트에서 취소 중',
  refunded: '취소됨',
  dismissed: '지워짐',
  failed: '담기 실패',
  cancelled: '전산 취소',
  expired: '만료됨',
}

// ' (지금 상태: POS에 담김)'. 모르는 값이면 빈 문자열(내부 값을 그대로 보이지 않는다).
function statusNote(status) {
  return status && STATUS_NAME[status] ? ` (지금 상태: ${STATUS_NAME[status]})` : ''
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

// sentToFront: 방금 [프론트로 넘기기]로 넘긴 cart → 넘긴 시각. 넘기기 직전에 출발한 폴링 응답이 그 카드를
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

// ── 프론트 승인 미반영 경고(frontOrphan) ─────────────────────────────────────
// 서버가 이 주문의 손님 카드 승인을 프론트에서 받았지만 주문에 기록하지 못한 경우다([결제 중 풀기] 뒤 늦게 온 승인 등). 서버는
// 주문에 frontOrphan {at, approvalNo, amount}를 남겨 POS의 모든 카드(전산 주문·프론트 결제·최근 결제)에 싣는다. 이 주문을 POS에서
// 다시 결제하면 손님이 두 번 낸다 -- 빨간 경고를 띄우고, 담기·프론트로 넘기기·[POS에서 결제했어요]는 따로 한 번 더 확인받는다.
// 직원이 토스 결제내역에서 정리했으면 [확인했어요](두 번 눌러 확인)로 '매장 확인함'을 남긴다(서버 clear-front-orphan). 서버는 흔적을 지우지
// 않고 ackAt만 남긴다 -- 관리자 웹의 '대사 필요' 표시가 사라지면 본사가 이중 결제를 찾을 근거가 없어진다. 확인한 경고는 접어서 보여주고
// 담기·넘기기 앞 확인 단계도 풀린다.
// 이 승인이 정말 이 주문의 결제면(손님이 프론트에서 냈는데 [결제 중 풀기] 뒤에 보고가 늦게 옴) [프론트 결제로 완료 처리]로 그 승인을
// 주문의 결제로 남긴다(서버 record-front-orphan). 예전에는 그 길이 없어 경고를 따른 직원이 [지우기]를 누르거나 만료되면 손님은 냈는데
// 전산에는 미결제로 남았다.
export function hasFrontOrphan(cart) {
  return Boolean(cart && cart.frontOrphan && typeof cart.frontOrphan === 'object')
}

// 아직 매장이 확인하지 않은 경고인지. 빨간 경고·확인 단계·기록 버튼은 이때만 보여준다.
export function isFrontOrphanOpen(cart) {
  return hasFrontOrphan(cart) && !cart.frontOrphan.ackAt
}

function orphanParts(orphan) {
  const approvalNo = orphan && orphan.approvalNo ? String(orphan.approvalNo) : '확인 불가'
  const known = orphan && typeof orphan.amount === 'number' && Number.isFinite(orphan.amount)
  return { approvalNo, amount: known ? formatWon(orphan.amount) : '확인 불가', known }
}

// 다른 결제로 이미 결제·취소 처리된 주문. 여기에 프론트 승인이 하나 더 있으면 손님이 두 번 냈을 수 있다.
const ORPHAN_SETTLED_STATUSES = new Set(['paid', 'refund_requested', 'refunding', 'refunded'])
// 닫힌 주문(서버 /api/pos/queue frontOrphans). 이 주문을 전산이 새로 보내면 다시 결제하면 안 된다.
const ORPHAN_CLOSED_LABEL = { dismissed: '지워진 주문', cancelled: '전산이 취소한 주문', expired: '만료된 주문' }

// 경고 문구는 주문 상태에 따라 다르다(결제 전 / 이미 다른 결제로 처리됨 / 닫힌 주문).
// 카드 결제를 되돌리는 일은 POS 화면 어디서나 '결제 취소'라 부른다('환불'은 현금에만 쓴다).
export function frontOrphanText(orphan, status) {
  const { approvalNo, amount, known } = orphanParts(orphan)
  if (ORPHAN_SETTLED_STATUSES.has(status)) {
    const approval = known ? `프론트 승인 ${amount}(승인번호 ${approvalNo})` : `프론트 승인(금액 확인 불가, 승인번호 ${approvalNo})`
    return `이 주문은 이미 다른 결제로 처리됐는데 ${approval}이 하나 더 있습니다. ` +
      `손님이 두 번 냈을 수 있으니 ${DOUBLE_PAID_TAIL}`
  }
  if (ORPHAN_CLOSED_LABEL[status]) {
    return `${ORPHAN_CLOSED_LABEL[status]}인데 프론트에서 승인된 결제가 있습니다 (승인번호 ${approvalNo}, 금액 ${amount}). ` +
      `손님이 이미 냈을 수 있습니다. 이 주문의 결제가 맞으면 [${ORPHAN_RECORD_LABEL}]를 눌러주세요. 전산이 같은 주문을 다시 보내도 다시 결제하지 마세요.`
  }
  return `프론트에서 이미 승인된 결제가 있습니다 (승인번호 ${approvalNo}, 금액 ${amount}). 다시 결제하지 마세요.`
}

// 이중 결제가 의심될 때 직원이 할 일. 경고 카드·거절 안내 여러 곳이 같은 말을 쓴다.
const DOUBLE_PAID_TAIL = '토스 결제내역에서 확인하고 한쪽 결제를 취소하세요.'

// 매장이 확인한 경고(ackAt)는 접어서 한 줄로 보여준다. 서버는 흔적을 지우지 않고 관리자 웹에는 '반영 안 됨 · 매장 확인함'으로 남는다.
// [확인했어요]는 주문을 결제로 바꾸지 않는다(이 주문의 결제로 남기는 건 [프론트 결제로 완료 처리]뿐이다). 그래서 '결제 확인 완료'처럼
// 결제가 끝난 것으로 읽히는 말은 쓰지 않는다 -- 예전 문구('프론트 결제 확인 완료')와 금액을 본 다른 직원은 결제 전 주문을 결제된 줄 알고
// 돈을 받지 않거나 [지우기]를 누를 수 있었다. 결제 전 주문(pending·loaded, 전산 주문 목록의 카드는 status가 없다)에는 그 사실을 덧붙인다.
export function frontOrphanAckedText(orphan, status) {
  const { approvalNo, amount } = orphanParts(orphan)
  const unpaid = !status || status === 'pending' || status === 'loaded' ? ' · 이 주문은 아직 결제 전이에요' : ''
  return `프론트 승인 1건 · 매장 확인함 — 결제로 기록되지 않았어요 (승인번호 ${approvalNo}, 금액 ${amount})${unpaid}`
}

// [프론트 결제로 완료 처리]를 보여줄 주문. 결제 전(pending·loaded)이거나 닫힌 주문이고 매장이 아직 확인하지 않은 경고여야 한다.
// 서버가 같은 조건(과 금액)을 다시 확인한다. 전산 주문 목록의 카드는 status가 없다(늘 pending).
// (예전 이름 '프론트 승인으로 결제 완료 기록'은 작은 버튼에 길고 '승인'이 직원에게 낯선 말이었다. 무엇을 하는지는 확인 문구가 설명한다.)
const ORPHAN_RECORDABLE = new Set(['pending', 'loaded', 'dismissed', 'expired', 'cancelled'])
export const ORPHAN_RECORD_LABEL = '프론트 결제로 완료 처리'

export function canRecordFrontOrphan(cart) {
  return isFrontOrphanOpen(cart) && ORPHAN_RECORDABLE.has(cart.status || 'pending')
}

export function orphanRecordConfirmText(orphan) {
  const { approvalNo, amount, known } = orphanParts(orphan)
  return `승인번호 ${approvalNo} · ${known ? amount : '금액 확인 불가'} 승인을 이 주문의 결제로 기록할까요?`
}

// 경고를 읽고 토스 결제내역을 볼 시간이 필요해서 일반 확인(3초)보다 길게 준다.
const ORPHAN_CONFIRM_MS = 10 * 1000
// 확인 문구는 왜 멈추는지(이중 결제 위험)를 말로 적는다. 예전 '프론트 승인 건입니다'만으로는 무엇이 위험한지 알 수 없었다.
const ORPHAN_LOAD_CONFIRM = '손님이 프론트에서 이미 결제했을 수 있어요. 그래도 담을까요?'
const ORPHAN_FRONT_CONFIRM = '손님이 프론트에서 이미 결제했을 수 있어요. 그래도 넘길까요?'
// [지우기] 앞 확인 단계. 지운 주문에 손님이 낸 돈이 있으면 전산에는 미결제로 남는다. 다른 경고처럼 '냈을 수 있다'로 쓰고
// 질문으로 끝내서, 한 번 더 누르면 지우기로 넘어간다는 것을 알 수 있게 한다.
const ORPHAN_DISMISS_CONFIRM = '손님이 이미 결제했을 수 있어요. 지우면 전산에는 미결제로 남아요. 그래도 지울까요?'
export const ORPHAN_ACK_CONFIRM = '토스 결제내역에서 확인을 마쳤나요? 한 번 더 누르면 경고를 접어요'
// `${'load' | 'front' | 'dismiss' | 'front-dismiss'}:${cartId}` -> timeoutId. 프론트 승인 경고가 있는 주문의 담기·넘기기·지우기 앞 확인 단계.
const orphanConfirm = new Map()
// [확인했어요] 두 번 누르기 확인(전산 주문·프론트 결제·닫힌 주문 경고 목록이 함께 쓴다) cartId -> timeoutId, 그리고 보내는 중인 cart.
const orphanAckConfirm = new Map()
const orphanAckBusy = new Set()
// [프론트 결제로 완료 처리] 두 번 누르기 확인(세 목록 공용) cartId -> timeoutId, 그리고 보내는 중인 cart.
const orphanRecordConfirm = new Map()
const orphanRecordBusy = new Set()

function loadLabelOf(cart) {
  return cart && cart.autoPay ? '담고 결제 시작' : 'POS에 담기'
}

// 전산 주문·프론트 결제·닫힌 주문 경고 목록이 함께 쓰는 경고 블록. 확인한 경고는 한 줄로 접는다.
function frontOrphanBlock(cart) {
  if (!hasFrontOrphan(cart)) return ''
  if (!isFrontOrphanOpen(cart)) {
    return `
      <div class="erp-cart-memo front-orphan-acked">${deps.escapeHtml(frontOrphanAckedText(cart.frontOrphan, cart.status || 'pending'))}</div>`
  }
  const acking = orphanAckConfirm.has(cart.id)
  const recording = orphanRecordConfirm.has(cart.id)
  const view = { ...cart, status: cart.status || 'pending' }
  const record = canRecordFrontOrphan(view)
    ? `
        <button class="erp-cart-orphan-record${recording ? ' confirming' : ''}" type="button"
                data-cart-id="${deps.escapeHtml(cart.id)}" ${orphanRecordBusy.has(cart.id) ? 'disabled' : ''}>${deps.escapeHtml(recording ? orphanRecordConfirmText(cart.frontOrphan) : ORPHAN_RECORD_LABEL)}</button>`
    : ''
  return `
      <div class="erp-cart-memo front-orphan-warn">${deps.escapeHtml(frontOrphanText(cart.frontOrphan, view.status))}</div>
      <div class="erp-cart-actions">${record}
        <button class="erp-cart-orphan-ack${acking ? ' confirming' : ''}" type="button"
                data-cart-id="${deps.escapeHtml(cart.id)}" ${orphanAckBusy.has(cart.id) ? 'disabled' : ''}>${acking ? ORPHAN_ACK_CONFIRM : '확인했어요'}</button>
      </div>`
}

// 전산 주문 카드의 [프론트로 넘기기] 기본 글자. 확인 문구('프론트로 넘길까요?')·토스트('프론트로 넘겼습니다')와 같은 동사로 맞췄다
// (예전 '프론트 결제'는 옆의 '프론트 결제 대기' 목록 이름과 헷갈렸다).
const FRONT_LABEL = '프론트로 넘기기'

// 담았지만 서버에 알리지 못한 주문(이 단말기 기록의 needsConsume). 이 카드는 목록에 남는데, 다시 담으면 같은 품목이 두 번 들어간다.
// 토스트는 몇 초 뒤 사라지므로 카드 안에 계속 보여 준다(흐름 QA #11). 버튼을 눌러도 cardActionBlocked가 막는다.
function isUnreportedLoad(cartId) {
  return loadPendingPaid().some((e) => e.id === cartId && e.needsConsume && !e.paymentId)
}

function cartHtml(cart) {
  const loadArmed = orphanConfirm.has(`load:${cart.id}`)
  const frontArmed = orphanConfirm.has(`front:${cart.id}`)
  const dismissArmed = orphanConfirm.has(`dismiss:${cart.id}`)
  const buttonLabel = loadArmed ? ORPHAN_LOAD_CONFIRM : loadLabelOf(cart)
  const dismissing = dismissConfirm.has(cart.id) || dismissArmed
  const dismissLabel = dismissArmed ? ORPHAN_DISMISS_CONFIRM : dismissing ? '정말 지울까요?' : '지우기'
  const sendingToFront = frontConfirm.has(cart.id)
  const frontLabel = frontArmed ? ORPHAN_FRONT_CONFIRM : sendingToFront ? '프론트로 넘길까요?' : FRONT_LABEL
  const unreported = isUnreportedLoad(cart.id)
    ? `
      <div class="erp-cart-memo erp-cart-warn">이미 POS에 담았지만 서버에 알리지 못했어요. 다시 누르지 말고 [주문] 탭에서 결제해주세요. 결제하면 자동으로 정리돼요.</div>`
    : ''
  return `
    <article class="erp-cart-item${isFrontOrphanOpen(cart) ? ' has-front-orphan' : ''}" data-cart-id="${deps.escapeHtml(cart.id)}">
      <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')}</div>
      <div class="erp-cart-head">
        <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
        ${cart.linkedReservation ? '<span class="erp-cart-linked">접수 연결됨</span>' : ''}
      </div>
      ${cart.carNumber && cart.memo ? `<div class="erp-cart-memo">${deps.escapeHtml(cart.memo)}</div>` : ''}
      ${unreported}
      ${frontOrphanBlock(cart)}
      ${renderItemList(cart.items)}
      <div class="erp-cart-total">${formatWon(cart.totalAmount)}</div>
      <div class="erp-cart-actions">
        <button class="erp-cart-button${loadArmed ? ' confirming' : ''}" type="button" data-cart-id="${deps.escapeHtml(cart.id)}">${buttonLabel}</button>
        <button class="erp-cart-front${sendingToFront || frontArmed ? ' confirming' : ''}" type="button"
                data-cart-id="${deps.escapeHtml(cart.id)}">${frontLabel}</button>
        <button class="erp-cart-dismiss${dismissing ? ' confirming' : ''}" type="button"
                data-cart-id="${deps.escapeHtml(cart.id)}">${dismissLabel}</button>
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
        <div class="empty-title">전산에서 보낸 주문이 없어요</div>
        <div class="empty-copy">전산에서 주문을 보내면 이곳에 표시돼요.</div>
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
    const cart = lastCarts.find((c) => c.id === id)
    const frontArmed = orphanConfirm.has(`front:${id}`)
    const dismissArmed = orphanConfirm.has(`dismiss:${id}`)
    setConfirmButton(node.querySelector('button.erp-cart-dismiss'), dismissConfirm.has(id) || dismissArmed,
      dismissArmed ? ORPHAN_DISMISS_CONFIRM : '정말 지울까요?', '지우기')
    setConfirmButton(node.querySelector('button.erp-cart-front'), frontConfirm.has(id) || frontArmed,
      frontArmed ? ORPHAN_FRONT_CONFIRM : '프론트로 넘길까요?', FRONT_LABEL)
    setConfirmButton(node.querySelector('button.erp-cart-button'), orphanConfirm.has(`load:${id}`), ORPHAN_LOAD_CONFIRM, loadLabelOf(cart))
    setConfirmButton(node.querySelector('button.erp-cart-orphan-ack'), orphanAckConfirm.has(id), ORPHAN_ACK_CONFIRM, '확인했어요')
    setConfirmButton(node.querySelector('button.erp-cart-orphan-record'), orphanRecordConfirm.has(id),
      cart && hasFrontOrphan(cart) ? orphanRecordConfirmText(cart.frontOrphan) : ORPHAN_RECORD_LABEL, ORPHAN_RECORD_LABEL)
  }
}

// 경고 확인 상태가 바뀌면 세 목록(전산 주문·프론트 결제·닫힌 주문 경고)을 함께 맞춘다.
function syncOrphanViews() {
  syncConfirmButtons()
  renderFrontCarts()
  renderOrphanCarts()
}

function clearOrphanConfirm(key) {
  const timeoutId = orphanConfirm.get(key)
  if (timeoutId) clearTimeout(timeoutId)
  orphanConfirm.delete(key)
}

// 프론트 승인 경고가 있는 주문의 담기·프론트로 넘기기·지우기 앞에 두는 확인 단계. 한 번 누르면 경고 문구로 바뀌고 10초 안에 한 번 더
// 눌러야 원래 동작으로 넘어간다(넘기기·지우기는 그다음 평소의 "프론트로 넘길까요?"·"정말 지울까요?" 확인을 한 번 더 거친다). true면 원래
// 동작을 이어 가고, false면 이번 누름은 확인 단계로 쓰였다. 매장이 이미 확인한 경고(ackAt)는 막지 않는다.
//   kind: 'load' | 'front' | 'dismiss'(전산 주문 목록) | 'front-dismiss'(프론트 결제 목록)
function passOrphanGate(kind, cartId) {
  const cart = (kind === 'front-dismiss' ? lastFrontCarts : lastCarts).find((c) => c.id === cartId)
  if (!isFrontOrphanOpen(cart)) return true
  // 경고 확인을 마치고 평소 확인("프론트로 넘길까요?"·"정말 지울까요?") 중인 누름이다.
  if (kind === 'front' && frontConfirm.has(cartId)) return true
  if (kind === 'dismiss' && dismissConfirm.has(cartId)) return true
  if (kind === 'front-dismiss' && frontDismissConfirm.has(cartId)) return true
  const key = `${kind}:${cartId}`
  if (orphanConfirm.has(key)) {
    clearOrphanConfirm(key)
    syncOrphanViews()
    return true
  }
  // 화면에 "정말?"이 여러 개 떠 있으면 헷갈린다 -- 다른 확인 상태는 취소한다.
  Array.from(orphanConfirm.keys()).forEach(clearOrphanConfirm)
  Array.from(dismissConfirm.keys()).forEach(clearDismissConfirm)
  Array.from(frontConfirm.keys()).forEach(clearFrontConfirm)
  Array.from(frontDismissConfirm.values()).forEach(clearTimeout)
  frontDismissConfirm.clear()
  orphanConfirm.set(key, setTimeout(() => {
    orphanConfirm.delete(key)
    syncOrphanViews()
  }, ORPHAN_CONFIRM_MS))
  syncOrphanViews()
  return false
}

// [확인했어요]: 두 번 눌러야 서버에 매장 확인을 보낸다(전산 주문·프론트 결제·닫힌 주문 경고 목록 공용).
function handleOrphanAckClick(cartId) {
  if (orphanAckBusy.has(cartId)) return
  if (orphanAckConfirm.has(cartId)) {
    clearTimeout(orphanAckConfirm.get(cartId))
    orphanAckConfirm.delete(cartId)
    syncOrphanViews()
    clearFrontOrphan(cartId)
    return
  }
  Array.from(orphanAckConfirm.values()).forEach(clearTimeout)
  orphanAckConfirm.clear()
  orphanAckConfirm.set(cartId, setTimeout(() => {
    orphanAckConfirm.delete(cartId)
    syncOrphanViews()
  }, ORPHAN_CONFIRM_MS))
  syncOrphanViews()
}

// 서버에 프론트 승인 경고를 매장이 확인했다고 알린다(서버는 흔적을 지우지 않고 ackAt만 남긴다). 최근 결제 화면(settledCarts)도 이 함수를
// 쓴다. 성공하면 확인 시각(ISO 문자열), 실패하면 null.
export async function clearFrontOrphan(cartId) {
  if (!deps || orphanAckBusy.has(cartId)) return null
  orphanAckBusy.add(cartId)
  syncOrphanViews()
  try {
    let res
    try {
      res = await deps.apiPost(`/api/pos/erp-carts/${cartId}/clear-front-orphan`)
    } catch {
      deps.notify('error', '서버에 연결하지 못해 매장 확인을 남기지 못했습니다. 잠시 후 다시 시도해주세요.')
      return null
    }
    if (!res.ok) {
      if (res.status === 401) {
        deps.onUnauthorized(res.body && res.body.error)
        return null
      }
      deps.notify('error', (res.body && res.body.error) || '프론트 승인 경고에 매장 확인을 남기지 못했습니다.')
      return null
    }
    afterMutation()
    const ackAt = (res.body && res.body.frontOrphan && res.body.frontOrphan.ackAt) || new Date().toISOString()
    const ack = (c) => (c.id === cartId && hasFrontOrphan(c) ? { ...c, frontOrphan: { ...c.frontOrphan, ackAt } } : c)
    lastCarts = lastCarts.map(ack)
    lastFrontCarts = lastFrontCarts.map(ack)
    // 닫힌 주문 경고 목록은 확인하지 않은 경고만 싣는다.
    lastOrphanCarts = lastOrphanCarts.filter((c) => c.id !== cartId)
    // 관리자 화면에 어떻게 보이는지('매장 확인함')는 매장 직원이 알 필요가 없어 결과만 알린다.
    deps.notify('success', '확인 처리했어요. 경고는 한 줄로 접어 둘게요.')
    return ackAt
  } finally {
    orphanAckBusy.delete(cartId)
    renderErpCarts(lastCarts)
    renderFrontCarts()
    renderOrphanCarts()
  }
}

// ── 프론트 결제로 완료 처리(프론트 승인을 이 주문의 결제로 기록) ───────────────
// 경고된 프론트 승인을 이 주문의 결제로 서버에 기록한다(record-front-orphan). 서버는 금액이 주문 합계와 같을 때만 받는다(아니면 409
// AMOUNT_MISMATCH). 이 단말기가 그 주문을 POS 장바구니에 담아 뒀으면 그 품목을 지운다(담기 취소와 같은 방식) -- 남겨 두면 POS에서 또
// 결제될 수 있다. 최근 결제 화면(settledCarts)도 이 함수를 쓴다. 성공하면 true.
function orphanCartOf(cartId) {
  const erp = lastCarts.find((c) => c.id === cartId)
  if (erp) return { ...erp, status: erp.status || 'pending' }
  return lastFrontCarts.find((c) => c.id === cartId) || lastOrphanCarts.find((c) => c.id === cartId) || null
}

function handleOrphanRecordClick(cartId) {
  if (orphanRecordBusy.has(cartId)) return
  if (orphanRecordConfirm.has(cartId)) {
    clearTimeout(orphanRecordConfirm.get(cartId))
    orphanRecordConfirm.delete(cartId)
    syncOrphanViews()
    const cart = orphanCartOf(cartId)
    if (cart) {
      recordFrontOrphan(cart).catch((e) => {
        deps.notify('error', `처리 중 오류가 발생했습니다: ${e?.message || e}`)
      })
    }
    return
  }
  Array.from(orphanRecordConfirm.values()).forEach(clearTimeout)
  orphanRecordConfirm.clear()
  orphanRecordConfirm.set(cartId, setTimeout(() => {
    orphanRecordConfirm.delete(cartId)
    syncOrphanViews()
  }, ORPHAN_CONFIRM_MS))
  syncOrphanViews()
}

// 이 단말기가 담은 주문의 POS 품목을 지운다(settledCarts.unloadCart와 같은 방식: 장바구니를 읽어 아직 남아 있는 우리 key만 지운다).
//   loadedHere: 이 단말기에 담은 기록이 있었는지. unreadable: 장바구니를 못 읽었다. failed: 지우지 못한 품목 수.
async function deleteLoadedLines(cartId) {
  const record = peekLoadedRecord(cartId)
  const keys = record ? record.keys : []
  if (!keys.length) return { loadedHere: false, unreadable: false, deleted: 0, failed: 0 }
  let present
  try {
    const draft = await draftOrder.get()
    const inDraft = new Set((draft && Array.isArray(draft.lineItems) ? draft.lineItems : []).map((li) => li && li.key).filter(Boolean))
    present = keys.filter((key) => inDraft.has(key))
  } catch {
    return { loadedHere: true, unreadable: true, deleted: 0, failed: 0 }
  }
  let failed = 0
  for (const key of present) {
    try {
      await draftOrder.deleteLineItem(key)
    } catch {
      failed += 1
    }
  }
  return { loadedHere: true, unreadable: false, deleted: present.length - failed, failed }
}

function orphanRefusedText(body, label) {
  const status = body && body.status
  if (ORPHAN_SETTLED_STATUSES.has(status)) {
    return `이미 다른 결제로 처리된 주문이라 기록하지 않았습니다${label}. 손님이 두 번 냈을 수 있으니 ${DOUBLE_PAID_TAIL}`
  }
  if (status === 'paying') return `손님이 프론트에서 결제 중인 주문이라 기록하지 않았습니다${label}. 결제가 끝나면 다시 확인해주세요.`
  return `${(body && body.error) || '프론트 결제로 기록할 수 없는 주문입니다.'}${label}${statusNote(status)} 목록을 새로 불러온 뒤 다시 확인해주세요.`
}

export async function recordFrontOrphan(cart) {
  if (!deps || !cart || !cart.id || orphanRecordBusy.has(cart.id)) return false
  const cartId = cart.id
  const label = cart.referenceId ? ` (${cart.referenceId})` : ''
  // 이 단말기가 이 주문의 POS 결제를 이미 확인했다(전산 통보만 밀림). 프론트 승인까지 결제로 기록하면 같은 주문에 돈이 둘이다.
  const record = peekLoadedRecord(cartId)
  if (record && record.paymentId) {
    deps.notify('error', `이 단말기에서 이 주문의 POS 결제를 이미 확인했고 전산에 알리는 중입니다${label}. ` +
      `손님이 두 번 냈을 수 있으니 ${DOUBLE_PAID_TAIL}`)
    return false
  }
  orphanRecordBusy.add(cartId)
  syncOrphanViews()
  try {
    let res
    try {
      res = await deps.apiPost(`/api/pos/erp-carts/${cartId}/record-front-orphan`)
    } catch {
      deps.notify('error', '서버에 연결하지 못해 기록하지 못했습니다. 잠시 후 다시 시도해주세요.')
      return false
    }
    if (!res.ok) {
      const body = res.body || {}
      if (res.status === 401) {
        deps.onUnauthorized(body.error)
        return false
      }
      if (res.status === 409 && body.code === 'AMOUNT_MISMATCH') {
        const orphanAmount = typeof body.orphanAmount === 'number' ? body.orphanAmount
          : typeof body.paymentAmount === 'number' ? body.paymentAmount
            : cart.frontOrphan && typeof cart.frontOrphan.amount === 'number' ? cart.frontOrphan.amount : null
        const cartAmount = typeof body.cartAmount === 'number' ? body.cartAmount : Number(cart.totalAmount) || 0
        deps.notify('error', `프론트 승인 금액(${orphanAmount === null ? '확인 불가' : formatWon(orphanAmount)})이 주문 합계(${formatWon(cartAmount)})와 달라 ` +
          `결제 완료로 기록하지 않았습니다${label}. 토스 결제내역과 전산을 대조해 본사에 확인해주세요.`)
        return false
      }
      if (res.status === 409) {
        deps.notify('error', orphanRefusedText(body, label))
        return false
      }
      deps.notify('error', body.error || '프론트 승인으로 결제 완료를 기록하지 못했습니다. 잠시 후 다시 시도해주세요.')
      return false
    }
    afterMutation()
    const wasStatus = (res.body && res.body.wasStatus) || cart.status || 'pending'
    // 품목 key는 결제 대기 기록에 있다 -- 기록을 지우기 전에 지운다.
    const lines = await deleteLoadedLines(cartId)
    forgetPendingPaid(cartId)
    forgetLoadAttempt(cartId)
    consumed.set(cartId, Date.now())
    sentToFront.delete(cartId)
    lastCarts = lastCarts.filter((c) => c.id !== cartId)
    lastFrontCarts = lastFrontCarts.filter((c) => c.id !== cartId)
    lastOrphanCarts = lastOrphanCarts.filter((c) => c.id !== cartId)
    const head = `프론트 승인으로 결제 완료를 기록했습니다${label}. 이 주문은 다시 결제하지 마세요.`
    if (lines.unreadable) {
      deps.notify('warn', `${head} POS 장바구니를 확인하지 못했습니다. POS [주문]에 이 주문의 품목이 남아 있으면 지워주세요.`)
    } else if (lines.failed) {
      deps.notify('warn', `${head} 다만 POS 품목 ${lines.failed}개를 지우지 못했습니다. POS [주문]에서 직접 지워주세요.`)
    } else if (lines.deleted) {
      deps.notify('success', `${head} POS [주문]에 담았던 품목도 지웠습니다.`)
    } else if (!lines.loadedHere && wasStatus === 'loaded') {
      deps.notify('warn', `${head} 다른 단말기에서 POS에 담은 주문이었다면 그 단말기의 POS [주문]에서 품목을 지워주세요.`)
    } else {
      deps.notify('success', head)
    }
    return true
  } finally {
    orphanRecordBusy.delete(cartId)
    renderErpCarts(lastCarts)
    renderFrontCarts()
    renderOrphanCarts()
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

// [지우기]에 서버가 "이미 처리됨"으로 답했을 때 실제 상태를 알리는 문구. 지운 것이 아니므로 "지웠습니다"라고 하지 않는다 -- 다른
// 단말기가 방금 담은 주문을 "지웠다"고 믿은 직원이 손님·전산에 취소됐다고 알리면, 전산이 다시 보내 두 번 결제될 수 있다.
//   forget: 이 단말기의 결제 대기 기록·담기 표식도 지울지(닫힌 주문만). 담김·결제된 주문의 기록은 결제 통보의 근거라 둔다.
function dismissAlreadyNote(status, label) {
  switch (status) {
    case 'dismissed':
      return { forget: true, message: `이미 지워진 주문입니다${label}. 다른 단말기에서 먼저 지웠을 수 있습니다.` }
    case 'loaded':
      return { forget: false, message: `다른 단말기에서 이미 POS에 담은 주문이라 지우지 않았습니다${label}. 그 단말기에서 결제하거나 [최근 결제]에서 담기 취소해주세요.` }
    case 'paid':
    case 'refund_requested':
    case 'refunding':
    case 'refunded':
      return { forget: false, message: `이미 결제된 주문이라 지우지 않았습니다${label}. [최근 결제]에서 확인해주세요.` }
    case 'cancelled':
      return { forget: true, message: `전산에서 이미 취소한 주문입니다${label}. 따로 지울 필요가 없습니다.` }
    case 'expired':
      return { forget: true, message: `이미 만료된 주문입니다${label}. 따로 지울 필요가 없습니다.` }
    case 'failed':
      return { forget: true, message: `이미 담기 실패로 닫힌 주문입니다${label}. 따로 지울 필요가 없습니다.` }
    default:
      return { forget: false, message: `이미 처리된 주문이라 지우지 않았습니다${label}${statusNote(status)}. 목록을 새로 불러옵니다.` }
  }
}

async function dismissCart(cartId) {
  const cart = lastCarts.find((c) => c.id === cartId)
  const label = cart && cart.referenceId ? ` (${cart.referenceId})` : ''
  inFlight.add(cartId)
  try {
    const { ok, status, body } = await reportConsume(cartId, { result: 'dismissed', errorMessage: '매장에서 지움' })
    if (!ok) {
      // 네트워크·5xx는 reportConsume이 이미 안내했고, 401은 토큰 화면으로 갔다. 4xx는 안내가 없으니 여기서 알린다
      // (예전에는 아무 반응 없이 끝났다). 카드는 서버 목록에 맞춘다.
      if (status && status !== 401 && status < 500) {
        if (status === 409 && body && body.payTarget === 'front') {
          sentToFront.set(cartId, Date.now())
          lastCarts = lastCarts.filter((c) => c.id !== cartId)
          deps.notify('warn', `프론트에서 결제하도록 넘어간 주문이라 지우지 않았습니다${label}. [프론트 결제 대기] 목록에서 확인해주세요.`)
        } else {
          deps.notify('error', (body && body.error) || `지우지 못했습니다${label}. 목록을 새로 불러옵니다.`)
        }
        refreshErpCarts()
      }
      return
    }
    if (body && body.alreadyProcessed) {
      const note = dismissAlreadyNote(body.status, label)
      if (note.forget) {
        forgetPendingPaid(cartId)
        forgetLoadAttempt(cartId)
      }
      removeCartFromView(cartId)
      deps.notify('warn', note.message)
      refreshErpCarts()
      return
    }
    // 지운 주문에 대기 중인 결제 기록이 남아 있으면 나중에 엉뚱한 결제와 맞아 "결제완료"로 보고될 수 있다.
    forgetPendingPaid(cartId)
    forgetLoadAttempt(cartId)
    removeCartFromView(cartId)
    deps.notify('success', `전산 주문을 지웠습니다${label}. 전산에는 "매장에서 지움"으로 남습니다.`)
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
// [프론트에 다시 띄우기]를 보내는 중인 cart. 손님이 결제창을 놓치면(시간 초과·닫기) 프론트는 그 주문을 2분 동안 쉬게 해서
// 그동안 결제할 방법이 없었다(되돌렸다 다시 넘기기 = 4번 누르기). 서버가 frontSentAt을 새로 찍으면 프론트가 쉬던 것을 풀고
// 바로 다시 띄운다(서버 C5). 결제가 일어나는 동작이 아니라(손님이 카드를 내야 결제된다) 두 번 누르기 확인은 두지 않는다.
const resendFrontBusy = new Set()

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
      const dismissArmed = orphanConfirm.has(`front-dismiss:${cart.id}`)
      const dismissing = frontDismissConfirm.has(cart.id) || dismissArmed
      const dismissLabel = dismissArmed ? ORPHAN_DISMISS_CONFIRM : dismissing ? '정말 지울까요?' : '지우기'
      const elapsed = paying ? payingElapsedMs(cart) : null
      const overdue = elapsed !== null && elapsed > FORCE_RELEASE_AFTER_MS
      const releasing = forceReleaseConfirm.has(cart.id)
      // 섹션 제목이 이미 '프론트 결제 대기'라서 카드마다 같은 말을 되풀이하지 않는다. '손님 결제 중'과 구분만 되면 된다.
      const statusText = !paying
        ? '결제 대기'
        : elapsed === null ? '손님 결제 중' : `손님 결제 중 · ${Math.max(1, Math.floor(elapsed / 60000))}분째`
      let actions = ''
      if (!paying) {
        // 프론트 승인 경고가 열려 있는 주문은 다시 띄우지 않는다 -- 손님이 이미 냈을 수 있어 또 띄우면 두 번 결제될 수 있다.
        // 경고를 먼저 정리해야 한다([프론트 결제로 완료 처리]·[확인했어요]).
        const resendBusy = resendFrontBusy.has(cart.id)
        const resend = isFrontOrphanOpen(cart)
          ? ''
          : `
            <button class="erp-cart-resend-front" type="button"
                    data-cart-id="${deps.escapeHtml(cart.id)}" ${resendBusy ? 'disabled' : ''}>${resendBusy ? '다시 띄우는 중...' : '프론트에 다시 띄우기'}</button>`
        actions = `
          <div class="erp-cart-actions">${resend}
            <button class="erp-cart-return${confirming ? ' confirming' : ''}" type="button"
                    data-cart-id="${deps.escapeHtml(cart.id)}">${confirming ? '정말 되돌릴까요?' : 'POS로 되돌리기'}</button>
            <button class="erp-cart-dismiss erp-cart-front-dismiss${dismissing ? ' confirming' : ''}" type="button"
                    data-cart-id="${deps.escapeHtml(cart.id)}">${dismissLabel}</button>
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
        <article class="erp-cart-item front-cart-item${isFrontOrphanOpen(cart) ? ' has-front-orphan' : ''}" data-cart-id="${deps.escapeHtml(cart.id)}">
          <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')}</div>
          <div class="erp-cart-head">
            <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
            <span class="front-cart-status${paying ? ' paying' : ''}">${statusText}</span>
          </div>
          ${frontOrphanBlock(cart)}
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

// ── 닫힌 주문의 프론트 승인 경고 ──────────────────────────────────────────────
// [결제 중 풀기] 뒤 직원이 [지우기]를 눌렀거나 만료·전산 취소로 닫힌 주문에 늦게 온 프론트 승인. 이런 주문은 전산 주문·프론트 결제·최근 결제
// 어느 목록에도 실리지 않아 경고가 한 번도 보이지 않았다 -- 전산이 새 주문번호로 다시 보내면 손님이 한 번 더 낸다. 서버가 최근 7일의
// 확인하지 않은 경고를 따로 싣는다(/api/pos/queue frontOrphans). 전산 주문 목록 위에 빨간 카드로 띄우고 [프론트 결제로 완료 처리]·
// [확인했어요]를 둔다.
const orphanListEl = document.getElementById('front-orphan-list')
const orphanSectionEl = document.getElementById('front-orphan-section')
let lastOrphanCarts = []

function renderOrphanCarts() {
  if (!orphanListEl || !deps) return
  if (orphanSectionEl) orphanSectionEl.hidden = lastOrphanCarts.length === 0
  orphanListEl.innerHTML = lastOrphanCarts
    .map((cart) => `
        <article class="erp-cart-item front-orphan-item has-front-orphan" data-cart-id="${deps.escapeHtml(cart.id)}">
          <div class="erp-cart-ref">${deps.escapeHtml(cart.referenceId || '')}</div>
          <div class="erp-cart-head">
            <strong class="erp-cart-car">${deps.escapeHtml(cart.carNumber || cart.memo || '-')}</strong>
            <span class="front-cart-status closed">${deps.escapeHtml(ORPHAN_CLOSED_LABEL[cart.status] || '닫힌 주문')}</span>
          </div>
          ${frontOrphanBlock(cart)}
          <div class="erp-cart-total">주문 합계 ${formatWon(cart.totalAmount)}</div>
        </article>
      `)
    .join('')
}

export function applyFrontOrphans(carts) {
  if (!deps) return
  // 확인했거나(ackAt) 방금 기록·확인한 주문(옛 응답)은 싣지 않는다.
  lastOrphanCarts = (Array.isArray(carts) ? carts : []).filter((c) => c && typeof c.id === 'string' && isFrontOrphanOpen(c) && !isConsumed(c.id))
  renderOrphanCarts()
}

function handleOrphanListClick(e) {
  const recordBtn = e.target.closest('button.erp-cart-orphan-record')
  if (recordBtn && !recordBtn.disabled) {
    handleOrphanRecordClick(recordBtn.dataset.cartId)
    return
  }
  const ackBtn = e.target.closest('button.erp-cart-orphan-ack')
  if (ackBtn && !ackBtn.disabled) handleOrphanAckClick(ackBtn.dataset.cartId)
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

// [프론트에 다시 띄우기]: 결제 대기(pending)인 프론트 주문의 frontSentAt을 새로 찍게 한다(서버 C5). 그 밖의 상태면 서버가 409와
// status를 돌려준다(손님이 결제 중이거나 이미 끝남). 이 경로를 모르는 옛 서버는 본문 없는 404를 준다.
async function resendToFront(cartId) {
  if (resendFrontBusy.has(cartId)) return
  const cart = lastFrontCarts.find((c) => c.id === cartId)
  // 그 사이 경고가 생긴 주문은 보내지 않는다(renderFrontCarts의 버튼 숨김과 같은 이유).
  if (!cart || isFrontOrphanOpen(cart)) return
  resendFrontBusy.add(cartId)
  renderFrontCarts()
  const label = cart.carNumber ? ` (${cart.carNumber})` : ''
  try {
    let ok, status, body
    try {
      ;({ ok, status, body } = await deps.apiPost(`/api/pos/erp-carts/${cartId}/resend-front`))
    } catch {
      deps.notify('error', '서버에 연결하지 못해 다시 띄우지 못했어요. 잠시 후 다시 시도해주세요.')
      return
    }
    body = body || {}
    if (!ok) {
      if (status === 401) {
        deps.onUnauthorized(body.error)
        return
      }
      if (status === 404 && !body.error) {
        deps.notify('error', '서버가 아직 [프론트에 다시 띄우기]를 지원하지 않아요. [POS로 되돌리기]로 되돌린 뒤 다시 넘겨주세요.')
        return
      }
      if (status === 409 && body.status === 'paying') {
        deps.notify('warn', `손님이 이미 프론트에서 결제하고 있어요${label}. 결제가 끝날 때까지 기다려주세요.`)
      } else if (status === 409) {
        deps.notify('warn', `결제 대기 상태가 아니라서 다시 띄우지 않았어요${label}${statusNote(body.status)}. 목록을 새로 불러올게요.`)
      } else {
        deps.notify('error', body.error || '프론트에 다시 띄우지 못했어요. 잠시 후 다시 시도해주세요.')
        return
      }
      // 409는 목록이 낡았다는 뜻이다 -- 폴링을 빠르게 돌려 바로 맞춘다.
      try {
        if (typeof deps.noteActivity === 'function') deps.noteActivity()
      } catch {
        // 폴링 간격 조정이 실패해도 안내는 이미 했다.
      }
      return
    }
    afterMutation()
    if (body.frontSentAt) {
      lastFrontCarts = lastFrontCarts.map((c) => (c.id === cartId ? { ...c, frontSentAt: body.frontSentAt } : c))
    }
    // 바로 뜬다고 약속하지 않는다. 그 프론트에 확인이 안 끝난 지난 결제 기록이 남아 있으면 프론트가 이 주문을 1~10분 쉬게 하고(erp-front-pay.js
    // holdStuck), 다시 보내도 그 쉬기는 풀리지 않는다 -- 예전 문구('다시 띄웠어요')를 믿고 손님을 보내면 그동안 결제창이 뜨지 않는다.
    deps.notify('success', `프론트에 다시 보냈어요${label}. 프론트가 지난 결제를 확인하는 중이면 조금 뒤에 떠요.`)
  } finally {
    resendFrontBusy.delete(cartId)
    renderFrontCarts()
  }
}

function handleFrontListClick(e) {
  const resendBtn = e.target.closest('button.erp-cart-resend-front')
  if (resendBtn) {
    if (!resendBtn.disabled) {
      resendToFront(resendBtn.dataset.cartId).catch((err) => {
        deps.notify('error', `처리 중 오류가 발생했습니다: ${err?.message || err}`)
      })
    }
    return
  }
  const ackBtn = e.target.closest('button.erp-cart-orphan-ack')
  if (ackBtn && !ackBtn.disabled) {
    handleOrphanAckClick(ackBtn.dataset.cartId)
    return
  }
  const recordBtn = e.target.closest('button.erp-cart-orphan-record')
  if (recordBtn && !recordBtn.disabled) {
    handleOrphanRecordClick(recordBtn.dataset.cartId)
    return
  }
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
  // 프론트 승인 경고가 있는 주문은 지우기 전에 경고 확인을 한 번 더 받는다(passOrphanGate).
  if (!passOrphanGate('front-dismiss', cartId)) return
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
    if (body && body.status === 'dismissed') {
      // 들어온 지 24시간이 지난 주문은 서버가 대기로 돌리지 않고 닫는다(같은 주문번호로는 다시 결제할 수 없다). 예전에는 응답을 보지 않고
      // 대기로 그려 [POS로 되돌리기]·[지우기]를 안내했다 -- 누르면 409가 나고 다음 폴링에 카드가 말없이 사라져 주문이 어디 갔는지 몰랐다.
      // ('접수'는 손님 정비 접수를 가리키는 말이라 전산 주문에는 쓰지 않는다.)
      sentToFront.delete(cartId)
      lastFrontCarts = lastFrontCarts.filter((c) => c.id !== cartId)
      deps.notify('warn', '주문이 들어온 지 24시간이 지나 결제 중을 풀면서 주문을 닫았습니다. 결제하려면 전산에서 다시 보내주세요.')
      return
    }
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
  const ackBtn = e.target.closest('button.erp-cart-orphan-ack')
  if (ackBtn && !ackBtn.disabled) {
    const id = ackBtn.dataset.cartId
    if (!inFlight.has(id)) handleOrphanAckClick(id)
    return
  }

  const recordBtn = e.target.closest('button.erp-cart-orphan-record')
  if (recordBtn && !recordBtn.disabled) {
    const id = recordBtn.dataset.cartId
    if (!inFlight.has(id) && !isConsumed(id)) handleOrphanRecordClick(id)
    return
  }

  const frontBtn = e.target.closest('button.erp-cart-front')
  if (frontBtn && !frontBtn.disabled) {
    const id = frontBtn.dataset.cartId
    if (!cardActionBlocked(id) && passOrphanGate('front', id)) handleFrontClick(id)
    return
  }

  const dismissBtn = e.target.closest('button.erp-cart-dismiss')
  if (dismissBtn && !dismissBtn.disabled) {
    const id = dismissBtn.dataset.cartId
    // 프론트 승인 경고가 있는 주문은 지우면 손님이 낸 돈이 전산에 미결제로 남는다 -- 한 번 더 확인받는다(passOrphanGate).
    if (!cardActionBlocked(id) && passOrphanGate('dismiss', id)) handleDismissClick(id)
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
  // 프론트에서 이미 승인된 결제가 있는 주문은 담기 전에 한 번 더 확인받는다(passOrphanGate).
  if (!passOrphanGate('load', cartId)) return
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
// 저장하고, 결제된 POS 주문을 order.getOrder로 읽어 기록의 품목이 그 주문에 모두 들어 있고 금액도 모자라지
// 않는 기록만 보고한다(pickMatchingEntries). 금액만 같거나 이름만 같은 것으로는 보고하지 않는다. 맞는 기록이
// 없거나 둘 이상이면 추측하지 않고, 그 결제를 "맞추지 못한 결제"로 이 단말기에 남겨 둔다 -- 직원이 [최근 결제]의
// [POS에서 결제했어요]에서 골라 기록한다(rememberUnmatchedPayment).
// 판단 기준이 시간에서 내용으로 바뀌어서 10분 유효시간은 없앴다. 대신 기록이 영영 쌓이지 않도록
// 지우는 시점을 둔다: [지우기]·담기 취소(unload)·결제 확정·서버가 끝난 주문이라고 답했을 때, 그리고
// POS 장바구니에서 이 기록의 품목이 모두 사라졌을 때(reconcileWithDraft).
//
// 여러 건을 연달아 담고 한 번에 결제할 수도 있으므로 배열로 들고 있고, 결제된 주문에 기록 몇 건이
// 함께 들어 있으면 그 건들을 함께 보고한다(pickMatchingEntries).
//
// 기록의 모양: { id, ref, at, keys, totalAmount, items:[{title,quantity,unitPrice}], attemptId,
//   needsConsume?, goneAt?, paymentId?, orderId?, paidAt?, paidAmount?, paidTitles?, paidRejects? }.
// paymentId부터는 'paid'가 확정된 뒤 통보가 실패해 남은 건에만 붙는다(paidRejects는 서버가 4xx로 거절한 횟수).
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

// ── 담기 시도 표식(attemptId) ────────────────────────────────────────────────
// 서버는 [담기 취소]를 담은 단말기에서만 받는다(담을 때 consume에 실은 attemptId와 같은지 본다). 예전에는 이 값을 결제 대기 기록 안에만
// 두어서, 직원이 POS 장바구니에서 품목을 지우고 5분이 지나 기록이 정리되면(dropVanishedEntries) attemptId도 함께 사라졌다 -- 담은
// 단말기에서 누른 [담기 취소]가 '다른 단말기에서 담은 주문'으로 최대 30분 거절됐다(단말기가 한 대뿐인 매장에서도).
// 그래서 대조용 기록과 따로, 기록 정리가 건드리지 않는 곳에 7일 동안 남긴다(cartId -> {attemptId, at}). 지우는 때는 담기 취소가
// 성공했을 때, 결제 완료로 기록됐을 때, 이 단말기가 담지 않은 것으로 판명됐을 때(다른 단말기가 가져감·지우기)뿐이다. 남은 값이
// 틀려도(그 뒤 다른 단말기가 다시 담음) 서버가 다르다고 거절할 뿐이라 해가 없다. 대기 기록에 껍데기를 남기는 방식은 쓰지 않는다 --
// 결제 대조(handlePaid)가 기록이 있다고 보고 모든 POS 결제를 맞추지 못한 결제로 만들 수 있다.
const LOAD_ATTEMPTS_KEY = 'chevrolet_erp_load_attempts'
const LOAD_ATTEMPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LOAD_ATTEMPTS_MAX = 200

function loadAttempts() {
  try {
    const raw = localStorage.getItem(LOAD_ATTEMPTS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const now = Date.now()
    const out = {}
    for (const id of Object.keys(parsed)) {
      const v = parsed[id]
      if (v && typeof v.attemptId === 'string' && v.attemptId && Number.isFinite(v.at) && now - v.at <= LOAD_ATTEMPT_TTL_MS) out[id] = v
    }
    return out
  } catch {
    return {}
  }
}

function saveAttempts(map) {
  try {
    const ids = Object.keys(map).sort((a, b) => map[a].at - map[b].at).slice(-LOAD_ATTEMPTS_MAX)
    if (!ids.length) {
      localStorage.removeItem(LOAD_ATTEMPTS_KEY)
      return
    }
    const kept = {}
    for (const id of ids) kept[id] = map[id]
    localStorage.setItem(LOAD_ATTEMPTS_KEY, JSON.stringify(kept))
  } catch {
    // 저장이 막힌 환경이면 담기 취소가 '다른 단말기'로 거절될 수 있을 뿐이다(30분 뒤 [그래도 되돌리기]로 풀린다).
  }
}

function rememberLoadAttempt(cartId, attemptId) {
  if (!cartId || !attemptId) return
  const map = loadAttempts()
  map[cartId] = { attemptId, at: Date.now() }
  saveAttempts(map)
}

// 결제 대기 기록 안의 attemptId를 담기 표식으로 옮긴다(이미 있는 표식은 그대로 둔다). 표식 시각은 담은 시각(기록의 at)으로 해서 7일이
// 원래 담은 때부터 세어지게 한다. 두 곳에서 부른다:
//   - 시작할 때: 업그레이드 전 탭앱은 attemptId를 대기 기록 안에만 두었다. 옮기지 않으면 업그레이드 전에 담은 주문의 품목이 지워지고 5분 뒤
//     기록이 정리되는 순간 표식이 사라져, 담은 단말기의 [담기 취소]가 '다른 단말기에서 담은 주문'으로 거절된다.
//   - 품목이 사라진 기록을 정리할 때(dropVanishedEntries): 어떤 경로로 표식이 빠졌든 기록과 함께 잃지 않는다.
function preserveLoadAttempts(entries) {
  const withIds = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.id === 'string' && typeof e.attemptId === 'string' && e.attemptId)
  if (!withIds.length) return
  const map = loadAttempts()
  const now = Date.now()
  let changed = false
  for (const e of withIds) {
    if (map[e.id]) continue
    const at = Number.isFinite(e.at) ? Math.min(e.at, now) : now
    if (now - at > LOAD_ATTEMPT_TTL_MS) continue
    map[e.id] = { attemptId: e.attemptId, at }
    changed = true
  }
  if (changed) saveAttempts(map)
}

function forgetLoadAttempt(cartId) {
  const map = loadAttempts()
  if (!map[cartId]) return
  delete map[cartId]
  saveAttempts(map)
}

function loadAttemptOf(cartId) {
  const v = loadAttempts()[cartId]
  return v ? v.attemptId : null
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
  // 담기 표식은 대조용 기록과 따로 남긴다(위 '담기 시도 표식' 주석). consume 보고보다 먼저 남겨야 보고가 안 닿아도 남는다.
  rememberLoadAttempt(cart.id, attemptId)
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

// 최근 결제 화면이 [담기 취소]·[POS에서 결제했어요]를 판단할 때 이 단말기의 기록을 본다(기록은 바꾸지 않는다).
// 이 단말기가 담은 주문이 아니면 null이다(대조용 기록이 정리됐어도 담기 표식이 남아 있으면 attemptId만 실어 돌려준다).
//   attemptId: 담을 때 만든 표식. 서버는 담기 취소를 담은 단말기에서만 받는다(같은 표식인지 본다).
//   paymentId: 이 단말기가 결제를 확인했지만 전산 통보가 밀려 있는 건. 이때 담기 취소하면 받은 돈이 기록에서 사라진다.
//   goneAt: POS 장바구니에서 이 기록의 품목이 사라진 시각. 결제로 비워졌을 수도 있다.
export function peekLoadedRecord(cartId) {
  const entry = loadPendingPaid().find((e) => e.id === cartId)
  const attemptId = (entry && entry.attemptId) || loadAttemptOf(cartId)
  if (!entry && !attemptId) return null
  return {
    attemptId: attemptId || null,
    paymentId: (entry && entry.paymentId) || null,
    goneAt: (entry && entry.goneAt) || null,
    keys: entry && Array.isArray(entry.keys) ? entry.keys : [],
  }
}

// [POS에서 결제했어요]로 결제를 기록한 뒤 부른다. 대기 기록이 남아 있으면 나중의 다른 결제와 또 맞을 수 있다.
export function forgetPaidCart(cartId) {
  forgetPendingPaid(cartId)
  forgetLoadAttempt(cartId)
  afterMutation()
}

// [POS에서 결제했어요]·[POS에서 다시 결제했어요]로 고른 결제를 서버에 기록한 뒤 부른다(settledCarts.submitManualPaid).
//   - 그 결제는 맞추지 못한 결제 목록에서 바로 지우지 않고 기록한 주문을 붙여 둔다. 한 결제로 전산 주문 여러 건을 함께 계산했을 수
//     있다(할인 때문에 자동 대조가 못 맞춘 경우 등) -- 다른 주문도 같은 결제로 기록할 수 있어야 한다. 기록한 주문 합계가 결제 금액에
//     이르면 뺀다(markUnmatchedRecorded).
//   - 이 POS 주문을 전산에 알렸다고 남긴다(취소 후 다시 결제를 알아보는 데 쓴다, rememberReportedOrder).
//   - 이 단말기의 결제 대기 기록과 담기 표식을 지운다. 남겨 두면 나중의 다른 결제와 또 맞을 수 있다.
export function noteManualPaid(cart, payment) {
  if (!cart || !payment || !payment.paymentId) return
  const ref = cart.referenceId || ''
  markUnmatchedRecorded(payment.paymentId, { id: cart.id, ref, total: Number(cart.totalAmount) || 0 })
  if (payment.orderId) rememberReportedOrder(payment.orderId, payment.paymentId, [{ id: cart.id, ref }])
  // 다시 결제를 기록했으니 이 주문은 더 기다릴 필요가 없다(repay 창 주석).
  closeRepayWindowFor([cart.id])
  forgetPaidCart(cart.id)
}

// 최근 결제 목록의 [POS에서 비우기](서버 unload)가 성공한 뒤 부른다. 서버는 그 주문을 pending으로
// 되돌렸으므로 (1) 대기 중인 결제 기록을 지우고(안 지우면 이후 엉뚱한 결제와 맞을 수 있다) (2) 방금 처리했다고
// 기억해 둔 consumed에서 빼고(안 빼면 60초 동안 되살아난 카드를 화면이 걸러낸다) (3) POS 목록을 바로 맞춘다.
// POS 장바구니에 담겨 있던 품목은 건드리지 않는다 -- 이 주문을 다시 담으려면 먼저 그 품목을 지워야
// 같은 품목이 두 번 들어가지 않는다. 호출하는 쪽이 안내할 수 있게 지운 기록의 key들을 돌려준다.
// 결제가 붙은 기록(paymentId)은 지우지 않는다 -- 전산에 결제를 알릴 근거다. 담기 취소는 그런 기록이 있으면
// 요청 전에 막지만(settledCarts.unloadCart), 다른 경로로 불려도 받은 돈의 흔적이 사라지지 않게 여기서도 지킨다.
export function forgetLoadedCart(cartId) {
  const forgotten = loadPendingPaid().find((e) => e.id === cartId)
  if (!(forgotten && forgotten.paymentId)) forgetPendingPaid(cartId)
  // 서버가 담기를 되돌렸으니 이 시도의 표식은 더 쓸 데가 없다(다시 담으면 새 표식이 생긴다).
  forgetLoadAttempt(cartId)
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
  if (kept.length === entries.length) return
  // 기록은 지워도 담기 표식은 남긴다(preserveLoadAttempts 주석).
  preserveLoadAttempts(entries.filter((e) => !kept.includes(e)))
  savePendingPaid(kept)
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

// inner의 품목이 모두 outer 안에 들어 있는지(이름마다 outer 쪽 수량이 같거나 많은지). 같은지가 아니라 들어 있는지를
// 보는 이유: 전산 주문을 담은 뒤 같은 손님 몫으로 POS 상품(와이퍼 등)을 더 담아 한 번에 결제하는 일이 흔하다. 예전에는
// 품목이 정확히 같아야 해서 이런 결제를 맞추지 못했고, 그 결제는 아무 데도 남지 않았다.
function tallyContains(outer, inner) {
  for (const [title, quantity] of inner) {
    if ((outer.get(title) || 0) < quantity) return false
  }
  return true
}

function readLineQuantity(line) {
  const q = line && line.quantity
  return Number(q && typeof q === 'object' ? q.value : q)
}

// 주문이 다 결제됐는지. 'paid' 이벤트는 결제 한 건마다 온다 -- 카드 두 장으로 나눠 결제하면 첫 'paid' 때 주문은
// 'PAID'(부분 결제)다. 그때 보고하면 두 번째 결제가 실패하거나 중단돼도 전산은 전액 결제로 안다.
//   'full' = 남은 금액 없음(COMPLETED 또는 미납 0), 'partial' = 남은 금액이 있음, 'closed' = 취소·환불된 주문,
//   null = 알 수 없음(이때는 보고하지 않는다).
function readPaymentProgress(order) {
  const state = order && order.paymentState
  const unpaid = order && order.paymentPrice && typeof order.paymentPrice.paymentUnpaidValue === 'number'
    ? order.paymentPrice.paymentUnpaidValue
    : null
  if (state === 'CANCELLED' || state === 'REFUNDED') return 'closed'
  if (state === 'COMPLETED' || unpaid === 0) return 'full'
  if (state === 'PAID' || state === 'OPENED' || (unpaid !== null && unpaid > 0)) return 'partial'
  return null
}

// getOrder 결과에서 대조에 쓸 값만 뽑는다. 읽을 수 없는 값은 null -- "다르다"가 아니라 "알 수 없다"로 취급하고,
// 알 수 없으면 맞는다고 하지 않는다.
function readPaidOrder(order) {
  const lines = Array.isArray(order && order.lineItems) ? order.lineItems : []
  const readable = lines.length > 0 && lines.every((li) => typeof (li && li.item && li.item.title) === 'string' && Number.isFinite(readLineQuantity(li)))
  const tally = readable
    ? tallyByTitle(lines.map((li) => ({ title: li.item.title, quantity: readLineQuantity(li) })))
    : null
  const amount = order && order.chargePrice && typeof order.chargePrice.chargePriceValue === 'number'
    ? order.chargePrice.chargePriceValue
    : null
  return { tally, amount, progress: readPaymentProgress(order) }
}

// 대조할 수 있는 기록인지. 품목이 없거나 수량이 0뿐인 기록은 어떤 결제에도 "들어 있다"가 되어 버린다.
function matchableEntry(entry) {
  return Array.isArray(entry.items) && entry.items.some((i) => normalizeTitle(i.title) && Number(i.quantity) > 0)
}

// 기록 몇 건(subset)이 결제된 주문에 들어 있는지. 기록의 품목 이름·수량이 모두 주문 품목 안에 있고, 주문 청구 금액이
// 기록 합계 이상이어야 한다. 품목을 못 읽었거나 금액을 모르면 맞는다고 하지 않는다 -- 금액만 같은 다른 손님 결제나,
// 이름만 같은 상품을 다른 금액에 판 결제를 전산 주문의 결제로 보고하면 돈을 안 받은 주문이 결제완료가 된다.
function subsetFits(subset, paid) {
  if (!paid.tally || paid.amount === null) return false
  const tally = tallyByTitle(subset.flatMap((e) => e.items || []).filter((i) => Number(i.quantity) > 0))
  if (!tallyContains(paid.tally, tally)) return false
  const total = subset.reduce((sum, e) => sum + Math.max(0, Number(e.totalAmount) || 0), 0)
  return paid.amount >= total
}

// 결제된 주문에 들어 있는 기록 묶음을 찾는다. 들어 있는 묶음은 그 일부도 늘 들어 있다(전산 주문 두 건을 한 번에
// 결제하면 한 건만 떼어 봐도 들어 있다) -- 그래서 한 건도 더 붙일 수 없는 가장 큰 묶음만 후보로 센다. 그런 묶음이
// 정확히 하나일 때만 고르고, 없거나 둘 이상이면(같은 내용의 전산 주문 두 건 중 한 건만 결제 등) 고르지 않는다.
function pickMatchingEntries(fresh, paid) {
  const candidates = fresh.filter(matchableEntry)
  const n = candidates.length
  if (!n || !paid.tally || paid.amount === null) return { kind: 'none' }
  // 묶음 수가 2^n이다. 현실의 n은 한두 건이고 그 이상은 어차피 사람이 확인해야 할 상황이다.
  if (n > 10) return { kind: 'ambiguous' }
  const fits = new Set()
  for (let mask = 1; mask < (1 << n); mask += 1) {
    if (subsetFits(candidates.filter((_, i) => mask & (1 << i)), paid)) fits.add(mask)
  }
  // 들어 있는 묶음의 일부는 늘 들어 있으므로(품목도 금액도 줄기만 한다), 한 건을 더 붙인 묶음이 하나도 안 들어
  // 있으면 그 묶음이 가장 크다.
  const largest = [...fits].filter((mask) => {
    for (let i = 0; i < n; i += 1) {
      const bit = 1 << i
      if (!(mask & bit) && fits.has(mask | bit)) return false
    }
    return true
  })
  if (largest.length === 1) return { kind: 'match', entries: candidates.filter((_, i) => largest[0] & (1 << i)) }
  return { kind: largest.length ? 'ambiguous' : 'none' }
}

// 주문을 읽지 못했을 때 맞추지 못한 결제 목록에 금액이라도 남기려고 결제 한 건을 읽어 본다.
async function readPaymentAmount(paymentId) {
  try {
    if (posPluginSdk.payment && typeof posPluginSdk.payment.getPayment === 'function') {
      const payment = await posPluginSdk.payment.getPayment(paymentId)
      if (payment && typeof payment.amountMoney === 'number') return payment.amountMoney
    }
  } catch (e) {
    console.error('[erp-cart] POS 결제를 읽지 못했습니다.', e?.message)
  }
  return null
}

// 결제된 POS 주문을 읽어 기록과 맞춘다. summary는 맞추지 못한 결제로 남길 때 직원에게 보여줄 값(금액·품목)이다.
//   { kind: 'match', entries }  보고할 기록이 정해졌다
//   { kind: 'partial', relevant }  나눠 결제 중이다. 남은 금액이 결제되면 같은 주문의 'paid'가 다시 온다.
//                                  relevant는 다 결제되면 맞을 기록이 지금 있는지(안내를 띄울지)다.
//   { kind: 'closed' }  읽어 보니 이미 취소·환불된 주문이다
//   { kind: 'none' | 'ambiguous' | 'unreadable' }  맞추지 못했다
async function readPosOrder(orderId) {
  try {
    // SDK 버전에 따라 없을 수 있다. 없으면 대조할 방법이 없으니 보고하지 않는다.
    if (orderId && posPluginSdk.order && typeof posPluginSdk.order.getOrder === 'function') {
      return (await posPluginSdk.order.getOrder(orderId)) || null
    }
  } catch (e) {
    console.error('[erp-cart] 결제된 POS 주문을 읽지 못했습니다.', e?.message)
  }
  return null
}

// 결제된 POS 주문을 읽어 대조 값(paid)과 직원에게 보여줄 값(summary)을 만든다. 주문을 못 읽으면 paid는 null이고 금액만 결제에서 읽는다.
async function readPaidSummary(paymentId, orderId) {
  const order = await readPosOrder(orderId)
  if (!order) return { paid: null, summary: { amount: await readPaymentAmount(paymentId), titles: [] } }
  const paid = readPaidOrder(order)
  const summary = {
    amount: paid.amount,
    titles: paid.tally ? [...paid.tally].map(([title, quantity]) => `${title} ×${quantity}`) : [],
  }
  return { paid, summary }
}

async function matchFreshEntries(fresh, paymentId, orderId) {
  const { paid, summary } = await readPaidSummary(paymentId, orderId)
  if (!paid) return { kind: 'unreadable', summary }
  if (paid.progress === 'closed') return { kind: 'closed', summary }
  if (paid.progress === 'partial') {
    // 지금 금액(청구 총액)은 이미 다 결제됐을 때와 같아서, 다 결제되면 맞을지 미리 볼 수 있다.
    return { kind: 'partial', relevant: pickMatchingEntries(fresh, paid).kind === 'match', summary }
  }
  // 다 결제됐는지 모르면 보고하지 않는다(나눠 결제의 첫 건일 수 있다). 직원이 확인해 기록하게 남긴다.
  if (paid.progress === null) return { kind: 'unreadable', summary }
  return { ...pickMatchingEntries(fresh, paid), summary }
}

// ── 맞추지 못한 POS 결제 ────────────────────────────────────────────────────
// 전산 주문과 맞추지 못한 실제 POS 결제. 예전에는 안내만 띄우고 버려서 받은 돈이 어느 전산 주문 몫인지 남는 곳이
// 없었다 -- 최근 결제에는 그 주문이 'POS에 담김 · 결제 전'으로 남고 [담기 취소]만 보여, 되돌린 뒤 다시 결제하면
// 이중 청구였다. 이 단말기에 24시간(최대 30건) 남겨 두고, 최근 결제의 [POS에서 결제했어요]에서 직원이 골라 기록한다.
// 모양: { paymentId, orderId, amount(원, 모르면 null), at(결제를 받은 시각 ms), titles:['이름 ×수량'],
//   recordedCartIds?, recordedRefs?, recordedTotal?  -- [POS에서 결제했어요]로 이미 기록한 주문(한 결제로 여러 주문을 함께 계산한 경우)
//   hintCartIds?, hintRefs?, hintKind?  -- 이 결제와 이어졌을 수 있는 주문. 'repaid' = 전산에 알린 POS 주문에 다시 들어온 결제,
//                                         'lost' = 그 주문의 결제 통보가 실패한 사이 대기 기록이 지워짐 }
const UNMATCHED_KEY = 'chevrolet_erp_unmatched_payments'
const UNMATCHED_TTL_MS = 24 * 60 * 60 * 1000
const UNMATCHED_MAX = 30

function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v) : []
}

export function listUnmatchedPayments() {
  try {
    const raw = localStorage.getItem(UNMATCHED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter((p) => p && typeof p.paymentId === 'string' && p.paymentId &&
      Number.isFinite(p.at) && now - p.at <= UNMATCHED_TTL_MS)
  } catch {
    return []
  }
}

// 전산 주문 몫일 가능성이 높은 결제(이어진 주문 표시나 이미 기록한 주문이 있음). 30건을 넘으면 이런 결제는 일반 판매보다 늦게 밀어낸다 --
// 바쁜 날 일반 판매에 밀려 'lost'·'repaid' 표시가 붙은 진짜 결제가 사라지면 [POS에서 결제했어요]로 기록할 길이 없다.
function isMarkedUnmatched(p) {
  return stringList(p && p.hintCartIds).length > 0 || stringList(p && p.recordedCartIds).length > 0
}

function saveUnmatchedPayments(list) {
  try {
    let kept = list
    if (kept.length > UNMATCHED_MAX) {
      let excess = kept.length - UNMATCHED_MAX
      const drop = new Set()
      // 목록은 받은 시각 순이다 -- 표시 없는 것 중 오래된 것부터 뺀다.
      for (const p of kept) {
        if (excess <= 0) break
        if (isMarkedUnmatched(p)) continue
        drop.add(p)
        excess -= 1
      }
      kept = kept.filter((p) => !drop.has(p)).slice(-UNMATCHED_MAX)
    }
    if (kept.length) localStorage.setItem(UNMATCHED_KEY, JSON.stringify(kept))
    else localStorage.removeItem(UNMATCHED_KEY)
  } catch {
    // 저장이 막힌 환경이면 남기지 못한다. 직원에게는 이미 안내가 떴다.
  }
}

function rememberUnmatchedPayment(payment) {
  if (!payment || !payment.paymentId) return
  const paymentId = String(payment.paymentId)
  const all = listUnmatchedPayments()
  const prev = all.find((p) => p.paymentId === paymentId)
  const amount = typeof payment.amount === 'number' && Number.isFinite(payment.amount) ? payment.amount : null
  const at = Number.isFinite(payment.at) ? payment.at : Date.now()
  const titles = Array.isArray(payment.titles) ? payment.titles.map(String).slice(0, 20) : []
  const entry = {
    paymentId,
    orderId: payment.orderId ? String(payment.orderId) : (prev && prev.orderId) || '',
    amount: amount !== null ? amount : prev ? prev.amount : null,
    // 같은 결제를 다시 남겨도 처음 받은 시각을 둔다 -- 고르기 칸은 "담은 뒤의 결제"를 이 시각으로 가른다.
    at: prev ? Math.min(prev.at, at) : at,
    titles: titles.length ? titles : (prev && prev.titles) || [],
  }
  // 이미 기록한 주문과 이어진 주문 표시는 다시 남길 때도 잃지 않는다.
  if (prev && stringList(prev.recordedCartIds).length) {
    entry.recordedCartIds = stringList(prev.recordedCartIds)
    entry.recordedRefs = Array.isArray(prev.recordedRefs) ? prev.recordedRefs.map(String) : []
    entry.recordedTotal = Number(prev.recordedTotal) || 0
  }
  const hintCartIds = stringList(prev && prev.hintCartIds)
  const hintRefs = prev && Array.isArray(prev.hintRefs) ? prev.hintRefs.map(String) : []
  stringList(payment.hintCartIds).forEach((id, i) => {
    if (hintCartIds.includes(id)) return
    hintCartIds.push(id)
    hintRefs.push(String((payment.hintRefs && payment.hintRefs[i]) || id))
  })
  if (hintCartIds.length) {
    entry.hintCartIds = hintCartIds
    entry.hintRefs = hintRefs
    entry.hintKind = payment.hintKind || (prev && prev.hintKind) || null
  }
  // 같은 결제는 한 번만 남긴다(같은 'paid'가 두 번 와도). 오래된 것부터 밀려난다.
  const list = all.filter((p) => p.paymentId !== paymentId)
  list.push(entry)
  list.sort((a, b) => a.at - b.at)
  saveUnmatchedPayments(list)
}

// [POS에서 결제했어요]로 이 결제를 주문 하나에 기록했다. 목록에서 바로 빼지 않는다 -- 같은 결제로 함께 계산한 다른 전산 주문(할인으로
// 합계가 안 맞아 자동 대조가 못 맞춘 경우 등)도 이 결제로 기록할 수 있어야 한다. 예전에는 바로 빼서, 둘째 주문은 돈을 받았는데도
// 'POS에 담김 · 결제 전'으로 갇혔다. 기록한 주문 합계가 결제 금액에 이르면 더 나눠 쓸 몫이 없으니 뺀다(금액을 모르면 24시간 뒤 빠진다).
function markUnmatchedRecorded(paymentId, cart) {
  const list = listUnmatchedPayments()
  const p = list.find((x) => x.paymentId === paymentId)
  if (!p) return
  const ids = stringList(p.recordedCartIds)
  const refs = Array.isArray(p.recordedRefs) ? p.recordedRefs.map(String) : []
  let total = Number(p.recordedTotal) || 0
  if (!ids.includes(cart.id)) {
    ids.push(cart.id)
    refs.push(cart.ref || cart.id)
    total += Math.max(0, Number(cart.total) || 0)
  }
  if (typeof p.amount === 'number' && total >= p.amount) {
    saveUnmatchedPayments(list.filter((x) => x.paymentId !== paymentId))
    return
  }
  saveUnmatchedPayments(list.map((x) => (x.paymentId === paymentId
    ? { ...x, recordedCartIds: ids, recordedRefs: refs, recordedTotal: total }
    : x)))
}

// 목록에서 결제를 뺀다(POS에서 취소된 결제 등 더 기록할 수 없는 결제).
export function removeUnmatchedPayment(paymentId) {
  const list = listUnmatchedPayments()
  const next = list.filter((p) => p.paymentId !== paymentId)
  if (next.length !== list.length) saveUnmatchedPayments(next)
}

// ── 전산에 결제 완료로 알린 POS 주문 ──────────────────────────────────────────
// POS 주문 -> { paymentId, cartIds, refs, at }. 24시간 남긴다(탭앱이 다시 로드돼도 남게 저장소에 둔다).
// 직원이 POS [주문]에서 결제를 취소하고 다른 카드로 다시 결제하면(카드 바꿔 결제·할부 변경) 같은 POS 주문에 새 'paid'가 온다. 예전에는
// 처리한 주문 ID로 걸러 그 결제를 그냥 버렸고, 전산 주문은 토스 취소 웹훅으로 refunded가 되어 받은 돈이 어디에도 남지 않았다.
// 이 기록으로 "이미 전산에 알린 주문의 새 결제"를 알아보고, 자동으로 보고하지 않고 그 주문 ID를 붙여 맞추지 못한 결제로 남긴다.
const REPORTED_ORDERS_KEY = 'chevrolet_erp_reported_orders'
const REPORTED_ORDER_TTL_MS = 24 * 60 * 60 * 1000
const REPORTED_ORDERS_MAX = 100

function loadReportedOrders() {
  try {
    const raw = localStorage.getItem(REPORTED_ORDERS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const now = Date.now()
    const out = {}
    for (const orderId of Object.keys(parsed)) {
      const v = parsed[orderId]
      if (v && typeof v.paymentId === 'string' && Number.isFinite(v.at) && now - v.at <= REPORTED_ORDER_TTL_MS) {
        out[orderId] = { paymentId: v.paymentId, cartIds: stringList(v.cartIds), refs: Array.isArray(v.refs) ? v.refs.map(String) : [], at: v.at }
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveReportedOrders(map) {
  try {
    const ids = Object.keys(map).sort((a, b) => map[a].at - map[b].at).slice(-REPORTED_ORDERS_MAX)
    if (!ids.length) {
      localStorage.removeItem(REPORTED_ORDERS_KEY)
      return
    }
    const kept = {}
    for (const id of ids) kept[id] = map[id]
    localStorage.setItem(REPORTED_ORDERS_KEY, JSON.stringify(kept))
  } catch {
    // 저장이 막힌 환경이면 취소 후 다시 결제를 알아보지 못할 뿐이다(그 결제는 맞추지 못한 결제 규칙을 탄다).
  }
}

// carts: [{ id, ref }]. 같은 결제로 여러 번 부르면 주문을 더한다(한 결제로 함께 계산한 주문). 결제가 바뀌면 새 결제로 바꾼다.
function rememberReportedOrder(orderId, paymentId, carts) {
  if (!orderId || !paymentId) return
  const map = loadReportedOrders()
  const key = String(orderId)
  const prev = map[key]
  const same = prev && prev.paymentId === String(paymentId)
  const cartIds = same ? prev.cartIds.slice() : []
  const refs = same ? prev.refs.slice() : []
  for (const c of carts) {
    if (!c || !c.id || cartIds.includes(c.id)) continue
    cartIds.push(c.id)
    refs.push(c.ref || c.id)
  }
  map[key] = { paymentId: String(paymentId), cartIds, refs, at: Date.now() }
  saveReportedOrders(map)
}

function reportedOrderOf(orderId) {
  if (!orderId) return null
  return loadReportedOrders()[String(orderId)] || null
}

// ── 이 매장의 결제 전·취소된 POS 전산 주문 ───────────────────────────────────
// 최근 결제 목록(서버)에서 본 이 매장의 POS 전산 주문을 요약해 둔다. 이 단말기에 결제 대기 기록이 없어도 POS 결제를 맞추지 못한 결제로
// 남길지 정하는 데 쓴다: 기록이 지워졌거나(업그레이드·정리) 다른 단말기가 담은 주문을 여기서 결제했거나, POS에서 취소된 주문을 다시
// 결제했을 수 있다. 결제 화면이 열리며 탭앱이 다시 로드된 직후에도 쓰도록 저장소에 남긴다(24시간이 지난 요약은 쓰지 않는다).
// 예전에는 매장 어디에든 담김 주문이 하나라도 있거나(기간 제한 없이) 24시간 안의 POS 취소가 한 건이라도 있으면 모든 단말기의 모든 일반
// 판매를 남기고 판매마다 경고를 띄웠다 -- 정리 안 된 담김 주문 하나로 경고가 끝없이 떴고, 쌓인 일반 판매가 진짜 미대조 결제를 밀어냈다.
// 그래서 (1) 담은 지 24시간 안의 담김 주문과 POS 취소된 지 2시간 안의 주문만 후보로 세고 (2) 후보마다 품목·금액을 남겨, 결제된 POS
// 주문에 그 품목이 들어 있고 금액이 모자라지 않을 때만 그 주문을 이어 두고 안내한다. 맞는 후보가 없는 일반 판매는 안내 없이 조용히
// 남긴다(고르기 칸에서만 보인다).
const OPEN_POS_CARTS_KEY = 'chevrolet_erp_open_pos_carts'
const OPEN_POS_CARTS_TTL_MS = 24 * 60 * 60 * 1000
const OPEN_LOADED_MS = 24 * 60 * 60 * 1000
const OPEN_REPAY_MS = 2 * 60 * 60 * 1000
// POS 결제 취소가 기록된 사유(서버 refundNote). 토스 취소 웹훅과 탭앱·직원의 POS 취소 기록이다.
const POS_CANCEL_NOTES = new Set(['토스 결제 취소 확인', 'POS에서 결제 취소'])
// 취소 후 다시 결제를 기록할 수 있는 기간. 서버도 같은 24시간 안에서만 되살린다.
const REPAY_WINDOW_MS = 24 * 60 * 60 * 1000
let openPosCartsMemo = null

// POS 결제가 POS·토스 쪽 취소로 환불된 지 24시간이 안 된 전산 주문인지([POS에서 다시 결제했어요] 대상).
export function isRecentPosCancel(cart) {
  if (!cart || cart.status !== 'refunded' || cart.payTarget !== 'pos') return false
  if (!POS_CANCEL_NOTES.has(String(cart.refundNote || ''))) return false
  const at = Date.parse(cart.refundedAt || '')
  return Number.isFinite(at) && Date.now() - at <= REPAY_WINDOW_MS
}

// 최근 결제 목록의 카드 한 장을 후보로 줄인다. 후보가 아니면 null.
//   kind 'loaded' = 담은 지 24시간 안의 담김 주문, 'repaid' = POS 취소된 지 2시간 안의 주문. until이 지나면 후보에서 빠진다.
function openCandidateOf(c, now) {
  if (!c || typeof c.id !== 'string' || c.payTarget === 'front') return null
  let kind = null
  let until = 0
  if (c.status === 'loaded') {
    const at = Date.parse(c.loadedAt || '')
    if (!Number.isFinite(at) || now - at > OPEN_LOADED_MS) return null
    kind = 'loaded'
    until = at + OPEN_LOADED_MS
  } else if (isRecentPosCancel(c)) {
    const at = Date.parse(c.refundedAt || '')
    if (now - at > OPEN_REPAY_MS) return null
    kind = 'repaid'
    until = at + OPEN_REPAY_MS
  } else {
    return null
  }
  const items = (Array.isArray(c.items) ? c.items : [])
    .map((i) => ({ title: normalizeTitle(i && (i.name ?? i.title)), quantity: Number(i && i.quantity) || 0 }))
    .filter((i) => i.title && i.quantity > 0)
  return { id: c.id, ref: c.referenceId || '', kind, until, total: Math.max(0, Number(c.totalAmount) || 0), items }
}

// 최근 결제 목록이 올 때마다 부른다(settledCarts.applySettledCarts). [결제 취소]·[POS에서 취소했어요] 직후에도 부른다 -- 탭앱이 가려지면
// 폴링이 멈추므로(app.js) 그 사이 들어온 다시 결제를 판단할 근거가 취소 전 요약으로 남지 않게 한다.
export function noteRecentCarts(carts) {
  const now = Date.now()
  const candidates = (Array.isArray(carts) ? carts : []).map((c) => openCandidateOf(c, now)).filter(Boolean)
  const sig = JSON.stringify(candidates.map((c) => [c.id, c.kind, c.until]))
  // 폴링마다 쓰지 않는다 -- 후보가 바뀌었거나 한 시간이 지났을 때만 저장한다.
  if (openPosCartsMemo && openPosCartsMemo.sig === sig && now - openPosCartsMemo.at < 60 * 60 * 1000) return
  openPosCartsMemo = { at: now, sig, candidates }
  try {
    localStorage.setItem(OPEN_POS_CARTS_KEY, JSON.stringify({ at: now, candidates }))
  } catch {
    // 저장이 막히면 메모리 값만 쓴다.
  }
}

// 지금 유효한 후보. 옛 탭앱이 남긴 요약(개수만 있음)은 쓰지 않는다 -- 다음 폴링이 새로 채운다.
function openPosCandidates() {
  let snap = openPosCartsMemo
  if (!snap) {
    try {
      const raw = localStorage.getItem(OPEN_POS_CARTS_KEY)
      snap = raw ? JSON.parse(raw) : null
    } catch {
      snap = null
    }
  }
  const now = Date.now()
  if (!snap || !Number.isFinite(snap.at) || now - snap.at > OPEN_POS_CARTS_TTL_MS || !Array.isArray(snap.candidates)) return []
  return snap.candidates.filter((c) => c && typeof c.id === 'string' && Number.isFinite(c.until) && c.until >= now && Array.isArray(c.items))
}

// 결제된 POS 주문(paid)에 후보 주문의 품목이 모두 들어 있고 금액도 모자라지 않는지(자동 대조와 같은 규칙, subsetFits).
function candidateFits(candidate, paid) {
  if (!paid || !candidate.items.length) return false
  return subsetFits([{ items: candidate.items, totalAmount: candidate.total }], paid)
}

// ── 다시 결제를 기다리는 창(repay 창) ─────────────────────────────────────────
// 전산에 결제 완료로 알린 POS 결제가 취소되면(탭앱 [결제 취소]·[POS에서 취소했어요]·POS [주문] 취소의 'cancel' 이벤트) 그 전산 주문을 2시간
// 기억한다. 직원은 흔히 품목을 새 POS 주문으로 다시 찍어 다른 카드로 결제한다 -- 새 주문이라 POS 주문 ID로는 다시 결제인지 알 수 없고,
// 그동안 탭앱은 가려져 폴링(최근 결제 요약)이 멈춰 있다. 예전에는 이 결제를 평범한 판매로 보고 버려, [POS에서 다시 결제했어요]를 눌러도
// 고를 결제가 없었다(받은 돈이 전산에 환불로 남았다). 창이 열려 있는 동안 이 단말기에 기록 없이 들어온 결제는 그 주문을 이어 'repaid'로
// 남긴다. 안내는 창마다 처음 한 번만 띄운다(같은 2시간 안의 일반 판매마다 띄우지 않는다). 폴링 요약과 따로 둔다 -- 웹훅 반영 전에 온 폴링이
// 요약을 덮어써도 창은 남는다.
const REPAY_WINDOW_KEY = 'chevrolet_erp_repay_window'
const LOCAL_REPAY_WINDOW_MS = 2 * 60 * 60 * 1000
const REPAY_WINDOW_MAX = 20

function loadRepayWindow() {
  try {
    const raw = localStorage.getItem(REPAY_WINDOW_KEY)
    const v = raw ? JSON.parse(raw) : null
    if (!v || !Number.isFinite(v.at) || Date.now() - v.at > LOCAL_REPAY_WINDOW_MS) return null
    const cartIds = stringList(v.cartIds)
    if (!cartIds.length) return null
    const refs = cartIds.map((id, i) => String((Array.isArray(v.refs) && v.refs[i]) || id))
    return { at: v.at, cartIds, refs, notifiedAt: Number.isFinite(v.notifiedAt) ? v.notifiedAt : null }
  } catch {
    return null
  }
}

function saveRepayWindow(w) {
  try {
    if (w && w.cartIds.length) localStorage.setItem(REPAY_WINDOW_KEY, JSON.stringify(w))
    else localStorage.removeItem(REPAY_WINDOW_KEY)
  } catch {
    // 저장이 막히면 창 없이 동작한다(최근 결제 요약만으로 판단한다).
  }
}

// carts: [{ id, ref }]. 이미 열린 창이면 주문을 더하고 2시간을 새로 센다(새 취소라 안내도 다시 한 번 띄운다).
export function openRepayWindow(carts) {
  const list = (Array.isArray(carts) ? carts : []).filter((c) => c && typeof c.id === 'string' && c.id)
  if (!list.length) return
  const prev = loadRepayWindow()
  const cartIds = prev ? prev.cartIds.slice() : []
  const refs = prev ? prev.refs.slice() : []
  for (const c of list) {
    if (cartIds.includes(c.id)) continue
    cartIds.push(c.id)
    refs.push(String(c.ref || c.id))
  }
  saveRepayWindow({ at: Date.now(), cartIds: cartIds.slice(-REPAY_WINDOW_MAX), refs: refs.slice(-REPAY_WINDOW_MAX), notifiedAt: null })
}

function closeRepayWindowFor(cartIds) {
  const w = loadRepayWindow()
  if (!w) return
  const drop = new Set(cartIds)
  const keep = w.cartIds.map((id, i) => [id, w.refs[i]]).filter(([id]) => !drop.has(id))
  if (keep.length === w.cartIds.length) return
  saveRepayWindow({ ...w, cartIds: keep.map(([id]) => id), refs: keep.map(([, ref]) => ref) })
}

function markRepayWindowNotified() {
  const w = loadRepayWindow()
  if (w) saveRepayWindow({ ...w, notifiedAt: Date.now() })
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
//   ALREADY_PAID_OTHER: 그 주문이 이미 다른 결제(다른 단말기·프론트·다른 POS 결제)로 결제됐다. 같은 주문을 두 번
//     받았을 수 있다(이중 결제). 예전 서버는 이걸 "이미 처리됨" 성공으로 답해서 두 번째 결제가 아무 흔적 없이 묻혔다.
//   ALREADY_CLOSED: 결제하는 사이 전산에서 주문이 닫혔다(취소·지움·만료 등).
// refunded는 POS 화면의 다른 곳(상태 '취소됨', 버튼 [결제 취소])과 같은 말로 '결제 취소된'이라 쓴다.
const PAID_TERMINAL_LABEL = { dismissed: '지워진', failed: '실패 처리된', cancelled: '취소된', refunded: '결제 취소된', expired: '만료된' }

function terminalPaidReason(r) {
  if (r.status === 404) return '전산에서 찾을 수 없는'
  if (r.status !== 409 || !r.body) return null
  if (r.body.code === 'ALREADY_PAID_OTHER') return '이미 다른 결제로 결제된'
  if (r.body.code === 'ALREADY_CLOSED') return `결제하는 사이 전산에서 ${PAID_TERMINAL_LABEL[r.body.status] || '닫힌'}`
  if (PAID_TERMINAL_LABEL[r.body.status]) return `전산에서 이미 ${PAID_TERMINAL_LABEL[r.body.status]}`
  return null
}

function notifyTerminalPaid(r) {
  const label = r.entry.ref || r.entry.id
  if (r.body && r.body.code === 'ALREADY_PAID_OTHER') {
    // 탭앱의 다른 안내는 '결제 완료를 전산에 알렸습니다'처럼 '알리다'를 쓴다 -- '통보'를 섞지 않는다.
    deps.notify(
      'error',
      `이 주문은 이미 다른 결제로 결제됐습니다 (${label}). 이중 결제인지 POS [주문]에서 확인하세요. 이 결제는 더 이상 전산에 알리지 않습니다.`
    )
    return
  }
  deps.notify(
    'error',
    `${terminalPaidReason(r)} 주문입니다 (${label}). 이 결제는 더 이상 전산에 알리지 않습니다. ` +
    '실제로 결제가 이뤄졌다면 [주문] 탭 내역과 전산을 직접 대조해주세요.'
  )
}

// 종료 사유가 아닌 4xx(형식 오류, 결제 대상이 프론트로 바뀐 주문 등)는 다시 보내도 같은 답이 온다. 예전에는 폴링마다
// 영영 다시 보냈다. 이만큼 거절되면 자동 통보를 멈추고 그 결제를 맞추지 못한 결제로 옮겨, 직원이 확인하고
// [POS에서 결제했어요]로 다시 기록할 수 있게 한다. 401은 토큰 문제라 세지 않는다. 408·429는 잠깐의 문제라 세지 않는다.
const PAID_REJECT_LIMIT = 20

function isPaidRejection(r) {
  return typeof r.status === 'number' && r.status >= 400 && r.status < 500 &&
    r.status !== 401 && r.status !== 408 && r.status !== 429
}

function notifyAbandonedPaid(r) {
  const reason = r.body && r.body.error ? ` 사유: ${r.body.error}` : ''
  deps.notify(
    'error',
    `전산이 결제 완료 알림을 계속 받지 않아 자동으로 알리기를 멈췄습니다 (${r.entry.ref || r.entry.id}).${reason} ` +
    '이 결제는 맞추지 못한 결제로 남겨 뒀습니다. [최근 결제]에서 그 주문의 [POS에서 결제했어요]로 다시 기록하거나 전산에 확인해주세요.'
  )
}

// 같은 기록을 두 곳(결제 이벤트, 폴링 재시도)이 동시에 보고하지 않게 하는 표식.
const reportingIds = new Set()

// targets: [{ entry, paymentId, orderId, summary? }]를 보고하고 저장된 기록을 정리한다.
// summary(결제 금액·품목)는 이번 결제에서 처음 맞춘 기록에만 있다 -- 통보가 실패하면 기록에 남겨, 나중에 맞추지
// 못한 결제로 옮길 때 직원에게 보여준다.
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
    const abandoned = []
    const kept = []
    const present = new Set()
    for (const e of loadPendingPaid()) {
      present.add(e.id)
      if (gone.has(e.id)) continue
      const f = failedById.get(e.id)
      if (!f) {
        kept.push(e)
        continue
      }
      const rejects = (Number(e.paidRejects) || 0) + (isPaidRejection(f) ? 1 : 0)
      const next = {
        ...e,
        paymentId: f.paymentId,
        orderId: f.orderId,
        paidAt: e.paidAt || Date.now(),
        paidAmount: e.paidAmount ?? (f.summary ? f.summary.amount : null),
        paidTitles: e.paidTitles || (f.summary ? f.summary.titles : null),
        paidRejects: rejects || undefined,
      }
      if (rejects >= PAID_REJECT_LIMIT) abandoned.push({ ...f, entry: next })
      else kept.push(next)
    }
    // 보고하는 사이 다른 경로(다시 담기·지우기 등)가 그 기록을 지웠다. 통보가 실패한 결제를 여기서 버리면 받은 돈이 어디에도 남지
    // 않는데 직원에게는 "자동으로 다시 시도합니다"가 뜬다 -- 맞추지 못한 결제로 옮겨 [POS에서 결제했어요]로 기록하게 한다.
    const orphaned = failed.filter((r) => !present.has(r.entry.id))
    savePendingPaid(kept)
    abandoned.forEach((r) => rememberUnmatchedPayment({
      paymentId: r.entry.paymentId,
      orderId: r.entry.orderId,
      amount: r.entry.paidAmount,
      at: r.entry.paidAt,
      titles: r.entry.paidTitles || [],
    }))
    orphaned.forEach((r) => rememberUnmatchedPayment({
      paymentId: r.paymentId,
      orderId: r.orderId,
      amount: r.entry.paidAmount ?? (r.summary ? r.summary.amount : null),
      at: r.entry.paidAt || Date.now(),
      titles: r.entry.paidTitles || (r.summary ? r.summary.titles : []),
      hintCartIds: [r.entry.id],
      hintRefs: [r.entry.ref || r.entry.id],
      hintKind: 'lost',
    }))
    // 전산에 알린 POS 주문을 남긴다(취소 후 다시 결제를 알아보는 데 쓴다). 결제 완료가 확정됐으니 담기 표식도 더 쓸 데가 없다.
    for (const r of succeeded) {
      rememberReportedOrder(r.orderId, r.paymentId, [{ id: r.entry.id, ref: r.entry.ref || '' }])
      forgetLoadAttempt(r.entry.id)
    }
    terminal.forEach((r) => forgetLoadAttempt(r.entry.id))
    if (succeeded.length) afterMutation()
    const abandonedIds = new Set(abandoned.map((r) => r.entry.id))
    const orphanedIds = new Set(orphaned.map((r) => r.entry.id))
    return {
      succeeded,
      failed: failed.filter((r) => !abandonedIds.has(r.entry.id) && !orphanedIds.has(r.entry.id)),
      terminal,
      abandoned,
      orphaned,
    }
  } finally {
    todo.forEach((t) => reportingIds.delete(t.entry.id))
  }
}

const UNMATCHED_PAYMENT_MESSAGE =
  'POS 결제를 전산 주문과 맞추지 못했습니다. 이 결제가 전산 주문 몫이면 [최근 결제]에서 그 주문의 [POS에서 결제했어요]를 눌러 이 결제를 골라주세요.'
// 이 단말기에 대조할 기록이 없는데 결제된 POS 주문에 최근 담김·POS 취소된 전산 주문의 품목이 들어 있을 때(handleUnrecordedPaid).
function unrecordedPaymentMessage(refs) {
  return `POS 결제를 전산 주문과 맞추지 못했습니다(이 단말기에 담기 기록 없음). 이 결제에 ${refs.join(', ')}의 품목이 들어 있습니다. ` +
    '그 주문의 결제였다면 [최근 결제]에서 그 주문의 [POS에서 결제했어요] 또는 [POS에서 다시 결제했어요]로 이 결제를 골라주세요.'
}

// POS에서 취소된 전산 주문을 기다리는 동안(repay 창) 이 단말기에 기록 없이 들어온 결제.
function repayWindowMessage(refs) {
  return `POS에서 결제를 취소한 전산 주문(${refs.join(', ')}) 뒤에 새 POS 결제가 들어왔습니다. 다른 카드로 다시 결제했다면 ` +
    '[최근 결제]에서 그 주문의 [POS에서 다시 결제했어요]로 이 결제를 기록해주세요. 자동으로 기록하지 않았습니다.'
}
const PARTIAL_PAYMENT_MESSAGE = '나눠 결제 중인 주문입니다. 남은 금액까지 결제되면 전산에 결제 완료를 알립니다.'

function repaidMessage(reported) {
  const refs = reported.refs.length ? reported.refs.join(', ') : '전산 주문'
  return `이미 전산에 결제 완료로 알린 POS 주문에 새 결제가 들어왔습니다 (${refs}). 이전 결제를 취소하고 다시 결제했다면 ` +
    '[최근 결제]에서 그 주문의 [POS에서 다시 결제했어요]로 이 결제를 기록해주세요. 자동으로 기록하지 않았습니다.'
}

// settleReports가 맞추지 못한 결제로 옮긴 통보 실패 건(대기 기록이 그 사이 지워짐)을 알린다.
function notifyOrphanedPaid(list) {
  if (!list || !list.length) return
  const refs = list.map((r) => r.entry.ref || r.entry.id).join(', ')
  deps.notify(
    'error',
    `결제는 완료됐지만 전산에 알리지 못했고, 그 사이 이 주문의 대기 기록이 정리됐습니다 (${refs}). 결제를 취소하지 마세요 — ` +
    '이 결제는 맞추지 못한 결제로 남겨 뒀습니다. [최근 결제]에서 그 주문의 [POS에서 결제했어요]로 기록해주세요.'
  )
}

// 나눠 결제 중인 POS 주문 → { paymentId, at, relevant }. 남은 금액이 결제되면 같은 주문의 'paid'가 다시 오지만, 그때
// 읽은 주문이 아직 옛 상태이거나 이벤트를 놓칠 수 있어(실단말기 미검증) 폴링(retryPendingPaid)이 주문을 다시 읽어
// 본다. 30분이 지나도 끝나지 않으면 지켜보기를 멈춘다(기록은 그대로 남아 다음 결제를 기다린다).
const PARTIAL_WATCH_MS = 30 * 60 * 1000
const partialOrders = new Map()
// 처리를 끝낸 POS 결제 → { at, orderId }. 같은 결제의 'paid'가 두 번 와도 두 번 처리하지 않는다. 예전에는 POS 주문 ID로 걸렀는데,
// 직원이 POS [주문]에서 결제를 취소하고 같은 주문을 다른 카드로 다시 결제하면 새 결제까지 걸러져 받은 돈이 어디에도 남지 않았다.
// 같은 주문의 다른 결제는 handlePaid가 나눠 결제의 나머지인지(앞 결제가 그대로 살아 있음) 다시 결제한 것인지(앞 결제가 취소됨) 가른다.
const HANDLED_PAYMENT_TTL_MS = 60 * 60 * 1000
const handledPayments = new Map()

function isHandledPayment(paymentId) {
  const v = handledPayments.get(paymentId)
  if (!v) return false
  if (Date.now() - v.at > HANDLED_PAYMENT_TTL_MS) {
    handledPayments.delete(paymentId)
    return false
  }
  return true
}

function markHandledPayment(paymentId, orderId) {
  if (!paymentId) return
  const now = Date.now()
  handledPayments.set(paymentId, { at: now, orderId: orderId || '' })
  for (const [id, v] of handledPayments) {
    if (now - v.at > HANDLED_PAYMENT_TTL_MS) handledPayments.delete(id)
  }
}

// 이 POS 주문에서 앞서 처리했거나 전산에 알린 다른 결제들.
function priorPaymentIdsOf(orderId, paymentId) {
  const ids = new Set()
  const now = Date.now()
  for (const [id, v] of handledPayments) {
    if (v.orderId === orderId && id !== paymentId && now - v.at <= HANDLED_PAYMENT_TTL_MS) ids.add(id)
  }
  const reported = reportedOrderOf(orderId)
  if (reported && reported.paymentId !== paymentId) ids.add(reported.paymentId)
  return [...ids]
}

// startedAt 이후 같은 주문의 다른 결제를 처리했는지(주문을 읽는 사이 이벤트·폴링이 먼저 끝낸 경우).
function orderHandledSince(orderId, startedAt, paymentId) {
  for (const [id, v] of handledPayments) {
    if (v.orderId === orderId && id !== paymentId && v.at >= startedAt) return true
  }
  return false
}

// POS에서 취소된 결제(SDK 'cancel' 이벤트) → 받은 시각. 같은 주문의 새 결제가 다시 결제한 것인지 가르는 데 쓴다.
const CANCELLED_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000
const cancelledPayments = new Map()

// 앞서 처리한 결제가 그 주문에서 취소됐는지. true = 취소됨(다시 결제), false = 그대로 살아 있음(나눠 결제의 나머지),
// null = 주문을 못 읽어 알 수 없음.
async function priorPaymentsCancelled(orderId, priorIds) {
  if (priorIds.some((id) => cancelledPayments.has(id))) return true
  const order = await readPosOrder(orderId)
  const payments = order && Array.isArray(order.payments) ? order.payments : null
  if (!payments) return null
  const byId = new Map(payments.filter(Boolean).map((p) => [String(p.id), p]))
  // 앞 결제가 취소됐거나 그 주문에서 사라졌으면 다시 결제한 것이다.
  if (priorIds.some((id) => {
    const p = byId.get(String(id))
    return !p || p.state === 'CANCELLED'
  })) return true
  // 취소가 아직 주문에 반영되지 않았어도, 살아 있는 결제의 합이 주문 청구 금액보다 크면 나눠 결제가 아니라 다시 결제한 것이다.
  const live = payments.filter((p) => p && p.state !== 'CANCELLED')
  const charge = order.chargePrice && typeof order.chargePrice.chargePriceValue === 'number' ? order.chargePrice.chargePriceValue : null
  const amounts = live.map((p) => p.amountMoney)
  if (charge !== null && amounts.length && amounts.every((a) => typeof a === 'number')) {
    if (amounts.reduce((sum, a) => sum + a, 0) > charge) return true
  }
  return false
}

// 이 단말기에 대조할 기록이 없는 결제(기록이 없거나 모두 다른 결제에 이미 맞춰짐). 기록이 지워졌거나(업그레이드·정리) 다른 단말기가 담은
// 주문을 여기서 결제했거나, POS에서 취소한 주문을 새 POS 주문으로 다시 결제했을 수 있다. 예전에는 아무 데도 남지 않아 그 주문을 결제 완료로
// 기록할 방법이 없었다. 남기는 경우와 안내:
//   - 나눠 결제가 시작될 때는 맞을 기록이 있었는데(relevant) 그 사이 기록이 정리됨: 남기고 안내한다.
//   - 다시 결제를 기다리는 주문이 있음(repay 창): 그 주문을 이어 'repaid'로 남긴다. 안내는 창마다 처음 한 번(또는 품목이 맞을 때).
//   - 결제된 POS 주문에 최근 담김·POS 취소 주문의 품목이 들어 있고 금액도 모자라지 않음: 그 주문을 이어 남기고 안내한다.
//   - 후보 주문은 있지만 품목이 맞지 않음(일반 판매일 가능성이 높다): 안내 없이 조용히 남긴다 -- 할인이나 품목을 못 읽은 결제일 수 있어
//     고르기 칸에서는 고를 수 있어야 한다.
//   - 후보도 창도 없음: 평범한 POS 판매라 남기지 않는다.
async function handleUnrecordedPaid(paymentId, orderId, partialBefore) {
  const relevant = Boolean(partialBefore && partialBefore.relevant)
  const repay = loadRepayWindow()
  const candidates = openPosCandidates()
  if (!relevant && !repay && !candidates.length) {
    partialOrders.delete(orderId)
    markHandledPayment(paymentId, orderId)
    return
  }
  const { paid, summary } = await readPaidSummary(paymentId, orderId)
  if (isHandledPayment(paymentId)) return
  if (paid && paid.progress === 'partial') {
    // 남은 금액이 결제되면 그때 남긴다(같은 주문의 'paid'가 다시 오거나 폴링이 주문을 다시 읽는다).
    const prev = partialOrders.get(orderId)
    partialOrders.set(orderId, { paymentId, at: prev ? prev.at : Date.now(), relevant })
    return
  }
  partialOrders.delete(orderId)
  markHandledPayment(paymentId, orderId)
  if (paid && paid.progress === 'closed') return
  const fitting = candidates.filter((c) => candidateFits(c, paid))
  // 이 결제와 이어 둘 주문. 창이 열려 있으면 창의 주문과 품목이 맞는 POS 취소 주문을 'repaid'로, 아니면 품목이 맞는 후보를 잇는다.
  const hint = { ids: [], refs: [], kind: null }
  const addHint = (id, ref) => {
    if (hint.ids.includes(id)) return
    hint.ids.push(id)
    hint.refs.push(ref || id)
  }
  if (repay) {
    repay.cartIds.forEach((id, i) => addHint(id, repay.refs[i]))
    fitting.filter((c) => c.kind === 'repaid').forEach((c) => addHint(c.id, c.ref))
    hint.kind = 'repaid'
  } else if (fitting.length) {
    fitting.forEach((c) => addHint(c.id, c.ref))
    hint.kind = fitting.every((c) => c.kind === 'repaid') ? 'repaid' : 'match'
  }
  rememberUnmatchedPayment({
    paymentId,
    orderId,
    at: Date.now(),
    ...summary,
    ...(hint.ids.length ? { hintCartIds: hint.ids, hintRefs: hint.refs, hintKind: hint.kind } : {}),
  })
  if (relevant) {
    deps.notify('warn', UNMATCHED_PAYMENT_MESSAGE)
  } else if (repay && (!repay.notifiedAt || fitting.some((c) => c.kind === 'repaid'))) {
    markRepayWindowNotified()
    deps.notify('warn', repayWindowMessage(hint.refs))
  } else if (fitting.length) {
    deps.notify('warn', unrecordedPaymentMessage(fitting.map((c) => c.ref || c.id)))
  }
  // 그 밖(맞는 후보가 없는 일반 판매)은 안내하지 않는다 -- 판매마다 경고를 띄우면 진짜 경고가 묻힌다.
}

// partialInfo: 폴링(recheckPartialOrders)이 나눠 결제가 끝난 것을 확인하고 부를 때 넘기는 그 주문의 지켜보기 정보.
async function handlePaid(paymentId, orderId, { partialInfo = null } = {}) {
  if (!paymentId || isHandledPayment(paymentId)) return
  const startedAt = Date.now()
  // 이 결제로 이미 전산에 알린 주문이다(탭앱이 다시 로드된 뒤 같은 'paid'가 또 왔다).
  const reported = reportedOrderOf(orderId)
  if (reported && reported.paymentId === paymentId) {
    markHandledPayment(paymentId, orderId)
    return
  }
  // 같은 POS 주문의 다른 결제를 이미 처리했다: 나눠 결제의 나머지 카드이거나, 앞 결제를 취소하고 다시 결제한 것이다.
  const priorIds = orderId ? priorPaymentIdsOf(orderId, paymentId) : []
  if (priorIds.length) {
    const cancelledBefore = await priorPaymentsCancelled(orderId, priorIds)
    if (isHandledPayment(paymentId)) return
    if (cancelledBefore === false) {
      // 앞 결제가 그대로 살아 있다 -- 나눠 결제의 나머지다. 그 주문은 이미 처리했다(전산에 알렸거나 맞추지 못한 결제로 남겼다).
      markHandledPayment(paymentId, orderId)
      partialOrders.delete(orderId)
      return
    }
    const reportedNow = reportedOrderOf(orderId)
    if (reportedNow && reportedNow.paymentId !== paymentId) {
      // 전산에 결제 완료로 알린 POS 주문에 새 결제가 왔다(앞 결제가 취소됐거나, 주문을 못 읽어 알 수 없음). 그 전산 주문은 앞 결제의
      // 취소 웹훅으로 취소(refunded)가 된다. 자동으로 보고하지 않고 그 주문을 붙여 맞추지 못한 결제로 남긴다 -- 직원이 그 주문의
      // [POS에서 다시 결제했어요]로 기록하면 서버가 결제 완료로 되살린다.
      markHandledPayment(paymentId, orderId)
      partialOrders.delete(orderId)
      const { summary } = await readPaidSummary(paymentId, orderId)
      // 같은 주문에 결제가 여럿이라 주문 금액보다 이 결제 금액이 정확하다.
      const amount = await readPaymentAmount(paymentId)
      rememberUnmatchedPayment({
        paymentId,
        orderId,
        at: Date.now(),
        titles: summary.titles,
        amount: amount !== null ? amount : summary.amount,
        hintCartIds: reportedNow.cartIds,
        hintRefs: reportedNow.refs,
        hintKind: 'repaid',
      })
      deps.notify('warn', repaidMessage(reportedNow))
      return
    }
    // 앞서 처리했지만 전산에 알리지 않은 주문(맞추지 못한 결제로 남긴 주문 등)이면 처음 온 결제처럼 다룬다.
  }
  const partialBefore = partialOrders.get(orderId) || partialInfo
  const entries = loadPendingPaid()
  // 예전에 통보가 실패해 남아 있던 항목(paymentId가 이미 있다)은 그때 확정된 자기 값을 그대로 다시 써야
  // 한다 — 지금 결제와는 다른 건이라, 새 값을 붙이면 전산에 엉뚱한 결제 건으로 기록된다.
  const targets = entries
    .filter((e) => e.paymentId)
    .map((e) => ({ entry: e, paymentId: e.paymentId, orderId: e.orderId }))
  // 아직 결제가 안 붙은 항목은 이번 결제가 정말 자기 것인지 주문 내용으로 확인한 것만 이번 값을 쓴다.
  // 지금 보고 중인 기록은 다른 결제에 이미 맞춰진 것이라 뺀다.
  const fresh = entries.filter((e) => !e.paymentId && !reportingIds.has(e.id))
  if (!fresh.length) {
    await handleUnrecordedPaid(paymentId, orderId, partialBefore)
  } else {
    const picked = await matchFreshEntries(fresh, paymentId, orderId)
    // 주문을 읽는 사이 같은 결제나 같은 주문의 다른 결제를 다른 쪽(이벤트·폴링)이 먼저 처리했으면 여기서는 손대지 않는다.
    if (isHandledPayment(paymentId) || (orderId && orderHandledSince(orderId, startedAt, paymentId))) return
    if (picked.kind === 'partial') {
      // 남은 금액이 결제될 때까지 기록을 그대로 둔다. 안내는 처음 한 번만, 다 결제되면 맞을 주문이 있을 때만 띄운다.
      const prev = partialOrders.get(orderId)
      partialOrders.set(orderId, { paymentId, at: prev ? prev.at : Date.now(), relevant: picked.relevant })
      if (picked.relevant && !prev) deps.notify('warn', PARTIAL_PAYMENT_MESSAGE)
    } else {
      partialOrders.delete(orderId)
      markHandledPayment(paymentId, orderId)
      if (picked.kind === 'match') {
        const paidAt = Date.now()
        for (const e of picked.entries) {
          // 통보를 기다리는 사이 다른 경로(품목이 사라진 기록 정리·담기 취소)가 이 기록을 지우지 않게, 맞춘 결제를 먼저 기록에
          // 붙인다. paymentId가 붙은 기록은 정리·담기 취소가 건드리지 않는다.
          const patch = { paymentId, orderId, paidAt, paidAmount: picked.summary.amount, paidTitles: picked.summary.titles }
          patchPendingEntry(e.id, patch)
          targets.push({ entry: { ...e, ...patch }, paymentId, orderId, summary: picked.summary })
        }
      } else if (picked.kind !== 'closed') {
        rememberUnmatchedPayment({ paymentId, orderId, at: Date.now(), ...picked.summary })
        deps.notify('warn', UNMATCHED_PAYMENT_MESSAGE)
      }
    }
  }
  if (!targets.length) return

  const { succeeded, failed, terminal, abandoned, orphaned } = await settleReports(targets)
  terminal.forEach(notifyTerminalPaid)
  abandoned.forEach(notifyAbandonedPaid)
  notifyOrphanedPaid(orphaned)
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

// 나눠 결제 중인 주문을 다시 읽어, 다 결제됐으면 그때 처리한다(partialOrders 주석 참고).
async function recheckPartialOrders() {
  for (const [orderId, info] of [...partialOrders]) {
    if (Date.now() - info.at > PARTIAL_WATCH_MS) {
      partialOrders.delete(orderId)
      if (info.relevant) {
        deps.notify('warn', '나눠 결제하던 POS 주문이 30분 넘게 끝나지 않았습니다. POS [주문]에서 남은 금액을 확인해주세요.')
      }
      continue
    }
    let order = null
    try {
      order = await posPluginSdk.order.getOrder(orderId)
    } catch {
      continue // 다음 폴링에서 다시 읽는다.
    }
    const progress = readPaymentProgress(order)
    if (progress === 'partial') continue
    partialOrders.delete(orderId)
    if (progress === 'closed') continue
    // 지켜보던 정보를 넘긴다 -- 그 사이 기록이 정리됐어도 맞을 기록이 있던 결제(relevant)면 맞추지 못한 결제로 남긴다.
    await handlePaid(info.paymentId, orderId, { partialInfo: info })
  }
}

// 이 탭앱이 [결제 취소]로 직접 취소하는 결제 → 시각. 그 취소의 'cancel' 이벤트에는 따로 안내하지 않는다(취소 흐름이 이미 안내한다).
const SELF_CANCEL_TTL_MS = 5 * 60 * 1000
const selfCancels = new Map()

export function noteSelfCancel(paymentId) {
  if (!paymentId) return
  selfCancels.set(String(paymentId), Date.now())
}

// POS에서 결제가 취소됐다(posPluginSdk.payment.on('cancel')). 직원이 POS [주문]에서 취소하고 다른 카드로 다시 결제하는 일이 흔하다.
//   - 맞추지 못한 결제 목록에 있던 결제는 더 기록할 수 없으니 뺀다(남겨 두면 취소된 돈을 결제 완료로 기록할 수 있다).
//   - 전산에 결제 완료로 알린 결제였으면 어느 전산 주문인지 알린다 -- 토스 취소 웹훅이 그 주문을 취소로 바꾸는데, 다시 결제했다면
//     새 결제를 [POS에서 다시 결제했어요]로 기록해야 한다. 다시 결제가 새 POS 주문으로 와도 알아보게 그 주문의 repay 창을 연다.
//   - 이 탭앱의 [결제 취소]로 취소한 결제는 그 흐름이 이미 안내했다(repay 창은 이때도 연다).
function handleCancelled(paymentId, orderId) {
  if (!paymentId) return
  const id = String(paymentId)
  const now = Date.now()
  cancelledPayments.set(id, now)
  for (const [k, at] of cancelledPayments) {
    if (now - at > CANCELLED_PAYMENT_TTL_MS) cancelledPayments.delete(k)
  }
  const listed = listUnmatchedPayments().find((p) => p.paymentId === id)
  if (listed) removeUnmatchedPayment(id)
  // 전산에 알렸던 결제인지는 자기 취소인지 보기 전에 가린다 -- 탭앱 [결제 취소] 뒤의 다시 결제도 repay 창으로 알아봐야 한다.
  const byOrder = reportedOrderOf(orderId)
  const reported = byOrder && byOrder.paymentId === id
    ? byOrder
    : Object.values(loadReportedOrders()).find((v) => v.paymentId === id) || null
  const ids = reported ? reported.cartIds : listed ? stringList(listed.recordedCartIds) : []
  const refs = reported ? reported.refs : listed && Array.isArray(listed.recordedRefs) ? listed.recordedRefs.map(String) : []
  if (ids.length) openRepayWindow(ids.map((cartId, i) => ({ id: cartId, ref: refs[i] || cartId })))
  const selfAt = selfCancels.get(id)
  if (selfAt !== undefined && now - selfAt <= SELF_CANCEL_TTL_MS) {
    selfCancels.delete(id)
    return
  }
  if (!refs.length) return
  deps.notify(
    'warn',
    `POS에서 결제가 취소됐습니다. 이 결제로 결제 완료를 알린 전산 주문: ${refs.join(', ')}. 토스 취소 확인이 오면 전산 주문은 취소로 바뀝니다. ` +
    '다른 카드로 다시 결제했다면 [최근 결제]에서 그 주문의 [POS에서 다시 결제했어요]로 새 결제를 기록해주세요.'
  )
}

// consume 보고가 닿지 못한 기록(needsConsume)의 보고를 다시 보낸다. 같은 attemptId라서 서버가 이미 받았다면
// "이미 처리됨"과 함께 내 요청이었는지(ownAttempt)를 알려준다. 서버가 이 주문을 loaded로 모르는 채 결제만
// 통보하면 전산 화면에서 "결제됐는데 담기 기록이 없는" 상태가 되므로, 결제 통보보다 먼저 맞춘다.
//
// 결제가 붙은 기록(paymentId)은 여기서 다루지 않는다(retryPendingPaid가 바로 /paid로 보낸다). 그런 기록을 "다른
// 단말기가 처리함"으로 지우고 "결제하지 마세요"라고 안내하면, 이미 받은 돈이 전산에 한 번도 알려지지 않는다. 요청이
// 가는 사이 결제가 붙었을 수도 있으니 응답을 받은 뒤 지금 기록을 다시 보고 판단한다.
async function resendConsume(entry) {
  const label = entry.ref || entry.id
  const r = await reportConsume(entry.id, { result: 'loaded', attemptId: entry.attemptId }, { silent: true })
  const current = loadPendingPaid().find((e) => e.id === entry.id)
  if (!current) return
  if (current.paymentId) return // /paid가 서버 상태에 맞춰 정리하고 안내한다(notifyTerminalPaid).
  if (!r.ok) {
    if (r.status === 404 || r.status === 409) {
      forgetPendingPaid(entry.id)
      forgetLoadAttempt(entry.id)
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
  // ownAttempt가 true면 서버에 남은 담기 표식이 내 것이다(결제까지 끝난 'paid'여도). 내 첫 요청이 닿았던 것이다.
  if (body.ownAttempt === true) {
    patchPendingEntry(entry.id, { needsConsume: undefined })
    return
  }
  // ownAttempt를 모르는 옛 서버는 상태로만 본다: 이미 loaded(또는 결제까지 끝남)이면 처음 보냈던 내 요청이
  // 서버에서는 성공했던 것으로 본다. 그 외(지움·실패 등)는 다른 단말기 몫이다.
  const lostToOther = Boolean(body.alreadyProcessed) &&
    (body.ownAttempt === false || (body.ownAttempt === undefined && body.status !== 'loaded' && body.status !== 'paid'))
  if (lostToOther) {
    forgetPendingPaid(entry.id)
    forgetLoadAttempt(entry.id)
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
// 보고할 것 자체가 없다. paymentId가 붙은 항목은 담기 보고(needsConsume)가 밀려 있어도 consume을 다시 보내지 않고
// 바로 /paid를 보낸다 -- 서버는 pending·loaded 주문의 결제 통보를 받고, 이미 끝난 주문이면 409와 상태를 돌려준다.
let retryingPaid = false

async function retryPendingPaid() {
  dropVanishedEntries()
  if (retryingPaid) return
  retryingPaid = true
  try {
    await recheckPartialOrders()

    const candidates = loadPendingPaid().filter(
      (e) => (e.paymentId || e.needsConsume) && !inFlight.has(e.id) && !reportingIds.has(e.id)
    )
    if (!candidates.length) return
    for (const entry of candidates.filter((e) => e.needsConsume && !e.paymentId)) await resendConsume(entry)

    // consume 재전송에서 지워진 기록이 있을 수 있으니 지금 시점 기록을 다시 읽는다.
    const ids = new Set(candidates.map((e) => e.id))
    const targets = loadPendingPaid()
      .filter((e) => e.paymentId && ids.has(e.id))
      .map((e) => ({ entry: e, paymentId: e.paymentId, orderId: e.orderId }))
    if (!targets.length) return
    const { succeeded, terminal, abandoned, orphaned } = await settleReports(targets)
    terminal.forEach(notifyTerminalPaid)
    abandoned.forEach(notifyAbandonedPaid)
    notifyOrphanedPaid(orphaned)
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
  try {
    // sdk.d.ts의 Payment.on(event: 'cancel' | 'paid', (paymentId, orderId) => void). 실단말기에서 POS [주문] 취소에도 오는지는 미검증이다 --
    // 안 와도 같은 주문의 새 결제는 handlePaid가 주문을 읽어 가르고, 취소된 주문은 [POS에서 다시 결제했어요]로 기록할 수 있다.
    posPluginSdk.payment.on('cancel', (paymentId, orderId) => {
      try {
        handleCancelled(paymentId, orderId)
      } catch (e) {
        console.error('[erp-cart] 결제 취소 처리 중 오류가 났습니다.', e?.message)
      }
    })
  } catch (e) {
    console.error('[erp-cart] 결제 취소 이벤트를 구독하지 못했습니다.', e?.message)
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
  // 지금은 buildLineItem이 key를 직접 발급하므로 그 값을 그대로 들고 있으면 된다.
  // 그래도 담기 전 장바구니의 key를 한 번 찍어 둔다(snapshotKeys). 담다가 실패하면 장바구니를 다시 읽어, 우리 key뿐
  // 아니라 담기 전에 없던 줄 중 이 주문 품목과 이름이 같은 줄까지 걷어낸다(revertLoadedLines).
  const addedKeys = []
  // alreadyProcessed/dismissed 분기에서 되돌리기 실패를 안내에 특정하기 위한 key→품목명 매핑.
  // addedKeys는 handleLoadFailure와도 공유하는 배열이라 구조를 바꾸지 않고 별도로 들고 있는다.
  const addedTitleByKey = new Map()
  const revert = { addedKeys, addedTitleByKey, snapshotKeys: null }
  // 이 담기 시도의 표식. reportConsume의 재시도와, 보고가 안 닿았을 때 폴링이 다시 보내는 consume이 모두
  // 같은 값을 보낸다. 서버가 "이미 처리됨"이라고 답할 때 그게 내 첫 요청이 성공한 것인지(ownAttempt)
  // 다른 단말기가 가져간 것인지 가리려면 요청마다 시도를 구분할 수 있어야 한다.
  const attemptId = makeAttemptId()
  try {
    const base = await getBaseCatalogItem()
    if (!base) throw new Error('POS 카탈로그에 등록된 상품이 없습니다. POS에서 상품을 하나 이상 등록해주세요.')

    try {
      const before = await draftOrder.get()
      if (before && Array.isArray(before.lineItems)) {
        revert.snapshotKeys = new Set(before.lineItems.map((li) => li && li.key).filter(Boolean))
      }
    } catch (e) {
      // 못 읽어도 담기는 한다. 실패하면 우리 key만 걷어내고 직원에게 [주문] 확인을 맡긴다.
      console.error('[erp-cart] 담기 전 장바구니를 읽지 못했습니다.', e?.message)
    }

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
      // addLineItem을 부르기 **전에** 되돌리기 목록에 넣는다. SDK는 30초 안에 응답이 없으면 "지연되고 있습니다"로
      // 던지지만, 요청은 이미 POS로 갔으므로 POS가 늦게 담을 수 있다. 예전에는 성공한 뒤에 넣어서, 시간 초과된
      // 품목이 되돌리기에서 빠진 채 장바구니에 남아 다음 결제에 함께 청구될 수 있었다.
      addedKeys.push(lineItem.key)
      addedTitleByKey.set(lineItem.key, item.name)
      await draftOrder.addLineItem(lineItem)
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
      const reverted = await revertLoadedLines(cart, revert)
      forgetPendingPaid(cart.id)
      forgetLoadAttempt(cart.id)
      sentToFront.set(cart.id, Date.now())
      lastCarts = lastCarts.filter((c) => c.id !== cart.id)
      deps.notify('error', `프론트에서 결제하도록 넘긴 주문입니다. ${revertNoteOf(reverted)} POS에서는 결제하지 마세요.`)
      return
    }

    if (!reported.ok) {
      // 아직 결제는 시작하지 않았다. 서버가 어떤 상태인지 모르는 채로 결제까지 자동으로
      // 밀어붙이면, 나중에 이 카드가 되살아났을 때 결제된 건인지 아닌지 아무도 모른다.
      // 담긴 것은 사실이므로 카드는 남겨두고, 결제는 직원이 직접 누르게 한다.
      // 보고가 안 닿았다는 표시를 기록에 남겨 두면 폴링이 consume 'loaded'를 다시 보낸다(resendConsume).
      patchPendingEntry(cart.id, { needsConsume: true })
      // 토스트는 짧게 사라지므로 가장 중요한 지시(다시 누르지 말 것, 결제할 곳)를 앞에 둔다. 같은 지시가 카드 안에도 계속 남는다(cartHtml).
      deps.notify(
        'error',
        '담았지만 서버에 알리지 못했어요. 다시 누르지 말고 [주문] 탭에서 결제해주세요(결제하면 자동으로 정리돼요).'
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
      // 되돌리기가 하나라도 실패했는데 "되돌렸습니다"라고 단정하면, 그 말을 믿은 직원이 다음
      // 결제를 그대로 진행해서 이미 다른 단말기가 처리한 품목이 함께 결제되는 사고로 이어진다
      // (돈이 잘못되는 경로). 전부 성공했을 때만 단정하고, 하나라도 남으면 무엇이 남았을 수
      // 있는지와 할 일을 알려준다(revertNoteOf).
      const revertNote = revertNoteOf(await revertLoadedLines(cart, revert))
      // 이 단말기에서는 결제를 시작하지 않으므로 결제 대기 기록도 지운다 — 남겨두면 나중에
      // 이 단말기에서 벌어지는 다른 결제에 이 주문이 딸려가 "결제완료"로 잘못 보고된다. 담기 표식도 이 단말기 것이 아니게 됐다.
      forgetPendingPaid(cart.id)
      forgetLoadAttempt(cart.id)
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
    await handleLoadFailure(cart, e, revert)
  }
}

// 방금 담은(담으려 한) 품목을 POS 장바구니에서 걷어낸다. 원래 있던 항목은 절대 건드리지 않는다 -- draftOrder.clear()를
// 쓰지 않는 이유와 같다. 장바구니를 다시 읽어 지금 실제로 있는 줄만 지운다:
//   - 우리가 만든 key의 줄(시간 초과로 실패한 것처럼 보였지만 POS가 담은 줄 포함)
//   - 담기 전에 없던 줄(snapshotKeys에 없음) 중 이 주문 품목과 이름이 같은 줄. POS가 key를 바꿔 담았을 때를 위한 대비다.
// 장바구니를 못 읽으면 우리 key만 지워 보고 unreadable을 돌려준다 -- 직원이 [주문] 탭에서 직접 확인해야 한다.
async function revertLoadedLines(cart, { addedKeys, addedTitleByKey, snapshotKeys }) {
  const ours = new Set(addedKeys)
  const cartTitles = new Set((cart.items || []).map((i) => normalizeTitle(i.name)).filter(Boolean))
  let draft = null
  try {
    draft = await draftOrder.get()
  } catch (e) {
    console.error('[erp-cart] 되돌리기 전에 장바구니를 읽지 못했습니다.', e?.message)
  }
  const failedTitles = []
  if (!draft || !Array.isArray(draft.lineItems)) {
    for (const key of addedKeys) {
      try {
        await draftOrder.deleteLineItem(key)
      } catch {
        // 담기지 않은 key일 수 있다(그러면 지울 것도 없다). 남았는지는 직원이 확인한다.
      }
    }
    return { failedTitles, unreadable: true }
  }
  const lines = draft.lineItems.filter((li) => li && li.key && (
    ours.has(li.key) ||
    (snapshotKeys && !snapshotKeys.has(li.key) && cartTitles.has(normalizeTitle(li.item && li.item.title)))
  ))
  for (const li of lines) {
    try {
      await draftOrder.deleteLineItem(li.key)
    } catch {
      // 콘솔은 매장에서 아무도 안 본다 — 로그는 남기되, 실제 안내는 revertNoteOf로 직원 눈에 보이게 한다.
      console.error('[erp-cart] 되돌리기 실패 — POS 장바구니를 직접 확인해주세요.', li.key)
      failedTitles.push(addedTitleByKey.get(li.key) || (li.item && li.item.title) || li.key)
    }
  }
  return { failedTitles, unreadable: false }
}

function revertNoteOf({ failedTitles, unreadable }) {
  if (unreadable) return 'POS 장바구니를 확인하지 못했습니다. 방금 담은 품목이 남아 있을 수 있으니 [주문] 탭에서 직접 확인 후 지워주세요.'
  if (failedTitles.length) {
    return `방금 담은 품목 중 되돌리기에 실패한 것이 있습니다(${failedTitles.join(', ')}). POS 장바구니에 남아 있을 수 있으니 [주문] 탭에서 직접 확인 후 지워주세요.`
  }
  return '방금 담은 품목은 되돌렸습니다.'
}

async function handleLoadFailure(cart, error, revert) {
  // 절반만 담긴 장바구니가 남으면 직원이 잘못된 금액으로 결제할 수 있다 — 방금 우리가
  // 추가한 항목만 골라 지운다(원래 있던 항목은 절대 건드리지 않는다).
  const reverted = await revertLoadedLines(cart, revert)
  const reason = error?.message || String(error)
  // 시간 초과는 POS가 요청을 나중에 처리할 수 있다 -- 방금 장바구니를 확인한 뒤에 품목이 들어올 수도 있다.
  const timedOut = String(reason).includes('지연되고 있습니다')
  let leftover = ''
  if (reverted.unreadable || reverted.failedTitles.length) leftover = ` ${revertNoteOf(reverted)}`
  else if (timedOut) leftover = ' POS 응답이 늦어 품목이 뒤늦게 담길 수 있습니다. 잠시 뒤 [주문] 탭에 이 주문의 품목이 있으면 지워주세요.'
  const reported = await reportConsume(cart.id, { result: 'failed', errorMessage: reason })
  if (!reported.ok) {
    // 보고가 닿지 않았으면 서버는 여전히 pending이다. 카드를 지우면 되살아나서 직원이
    // 혼란스러우므로 그대로 두고, 되돌리기는 이미 했으니 다시 눌러도 안전하다.
    deps.notify('error', `POS에 담지 못했습니다: ${reason}${leftover}`)
    return
  }
  // 실패를 보고한 순간 서버에서 이 장바구니는 failed로 끝난 상태다. 그런데도 카드를 남겨두고
  // 버튼을 되살리면, 직원이 다시 눌렀을 때 POS에는 품목이 또 담기지만 서버는 이미 종료된 건이라
  // alreadyProcessed로 흘려버린다 — 전산에는 계속 "실패"로 보이는데 실제로는 결제가 일어나는
  // 상태 불일치가 생긴다. 돈이 오가는 경로라 그 어긋남을 허용하지 않고, 카드를 치운 뒤 전산에서
  // 다시 보내게 안내한다.
  removeCartFromView(cart.id)
  deps.notify('error', `POS에 담지 못했습니다. 전산에서 다시 보내주세요. (${reason})${leftover}`)
}

// 처리를 마친 cart는 consumed에 남겨 뒤늦게 도착한 폴링 응답이 되살리지 못하게 한다.
// (뒤이어 finally의 renderErpCarts가 실제 DOM을 갱신한다 — 여기서 그리면 inFlight가 아직 서 있어
//  어차피 무시되므로 목록만 손본다.)
function removeCartFromView(cartId) {
  consumed.set(cartId, Date.now())
  renderErpCarts(lastCarts.filter((c) => c.id !== cartId))
}
