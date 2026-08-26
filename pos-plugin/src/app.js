// ⚠️ 다른 어떤 import보다 먼저. 이 아래에서 나는 오류를 잡으려면 가드가 먼저 걸려 있어야 한다.
import { installCrashGuard } from './crashGuard.js'
installCrashGuard()

import { posPluginSdk } from '@tossplace/pos-plugin-sdk'
// 전산(ERP)이 담아둔 장바구니를 POS로 옮기는 화면. 대기열 폴링/토큰 화면과 관심사가 달라
// 별도 파일로 뒀다 — app.js에서는 초기화와 "같은 폴링 타이머에서 같이 불러오기"만 담당한다.
import { initErpCarts, refreshErpCarts, applyErpCarts } from './erpCarts.js'
// 차량번호로 지난 정비 내역을 보는 화면. 정비소에서 가장 자주 나오는 질문이라 대기 카드에서
// 바로 열 수 있게 해뒀다.
import { initHistory, openHistoryFor, loadRecentHistory } from './history.js'
// 좌측 메뉴와 화면 전환. 화면을 나누면 전산 주문이 메뉴 뒤로 숨는데, 그때 새 주문을
// 놓치지 않게 배지와 토스트로 알리는 것도 이 모듈이 맡는다.
import { initNav, switchTo, registerViewLoader, updateBadges, notifyNewErpCarts } from './nav.js'

// 실제 토스POS 단말기 밖(로컬 브라우저)에서 미리 볼 때는 posPluginSdk가 부모 프레임(POS 앱)과
// 통신하지 못해 응답이 오지 않는다. 백엔드가 제공하는 미리보기에서는 같은 origin을 사용하고,
// 실제 배포 번들은 빌드 시 CHEVROLET_API_BASE_URL을 주입한다.
const configuredApiBaseUrl = __CHEVROLET_API_BASE_URL__
const isPreview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.pathname.startsWith('/pos-plugin/')

const API_BASE = isPreview ? '' : String(configuredApiBaseUrl).replace(/\/$/, '')

const STATUS_LABEL = { waiting: '대기중', called: '호출완료', notify_failed: '알림실패', cancelled: '취소됨' }

// ─────────────────────────────────────────────────────────────────────────
// POS 인증: X-Store-Token
// ─────────────────────────────────────────────────────────────────────────
// 예전에는 /api/pos/* 요청이 merchantId 하나만 알면 인증이 끝났다. merchantId는 쿼리스트링/요청
// 바디에 평문으로 실리는, 사실상 비밀도 아닌 값이라 — 매장 번호만 추측하거나 다른 요청에서 한 번
// 보기만 해도 — 누구나 그 매장 손님의 전화번호·차량번호를 읽고(개인정보 유출), 순서 호출 알림톡을
// 마음대로 발송하고(비용 발생), 대기열을 조작할 수 있었다. 사실상 인증이 없는 것과 같았다.
// 지금은 매장마다 발급된 64자리 hex 토큰이 있어야만 서버가 /api/pos/* 요청을 받아준다. 이 토큰을
// `X-Store-Token` 헤더에 실어 보내고, 로컬(`localStorage`)에 저장해 다음 접속부터는 다시 입력하지
// 않게 한다. 토큰이 없거나(최초 실행/초기화) 서버가 401(`STORE_TOKEN_REQUIRED`/`INVALID_STORE_TOKEN`)을
// 돌려주면 토큰 입력 화면으로 보낸다. isPreview 여부와 무관하게 이 규칙을 그대로 적용한다 — 로컬
// 미리보기라고 해서 인증을 건너뛰면, 실제 배포에서 인증이 막상 어떻게 동작하는지 아무도 눈으로
// 확인해보지 못한 채로 넘어가게 된다.
const STORE_TOKEN_KEY = 'chevrolet_pos_store_token'

function getStoreToken() {
  try {
    return localStorage.getItem(STORE_TOKEN_KEY) || ''
  } catch {
    // 사파리 프라이빗 모드 등 localStorage 접근이 차단된 환경 대응. 저장이 안 되면 매 세션 다시
    // 입력해야 하지만, 최소한 예외로 앱 전체가 죽는 일은 없게 한다.
    return ''
  }
}

