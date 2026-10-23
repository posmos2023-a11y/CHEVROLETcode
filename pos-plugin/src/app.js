// ⚠️ 다른 어떤 import보다 먼저. 이 아래에서 나는 오류를 잡으려면 가드가 먼저 걸려 있어야 한다.
import { installCrashGuard } from './crashGuard.js'
installCrashGuard()

import { posPluginSdk } from '@tossplace/pos-plugin-sdk'
// 전산(ERP)이 담아둔 장바구니를 POS로 옮기는 화면. 대기열 폴링/토큰 화면과 관심사가 달라
// 별도 파일로 뒀다 — app.js에서는 초기화와 "같은 폴링 타이머에서 같이 불러오기"만 담당한다.
import { initErpCarts, refreshErpCarts, applyErpCarts, applyFrontCarts, applyFrontOrphans, getErpGeneration, forgetLoadedCart } from './erpCarts.js'
// 오늘 결제된 전산 주문과 결제 취소. 같은 대기열 폴링 응답(settledCarts)으로 갱신한다.
import { initSettledCarts, applySettledCarts } from './settledCarts.js'
// [홍보 문자] 화면: 기간을 정해 방문 손님에게 홍보 문자를 한 번에 보낸다.
import { initPromoCampaign, loadPromoView } from './promoCampaign.js'
// 차량번호로 지난 정비 내역을 보는 화면. 정비소에서 가장 자주 나오는 질문이라 대기 카드에서
// 바로 열 수 있게 해뒀다.
import { initHistory, openHistoryFor, loadRecentHistory } from './history.js'
// 좌측 메뉴와 화면 전환. 화면을 나누면 전산 주문이 메뉴 뒤로 숨는데, 그때 새 주문을
// 놓치지 않게 배지와 토스트로 알리는 것도 이 모듈이 맡는다.
import { initNav, switchTo, registerViewLoader, updateBadges, notifyNewErpCarts, notifyNewReservations } from './nav.js'
// 대기 카드 한 장의 규칙(상태별 버튼, 접수 시각·경과 시간, 어제 넘어온 접수, 결과 안내 문구). DOM과 무관한 순수 함수라 따로 뒀다.
import { queueCardHtml, isCarriedOver, completesSilently, actionResultMessage, actionErrorMessage } from './queueCard.js'

// 실제 토스POS 단말기 밖(로컬 브라우저)에서 미리 볼 때는 posPluginSdk가 부모 프레임(POS 앱)과
// 통신하지 못해 응답이 오지 않는다. 백엔드가 제공하는 미리보기에서는 같은 origin을 사용하고,
// 실제 배포 번들은 빌드 시 CHEVROLET_API_BASE_URL을 주입한다.
const configuredApiBaseUrl = __CHEVROLET_API_BASE_URL__
const isPreview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.pathname.startsWith('/pos-plugin/')

const API_BASE = isPreview ? '' : String(configuredApiBaseUrl).replace(/\/$/, '')

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
const connectionBannerEl = document.getElementById('connection-banner')
const refreshButtonEl = document.getElementById('refresh-button')
const pageStatusEl = document.getElementById('page-status')
const tokenScreenEl = document.getElementById('token-screen')
const mainViewEl = document.getElementById('main-view')
const tokenInputEl = document.getElementById('token-input')
const tokenSubmitEl = document.getElementById('token-submit')
const tokenErrorEl = document.getElementById('token-error')
const tokenResetButtonEl = document.getElementById('token-reset-button')
const waitingNoteEl = document.getElementById('waiting-note')

let pollTimer = null
// 행마다 "몇 초 안에 다시 누르면 확정" 확인 상태를 들고 있는다. 번호를 탭하는 것만으로는
// 절대 호출/완료/취소/알림 다시 보내기가 나가면 안 되고, 반드시 버튼을 두 번(확인 상태 진입 -> 확정) 눌러야 한다.
// 'retry-twice'는 결과를 모르는 알림을 다시 보내기 전의 추가 확인 단계다(handleActionClick).
const confirming = new Map() // reservationId -> { action: 'call' | 'retry' | 'retry-twice' | 'complete' | 'cancel', timeoutId }
// 서버 응답을 기다리는 카드 -> 동작. 그동안 그 카드의 버튼을 잠근다(같은 요청을 두 번 보내지 않게).
const busy = new Map()
// [알림 다시 보내기]의 결과를 모르는 접수(서버 retry-notify notify 'unknown', 또는 응답을 못 받음). 서버는 이때도 접수를 'notify_failed'로
// 두고 마지막 발송 결과를 대기열에 싣지 않는다 -- 이 단말기가 기억해 카드에 '전달 여부 확인 필요'를 띄운다. 알림은 실제로 나갔을 수 있어서
// 토스트를 놓친 직원이 또 보내면 손님이 '순서입니다'를 두 번 받는다. 메모리에만 두므로 탭앱을 다시 켜면 사라진다.
// 접수가 알림 실패 상태를 벗어나면(호출됨·완료·취소) 지운다(applyQueueResponse).
const notifyUnknown = new Set()
// 결과를 모르는 알림을 다시 보내기 전 확인('두 번 받을 수 있어요')을 읽을 시간. 평소 확인(3초)보다 길게 준다.
const DOUBLE_SEND_CONFIRM_MS = 10 * 1000

