// 차량번호로 정비 이력을 보는 화면.
//
// 왜 필요한가: 정비소에서 가장 자주 나오는 질문이 "이 차 지난번에 뭐 갈았지?"다. 지금은 전산을
// 따로 열어야 하는데, 손님이 POS 앞에 서 있는 상황이라 그 사이 손이 비면 안 된다.
//
// 개인정보 관점에서 좁혀둔 것:
//   - 조회는 서버가 매장 토큰으로 자기 매장 것만 돌려준다.
//   - 전화번호는 응답에 아예 없다. 이력 확인에 필요 없다.
//   - 보관기간이 지나 파기(익명화)된 건은 차량번호가 덮여 있어 검색되지 않는다.
//     "지운다고 해놓고 조회에는 남아 있는" 상황이 구조적으로 생기지 않는다.
//
// 이 기능을 쓰려면 손님 동의의 이용 목적에 "정비 이력 관리"가 들어 있어야 한다
// (front-plugin의 동의 문구). 목적 밖 이용이 되지 않도록 화면에도 최소한만 띄운다.

let deps = null

const panelEl = () => document.getElementById('history-panel')
const inputEl = () => document.getElementById('history-input')
const bodyEl = () => document.getElementById('history-body')

export function initHistory(injected) {
  deps = injected
  const form = document.getElementById('history-form')
  if (!form) return

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    search(inputEl().value)
  })

  const closeBtn = document.getElementById('history-close')
  if (closeBtn) closeBtn.addEventListener('click', close)
}

// 대기 고객 카드의 [이력] 버튼에서 부른다 — 직원이 차량번호를 다시 칠 이유가 없다.
export function openHistoryFor(carNumber) {
  const panel = panelEl()
  if (!panel) return
  panel.hidden = false
  inputEl().value = carNumber || ''
  if (carNumber) search(carNumber)
  else inputEl().focus()
}

function close() {
  const panel = panelEl()
  if (panel) panel.hidden = true
}

function formatWon(v) {
  return `${Number(v || 0).toLocaleString('ko-KR')}원`
}

function formatDate(value) {
  if (!value) return ''
  const d = new Date(value)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

const STATUS_LABEL = {
  waiting: '대기중', called: '호출완료', notify_failed: '알림실패',
  completed: '정비완료', cancelled: '취소됨',
}

function renderVisits(carNumber, visits) {
  const body = bodyEl()
  if (!body) return

  if (!visits.length) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">✓</div>
        <div class="empty-title">${deps.escapeHtml(carNumber)} 방문 이력이 없습니다</div>
        <div class="empty-copy">이 매장에서 처음 방문하는 차량이거나, 보관기간이 지나 파기된 기록입니다.</div>
      </div>
    `
    return
  }

  body.innerHTML = visits.map((v) => {
    // 한 방문에 전산 주문이 여러 건일 수 있다(부품을 나눠 담은 경우).
    const orders = v.orders || []
    const total = orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0)
    const itemLines = orders.flatMap((o) => o.items || [])
    const paid = orders.some((o) => o.paid)

    return `
      <article class="history-visit">
        <div class="history-visit-top">
          <strong class="history-date">${deps.escapeHtml(v.date || formatDate(v.at))}</strong>
          ${v.status ? `<span class="history-badge">${deps.escapeHtml(STATUS_LABEL[v.status] || v.status)}</span>` : ''}
          ${paid ? '<span class="history-badge paid">결제완료</span>' : ''}
        </div>
        ${v.serviceType ? `<div class="history-service">${deps.escapeHtml(v.serviceType)}</div>` : ''}
        ${itemLines.length ? `<ul class="history-items">${itemLines.map((i) => `
          <li>${deps.escapeHtml(i.name)} <span class="history-qty">×${i.quantity}</span></li>
        `).join('')}</ul>` : ''}
        ${total ? `<div class="history-total">${formatWon(total)}</div>` : ''}
      </article>
    `
  }).join('')
}

async function search(rawCarNumber) {
  const carNumber = String(rawCarNumber || '').trim()
  const body = bodyEl()
  if (!carNumber) {
    body.innerHTML = '<div class="empty"><div class="empty-copy">차량번호를 입력해주세요.</div></div>'
    return
  }

  body.innerHTML = '<div class="empty"><div class="empty-copy">불러오는 중...</div></div>'
  try {
    const { ok, status, body: res } = await deps.apiGet(`/api/pos/history?carNumber=${encodeURIComponent(carNumber)}`)
    if (!ok) {
      if (status === 401) {
        deps.onUnauthorized(res.error)
        return
      }
      body.innerHTML = `<div class="empty"><div class="empty-copy">${deps.escapeHtml(res.error || '이력을 불러오지 못했습니다.')}</div></div>`
      return
    }
    renderVisits(carNumber, res.visits || [])
  } catch {
    body.innerHTML = '<div class="empty"><div class="empty-copy">네트워크 연결을 확인한 뒤 다시 시도해주세요.</div></div>'
  }
}
