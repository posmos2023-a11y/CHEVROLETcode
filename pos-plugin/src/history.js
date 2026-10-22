// 차량번호(또는 전화번호)로 정비 이력을 보는 화면.
//
// 왜 필요한가: 정비소에서 가장 자주 나오는 질문이 "이 차 지난번에 뭐 갈았지?"다. 지금은 전산을
// 따로 열어야 하는데, 손님이 POS 앞에 서 있는 상황이라 그 사이 손이 비면 안 된다.
//
// 개인정보 관점에서 좁혀둔 것:
//   - 조회는 서버가 매장 토큰으로 자기 매장 것만 돌려준다.
//   - 연락처는 전체 번호(010-1234-5678)로 온다. 직원이 이 화면에서 손님에게 바로 연락할 수 있게 하려는
//     것이다(사장님 결정). 대기실 손님에게 보일 수 있는 정비 대기 화면은 여전히 가린 번호만 쓴다.
//   - 전산 주문에는 전산이 보낸 고객명(예: 김민준님)이 함께 온다.
//   - 보관기간이 지나 파기(익명화)된 건은 차량번호가 덮여 있어 검색되지 않는다.
//     "지운다고 해놓고 조회에는 남아 있는" 상황이 구조적으로 생기지 않는다.
//
// 이 기능을 쓰려면 손님 동의의 이용 목적에 "정비 이력 관리"가 들어 있어야 한다
// (front-plugin의 동의 문구). 목적 밖 이용이 되지 않도록 화면에도 최소한만 띄운다.

let deps = null

const inputEl = () => document.getElementById('history-input')
const bodyEl = () => document.getElementById('history-body')
const promoEl = () => document.getElementById('history-promo')

// 지금 화면에 띄워둔 차량번호. 홍보 발송이 어느 차에 대한 것인지 헷갈리지 않게 들고 있는다.
let shownCarNumber = ''

export function initHistory(injected) {
  // 최근 목록의 줄을 누르면 그 차량번호로 상세 조회한다. 목록은 다시 그려지므로 위임으로 받는다.
  const bodyHost = document.getElementById('history-body')
  if (bodyHost) {
    bodyHost.addEventListener('click', (e) => {
      const tool = e.target.closest('.history-visit-tool')
      if (tool) {
        if (!tool.disabled) handleVisitTool(tool)
        return
      }
      const row = e.target.closest('.history-recent-row')
      if (!row) return
      const car = row.dataset.car
      if (!car) return
      const input = inputEl()
      if (input) input.value = car
      search(car)
    })
  }

  deps = injected
  const form = document.getElementById('history-form')
  if (!form) return

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    search(inputEl().value)
  })

}

// 대기 고객 카드의 [이력] 버튼에서 부른다 — 직원이 차량번호를 다시 칠 이유가 없다.
// 화면 전환은 호출부(app.js)가 이미 했고, 여기서는 조회만 한다.
export function openHistoryFor(carNumber) {
  const input = inputEl()
  if (!input) return
  input.value = carNumber || ''
  if (carNumber) {
    search(carNumber)
    return
  }
  bodyEl().innerHTML = '<div class="empty"><div class="empty-copy">차량번호나 전화번호를 입력하면 지난 정비 내역을 보여드립니다.</div></div>'
  const promo = promoEl()
  if (promo) promo.hidden = true
  input.focus()
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

// 이력 화면에는 두 갈래의 비동기 요청이 들어온다 — 화면에 들어갈 때 뜨는 최근 목록과,
// 차량번호 검색. 둘이 겹치면 늦게 도착한 쪽이 이긴다. 대기 카드의 [이력]을 누르면 화면 전환과
// 검색이 거의 동시에 일어나므로 실제로 겹친다. 순번을 붙여 마지막 요청만 화면에 쓰게 한다.
let renderSeq = 0

function claimRender() {
  renderSeq += 1
  const mine = renderSeq
  return () => mine === renderSeq
}

function ownerLine(info) {
  const parts = [info.contact, info.customerName].filter(Boolean)
  return parts.length ? parts.map((p) => deps.escapeHtml(p)).join(' · ') : ''
}

function renderVisits(carNumber, visits, info = {}) {
  const body = bodyEl()
  if (!body) return
  lastRendered = { carNumber, visits, info }
  const owner = ownerLine(info)
  const head = `
    <div class="history-owner">
      <strong class="history-owner-car">${deps.escapeHtml(carNumber)}</strong>
      ${owner ? `<span class="history-owner-contact">${owner}</span>` : '<span class="history-owner-contact">연락처 기록 없음</span>'}
      ${info.phoneSearch ? `<span class="history-owner-note">${deps.escapeHtml(info.phoneSearch)}(으)로 찾음</span>` : ''}
    </div>
  `

  if (!visits.length) {
    body.innerHTML = head + `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">✓</div>
        <div class="empty-title">${deps.escapeHtml(carNumber)} 방문 이력이 없습니다</div>
        <div class="empty-copy">이 매장에서 처음 방문하는 차량이거나, 보관기간이 지나 파기된 기록입니다.</div>
      </div>
    `
    return
  }

  body.innerHTML = head + visits.map((v) => {
    // 한 방문에 전산 주문이 여러 건일 수 있다(부품을 나눠 담은 경우).
    const orders = v.orders || []
    const total = orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0)
    const itemLines = orders.flatMap((o) => o.items || [])
    const paid = orders.some((o) => o.paid)
    // 지금 연락처·고객명과 다를 때만 그 방문의 값을 따로 보여준다(번호를 바꾼 손님 등).
    const visitContact = v.contact && v.contact !== info.contact ? v.contact : ''
    const visitName = orders.map((o) => o.customerName).find((n) => n && n !== info.customerName) || ''
    const visitOwner = [visitContact, visitName].filter(Boolean).map((p) => deps.escapeHtml(p)).join(' · ')

    return `
      <article class="history-visit">
        <div class="history-visit-top">
          <strong class="history-date">${deps.escapeHtml(v.date || formatDate(v.at))}</strong>
          ${v.status ? `<span class="history-badge">${deps.escapeHtml(STATUS_LABEL[v.status] || v.status)}</span>` : ''}
          ${paid ? '<span class="history-badge paid">결제완료</span>' : ''}
        </div>
        ${v.serviceType ? `<div class="history-service">${deps.escapeHtml(v.serviceType)}</div>` : ''}
        ${visitOwner ? `<div class="history-service">${visitOwner}</div>` : ''}
        ${itemLines.length ? `<ul class="history-items">${itemLines.map((i) => `
          <li>${deps.escapeHtml(i.name)} <span class="history-qty">×${i.quantity}</span></li>
        `).join('')}</ul>` : ''}
        ${total ? `<div class="history-total">${formatWon(total)}</div>` : ''}
        ${visitTools(v)}
      </article>
    `
  }).join('')
}