// getMerchant()는 더 이상 인증에 쓰이지 않는다(그 용도는 X-Store-Token이 대신한다). 대기열 응답이
// 오기 전까지 헤더에 보여줄 매장 이름을 잠깐 채워두는, 순전히 화면 표시용 보조 정보일 뿐이다.
async function getMerchant() {
  if (isPreview) {
    return { name: '쉐보레 대리점 (테스트)' }
  }
  return posPluginSdk.merchant.getMerchant()
}

// button: { text, onClick } -- POS 토스트에 버튼 하나를 붙인다(SDK ToastTypes, 새 접수·새 전산 주문의 [보기]).
// 단말기에서 버튼이 안 보이거나 눌리지 않아도 안내 글자는 그대로 뜬다.
function notify(kind, message, button) {
  // 실제 단말기에서는 posPluginSdk.toast로 POS 네이티브 토스트를 띄우고,
  // 로컬 미리보기에서는 toast API가 응답하지 않으므로 alert로 대신한다.
  if (!isPreview && posPluginSdk?.toast?.[kind]) {
    posPluginSdk.toast[kind](button ? { message, button } : { message })
  } else {
    alert(message)
  }
  pageStatusEl.textContent = message
}

// 오른쪽 위 점 하나만으로는 연결이 끊긴 걸 아무도 모른다 -- 그동안 새 접수·전산 주문이 안 보이는데 직원은
// "오늘 한가하네"로 받아들인다. 연속으로 3번 실패하면(15~45초) 화면 위에 띠를 띄운다. 한 번 실패는 흔해서 띄우지 않는다.
const CONNECTION_BANNER_AFTER = 3
let connectionErrors = 0

function setConnection(state) {
  connectionDotEl.className = `connection-dot ${state === 'online' ? '' : state}`.trim()
  connectionDotEl.title = state === 'online' ? '서버 연결됨' : state === 'checking' ? '서버 확인 중' : '서버 연결 오류'
  if (state === 'online') connectionErrors = 0
  else if (state === 'error') connectionErrors += 1
  if (connectionBannerEl) connectionBannerEl.hidden = connectionErrors < CONNECTION_BANNER_AFTER
}

function updateSummary(reservations) {
  // '현재 대기'와 '다음 호출'은 오늘 호출할 수 있는 손님만 센다. 어제 '대기 중'으로 넘어온 접수(carriedOver)는
  // 호출할 수 없어서(서버가 오늘 접수만 호출한다) 다음 호출 번호로 띄우면 안 된다 -- 목록에 '어제' 배지로 따로 보인다.
  const waiting = reservations.filter((r) => r.status === 'waiting' && !isCarriedOver(r, todayServiceDate))
  const carriedWaiting = reservations.filter((r) => r.status === 'waiting' && isCarriedOver(r, todayServiceDate)).length
  waitingCountEl.textContent = String(waiting.length)
  nextNumberEl.textContent = waiting.length ? `#${waiting[0].queueNumber}` : '—'
  if (waitingNoteEl) {
    waitingNoteEl.textContent = carriedWaiting
      ? `아직 호출하지 않은 손님 · 어제 남은 ${carriedWaiting}명은 빼고 셌어요`
      : '아직 호출하지 않은 손님'
  }
  // 다른 화면을 보고 있어도 대기 인원이 메뉴에 보이게 한다.
  updateBadges({ waiting: waiting.length })
}

function updateLastUpdated() {
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date())
  // 실제 주기는 POLL_MIN_MS(5초)~POLL_MAX_MS(15초) 사이를 오가는 적응형 간격(pollIntervalMs)이라 초를 적으면
  // 5, 8, 11, 15로 계속 바뀌어 오히려 이상해 보인다. 화면이 멈췄는지는 기준 시각만으로 알 수 있다.
  lastUpdatedEl.textContent = `${time} 기준 · 자동 새로고침`
}