function setStoreToken(token) {
  try {
    localStorage.setItem(STORE_TOKEN_KEY, token)
  } catch {
    // 위 getStoreToken 주석과 동일한 이유로 무시한다.
  }
}

function clearStoreToken() {
  try {
    localStorage.removeItem(STORE_TOKEN_KEY)
  } catch {
    // ignore
  }
}

const listEl = document.getElementById('list')
const storeNameEl = document.getElementById('store-name')
const waitingCountEl = document.getElementById('waiting-count')
const nextNumberEl = document.getElementById('next-number')
const lastUpdatedEl = document.getElementById('last-updated')
const connectionDotEl = document.getElementById('connection-dot')
const refreshButtonEl = document.getElementById('refresh-button')
const pageStatusEl = document.getElementById('page-status')
const tokenScreenEl = document.getElementById('token-screen')
const mainViewEl = document.getElementById('main-view')
const tokenInputEl = document.getElementById('token-input')
const tokenSubmitEl = document.getElementById('token-submit')
const tokenErrorEl = document.getElementById('token-error')
const tokenResetButtonEl = document.getElementById('token-reset-button')

let pollTimer = null
// 행마다 "몇 초 안에 다시 누르면 확정" 확인 상태를 들고 있는다. 번호를 탭하는 것만으로는
// 절대 호출/완료/취소가 나가면 안 되고, 반드시 버튼을 두 번(확인 상태 진입 -> 확정) 눌러야 한다.
const confirming = new Map() // reservationId -> { action: 'call' | 'complete' | 'cancel', timeoutId }

// getMerchant()는 더 이상 인증에 쓰이지 않는다(그 용도는 X-Store-Token이 대신한다). 대기열 응답이
// 오기 전까지 헤더에 보여줄 매장 이름을 잠깐 채워두는, 순전히 화면 표시용 보조 정보일 뿐이다.
async function getMerchant() {
  if (isPreview) {
    return { name: '쉐보레 대리점 (테스트)' }
  }
  return posPluginSdk.merchant.getMerchant()
}

function notify(kind, message) {
  // 실제 단말기에서는 posPluginSdk.toast로 POS 네이티브 토스트를 띄우고,
  // 로컬 미리보기에서는 toast API가 응답하지 않으므로 alert로 대신한다.
  if (!isPreview && posPluginSdk?.toast?.[kind]) {
    posPluginSdk.toast[kind]({ message })
  } else {
    alert(message)
  }
  pageStatusEl.textContent = message
}

function setConnection(state) {
  connectionDotEl.className = `connection-dot ${state === 'online' ? '' : state}`.trim()
  connectionDotEl.title = state === 'online' ? '서버 연결됨' : state === 'checking' ? '서버 확인 중' : '서버 연결 오류'
}

function updateSummary(reservations) {
  const waiting = reservations.filter((reservation) => reservation.status === 'waiting')
  waitingCountEl.textContent = String(waiting.length)
  nextNumberEl.textContent = waiting.length ? `#${waiting[0].queueNumber}` : '—'
  // 다른 화면을 보고 있어도 대기 인원이 메뉴에 보이게 한다.
  updateBadges({ waiting: waiting.length })
}

function updateLastUpdated() {
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date())
  lastUpdatedEl.textContent = `${time} 기준 · 5초마다 자동 업데이트`
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Store-Token': getStoreToken() },
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok && body.ok, status: res.status, body }
}

// body 기본값을 {}로 둬서 기존 호출부(call/complete/cancel — 전부 빈 바디)는 그대로 동작하고,
// ERP 장바구니 결과 보고(consume)처럼 실제 바디가 필요한 곳만 두 번째 인자를 넘기면 된다.
async function apiPost(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Store-Token': getStoreToken() },
    body: JSON.stringify(body),
  })
  const responseBody = await res.json().catch(() => ({}))
  return { ok: res.ok && responseBody.ok, status: res.status, body: responseBody }
}