// ── 방문 카드 도구: 이력에서 숨기기(리허설·테스트 기록 정리), 완료 문자 다시 보내기 ─────────────
// 둘 다 두 번 눌러야 실행된다(숨기면 이 화면에서는 되돌릴 수 없고, 완료 문자는 손님에게 간다).
const toolConfirm = new Map() // key -> timeoutId
const toolBusy = new Set()

function toolButton(key, label, confirmLabel, data) {
  const attrs = Object.entries(data).map(([k, val]) => `data-${k}="${deps.escapeHtml(val)}"`).join(' ')
  return `<button class="history-visit-tool${toolConfirm.has(key) ? ' confirming' : ''}" type="button" data-key="${deps.escapeHtml(key)}" ${attrs}
            ${toolBusy.has(key) ? 'disabled' : ''}>${toolConfirm.has(key) ? confirmLabel : label}</button>`
}

function visitTools(v) {
  const parts = []
  if (v.reservationId && v.status === 'completed') {
    parts.push(toolButton(`done:${v.reservationId}`, '완료 문자 보내기', '손님께 보낼까요?', { tool: 'done', id: v.reservationId }))
  }
  if (v.reservationId) {
    parts.push(toolButton(`hide-res:${v.reservationId}`, '이력에서 숨기기', '정말 숨길까요?', { tool: 'hide-res', id: v.reservationId }))
  } else if (v.orders && v.orders[0]?.id) {
    parts.push(toolButton(`hide-cart:${v.orders[0].id}`, '이력에서 숨기기', '정말 숨길까요?', { tool: 'hide-cart', id: v.orders[0].id }))
  }
  return parts.length ? `<div class="history-visit-tools">${parts.join('')}</div>` : ''
}

let lastRendered = null // { carNumber, visits, info } -- 확인 상태만 바뀔 때 다시 그리는 용도

function rerender() {
  // 그 사이 최근 목록 등 다른 화면으로 바뀌었으면 건드리지 않는다.
  if (!lastRendered || !bodyEl()?.querySelector('.history-owner')) return
  renderVisits(lastRendered.carNumber, lastRendered.visits, lastRendered.info)
}

function handleVisitTool(btn) {
  const { key, tool, id } = btn.dataset
  if (!toolConfirm.has(key)) {
    for (const t of toolConfirm.values()) clearTimeout(t)
    toolConfirm.clear()
    toolConfirm.set(key, setTimeout(() => { toolConfirm.delete(key); rerender() }, 3000))
    rerender()
    return
  }
  clearTimeout(toolConfirm.get(key))
  toolConfirm.delete(key)
  runVisitTool(key, tool, id)
}