// fetch에 상한을 두지 않으면, 서버가 응답을 영영 안 주는 순간(다운/과부하) 그 요청도 영영 안
// 끝난다 — 아래 loadQueue의 "이전 요청이 안 끝났으면 새로 시작하지 않는다" 가드를 넣어도, 그
// 가드가 붙들고 있는 요청 자체가 안 풀리면 가드도 영원히 풀리지 않는다. 그래서 조회/변경 요청
// 둘 다 AbortController로 상한을 건다. 값은 용도에 따라 다르게 뒀다(아래 각 함수 주석 참고).
//
// 조회(GET)는 실패해도 다음 폴링에서 다시 물어보면 그만이라 짧게 끊어도 손해가 없다. 폴링
// 최소 간격(POLL_MIN_MS, 5초)보다는 넉넉히 길게 잡아, 그냥 좀 느린 정상 응답을 타임아웃으로
// 오인해 "네트워크 연결 확인" 오류를 괜히 띄우지 않게 한다.
const GET_TIMEOUT_MS = 8000

// 상태 변경(POST: 호출/완료/취소, 그리고 erpCarts.js가 같은 apiPost로 보내는 담기/결제 보고)은
// 얘기가 다르다. 요청이 서버에 도착해 처리(알림톡 발송, 결제 확정 등)까지 끝났는데 응답만
// 못 받은 경우, 여기서 "실패"로 단정해버리면 직원이 같은 조작을 다시 시도해 중복 처리(알림톡
// 중복 발송, 결제 중복 등)로 이어질 수 있다. 그래서 GET보다 훨씬 길게 잡아 어지간히 느린
// 응답은 성공으로 받아내고, 정말 응답이 없는(연결이 끊긴) 경우에만 포기한다. 그래도 무한정
// 기다리게 두면 ①의 가드가 영원히 안 풀리는 건 GET과 마찬가지라 상한 자체는 반드시 둔다.
const POST_TIMEOUT_MS = 20000

async function apiGet(path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'X-Store-Token': getStoreToken() },
      signal: controller.signal,
    })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok && body.ok, status: res.status, body }
  } finally {
    // 성공/실패/타임아웃 어느 경로로 끝나든 타이머를 반드시 지운다 — 안 지우면 이미 끝난 요청의
    // abort()가 나중에 불필요하게 예약돼 있는 채로 남는다.
    clearTimeout(timer)
  }
}

// body 기본값을 {}로 둬서 기존 호출부(call/complete/cancel — 전부 빈 바디)는 그대로 동작하고,
// ERP 장바구니 결과 보고(consume)처럼 실제 바디가 필요한 곳만 두 번째 인자를 넘기면 된다.
async function apiPost(path, body = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Store-Token': getStoreToken() },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const responseBody = await res.json().catch(() => ({}))
    return { ok: res.ok && responseBody.ok, status: res.status, body: responseBody }
  } finally {
    clearTimeout(timer)
  }
}

// 토큰이 만료/폐기됐을 때의 처리를 한 곳에 모은다 — 대기열(runAction/loadQueue)과 전산 주문
// (erpCarts.refreshErpCarts)이 401을 받았을 때 똑같이 이 함수를 타야, 나중에 처리 방식이 하나만
// 바뀌고 나머지가 어긋나는 일이 없다.
function handleUnauthorized(errorMessage) {
  clearStoreToken()
  // 토큰에는 만료가 없다 -- 본사가 재발급하면 바뀐다. 매장은 재발급할 수 없으니 새 토큰을 어디서 받는지 알려 준다.
  showTokenScreen(errorMessage || '매장 토큰이 바뀌었거나 올바르지 않아요. 본사에서 받은 새 토큰을 입력해주세요.')
}

function clearConfirm(id) {
  const state = confirming.get(id)
  if (state) clearTimeout(state.timeoutId)
  confirming.delete(id)
}

// 버튼을 처음 누르면 "한 번 더 누르면 호출돼요"처럼 바뀌고, 3초 안에 같은 버튼을 한 번 더 눌러야
// 실제로 서버에 요청이 나간다. 그 사이 다른 곳을 누르거나 3초가 지나면 원래 상태로 되돌아간다.
// 이렇게 하면 "대기번호 1번을 실수로 탭"하는 정도로는 절대 알림이 나가거나 접수가 취소되지 않는다.
function handleActionClick(id, action) {
  if (busy.has(id)) return
  const existing = confirming.get(id)
  if (existing && existing.action === action) {
    clearConfirm(id)
    runAction(id, action)
    return
  }
  // 결과를 모르는 알림을 다시 보낼 때는 평소 확인 앞에 '손님이 두 번 받을 수 있어요' 확인을 한 번 더 받는다(세 번 눌러야 보낸다).
  if (action === 'retry' && notifyUnknown.has(id) && !(existing && existing.action === 'retry-twice')) {
    armConfirm(id, 'retry-twice', DOUBLE_SEND_CONFIRM_MS)
    return
  }
  armConfirm(id, action, 3000)
}

function armConfirm(id, action, ms) {
  confirming.forEach((_, otherId) => clearConfirm(otherId))
  const timeoutId = setTimeout(() => {
    confirming.delete(id)
    render(lastReservations)
  }, ms)
  confirming.set(id, { action, timeoutId })
  render(lastReservations)
}

