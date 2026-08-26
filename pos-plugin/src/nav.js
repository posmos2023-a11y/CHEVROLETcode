// 좌측 메뉴와 화면 전환.
//
// 한 화면에 다 쌓여 있던 것을 나눴다. 다만 나누면 잃는 게 하나 있다 — 전에는 전산 주문이
// 대기열 위에 바로 떠서 새 주문이 오면 눈에 걸렸는데, 메뉴 뒤로 들어가면 직원이 못 본다.
// 그래서 메뉴 항목에 대기 건수를 배지로 띄운다. 이게 이 파일에서 제일 중요한 부분이다.

let deps = null
let currentView = 'queue'

const VIEW_TITLE = {
  queue: '정비 대기',
  erp: '전산 주문',
  history: '정비 이력',
  today: '오늘 현황',
  settings: '설정',
}

// 화면을 열 때 한 번 불러야 하는 것들. 폴링으로 계속 받는 대기열/전산주문과 달리
// 이쪽은 자주 바뀌지 않아서 열 때만 부른다.
const ON_ENTER = {}

export function registerViewLoader(view, fn) {
  ON_ENTER[view] = fn
}

export function initNav(injected) {
  deps = injected
  const nav = document.querySelector('.sidenav')
  if (!nav) return

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item')
    if (!btn) return
    switchTo(btn.dataset.view)
  })
}

export function switchTo(view) {
  if (!VIEW_TITLE[view]) return
  currentView = view

  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === view)
  })
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('is-active', v.id === `view-${view}`)
  })

  const title = document.getElementById('view-title')
  if (title) title.textContent = VIEW_TITLE[view]

  // 화면을 바꾸면 위로 올린다 — 아래로 스크롤한 상태에서 전환하면 새 화면의 중간이 보인다.
  window.scrollTo({ top: 0, behavior: 'auto' })

  const loader = ON_ENTER[view]
  if (loader) loader()
}

export function getCurrentView() {
  return currentView
}

// 대기 인원과 전산 주문 건수를 메뉴에 표시한다. 0이면 배지를 숨긴다 — 늘 0이 떠 있으면
// 배지가 배경이 되어버려서, 정작 숫자가 생겼을 때 눈에 안 걸린다.
function setBadge(id, count) {
  const el = document.getElementById(id)
  if (!el) return
  if (!count) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.textContent = String(count)
}

export function updateBadges({ waiting, erpCarts }) {
  if (waiting !== undefined) setBadge('nav-badge-queue', waiting)
  if (erpCarts !== undefined) setBadge('nav-badge-erp', erpCarts)
}

// 새 전산 주문이 들어왔는데 다른 화면을 보고 있으면 배지만으로는 약하다 — 토스트로 한 번
// 알린다. 이미 그 화면을 보고 있으면 카드가 눈앞에 뜨므로 알리지 않는다.
let lastErpIds = new Set()

export function notifyNewErpCarts(carts) {
  const ids = new Set((carts || []).map((c) => c.id))
  const fresh = [...ids].filter((id) => !lastErpIds.has(id))
  lastErpIds = ids

  // 첫 응답에서는 알리지 않는다(탭앱을 켰을 때 기존 주문까지 전부 알림이 뜨면 소음이 된다).
  if (!initialised) {
    initialised = true
    return
  }
  if (!fresh.length || currentView === 'erp') return
  deps.notify('success', `전산 주문이 ${fresh.length}건 들어왔습니다. [전산 주문]에서 확인하세요.`)
}

let initialised = false
