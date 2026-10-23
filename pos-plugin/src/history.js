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

// 홍보 문자 발송이 발송사 계정 문제로 실패했을 때의 안내는 기간 발송 화면과 같은 문구를 쓴다.
import { PROVIDER_STOP_MESSAGE } from './promoCampaign.js'

let deps = null

const inputEl = () => document.getElementById('history-input')
const bodyEl = () => document.getElementById('history-body')
const promoEl = () => document.getElementById('history-promo')

// 지금 화면에 띄워둔 차량번호. 홍보 발송이 어느 차에 대한 것인지 헷갈리지 않게 들고 있는다.
let shownCarNumber = ''

// 홍보 확인(refreshPromo) 응답의 순번. 차를 바꿔 조회했는데 이전 차의 확인 응답이 늦게 도착하면, 지금 차 화면에
// 이전 차의 [홍보 문자 보내기] 버튼이 뜬다 -- 직원이 그대로 누르면 엉뚱한 손님에게 광고가 나간다(되돌릴 수 없다).
// 새 조회·목록 전환·새 확인이 시작될 때마다 올려서 그 전에 날아간 응답을 모두 무효로 만든다.
let promoSeq = 0

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

  // 검색어를 다 지우면 바로 전체 최근 목록으로 돌아간다(직원이 [조회]를 다시 누르지 않아도 되게).
  inputEl()?.addEventListener('input', () => {
    if (!inputEl().value.trim()) showRecentList()
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
  bodyEl().innerHTML = '<div class="empty"><div class="empty-copy">차량번호(뒷번호 4자리도 돼요)나 전화번호를 입력하면 지난 정비 내역을 보여드려요.</div></div>'
  promoSeq += 1
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

// 정비 대기 카드(queueCard.js STATUS_LABEL)와 같은 이름을 쓴다. 따로 바꾸면 대기 화면과 이력 화면의 표기가 어긋난다.
const STATUS_LABEL = {
  waiting: '대기 중', called: '호출됨', notify_failed: '알림 실패',
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

// 손님이 접수 때 적은 차종(선택). 서버가 접수에 이어진 방문에만 carModel을 준다(없으면 null, 옛 서버는 필드 없음).
function carModelOf(v) {
  return v && typeof v.carModel === 'string' ? v.carModel.trim() : ''
}

// 차종을 차량번호 옆에 붙이는 작은 보조 글씨. 값이 없으면 아무것도 그리지 않는다.
function carModelTag(model) {
  return model ? `<span class="history-car-model">${deps.escapeHtml(model)}</span>` : ''
}

function renderVisits(carNumber, visits, info = {}) {
  const body = bodyEl()
  if (!body) return
  lastRendered = { carNumber, visits, info }
  const owner = ownerLine(info)
  // 머리줄에는 가장 최근 방문의 차종을 쓴다(visits는 최근 것부터 온다). 방문 카드에는 그와 다를 때만 따로 보여 준다(연락처와 같은 방식).
  const latestModel = carModelOf(visits.find((v) => carModelOf(v)))
  const head = `
    <div class="history-owner">
      <strong class="history-owner-car">${deps.escapeHtml(carNumber)}</strong>
      ${carModelTag(latestModel)}
      ${owner ? `<span class="history-owner-contact">${owner}</span>` : '<span class="history-owner-contact">연락처 기록 없음</span>'}
      ${info.phoneSearch ? `<span class="history-owner-note">${deps.escapeHtml(info.phoneSearch)} 번호로 찾음</span>` : ''}
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
    const visitModel = carModelOf(v) && carModelOf(v) !== latestModel ? carModelOf(v) : ''

    return `
      <article class="history-visit">
        <div class="history-visit-top">
          <strong class="history-date">${deps.escapeHtml(v.date || formatDate(v.at))}</strong>
          ${carModelTag(visitModel)}
          ${v.status ? `<span class="history-badge">${deps.escapeHtml(STATUS_LABEL[v.status] || '기타')}</span>` : ''}
          ${paid ? '<span class="history-badge paid">결제 완료</span>' : ''}
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

// ── 방문 카드 도구: 삭제(리허설·테스트 기록 정리), 완료 알림 다시 보내기 ─────────────────────────
// 둘 다 두 번 눌러야 실행된다. [삭제]는 그 방문과 거기 이어진 결제 기록을 함께 지운다(최근 결제·오늘 현황에서도
// 빠진다. 서버는 행을 지우지 않고 삭제 표시만 남긴다). 완료 알림은 손님에게 간다(알림톡 템플릿이 없으면 문자로 나간다).
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
    parts.push(toolButton(`done:${v.reservationId}`, '완료 알림 다시 보내기', '손님께 다시 보낼까요?', { tool: 'done', id: v.reservationId }))
  }
  const hasPayment = (v.orders || []).some((o) => o.paid)
  const confirmLabel = hasPayment ? '결제 기록도 함께 삭제할까요?' : '정말 삭제할까요?'
  if (v.reservationId) {
    parts.push(toolButton(`del-res:${v.reservationId}`, '삭제', confirmLabel, { tool: 'del-res', id: v.reservationId }))
  } else if (v.orders && v.orders[0]?.id) {
    parts.push(toolButton(`del-cart:${v.orders[0].id}`, '삭제', confirmLabel, { tool: 'del-cart', id: v.orders[0].id }))
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
      res = await deps.apiPost('/api/pos/history/delete', tool === 'del-res' ? { reservationId: id } : { cartId: id })
    }
    if (!res.ok) {
      if (res.status === 401) return deps.onUnauthorized(res.body.error)
      // 409: 결제 전(POS에 담김)이거나 취소가 진행 중인 주문이 이어진 방문이라 지울 수 없다. 서버가 어느 쪽인지
      // 문구로 알려 주므로 그대로 보여준다 -- 일반 오류 문구로 바꾸면 직원이 왜 안 지워지는지 알 수 없다.
      if (res.status === 409 && tool !== 'done') {
        return deps.notify('error', res.body.error || '결제 전이거나 취소가 진행 중인 주문이 이어진 방문은 삭제할 수 없습니다.')
      }
      return deps.notify('error', res.body.error || '처리하지 못했습니다.')
    }
    if (tool === 'done') return deps.notify('success', '손님께 정비완료 알림을 다시 보냈어요.')
    deps.notify('success', '정비 이력에서 삭제했습니다.')
    if (shownCarNumber) await search(shownCarNumber)
  } catch {
    deps.notify('error', '서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.')
  } finally {
    toolBusy.delete(key)
    rerender()
  }
}

// 검색을 풀고 최근 목록으로 돌아간다. 차량 화면에 띄워 둔 홍보 발송 칸도 함께 닫는다.
function showRecentList() {
  shownCarNumber = ''
  promoSeq += 1
  const promo = promoEl()
  if (promo) promo.hidden = true
  loadRecentHistory()
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
  promoSeq += 1
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
          <span class="history-recent-car">${deps.escapeHtml(v.carNumber || '-')}${carModelTag(carModelOf(v))}</span>
          <span class="history-recent-mid">
            <span class="history-recent-desc">${deps.escapeHtml(v.serviceType || names || '정비')}</span>
            <span class="history-recent-date">${deps.escapeHtml(formatDate(v.at))}${owner ? ` · ${owner}` : ''}</span>
          </span>
          <span class="history-recent-right">
            ${v.totalAmount ? `<span class="history-recent-won">${formatWon(v.totalAmount)}</span>` : ''}
            ${v.paid ? '<span class="history-badge paid">결제 완료</span>' : ''}
          </span>
        </button>
      `
    }).join('')}
  `
}

// 입력이 숫자(하이픈·공백 허용)로만 된 010 번호면 전화번호로 찾는다.
function asPhone(raw) {
  const digits = String(raw || '').replace(/[\s-]/g, '')
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

// 뒷번호 4자리(예: 3456)만 넣었는지. 정비소에서는 "뒷번호 3456"으로 차를 찾는 일이 흔하다.
function asCarTail(raw) {
  const v = String(raw || '').replace(/\s/g, '')
  return /^\d{4}$/.test(v) ? v : null
}

// 뒷번호로 찾기. 서버 이력 조회는 차량번호가 정확히 같아야만 찾으므로, 서버를 바꾸지 않고 탭앱이 이미 받을 수 있는 범위
// (최근 이력 20건 + 오늘 대기열)에서 그 뒷번호로 끝나는 차를 고른다. 한 대면 바로 그 차의 이력을, 여러 대면 고르는 목록을
// 보여 준다. 범위 밖의 차는 찾지 못하므로 그때는 차량번호 전체를 넣어 달라고 알린다.
async function searchByTail(tail, isLatest) {
  const body = bodyEl()
  let recent = []
  let recentFailed = false
  try {
    const { ok, status, body: res } = await deps.apiGet('/api/pos/history/recent')
    if (!ok && status === 401) {
      deps.onUnauthorized(res.error)
      return
    }
    if (ok) recent = res.visits || []
    else recentFailed = true
  } catch {
    recentFailed = true
  }
  if (!isLatest()) return
  let queueCars = []
  try {
    queueCars = typeof deps.queueCarNumbers === 'function' ? deps.queueCarNumbers() || [] : []
  } catch {
    queueCars = []
  }
  const cars = [...new Set([...queueCars, ...recent.map((v) => v.carNumber)]
    .filter((c) => typeof c === 'string' && c.trim().endsWith(tail))
    .map((c) => c.trim()))]
  if (cars.length === 1) {
    const input = inputEl()
    if (input) input.value = cars[0]
    search(cars[0])
    return
  }
  if (!cars.length) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty-title">뒷번호 ${deps.escapeHtml(tail)}인 차를 찾지 못했어요</div>
        <div class="empty-copy">${recentFailed ? '최근 이력을 불러오지 못해 오늘 대기열에서만 찾았어요. ' : '최근 이력 20건과 오늘 대기열에서 찾았어요. '}차량번호 전체(예: 12가${deps.escapeHtml(tail)})나 전화번호로 찾아주세요.</div>
      </div>
    `
    return
  }
  body.innerHTML = `
    <div class="history-recent-head">뒷번호 ${deps.escapeHtml(tail)}인 차량 ${cars.length}대 · 차량을 누르면 그 차의 이력을 봐요</div>
    ${cars.map((car) => `
      <button class="history-recent-row" type="button" data-car="${deps.escapeHtml(car)}">
        <span class="history-recent-car">${deps.escapeHtml(car)}</span>
      </button>
    `).join('')}
  `
}

async function search(rawCarNumber) {
  const isLatest = claimRender()
  promoSeq += 1
  const carNumber = String(rawCarNumber || '').trim()
  const body = bodyEl()
  if (!carNumber) {
    // 빈 검색은 "전체 보기"로 본다.
    showRecentList()
    return
  }
  const phone = asPhone(carNumber)

  body.innerHTML = '<div class="empty"><div class="empty-copy">불러오는 중...</div></div>'
  const promo = promoEl()
  if (promo) promo.hidden = true
  const tail = phone ? null : asCarTail(carNumber)
  if (tail) {
    shownCarNumber = ''
    await searchByTail(tail, isLatest)
    return
  }
  try {
    const query = phone ? `phone=${encodeURIComponent(phone)}` : `carNumber=${encodeURIComponent(carNumber)}`
    const { ok, status, body: res } = await deps.apiGet(`/api/pos/history?${query}`)
    // 로그인 만료는 어느 요청이든 알려야 하므로 최신 여부보다 먼저 본다.
    if (!ok && status === 401) {
      deps.onUnauthorized(res.error)
      return
    }
    // 오류 응답도 최신 요청일 때만 화면에 쓴다. 성공 응답만 확인하던 때는, 먼저 보낸 검색이 늦게 실패하면 그 사이에
    // 띄운 다른 차의 이력 위에 "이력을 불러오지 못했습니다"가 덮였다.
    if (!isLatest()) return
    if (!ok) {
      body.innerHTML = `<div class="empty"><div class="empty-copy">${deps.escapeHtml(res.error || '이력을 불러오지 못했습니다.')}</div></div>`
      return
    }
    if (!res.carNumber) {
      renderCarChoices(res)
      return
    }
    shownCarNumber = res.carNumber
    renderVisits(res.carNumber, res.visits || [], res)
    refreshPromo(res.carNumber)
  } catch {
    if (!isLatest()) return
    body.innerHTML = '<div class="empty"><div class="empty-copy">네트워크 연결을 확인한 뒤 다시 시도해주세요.</div></div>'
  }
}

// ── 홍보 문자 수동 발송 ──────────────────────────────────────────────────────
// 광고성 정보 전송은 정보통신망법 제50조의 규제를 받는다. 보낼 수 있는지는 **서버가** 판단하고
// (동의 여부 / 야간 / 30일 내 재발송), 여기서는 그 결과를 보여주고 버튼을 켜고 끄는 것만 한다.
// 화면에서 막는 건 안내일 뿐 방어가 아니다 — 발송 라우트가 같은 조건을 다시 확인한다.
async function refreshPromo(carNumber) {
  const promo = promoEl()
  if (!promo) return
  // 이미 다른 차로 넘어간 뒤에 부른 것(발송 응답이 늦게 와서 부른 갱신 등)이면 지금 차의 홍보 칸을 건드리지 않는다.
  if (carNumber !== shownCarNumber) return
  promoSeq += 1
  const seq = promoSeq
  promo.hidden = false
  promo.innerHTML = '<div class="history-promo-note">확인 중...</div>'

  try {
    const { ok, body } = await deps.apiGet(`/api/pos/promo/eligibility?carNumber=${encodeURIComponent(carNumber)}`)
    // 그 사이 다른 차를 조회했거나 목록으로 나갔으면 이 응답은 버린다(promoSeq 설명 참고).
    if (seq !== promoSeq || carNumber !== shownCarNumber) return
    if (!ok) {
      promo.hidden = true
      return
    }
    if (body.canSend) {
      promo.innerHTML = `
        <button class="history-promo-button" type="button" id="history-promo-send">홍보 문자 보내기</button>
        <div class="history-promo-note">광고 수신에 동의한 손님입니다. 한 번 보내면 30일간 다시 보낼 수 없습니다.</div>
      `
      const btn = document.getElementById('history-promo-send')
      btn.addEventListener('click', () => sendPromo(carNumber, btn))
      return
    }
    // 못 보내는 이유를 그대로 보여준다. "왜 버튼이 없지?"를 묻게 두면 안 된다.
    promo.innerHTML = `<div class="history-promo-note blocked">${deps.escapeHtml(body.message || '지금은 보낼 수 없습니다.')}</div>`
  } catch {
    if (seq !== promoSeq || carNumber !== shownCarNumber) return
    promo.hidden = true
  }
}

async function sendPromo(carNumber, btn) {
  // 화면의 차가 이 버튼을 만든 차와 다르면 보내지 않는다. 확인 응답이 늦게 와서 남은 옛 버튼이나 발송 도중 차가
  // 바뀐 경우에도 문자는 지금 화면에 보이는 손님 기준이어야 한다(보낸 문자는 회수가 안 된다).
  if (carNumber !== shownCarNumber) {
    deps.notify('error', '화면의 차량이 바뀌었습니다. 다시 조회한 뒤 보내주세요.')
    return
  }
  // 되돌릴 수 없다(보낸 문자는 회수가 안 된다). 대기열의 호출·취소와 같은 방식으로 한 번 더 묻는다.
  if (btn.dataset.confirming !== 'true') {
    btn.dataset.confirming = 'true'
    btn.textContent = '정말 보낼까요?'
    btn.classList.add('confirming')
    setTimeout(() => {
      if (btn.dataset.confirming !== 'true') return
      btn.dataset.confirming = 'false'
      btn.textContent = '홍보 문자 보내기'
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
      // 발송사 계정 문제(잔액·발신번호·템플릿)는 잠시 뒤 다시 보내도 같은 실패다 -- 본사 확인이 필요하다고 분명히 알린다.
      deps.notify('error', body && body.reason === 'send_failed_provider' ? PROVIDER_STOP_MESSAGE : (body.error || '보내지 못했습니다.'))
      refreshPromo(carNumber)
      return
    }
    deps.notify('success', `${carNumber} 손님에게 홍보 문자를 보냈어요.`)
    refreshPromo(carNumber)
  } catch {
    deps.notify('error', '네트워크 연결을 확인한 뒤 다시 시도해주세요.')
    refreshPromo(carNumber)
  }
}