const ACTION_PATH = {
  call: (id) => `/api/pos/queue/${encodeURIComponent(id)}/call`,
  // 알림 실패 손님에게 호출 알림을 다시 보낸다(서버 C4). 서버가 접수 한 건마다 잠가서 POS 두 대가 동시에 눌러도 한 번만 나간다.
  retry: (id) => `/api/pos/queue/${encodeURIComponent(id)}/retry-notify`,
  complete: (id) => `/api/pos/queue/${encodeURIComponent(id)}/complete`,
  cancel: (id) => `/api/pos/queue/${encodeURIComponent(id)}/cancel`,
}

async function runAction(id, action) {
  // 직원이 뭔가를 눌렀다는 건 지금 바쁘다는 뜻이다 -- 폴링을 다시 빠르게 되돌린다.
  noteActivity()
  // 어제 넘어온 '대기 중' 접수의 [정비완료]는 완료 알림 없이 보낸다(queueCard.completesSilently -- 하루 늦은 '찾으러 와주세요'를 막는다).
  // 직원이 확인한 카드(지금 그려진 목록) 기준으로 정한다.
  const reservation = lastReservations.find((r) => r.id === id)
  const silent = action === 'complete' && completesSilently(reservation, todayServiceDate)
  busy.set(id, action)
  render(lastReservations)
  let response = null
  try {
    response = await apiPost(ACTION_PATH[action](id), silent ? { notify: false } : {})
  } catch {
    // 네트워크 오류이거나 POST_TIMEOUT_MS 타임아웃이다. 위 주석대로 이 시점엔 요청이 서버에
    // 도달해 실제로는 처리됐을 수도 있어 "실패"라고 단정하지 않는다 — 안내만 하고, 아래
    // loadQueue()로 서버의 실제 최신 상태를 다시 받아와 화면을 맞춘다. 여기서 catch 없이
    // 그냥 던지면 crashGuard의 unhandledrejection이 잡아 전체 화면이 오류 패널로 덮인다
    // (버튼 하나 눌렀다고 화면 전체가 하얘지면 안 된다).
    // 알림 다시 보내기는 실제로 나갔을 수 있다 -- 또 누르면 손님이 두 번 받으니 직접 연락을 먼저 권한다(카드에도 남긴다, notifyUnknown).
    if (action === 'retry') notifyUnknown.add(id)
    notify('error', action === 'retry'
      ? '인터넷 연결을 확인해주세요. 알림이 이미 갔을 수 있으니 다시 보내기 전에 손님께 직접 연락해주세요.'
      : '인터넷 연결을 확인해주세요. 처리됐는지는 목록에서 다시 확인해주세요.')
  } finally {
    // 잠금은 응답이 오면 바로 풀고 다시 그린다. 예전엔 아래 목록 새로고침에 맡겨서, 새로고침이 실패하면(연결 끊김·서버 오류)
    // 카드가 '처리 중...'으로 잠긴 채 다음 성공 폴링까지 남았다 -- 직원은 요청이 아직 진행 중인 줄 알았다.
    busy.delete(id)
    render(lastReservations)
  }
  if (response) {
    const { ok, status, body } = response
    if (status === 401 && !ok) {
      // 요청 도중 토큰이 회전/폐기됐을 수 있다. 저장된 값을 지우고 재입력을 받는다.
      handleUnauthorized(body.error)
      return
    }
    // 다른 POS나 프론트 결제의 자동 완료가 먼저 끝냈으면 서버는 alreadyCompleted를 준다 -- 거절이 아니라 이미 끝난 것이다.
    const alreadyCompleted = action === 'complete' && body && body.alreadyCompleted === true
    if (action === 'retry') noteRetryOutcome(id, body)
    if (ok || alreadyCompleted) {
      // 결과 문구는 queueCard.actionResultMessage 한 곳에서 정한다(호출했지만 알림 실패, 완료 알림 실패, 다시 보내기 결과 모름 등).
      const [kind, message] = actionResultMessage(action, body, { silent })
      notify(kind, message)
    } else if (action === 'retry' && (body.notify === 'failed' || body.notify === 'unknown')) {
      // 서버(C4)는 다시 보내기가 실패하거나 결과를 모르면 502 ok:false에 notify를 실어 준다. 거절이 아니라 발송 결과이므로
      // 결과 안내로 읽는다 -- 특히 'unknown'은 "두 번 갈 수 있으니 먼저 연락" 경고(warn)가 떠야 한다.
      const [kind, message] = actionResultMessage(action, body)
      notify(kind, message)
    } else {
      notify('error', actionErrorMessage(action, status, body))
    }
  }
  // bypassGuard: 자동 폴링이 마침 진행 중이면 가드에 걸려 조용히 아무 일도 안 하고, 방금 누른
  // 버튼의 결과가 화면에 반영되지 않는다 — 직원은 "안 눌렸나?" 하고 다시 누르게 된다. manual은
  // 안 쓴다(사람이 새로고침을 누른 게 아니라 방금 뜬 토스트를 화면과 맞추는 것뿐이라, 여기서
  // setConnection('checking')까지 깜빡이면 방금 본 결과를 의심하게 만드는 군더더기다).
  await loadQueue({ bypassGuard: true })
}