// 토큰이 만료/폐기됐을 때의 처리를 한 곳에 모은다 — 대기열(runAction/loadQueue)과 전산 주문
// (erpCarts.refreshErpCarts)이 401을 받았을 때 똑같이 이 함수를 타야, 나중에 처리 방식이 하나만
// 바뀌고 나머지가 어긋나는 일이 없다.
function handleUnauthorized(errorMessage) {
  clearStoreToken()
  showTokenScreen(errorMessage || '매장 인증 토큰이 만료되었거나 올바르지 않습니다. 다시 입력해주세요.')
}

function clearConfirm(id) {
  const state = confirming.get(id)
  if (state) clearTimeout(state.timeoutId)
  confirming.delete(id)
}

// 버튼을 처음 누르면 "정말 호출/완료/취소할까요?"로 바뀌고, 3초 안에 같은 버튼을 한 번 더 눌러야
// 실제로 서버에 요청이 나간다. 그 사이 다른 곳을 누르거나 3초가 지나면 원래 상태로 되돌아간다.
// 이렇게 하면 "대기번호 1번을 실수로 탭"하는 정도로는 절대 알림톡이 나가거나 예약이 취소되지 않는다.
function handleActionClick(id, action) {
  const existing = confirming.get(id)
  if (existing && existing.action === action) {
    clearConfirm(id)
    runAction(id, action)
    return
  }
  confirming.forEach((_, otherId) => clearConfirm(otherId))
  const timeoutId = setTimeout(() => {
    confirming.delete(id)
    render(lastReservations)
  }, 3000)
  confirming.set(id, { action, timeoutId })
  render(lastReservations)
}

const ACTION_PATH = {
  call: (id) => `/api/pos/queue/${id}/call`,
  complete: (id) => `/api/pos/queue/${id}/complete`,
  cancel: (id) => `/api/pos/queue/${id}/cancel`,
}

const ACTION_SUCCESS_MESSAGE = {
  call: (alreadyProcessed) => (alreadyProcessed ? '이미 호출 처리된 예약입니다.' : '순서 호출 알림톡을 보냈습니다.'),
  complete: (alreadyProcessed) => (alreadyProcessed ? '이미 정비완료 처리된 예약입니다.' : '정비완료로 처리했습니다.'),
  cancel: (alreadyProcessed) => (alreadyProcessed ? '이미 취소된 예약입니다.' : '대기열에서 취소 처리했습니다(노쇼 등).'),
}

async function runAction(id, action) {
  // 직원이 뭔가를 눌렀다는 건 지금 바쁘다는 뜻이다 -- 폴링을 다시 빠르게 되돌린다.
  noteActivity()
  const { ok, status, body } = await apiPost(ACTION_PATH[action](id))
  if (!ok) {
    if (status === 401) {
      // 요청 도중 토큰이 회전/폐기됐을 수 있다. 저장된 값을 지우고 재입력을 받는다.
      handleUnauthorized(body.error)
      return
    }
    notify('error', body.error || '처리 중 오류가 발생했습니다.')
  } else {
    notify('success', ACTION_SUCCESS_MESSAGE[action](body.alreadyProcessed))
  }
  await loadQueue()
}

let lastReservations = []
// GET /api/pos/queue 응답 최상단의 serviceDate(오늘, KST). 각 이월 건의 serviceDate와 비교해
// '이월' 배지를 붙일지 판단하는 기준값이라 render() 밖에서 계속 들고 있어야 한다 — 두 번째 탭
// 확정을 기다리는 3초 타임아웃(handleActionClick)에서도 새 응답 없이 render(lastReservations)만
// 다시 부르므로, 그 재렌더 시점에도 마지막으로 받은 오늘 날짜를 그대로 써야 배지가 깜빡이지 않는다.
let todayServiceDate = null