async function runVisitTool(key, tool, id) {
  toolBusy.add(key)
  rerender()
  try {
    let res
    if (tool === 'done') {
      res = await deps.apiPost(`/api/pos/queue/${encodeURIComponent(id)}/resend-done`)
    } else {
      res = await deps.apiPost('/api/pos/history/hide', tool === 'hide-res' ? { reservationId: id } : { cartId: id })
    }
    if (!res.ok) {
      if (res.status === 401) return deps.onUnauthorized(res.body.error)
      return deps.notify('error', res.body.error || '처리하지 못했습니다.')
    }
    if (tool === 'done') return deps.notify('success', '손님께 정비 완료 문자를 보냈습니다.')
    deps.notify('success', '정비 이력에서 숨겼습니다.')
    if (shownCarNumber) await search(shownCarNumber)
  } catch {
    deps.notify('error', '서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.')
  } finally {
    toolBusy.delete(key)
    rerender()
  }
}

// 화면에 들어올 때 부른다. 차량번호를 모르는 상태에서도 뭔가 보여야 이력 화면이다.
export async function loadRecentHistory() {
  const isLatest = claimRender()
  const body = bodyEl()
  if (!body) return
  const input = inputEl()
  // 검색어가 남아 있으면 그 차를 계속 보여준다 — 다른 화면 갔다 오면서 목록으로 튕기지 않게.
  if (input && input.value.trim()) {
    search(input.value)
    return
  }
  const promo = promoEl()
  if (promo) promo.hidden = true
  body.innerHTML = '<div class="empty"><div class="empty-copy">불러오는 중...</div></div>'
  try {
    const { ok, status, body: res } = await deps.apiGet('/api/pos/history/recent')
    if (!isLatest()) return
    if (!ok) {
      if (status === 401) {
        deps.onUnauthorized(res.error)
        return
      }
      body.innerHTML = `<div class="empty"><div class="empty-copy">${deps.escapeHtml(res.error || '최근 이력을 불러오지 못했습니다.')}</div></div>`
      return
    }
    renderRecent(res.visits || [])
  } catch {
    if (!isLatest()) return
    body.innerHTML = '<div class="empty"><div class="empty-copy">네트워크 연결을 확인한 뒤 다시 시도해주세요.</div></div>'
  }
}

function renderRecent(visits) {
  const body = bodyEl()
  if (!body) return
  lastRendered = null
  if (!visits.length) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">\u2713</div>
        <div class="empty-title">아직 정비 이력이 없습니다</div>
        <div class="empty-copy">정비가 끝나거나 전산 주문을 담으면 여기에 쌓입니다. 위에 차량번호나 전화번호를 넣어 찾아볼 수도 있습니다.</div>
      </div>
    `
    return
  }
  body.innerHTML = `
    <div class="history-recent-head">최근 ${visits.length}건 · 차량을 누르면 그 차의 전체 이력을 봅니다</div>
    ${visits.map((v) => {
      const names = (v.items || []).map((i) => i.name).join(', ')
      const owner = ownerLine(v)
      return `
        <button class="history-recent-row" type="button" data-car="${deps.escapeHtml(v.carNumber || '')}">
          <span class="history-recent-car">${deps.escapeHtml(v.carNumber || '-')}</span>
          <span class="history-recent-mid">
            <span class="history-recent-desc">${deps.escapeHtml(v.serviceType || names || '정비')}</span>
            <span class="history-recent-date">${deps.escapeHtml(formatDate(v.at))}${owner ? ` · ${owner}` : ''}</span>
          </span>
          <span class="history-recent-right">
            ${v.totalAmount ? `<span class="history-recent-won">${formatWon(v.totalAmount)}</span>` : ''}
            ${v.paid ? '<span class="history-badge paid">결제완료</span>' : ''}
          </span>
        </button>
      `
    }).join('')}
  `
}

// 입력이 숫자(하이픈·공백 허용)로만 된 010 번호면 전화번호로 찾는다.
function asPhone(raw) {
  const digits = String(raw || '').replace(/[s-]/g, '')
  return /^01[0-9]{8,9}$/.test(digits) ? digits : null
}

// 전화번호로 찾았는데 차가 여러 대(또는 0대)일 때. 차를 누르면 그 차의 이력을 본다.
function renderCarChoices(res) {
  const body = bodyEl()
  if (!body) return
  const cars = res.cars || []
  if (!cars.length) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty-title">${deps.escapeHtml(res.phoneSearch || '')} 번호로 방문한 기록이 없습니다</div>
        <div class="empty-copy">번호를 다시 확인하거나 차량번호로 찾아보세요.</div>
      </div>
    `
    return
  }
  body.innerHTML = `
    <div class="history-recent-head">${deps.escapeHtml(res.phoneSearch || '')} 번호로 방문한 차량 ${cars.length}대 · 차량을 누르면 그 차의 이력을 봅니다</div>
    ${cars.map((car) => `
      <button class="history-recent-row" type="button" data-car="${deps.escapeHtml(car)}">
        <span class="history-recent-car">${deps.escapeHtml(car)}</span>
      </button>
    `).join('')}
  `
}