// [알림 다시 보내기] 결과를 기억한다. 'unknown'이면 카드에 '전달 여부 확인 필요'를 남기고, 'sent'면 지운다. 'failed'는 그대로 둔다 --
// 이번 발송은 확실히 안 갔지만 앞서 결과를 모른 발송은 손님이 받았을 수 있다.
function noteRetryOutcome(id, body) {
  const outcome = body && body.notify
  if (outcome === 'unknown') notifyUnknown.add(id)
  else if (outcome === 'sent') notifyUnknown.delete(id)
}

let lastReservations = []
// GET /api/pos/queue 응답 최상단의 serviceDate(오늘, KST). 각 건의 serviceDate와 비교해 '어제'(넘어온 접수) 배지를
// 붙일지, 다음 호출 번호에 넣을지 판단하는 기준값이라 render() 밖에서 계속 들고 있어야 한다 — 두 번째 탭
// 확정을 기다리는 3초 타임아웃(handleActionClick)에서도 새 응답 없이 render(lastReservations)만
// 다시 부르므로, 그 재렌더 시점에도 마지막으로 받은 오늘 날짜를 그대로 써야 배지가 깜빡이지 않는다.
let todayServiceDate = null

function render(reservations) {
  lastReservations = reservations
  updateSummary(reservations)
  updateLastUpdated()
  pageStatusEl.textContent = `대기열 ${reservations.length}건을 불러왔어요.`

  const activeIds = new Set(reservations.map((reservation) => reservation.id))
  confirming.forEach((_, id) => {
    if (!activeIds.has(id)) clearConfirm(id)
  })

  if (!reservations.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">✓</div>
        <div class="empty-title">대기 중인 손님이 없어요</div>
        <div class="empty-copy">손님이 접수하면 이곳에 표시돼요.</div>
      </div>
    `
    return
  }
  // 카드 한 장의 규칙(상태별 버튼만 보이기, 접수 시각·경과 시간, '어제' 배지, 알림 실패 경고)은 queueCard.js에 있다.
  // 어제(혹은 그 이전) 접수해 아직 끝나지 않은 손님도 함께 내려온다(밤새 맡긴 차, 어제 호출하지 않은 접수). 오늘 새로 들어온
  // 손님과 똑같이 그리면 정비사가 "오늘 접수 순서"로 착각하므로 배지와 날짜로 구분하고, 호출 버튼은 두지 않는다.
  const now = Date.now()
  listEl.innerHTML = reservations
    .map((r) => queueCardHtml(r, {
      todayServiceDate,
      now,
      confirmingAction: confirming.get(r.id)?.action || null,
      busyAction: busy.get(r.id) || null,
      notifyUnknown: notifyUnknown.has(r.id),
      escapeHtml,
    }))
    .join('')
}

function renderError(message) {
  listEl.innerHTML = `
    <div class="error-card">
      <div class="error-mark" aria-hidden="true">!</div>
      <div class="error-title">대기열을 불러오지 못했어요</div>
      <div class="error-copy">${escapeHtml(message)}</div>
      <button class="error-retry" type="button" data-retry-queue="1">다시 시도</button>
    </div>
  `
  updateSummary([])
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

listEl.addEventListener('click', (e) => {
  // 오류 카드의 [다시 시도]. 다음 폴링(최대 15초)을 기다리지 않고 바로 다시 불러온다.
  if (e.target.closest('button[data-retry-queue]')) {
    loadQueue({ manual: true })
    return
  }
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
  const reservations = body.reservations || []
  // 알림 실패 상태를 벗어난 접수(다시 보내기 성공·완료·취소·목록에서 빠짐)는 '전달 여부 확인 필요'를 지운다.
  const stillFailed = new Set(reservations.filter((r) => r.status === 'notify_failed').map((r) => r.id))
  notifyUnknown.forEach((id) => {
    if (!stillFailed.has(id)) notifyUnknown.delete(id)
  })
  render(reservations)
  notifyNewReservations(body.reservations)
}

// 대기열 조회 경로. carriedOver=1은 "어제 '대기 중'으로 남은 접수(carriedOver:true)도 보내 달라"는 뜻이다(서버 C2). 그 접수를 다룰 줄 모르는
// 옛 탭앱은 이 값을 보내지 않으므로 서버가 예전 응답(오늘 접수와 어제 호출된 접수만)을 준다 -- 옛 탭앱이 어제 번호를 '다음 호출'로 띄우고
// 누를 수 없는 버튼을 안내하는 일을 막는다.
const QUEUE_PATH = '/api/pos/queue?carriedOver=1'

// setInterval(아래 startPolling)은 콜백이 끝났는지 신경 쓰지 않고 다음 콜백을 그대로 실행한다.
// 서버가 느려지면 한 단말기에서 응답 못 받은 요청이 계속 쌓이고, 가맹점 400곳이 동시에 그
// 상태가 되면 서버가 회복되려는 순간 쌓여있던 요청이 한꺼번에 몰려 회복을 방해한다(자기 증폭).
// 그래서 이전 요청이 아직 안 끝났으면 새 요청을 시작하지 않는다. 다만 "사람이 방금 뭔가 해서
// 지금 당장 최신 상태를 보여줘야 하는" 호출(bypassGuard)은 예외로 통과시킨다 — 자동 폴링과
// 드물게 겹치는 것보다, 버튼을 눌렀는데 화면이 그대로라 "안 눌렸나?" 싶은 상황이 매장에서는
// 더 나쁘다.
//
// 처음엔 manual 하나로 "가드 통과 여부"와 "queueLoadInFlight 플래그를 만질지"를 같이 결정했는데,
// 그러면 가드를 우회한 호출이 먼저 끝나는 순간 finally에서 플래그를 false로 내려버려 아직 안 끝난
// 자동 폴링 요청의 팻말을 떼는 사고가 났다(그 직후 폴링 틱이 가드 없이 통과 -> 자동 요청이 겹침).
// 그래서 지금은 가드를 지키는(자동 폴링) 호출만 플래그를 만지고, bypassGuard로 우회하는 호출은
// 플래그를 아예 건드리지 않는다 — 남의 팻말을 못 떼게.
//
// manual과 bypassGuard는 별개다. manual은 "새로고침 버튼을 사람이 눌렀다"는 뜻으로 setConnection
// ('checking') 표시까지 겸한다(눌렀는데 아무 표시도 안 바뀌면 그것도 "안 눌렸나?"로 보인다).
// runAction 사후 갱신과 visibilitychange 복귀는 성공/오류 토스트가 이미 떴거나 그냥 화면을 다시 본
// 것뿐이라 여기서 또 커넥션 점(dot)을 'checking'으로 깜빡이면 방금 본 성공 결과를 의심하게 만드는
// 군더더기 신호가 된다 — 그래서 이 둘은 bypassGuard만 쓰고 manual은 쓰지 않는다.
let queueLoadInFlight = false

async function loadQueue({ manual = false, bypassGuard = false } = {}) {
  const skipGuard = manual || bypassGuard
  if (queueLoadInFlight && !skipGuard) return false
  if (!skipGuard) queueLoadInFlight = true
  if (manual || !lastReservations.length) setConnection('checking')
  try {
    // 이 요청이 출발한 시점의 전산 주문 세대. 응답을 기다리는 사이 [POS로 되돌리기]·[프론트로 넘기기]·[지우기] 같은
    // 상태 변경이 성공하면 세대가 올라간다. 그러면 이 응답의 전산 주문·프론트 결제 목록은 변경 전에 만들어진
    // 옛 상태라서, 반영하면 방금 되돌린 카드가 사라지거나 방금 넘긴 카드가 되살아난다(erpCarts.js erpGeneration).
    const erpGeneration = getErpGeneration()
    const { ok, status, body } = await apiGet(QUEUE_PATH)
    if (!ok) {
      if (status === 401) {
        handleUnauthorized(body.error)
        return false
      }
      setConnection('error')
      if (!lastReservations.length) renderError(body.error || '서버에서 대기열을 확인하지 못했어요.')
      return false
    }
    setConnection('online')
    applyQueueResponse(body)
    // 전산 주문은 이 응답에 함께 실려 온다(서버가 /api/pos/queue에 erpCarts를 담아준다).
    // 예전에는 경로를 따로 한 번 더 호출해서 매장당 폴링 요청이 두 배였다.
    // 아직 그 필드를 안 주는 서버(배포 과도기)일 수도 있으므로, 없을 때만 옛 경로를 부른다.
    if (Array.isArray(body.erpCarts)) {
      // 위 erpGeneration 주석 참고. 옛 응답이면 두 목록과 배지·새 주문 알림을 건너뛴다(다음 폴링이 채운다).
      // 최근 결제(settledCarts)는 이 세대 규칙의 대상이 아니다(그쪽은 자기 요청 뒤 로컬에서 따로 고쳐 쓴다).
      const freshErp = erpGeneration === getErpGeneration()
      // 프론트 결제 대기 목록을 먼저 반영한다 -- 방금 프론트로 넘긴 카드를 기억하는 목록(sentToFront)이
      // 여기서 정리되므로, 그 뒤에 그려야 POS 목록이 최신 기준으로 걸러진다.
      if (freshErp) applyFrontCarts(body.frontCarts)
      // 닫힌 주문(지움·만료·전산 취소)에 남은 프론트 승인 경고. 이 필드를 안 주는 옛 서버면 건드리지 않는다.
      if (freshErp && Array.isArray(body.frontOrphans)) applyFrontOrphans(body.frontOrphans)
      applySettledCarts(body.settledCarts)
      if (freshErp) {
        applyErpCarts(body.erpCarts)
        // 닫힌 주문의 프론트 승인 경고도 [전산 주문] 화면에 있다 -- 다른 화면을 보고 있어도 배지로 눈에 걸리게 함께 센다.
        const openOrphans = Array.isArray(body.frontOrphans)
          ? body.frontOrphans.filter((x) => x && x.frontOrphan && !x.frontOrphan.ackAt).length
          : 0
        updateBadges({ erpCarts: body.erpCarts.length + openOrphans })
        notifyNewErpCarts(body.erpCarts)
      }
    } else {
      await refreshErpCarts()
    }
    onPollResult(body)
    return true
  } catch {
    setConnection('error')
    if (!lastReservations.length) renderError('인터넷 연결을 확인한 뒤 다시 시도해주세요.')
    return false
  } finally {
    // 어느 return 경로로 빠지든(성공/401/서버오류/네트워크오류·타임아웃) 반드시 풀어준다 —
    // 안 풀면 이번 요청 이후로 자동 폴링이 영원히 스스로를 건너뛰게 된다.
    // skipGuard였으면 애초에 세우지도 않았으니 여기서도 건드리지 않는다(남의 팻말을 뗄 수 있어서).
    if (!skipGuard) queueLoadInFlight = false
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
    // 프론트 승인 경고(frontOrphan)가 생기거나 매장 확인(ackAt)으로 접히는 것도 직원이 바로 봐야 하는 변화다.
    const o = (x) => (x.frontOrphan ? (x.frontOrphan.ackAt ? 2 : 1) : 0)
    const c = (body.erpCarts || []).map((x) => `${x.id}:${o(x)}`).join(',')
    // 프론트 결제(손님이 결제 중인지)와 최근 결제(결제됨·취소됨·영수증·숨김)도 직원이 지켜보는 값이다.
    // 이게 빠져 있으면 대기열과 전산 주문이 그대로인 동안 이 값들이 바뀌어도 폴링이 15초까지 느려졌다.
    const f = (body.frontCarts || []).map((x) => `${x.id}:${x.status}:${o(x)}`).join(',')
    const s = (body.settledCarts || []).map((x) => `${x.id}:${x.status}:${x.receiptStatus || ''}:${x.hidden ? 1 : 0}:${o(x)}`).join(',')
    const g = (body.frontOrphans || []).map((x) => `${x.id}:${x.status}:${o(x)}`).join(',')
    return `${q}|${c}|${f}|${s}|${g}`
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
    // bypassGuard: 화면을 다시 봤을 때 자동 폴링이 마침 진행 중이면 가드에 걸려 이 즉시-갱신이
    // 조용히 씹히고, 바로 위 주석의 "최대 15초 낡은 목록" 상황이 그대로 재현된다. manual은 안
    // 쓴다 — 사람이 새로고침 버튼을 누른 게 아니라 탭/화면을 다시 본 것뿐이라 커넥션 점을
    // 'checking'으로 깜빡일 이유가 없다.
    loadQueue({ bypassGuard: true })
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
    const { ok, status, body } = await apiGet(QUEUE_PATH)
    if (ok) {
      showMainView()
      applyQueueResponse(body)
      startPolling()
      return
    }
    clearStoreToken()
    tokenErrorEl.textContent =
      body.error || (status === 401 ? '매장 토큰이 올바르지 않아요. 다시 확인해주세요.' : '토큰을 확인하는 중 문제가 생겼어요. 다시 시도해주세요.')
  } catch {
    clearStoreToken()
    tokenErrorEl.textContent = '인터넷 연결을 확인한 뒤 다시 시도해주세요.'
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

// 본사가 관리자 웹에서 토큰을 재발급(회전)한 뒤, POS 단말기에서 다시 입력할 수 있는 통로.
// 401을 받아야만 재입력 화면으로 갈 수 있다면, 아직 옛 토큰이 살아 있는데 미리 바꿔주려는 경우 대응이 안 된다.
// 누르면 지금 토큰이 바로 지워져 이 단말기의 대기열·전산 주문이 멈춘다 -- 토큰을 모르는 직원이 스쳐 누르면 그대로 막힌다.
// 그래서 다른 위험한 버튼처럼 3초 안에 한 번 더 눌러야 지운다.
const TOKEN_RESET_LABEL = '토큰 다시 입력'
let tokenResetTimer = null
tokenResetButtonEl.addEventListener('click', () => {
  if (!tokenResetTimer) {
    tokenResetButtonEl.classList.add('confirming')
    tokenResetButtonEl.textContent = '한 번 더 누르면 지금 토큰을 지우고 입력 화면으로 가요'
    tokenResetTimer = setTimeout(() => {
      tokenResetTimer = null
      tokenResetButtonEl.classList.remove('confirming')
      tokenResetButtonEl.textContent = TOKEN_RESET_LABEL
    }, 3000)
    return
  }
  clearTimeout(tokenResetTimer)
  tokenResetTimer = null
  tokenResetButtonEl.classList.remove('confirming')
  tokenResetButtonEl.textContent = TOKEN_RESET_LABEL
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
  // 여긴 guard/manual/bypassGuard를 신경 쓸 필요가 없다 — startPolling()이 아직 호출 전이라
  // 자동 폴링 자체가 존재하지 않고(겹칠 상대가 없음), queueLoadInFlight도 항상 false로 시작한다.
  // 이 호출이 세우는 팻말은 이 호출 자신만 떼므로 남의 것을 건드릴 일이 없다.
  await loadQueue()
  // loadQueue가 401을 받으면 내부에서 이미 stopPolling()과 함께 토큰 화면으로 전환했다 — 토큰
  // 없이는 어차피 폴링해봐야 401만 반복되므로 그 상태에서는 폴링을 켜지 않는다. 그 외의 실패
  // (네트워크 오류 등)는 원래부터 폴링으로 자동 복구를 시도했으므로 동일하게 계속 폴링한다.
  if (tokenScreenEl.hidden) startPolling()
}

// erpCarts.js는 fetch를 직접 만들지 않고 여기(app.js)의 apiGet/apiPost/notify/escapeHtml과
// 401 처리(handleUnauthorized)를 그대로 주입받아 쓴다 — 같은 로직이 두 파일에 따로 생기는 것을
// 막기 위해서다.
// noteActivity: 상태를 바꾸는 요청(담기 보고·지우기·프론트로 넘기기·되돌리기·결제 중 풀기)이 끝나면 폴링을 다시
// 빠르게 되돌린다. 직원이 방금 만졌다는 뜻이고, 서버 상태가 곧 바뀌어 보일 때다.
initErpCarts({ apiGet, apiPost, notify, escapeHtml, onUnauthorized: handleUnauthorized, noteActivity })
initSettledCarts({ apiPost, notify, escapeHtml, onUnauthorized: handleUnauthorized, forgetLoadedCart })
initPromoCampaign({ apiGet, apiPost, notify, escapeHtml, onUnauthorized: handleUnauthorized })
// queueCarNumbers: 정비 이력의 뒷번호(4자리) 찾기가 오늘 대기열의 차량번호도 함께 본다(history.js searchByTail).
initHistory({ apiGet, apiPost, notify, escapeHtml, onUnauthorized: handleUnauthorized, queueCarNumbers: () => lastReservations.map((r) => r.carNumber) })
initNav({ notify })

// 오늘 현황은 폴링 대상이 아니다 — 화면을 열 때와 새로고침을 누를 때만 부른다.
registerViewLoader('history', loadRecentHistory)
registerViewLoader('today', loadTodaySummary)
registerViewLoader('promo', () => loadPromoView().catch(() => {}))
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
      body.innerHTML = `<div class="empty"><div class="empty-copy">${escapeHtml(res.error || '불러오지 못했어요.')}</div></div>`
      return
    }
    const dateEl = document.getElementById('today-date')
    if (dateEl) dateEl.textContent = `${res.serviceDate} 기준`
    body.innerHTML = [
      todayCard('접수', res.received, '건', '오늘 들어온 접수'),
      todayCard('정비완료', res.completed, '건', '처리를 마친 건'),
      todayCard('전산 주문', res.erpCarts, '건', `그중 결제 완료 ${res.erpCartsPaid}건`),
      todayCard('결제 금액', Number(res.paidAmount).toLocaleString('ko-KR'), '원', '전산 주문 결제분'),
    ].join('')
  } catch {
    body.innerHTML = '<div class="empty"><div class="empty-copy">인터넷 연결을 확인한 뒤 다시 시도해주세요.</div></div>'
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

// 정비 대기 화면 위의 [정비 이력] 버튼은 뺐다. 왼쪽 메뉴(좁은 화면에서는 위쪽 탭)에 [정비 이력]이 늘 보여서 같은 버튼이
// 두 번 있었다. 옛 index.html이 남아 있는 미리보기에서도 동작하도록 연결만 남겨 둔다.
const historyOpenEl = document.getElementById('history-open')
if (historyOpenEl) historyOpenEl.addEventListener('click', () => switchTo('history'))

const todayRefreshEl = document.getElementById('today-refresh')
if (todayRefreshEl) todayRefreshEl.addEventListener('click', loadTodaySummary)

main()