function render(reservations) {
  lastReservations = reservations
  updateSummary(reservations)
  updateLastUpdated()
  pageStatusEl.textContent = `대기열 ${reservations.length}건을 불러왔습니다.`

  const activeIds = new Set(reservations.map((reservation) => reservation.id))
  confirming.forEach((_, id) => {
    if (!activeIds.has(id)) clearConfirm(id)
  })

  if (!reservations.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">✓</div>
        <div class="empty-title">대기중인 손님이 없습니다</div>
        <div class="empty-copy">새 예약이 들어오면 이곳에 표시됩니다.</div>
      </div>
    `
    return
  }
  listEl.innerHTML = reservations
    .map((r) => {
      const state = confirming.get(r.id)
      const callConfirming = state?.action === 'call'
      const completeConfirming = state?.action === 'complete'
      const cancelConfirming = state?.action === 'cancel'
      const canCall = r.status === 'waiting'
      const canComplete = r.status === 'called' || r.status === 'notify_failed'
      const canCancel = r.status === 'waiting' || r.status === 'called' || r.status === 'notify_failed'
      const statusClass = ['waiting', 'called', 'notify_failed'].includes(r.status) ? r.status : 'waiting'
      const statusLabel = STATUS_LABEL[r.status] || r.status
      // '이월' 배지: 대기열 조회는 오늘 접수분뿐 아니라, 어제(혹은 그 이전) 접수해 밤새 차를 맡겨두고
      // 아직 호출/알림실패 상태로 남아있는 손님도 함께 내려준다(차를 못 찾아가고 하루를 넘긴 경우).
      // 이 손님을 오늘 새로 들어온 손님과 똑같이 그리면, 정비사가 "오늘 접수 순서"로 착각해 대기
      // 순번을 헷갈리거나 이미 호출된 손님을 다시 호출하려 할 수 있다. serviceDate가 오늘(응답
      // 최상단 serviceDate)과 다른 행에만 조용히 배지를 붙여 "이건 어제 넘어온 건"임을 알려준다.
      const isCarriedOver = Boolean(r.serviceDate) && Boolean(todayServiceDate) && r.serviceDate !== todayServiceDate
      const carriedOverBadge = isCarriedOver
        ? `<span class="badge carried-over" title="${escapeHtml(r.serviceDate)} 접수 · 오늘로 이월됨">이월</span>`
        : ''
      return `
        <article class="queue-item status-${statusClass}">
          <div class="queue-number">#${r.queueNumber}</div>
          <div class="queue-main">
            <div class="queue-top">
              <strong class="car-number">${escapeHtml(r.carNumber)}</strong>
              ${carriedOverBadge}
              <span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span>
            </div>
            <div class="service">${escapeHtml(r.serviceType || '-')}</div>
            <div class="phone">${escapeHtml(r.phoneMasked || '-')}</div>
          </div>
          <div class="actions">
            <button
              class="action-button ${callConfirming ? 'confirm' : ''}"
              data-id="${escapeHtml(r.id)}" data-action="call"
              aria-label="${callConfirming ? '호출 확정' : '호출'} ${escapeHtml(r.carNumber)}"
              ${canCall ? '' : 'disabled'}
            >${callConfirming ? '호출 확정' : '호출'}</button>
            <button
              class="action-button complete ${completeConfirming ? 'confirm' : ''}"
              data-id="${escapeHtml(r.id)}" data-action="complete"
              aria-label="${completeConfirming ? '완료 확정' : '완료'} ${escapeHtml(r.carNumber)}"
              ${canComplete ? '' : 'disabled'}
            >${completeConfirming ? '완료 확정' : '완료'}</button>
            <button
              class="action-button cancel ${cancelConfirming ? 'confirm' : ''}"
              data-id="${escapeHtml(r.id)}" data-action="cancel"
              aria-label="${cancelConfirming ? '취소 확정(되돌릴 수 없음)' : '대기열에서 취소'} ${escapeHtml(r.carNumber)}"
              ${canCancel ? '' : 'disabled'}
            >${cancelConfirming ? '취소 확정' : '취소'}</button>
            <button class="history-button" type="button" data-history="${escapeHtml(r.carNumber)}"
              aria-label="${escapeHtml(r.carNumber)} 정비 이력 보기">이력</button>
          </div>
        </article>
      `
    })
    .join('')
}

function renderError(message) {
  listEl.innerHTML = `
    <div class="error-card">
      <div class="error-mark" aria-hidden="true">!</div>
      <div class="error-title">대기열을 불러오지 못했습니다</div>
      <div class="error-copy">${escapeHtml(message)}</div>
    </div>
  `
  updateSummary([])
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

listEl.addEventListener('click', (e) => {
  const historyBtn = e.target.closest('button[data-history]')
  if (historyBtn) {
    // 이력은 이제 별도 화면이다. 옮겨간 뒤 그 차량번호로 바로 조회한다.
    switchTo('history')
    openHistoryFor(historyBtn.dataset.history)
    return
  }
  const btn = e.target.closest('button[data-action]')
  if (!btn || btn.disabled) return
  handleActionClick(btn.dataset.id, btn.dataset.action)
})

// GET /api/pos/queue 응답은 오늘(KST) 대기열 + storeName + 최상단 serviceDate(오늘 날짜)를 함께
// 내려준다. storeName은 헤더에 표시 중인 이름(최초 로드 전 getMerchant()가 채운 임시값)을 실제
// 매장 이름으로 덮어쓴다. 최상단 serviceDate는 화면에 직접 표시하진 않고, 각 항목의 serviceDate와
// 비교해 '이월' 배지를 붙일지 판단하는 기준으로만 쓴다(render 참고). 서버로 다시 돌려보내지 않는,
// 순수 표시용 값이다.
function applyQueueResponse(body) {
  if (body.storeName) storeNameEl.textContent = body.storeName
  todayServiceDate = body.serviceDate || todayServiceDate
  render(body.reservations || [])
}

async function loadQueue({ manual = false } = {}) {
  if (manual || !lastReservations.length) setConnection('checking')
  try {
    const { ok, status, body } = await apiGet('/api/pos/queue')
    if (!ok) {
      if (status === 401) {
        handleUnauthorized(body.error)
        return false
      }
      setConnection('error')
      if (!lastReservations.length) renderError(body.error || '서버에서 대기열을 확인할 수 없습니다.')
      return false
    }
    setConnection('online')
    applyQueueResponse(body)
    // 전산 주문은 이 응답에 함께 실려 온다(서버가 /api/pos/queue에 erpCarts를 담아준다).
    // 예전에는 경로를 따로 한 번 더 호출해서 매장당 폴링 요청이 두 배였다.
    // 아직 그 필드를 안 주는 서버(배포 과도기)일 수도 있으므로, 없을 때만 옛 경로를 부른다.
    if (Array.isArray(body.erpCarts)) {
      applyErpCarts(body.erpCarts)
      updateBadges({ erpCarts: body.erpCarts.length })
      notifyNewErpCarts(body.erpCarts)
    } else {
      await refreshErpCarts()
    }
    onPollResult(body)
    return true
  } catch {
    setConnection('error')
    if (!lastReservations.length) renderError('네트워크 연결을 확인한 뒤 다시 시도해주세요.')
    return false
  }
}

refreshButtonEl.addEventListener('click', async () => {
  refreshButtonEl.disabled = true
  try {
    await loadQueue({ manual: true })
  } finally {
    refreshButtonEl.disabled = false
  }
})

// ── 폴링 주기 ────────────────────────────────────────────────────────────
// 고정 5초로 돌리면 매장 한 곳이 하루 17,280번 서버를 부른다. 400개 매장이면 하루 690만 번인데,
// 그 대부분은 "바뀐 것 없음"을 확인하려고 서버와 DB를 깨우는 낭비다.
//
// 그래서 **바뀐 게 없으면 간격을 늘리고, 바뀌거나 사람이 만지면 즉시 빠르게 되돌린다.**
// 손님이 오가는 바쁜 시간에는 5초로 붙어 있고, 한산할 때만 느려진다. 상한을 15초로 낮게 둔 이유는
// 전산에서 주문을 보낸 직원이 POS 앞에서 기다리기 때문이다 — 30초까지 늘리면 "안 떠요" 소리가 난다.
const POLL_MIN_MS = 5000
const POLL_MAX_MS = 15000
let pollIntervalMs = POLL_MIN_MS
let lastSnapshot = ''

// 응답이 지난번과 같은지 비교할 지문. 화면에 그리는 값만 담아서, 서버가 순서를 바꾸거나
// 무관한 필드를 더해도 불필요하게 "바뀜"으로 잡히지 않게 한다.
function snapshotOf(body) {
  try {
    const q = (body.reservations || []).map((r) => `${r.id}:${r.status}`).join(',')
    const c = (body.erpCarts || []).map((x) => x.id).join(',')
    return `${q}|${c}`
  } catch {
    return String(Date.now()) // 비교 불가면 항상 "바뀜"으로 취급한다(느려지지 않는 쪽이 안전)
  }
}

function noteActivity() {
  if (pollIntervalMs === POLL_MIN_MS) return
  pollIntervalMs = POLL_MIN_MS
  if (pollTimer) startPolling()
}

function onPollResult(body) {
  const snap = snapshotOf(body)
  if (snap !== lastSnapshot) {
    lastSnapshot = snap
    noteActivity()
    return
  }
  // 변화가 없었다 -> 조금 느리게. 상한까지만.
  const next = Math.min(Math.round(pollIntervalMs * 1.5), POLL_MAX_MS)
  if (next !== pollIntervalMs) {
    pollIntervalMs = next
    if (pollTimer) startPolling()
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(loadQueue, pollIntervalMs)
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

// 화면이 가려져 있으면(다른 탭/앱을 보는 중) 폴링을 멈춘다. 정비소는 하루 10시간 남짓 영업하고
// 그 사이에도 POS는 다른 화면에 있는 시간이 훨씬 길다.
// ⚠️ 토스 POS 웹뷰에서 document.hidden이 실제로 동작하는지는 확인되지 않았다. 동작하지 않으면
// 이 코드는 아무 일도 하지 않고 기존과 똑같이 계속 폴링한다 — 즉 안 되더라도 손해는 없다.
// 다시 보일 때는 간격을 기다리지 않고 **즉시 한 번** 불러온다. 그러지 않으면 화면을 켠 직원이
// 최대 15초 동안 낡은 목록을 보게 된다.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling()
    return
  }
  if (tokenScreenEl.hidden) {
    noteActivity()
    loadQueue()
    startPolling()
  }
})

// ─────────────────────────────────────────────────────────────────────────
// 토큰 입력 화면
// ─────────────────────────────────────────────────────────────────────────
function showTokenScreen(errorMessage) {
  stopPolling()
  mainViewEl.hidden = true
  tokenScreenEl.hidden = false
  tokenErrorEl.textContent = errorMessage || ''
  tokenInputEl.value = ''
  tokenSubmitEl.disabled = false
  tokenInputEl.focus()
}

function showMainView() {
  tokenScreenEl.hidden = true
  mainViewEl.hidden = false
}

// 계약(API_CONTRACT_V2)에 토큰 전용 검증 엔드포인트가 없으므로, 입력받은 토큰을 그대로 저장해두고
// 실제 대기열 조회(GET /api/pos/queue)를 한 번 호출해 성공 여부로 유효성을 판단한다. 실패하면
// 저장했던 토큰을 지워 다음 재시도가 깨끗한 상태에서 시작하게 한다.
async function validateAndEnter(token) {
  setStoreToken(token)
  tokenSubmitEl.disabled = true
  tokenErrorEl.textContent = ''
  try {
    const { ok, status, body } = await apiGet('/api/pos/queue')
    if (ok) {
      showMainView()
      applyQueueResponse(body)
      startPolling()
      return
    }
    clearStoreToken()
    tokenErrorEl.textContent =
      body.error || (status === 401 ? '매장 인증 토큰이 올바르지 않습니다.' : '토큰을 확인하는 중 오류가 발생했습니다. 다시 시도해주세요.')
  } catch {
    clearStoreToken()
    tokenErrorEl.textContent = '네트워크 연결을 확인한 뒤 다시 시도해주세요.'
  } finally {
    tokenSubmitEl.disabled = false
  }
}

tokenSubmitEl.addEventListener('click', () => {
  const token = tokenInputEl.value.trim()
  if (!token) {
    tokenErrorEl.textContent = '토큰을 입력해주세요.'
    return
  }
  validateAndEnter(token)
})

tokenInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    tokenSubmitEl.click()
  }
})

// 매장 관리자가 관리자 웹에서 토큰을 재발급(회전)한 뒤, POS 단말기에서 다시 입력할 수 있는 통로.
// 401을 받아야만 재입력 화면으로 갈 수 있다면, 아직 만료 전인데 미리 바꿔주려는 경우 대응이 안 된다.
tokenResetButtonEl.addEventListener('click', () => {
  clearStoreToken()
  showTokenScreen()
})

async function main() {
  // storeName은 대기열 응답이 도착하면 바로 덮어써지는 임시 표시값이다. 인증(X-Store-Token) 여부와
  // 무관한 화면 장식이므로 실패해도 무시하고 진행한다.
  try {
    const merchant = await getMerchant()
    if (merchant?.name) storeNameEl.textContent = merchant.name
  } catch {
    // ignore — 위 주석 참고
  }

  const token = getStoreToken()
  if (!token) {
    showTokenScreen()
    return
  }

  showMainView()
  await loadQueue()
  // loadQueue가 401을 받으면 내부에서 이미 stopPolling()과 함께 토큰 화면으로 전환했다 — 토큰
  // 없이는 어차피 폴링해봐야 401만 반복되므로 그 상태에서는 폴링을 켜지 않는다. 그 외의 실패
  // (네트워크 오류 등)는 원래부터 폴링으로 자동 복구를 시도했으므로 동일하게 계속 폴링한다.
  if (tokenScreenEl.hidden) startPolling()
}

// erpCarts.js는 fetch를 직접 만들지 않고 여기(app.js)의 apiGet/apiPost/notify/escapeHtml과
// 401 처리(handleUnauthorized)를 그대로 주입받아 쓴다 — 같은 로직이 두 파일에 따로 생기는 것을
// 막기 위해서다.
initErpCarts({ apiGet, apiPost, notify, escapeHtml, onUnauthorized: handleUnauthorized })
initHistory({ apiGet, apiPost, notify, escapeHtml, onUnauthorized: handleUnauthorized })
initNav({ notify })

// 오늘 현황은 폴링 대상이 아니다 — 화면을 열 때와 새로고침을 누를 때만 부른다.
registerViewLoader('history', loadRecentHistory)
registerViewLoader('today', loadTodaySummary)
registerViewLoader('settings', renderSettings)

function todayCard(label, value, unit, note) {
  return `
    <div class="today-card">
      <span class="today-label">${escapeHtml(label)}</span>
      <strong class="today-value">${escapeHtml(String(value))}</strong>${unit ? `<span class="today-unit">${escapeHtml(unit)}</span>` : ''}
      ${note ? `<span class="today-note">${escapeHtml(note)}</span>` : ''}
    </div>
  `
}

async function loadTodaySummary() {
  const body = document.getElementById('today-body')
  if (!body) return
  body.innerHTML = '<div class="empty"><div class="empty-copy">불러오는 중...</div></div>'
  try {
    const { ok, status, body: res } = await apiGet('/api/pos/summary')
    if (!ok) {
      if (status === 401) {
        handleUnauthorized(res.error)
        return
      }
      body.innerHTML = `<div class="empty"><div class="empty-copy">${escapeHtml(res.error || '불러오지 못했습니다.')}</div></div>`
      return
    }
    const dateEl = document.getElementById('today-date')
    if (dateEl) dateEl.textContent = `${res.serviceDate} 기준`
    body.innerHTML = [
      todayCard('접수', res.received, '건', '오늘 들어온 예약'),
      todayCard('정비완료', res.completed, '건', '처리를 마친 건'),
      todayCard('전산 주문', res.erpCarts, '건', `그중 결제완료 ${res.erpCartsPaid}건`),
      todayCard('결제 금액', Number(res.paidAmount).toLocaleString('ko-KR'), '원', '전산 주문 결제분'),
    ].join('')
  } catch {
    body.innerHTML = '<div class="empty"><div class="empty-copy">네트워크 연결을 확인한 뒤 다시 시도해주세요.</div></div>'
  }
}

function renderSettings() {
  const storeEl = document.getElementById('settings-store')
  const connEl = document.getElementById('settings-connection')
  if (storeEl) storeEl.textContent = storeNameEl.textContent || '—'
  if (connEl) {
    const dot = connectionDotEl.className
    connEl.textContent = dot.includes('error') ? '연결 안 됨'
      : dot.includes('checking') ? '확인 중' : '정상'
  }
}

const todayRefreshEl = document.getElementById('today-refresh')
if (todayRefreshEl) todayRefreshEl.addEventListener('click', loadTodaySummary)

main()