async function search(rawCarNumber) {
  const isLatest = claimRender()
  const carNumber = String(rawCarNumber || '').trim()
  const body = bodyEl()
  if (!carNumber) {
    body.innerHTML = '<div class="empty"><div class="empty-copy">차량번호나 전화번호를 입력해주세요.</div></div>'
    return
  }
  const phone = asPhone(carNumber)

  body.innerHTML = '<div class="empty"><div class="empty-copy">불러오는 중...</div></div>'
  const promo = promoEl()
  if (promo) promo.hidden = true
  try {
    const query = phone ? `phone=${encodeURIComponent(phone)}` : `carNumber=${encodeURIComponent(carNumber)}`
    const { ok, status, body: res } = await deps.apiGet(`/api/pos/history?${query}`)
    if (!ok) {
      if (status === 401) {
        deps.onUnauthorized(res.error)
        return
      }
      body.innerHTML = `<div class="empty"><div class="empty-copy">${deps.escapeHtml(res.error || '이력을 불러오지 못했습니다.')}</div></div>`
      return
    }
    if (!isLatest()) return
    if (!res.carNumber) {
      renderCarChoices(res)
      return
    }
    shownCarNumber = res.carNumber
    renderVisits(res.carNumber, res.visits || [], res)
    refreshPromo(res.carNumber)
  } catch {
    body.innerHTML = '<div class="empty"><div class="empty-copy">네트워크 연결을 확인한 뒤 다시 시도해주세요.</div></div>'
  }
}

// ── 홍보 메시지 수동 발송 ────────────────────────────────────────────────────
// 광고성 정보 전송은 정보통신망법 제50조의 규제를 받는다. 보낼 수 있는지는 **서버가** 판단하고
// (동의 여부 / 야간 / 30일 내 재발송), 여기서는 그 결과를 보여주고 버튼을 켜고 끄는 것만 한다.
// 화면에서 막는 건 안내일 뿐 방어가 아니다 — 발송 라우트가 같은 조건을 다시 확인한다.
async function refreshPromo(carNumber) {
  const promo = promoEl()
  if (!promo) return
  promo.hidden = false
  promo.innerHTML = '<div class="history-promo-note">확인 중...</div>'

  try {
    const { ok, body } = await deps.apiGet(`/api/pos/promo/eligibility?carNumber=${encodeURIComponent(carNumber)}`)
    if (!ok) {
      promo.hidden = true
      return
    }
    if (body.canSend) {
      promo.innerHTML = `
        <button class="history-promo-button" type="button" id="history-promo-send">홍보 메시지 보내기</button>
        <div class="history-promo-note">광고 수신에 동의한 손님입니다. 한 번 보내면 30일간 다시 보낼 수 없습니다.</div>
      `
      const btn = document.getElementById('history-promo-send')
      btn.addEventListener('click', () => sendPromo(carNumber, btn))
      return
    }
    // 못 보내는 이유를 그대로 보여준다. "왜 버튼이 없지?"를 묻게 두면 안 된다.
    promo.innerHTML = `<div class="history-promo-note blocked">${deps.escapeHtml(body.message || '지금은 보낼 수 없습니다.')}</div>`
  } catch {
    promo.hidden = true
  }
}

async function sendPromo(carNumber, btn) {
  // 되돌릴 수 없다(보낸 문자는 회수가 안 된다). 대기열의 호출·취소와 같은 방식으로 한 번 더 묻는다.
  if (btn.dataset.confirming !== 'true') {
    btn.dataset.confirming = 'true'
    btn.textContent = '정말 보낼까요?'
    btn.classList.add('confirming')
    setTimeout(() => {
      if (btn.dataset.confirming !== 'true') return
      btn.dataset.confirming = 'false'
      btn.textContent = '홍보 메시지 보내기'
      btn.classList.remove('confirming')
    }, 3000)
    return
  }

  btn.dataset.confirming = 'false'
  btn.disabled = true
  btn.textContent = '보내는 중...'
  try {
    const { ok, body } = await deps.apiPost('/api/pos/promo/send', { carNumber })
    if (!ok) {
      deps.notify('error', body.error || '보내지 못했습니다.')
      refreshPromo(carNumber)
      return
    }
    deps.notify('success', `${carNumber} 손님에게 홍보 메시지를 보냈습니다.`)
    refreshPromo(carNumber)
  } catch {
    deps.notify('error', '네트워크 연결을 확인한 뒤 다시 시도해주세요.')
    refreshPromo(carNumber)
  }
}
