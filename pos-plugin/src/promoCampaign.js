// [홍보 문자] 화면: 기간을 정해 그 기간에 방문한 손님에게 홍보 문자를 한 번에 보낸다.
//
// 규칙은 전부 서버가 정한다(관리자 웹과 같은 로직): 가장 최근 방문에서 광고 수신에 동의한 번호만,
// 같은 번호는 한 번만, 수신거부·동의 2년 경과·최근 30일 안에 받은 번호 제외, 야간(21~8시) 금지.
// 이 화면은 들어오자마자(기간을 바꿀 때마다) 그 기간에 방문한 손님 전체 목록을 상태와 함께 보여주고,
// 보낼 수 있는 수를 [N명에게 보내기]로 두 번 눌러 확정해야 보낸다. 예전에는 [대상 확인]을 눌러야 숫자와
// 샘플 몇 명만 보여서, 직원이 "누가 왜 빠졌는지"를 볼 수 없었다.
// 아래쪽 [수신거부 등록]은 손님이 거부를 알려왔을 때 번호를 등록한다.
//
// 확인을 window.confirm 대신 두 번 누르기로 하는 이유: POS 탭 화면(iframe)에서는 브라우저 확인창이
// 막히거나 POS 화면을 멈출 수 있다. 대기열의 호출·완료와 같은 방식이라 직원에게도 익숙하다.

let deps = null
// 발송 기준. eligible은 지금 보고 있는 필터와 상관없이 "보낼 수 있음" 전체 수다(필터가 '제외'여도
// 발송 확인 인원은 그대로여야 서버의 confirmCount 검사와 맞는다).
let previewState = null // { from, to, eligible }
let listState = null // { from, to, filter, rows, hasMore, rowsTotal, counts, body } -- 화면에 그려진 목록
let activeFilter = 'all' // 'all' | 'eligible' | 'excluded'. 기간을 바꿔도 직원이 고른 탭은 유지한다.
let listSeq = 0 // 불러오기 요청 번호. 늦게 도착한 옛 응답이 새 기간/탭 위에 그려지지 않게 한다.
let dateTimer = null
let confirmTimer = null
let sending = false
let optOutConfirmTimer = null
// 목록 행 [삭제] 두 번 누르기. phone -> timeoutId
const rowDeleteConfirm = new Map()
const rowDeleting = new Set()

// 이어 보내기 상한. 탭앱은 한 번에 60건씩이라 넉넉히 둔다(남으면 화면에 남은 수를 알린다).
const MAX_ROUNDS = 100
const PAGE_SIZE = 100
const DATE_DEBOUNCE_MS = 300
const FILTERS = [
  ['all', '전체'],
  ['eligible', '보낼 수 있음'],
  ['excluded', '제외'],
]
const EMPTY_TEXT = {
  all: '이 기간에 방문한 손님이 없습니다.',
  eligible: '보낼 수 있는 손님이 없습니다.',
  excluded: '제외된 손님이 없습니다.',
}
const STATUS_LABEL = {
  ok: '보낼 수 있음',
  no_consent: '광고 미동의',
  opted_out: '수신거부',
  consent_expired: '동의 2년 경과',
}

const el = (id) => document.getElementById(id)

function kstDate(offsetDays) {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function setMessage(text, kind) {
  const msg = el('promo-campaign-msg')
  if (!msg) return
  msg.textContent = text || ''
  msg.className = 'promo-campaign-msg' + (kind ? ` ${kind}` : '')
}

function setOptOutMessage(text, kind) {
  const msg = el('promo-optout-msg')
  if (!msg) return
  msg.textContent = text || ''
  msg.className = 'promo-campaign-msg' + (kind ? ` ${kind}` : '')
}

function formatVisit(value) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' }).format(new Date(value))
}

function formatMonthDay(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Seoul' }).formatToParts(d)
  const month = parts.find((p) => p.type === 'month')
  const day = parts.find((p) => p.type === 'day')
  return month && day ? `${month.value}/${day.value}` : ''
}

function clearConfirm() {
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = null
}

// 목록을 비우는 건 "지금 화면의 기간과 목록이 맞지 않을 때"(날짜가 비었거나 불러오기 실패)뿐이다.
// 예전 resetPreview는 시연 모드·수신거부 뒤에도 불렀는데, 이제는 그때 목록을 지우지 않고 다시
// 불러와서 바꾼다 -- 지우면 응답이 올 때까지 빈 화면이 된다. 비울 때 previewState도 같이 지워
// 옛 인원수가 붙은 [보내기] 버튼이 남지 않게 한다.
function clearList() {
  listSeq += 1
  previewState = null
  listState = null
  clearConfirm()
  const result = el('promo-campaign-result')
  if (result) {
    result.innerHTML = ''
    result.classList.remove('is-loading')
  }
}

// 불러오는 동안 옛 목록은 흐리게 두고 누를 수 없게 한다: 기간을 바꾼 직후 옛 기간의 [보내기]를 누르는 일을 막는다.
function setLoading(on) {
  el('promo-campaign-result')?.classList.toggle('is-loading', on)
}

// 보내는 동안에는 기간·새로고침·탭·더 보기를 잠근다(같은 매장에 발송이 겹치거나 화면이 바뀌지 않게).
function lockForm(locked) {
  for (const id of ['promo-campaign-from', 'promo-campaign-to', 'promo-campaign-preview']) {
    const node = el(id)
    if (node) node.disabled = locked
  }
  document.querySelectorAll('#promo-campaign-result .promo-campaign-tab, #promo-campaign-result .promo-campaign-more')
    .forEach((node) => { node.disabled = locked })
}

// 기간 입력의 기본값(최근 30일 ~ 오늘)을 마지막으로 코드가 넣은 값. 탭앱은 POS에 며칠씩 켜 둔 채 쓰므로 앱을 처음 연
// 날로 고정해 두면 며칠 뒤에는 "오늘"이 기간 밖이라 오늘 방문한 손님이 목록에 안 나온다. 화면에 들어올 때마다
// 입력값이 이 값과 같으면(직원이 손대지 않았으면) 오늘 기준으로 다시 계산한다. 직원이 고른 기간은 건드리지 않는다.
let autoFrom = ''
let autoTo = ''

function applyDefaultDates() {
  const from = el('promo-campaign-from')
  const to = el('promo-campaign-to')
  if (!from || !to) return
  const today = kstDate(0)
  from.max = to.max = today
  // 발송 중에는 입력이 잠겨 있고 발송이 끝나면 그 기간으로 다시 불러온다 -- 값을 바꾸지 않는다.
  if (sending) return
  if (from.value === autoFrom) {
    autoFrom = kstDate(-30)
    from.value = autoFrom
  }
  if (to.value === autoTo) {
    autoTo = today
    to.value = autoTo
  }
}

export function initPromoCampaign(injected) {
  deps = injected
  const from = el('promo-campaign-from')
  const to = el('promo-campaign-to')
  const form = el('promo-campaign-form')
  if (!from || !to || !form) return

  autoFrom = kstDate(-30)
  autoTo = kstDate(0)
  from.value = autoFrom
  to.value = autoTo
  from.max = to.max = autoTo

  // 폼 submit(버튼 라벨은 '새로고침')은 같은 기간을 처음부터 다시 불러온다.
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (sending) return
    if (dateTimer) clearTimeout(dateTimer)
    dateTimer = null
    startLoad()
  })
  for (const input of [from, to]) {
    input.addEventListener('change', () => {
      if (sending) return
      scheduleReload()
    })
  }

  el('promo-campaign-result')?.addEventListener('click', (e) => {
    const send = e.target.closest('#promo-campaign-send')
    if (send) {
      if (!send.disabled) handleSendClick(send)
      return
    }
    if (sending) return
    const tab = e.target.closest('[data-promo-filter]')
    if (tab) {
      handleFilterClick(tab.dataset.promoFilter)
      return
    }
    if (e.target.closest('#promo-campaign-more')) {
      startLoad({ append: true })
      return
    }
    const del = e.target.closest('[data-promo-delete]')
    if (del && !del.disabled) handleRowDelete(del.dataset.promoDelete)
  })

  el('promo-optout-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    handleOptOutSubmit().catch((err) => setOptOutMessage(err?.message || String(err), 'error'))
  })

  el('promo-demo-toggle')?.addEventListener('click', () => {
    handleDemoToggle().catch((err) => deps.notify('error', err?.message || String(err)))
  })
}

// --- 시연 모드 ---------------------------------------------------------------------
// 켜면 그날 자정까지 이 매장의 "같은 번호 30일 내 재발송 금지"가 꺼진다(서버가 자정에 저절로 끈다). 단, 풀리는 건
// 정비 이력 화면의 차량별 홍보 발송뿐이다 -- 이 화면의 기간 발송과 자동 발송은 시연 모드여도 30일 제한을 그대로 건다.
// 수신 동의·수신거부·야간 금지는 그대로다. 시연이 끝나 실매장에서는 탭앱으로 켜지 않는다 -- 같은 손님에게
// 광고 문자가 반복해서 나갈 수 있다. 본사가 관리자 웹에서 켠 경우에만 카드가 보이고, 여기서는 끄기만 된다.
let demoMode = false

function formatTime(value) {
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function renderDemo(body) {
  demoMode = Boolean(body.demoMode)
  const card = el('promo-demo-card')
  const status = el('promo-demo-status')
  const btn = el('promo-demo-toggle')
  if (!card || !status || !btn) return
  card.hidden = !demoMode
  card.classList.toggle('is-on', demoMode)
  status.textContent = demoMode
    ? `켜짐 — 정비 이력의 차량별 홍보 발송만 30일 제한 없이 보낼 수 있습니다. 기간 발송은 30일 제한 그대로입니다. ${formatTime(body.demoUntil)}에 저절로 꺼집니다.`
    : '꺼짐 — 같은 번호에는 30일에 한 번만 보냅니다. 시연할 때만 켜세요(오늘 밤 12시에 저절로 꺼짐).'
  btn.textContent = demoMode ? '끄기' : '켜기'
  btn.classList.remove('confirming')
  btn.disabled = false
}

// [홍보 문자] 화면을 열 때 부른다(nav.registerViewLoader).
export async function loadPromoDemo() {
  if (!deps) return
  const { ok, status, body } = await deps.apiGet('/api/pos/promo/demo-mode')
  if (!ok) {
    if (status === 401) deps.onUnauthorized(body.error)
    return
  }
  renderDemo(body)
}

// [홍보 문자] 화면을 열 때 부른다(nav.registerViewLoader). 시연 모드 상태와 방문 손님 목록을 함께 불러온다.
// 발송 중에 다시 들어오면 목록은 건드리지 않는다(발송이 끝나면 스스로 다시 불러온다).
export async function loadPromoView() {
  if (!deps) return
  applyDefaultDates()
  const demo = loadPromoDemo()
  const list = sending ? Promise.resolve() : startLoad()
  await Promise.all([demo, list])
}

async function handleDemoToggle() {
  const btn = el('promo-demo-toggle')
  // 탭앱에서는 끄기만 한다(위 주석).
  if (!btn || btn.disabled || !demoMode) return
  const enabling = false
  btn.disabled = true
  let res
  try {
    res = await deps.apiPost('/api/pos/promo/demo-mode', { enabled: enabling })
  } catch {
    res = { ok: false, status: 0, body: { error: '서버에 연결하지 못했습니다.' } }
  }
  if (!res.ok) {
    if (res.status === 401) {
      deps.onUnauthorized(res.body.error)
      return
    }
    btn.disabled = false
    btn.classList.remove('confirming')
    btn.textContent = demoMode ? '끄기' : '켜기'
    deps.notify('error', res.body.error || '시연 모드를 바꾸지 못했습니다.')
    return
  }
  renderDemo(res.body)
  deps.notify('success', res.body.demoMode ? '시연 모드를 켰습니다. 오늘 밤 12시에 저절로 꺼집니다.' : '시연 모드를 껐습니다.')
  // 대상 수가 바뀌므로(30일 제외가 풀리거나 다시 걸림) 목록을 다시 불러온다.
  if (listState && !sending) startLoad()
}

function excludedText(ex, days) {
  return [
    ex.optedOut ? `수신거부 ${ex.optedOut}` : '',
    `광고 미동의 ${ex.noConsent}`,
    ex.consentExpired ? `동의 2년 경과 ${ex.consentExpired}` : '',
    days > 0 ? `최근 ${days}일 내 받은 번호 ${ex.recentlySent}` : '',
  ].filter(Boolean).join(' · ') + ' 제외' + (days > 0 ? '' : ' (시연 모드: 30일 제한 꺼짐)')
}

// 날짜 입력은 달력에서 연속으로 바뀌기도 하므로 300ms 모아서 한 번만 부른다.
// 바꾸는 순간 옛 응답은 무효로 하고(listSeq) 옛 목록은 눌리지 않게 흐리게 둔다.
function scheduleReload() {
  if (dateTimer) clearTimeout(dateTimer)
  dateTimer = null
  listSeq += 1
  if (!el('promo-campaign-from').value || !el('promo-campaign-to').value) {
    // 날짜를 지우는 중간 상태: 기간이 없으니 옛 기간의 목록을 남겨두지 않는다.
    clearList()
    setMessage('')
    return
  }
  setLoading(true)
  dateTimer = setTimeout(() => {
    dateTimer = null
    if (sending) return
    startLoad()
  }, DATE_DEBOUNCE_MS)
}

function handleFilterClick(filter) {
  if (!FILTERS.some(([key]) => key === filter) || filter === activeFilter) return
  activeFilter = filter
  // 응답이 오기 전에도 눌렀다는 게 보이도록 탭 표시를 먼저 바꾼다.
  document.querySelectorAll('#promo-campaign-result [data-promo-filter]').forEach((tab) => {
    const on = tab.dataset.promoFilter === filter
    tab.classList.toggle('is-active', on)
    tab.setAttribute('aria-pressed', String(on))
  })
  startLoad()
}

// loadList의 오류는 여기서 화면에 낸다(호출부 어디서든 같은 처리). 항상 resolve 한다.
function startLoad(options) {
  return loadList(options).catch((err) => {
    setLoading(false)
    setMessage(err?.message || String(err), 'error')
  })
}

// append=true는 [더 보기]: 지금 목록의 기간으로, 받은 행 수 다음부터 이어 붙인다.
// quiet=true는 발송 직후 다시 불러오기: 위에 떠 있는 발송 결과 문구를 지우거나 덮어쓰지 않는다.
async function loadList({ append = false, quiet = false } = {}) {
  const base = append && listState ? listState : null
  const from = base ? base.from : el('promo-campaign-from')?.value
  const to = base ? base.to : el('promo-campaign-to')?.value
  if (!from || !to) return
  const seq = (listSeq += 1)
  const filter = activeFilter
  if (!quiet) setMessage(append ? '' : '목록을 불러오는 중...')
  setLoading(true)

  const params = new URLSearchParams({
    from, to, filter, offset: String(base ? base.rows.length : 0), limit: String(PAGE_SIZE),
  })
  let res
  try {
    res = await deps.apiGet(`/api/pos/promo-campaign/preview?${params.toString()}`)
  } catch {
    res = { ok: false, status: 0, body: { error: '서버에 연결하지 못했습니다.' } }
  }
  if (seq !== listSeq) return // 더 새로운 요청이 있다. 그쪽이 화면을 맡는다.

  const body = res.body || {}
  if (!res.ok) {
    if (res.status === 401) {
      setLoading(false)
      deps.onUnauthorized(body.error)
      return
    }
    const text = body.error || '목록을 불러오지 못했습니다.'
    if (append) {
      // 이미 받은 목록은 그대로 두고 더 보기만 다시 누르게 한다.
      setLoading(false)
      setMessage(text, 'error')
      return
    }
    // 새 기간/탭의 목록을 못 받았으면 옛 목록을 남겨두지 않는다(기간 표시와 어긋난다).
    clearList()
    if (quiet) deps.notify('error', `${text} [새로고침]을 눌러 다시 불러오세요.`)
    else setMessage(text, 'error')
    return
  }

  const rows = Array.isArray(body.rows) ? body.rows : []
  const counts = body.filterCounts || {}
  listState = {
    from: body.from || from,
    to: body.to || to,
    filter,
    rows: base ? base.rows.concat(rows) : rows,
    // 이어 붙였는데 한 줄도 안 왔으면 더 없다고 본다(서버 hasMore가 틀려도 [더 보기]가 무한히 남지 않게).
    hasMore: Boolean(body.hasMore) && !(base && rows.length === 0),
    rowsTotal: Number.isFinite(Number(body.rowsTotal)) ? Number(body.rowsTotal) : null,
    counts,
    body,
  }
  previewState = {
    from: listState.from,
    to: listState.to,
    eligible: Number(counts.eligible ?? body.eligible) || 0,
  }
  if (!quiet) setMessage('')
  // 시연 모드가 실제로 바뀐 때만 다시 그린다: renderDemo가 켜기 버튼의 "한 번 더 누르면 켜짐" 대기를 풀어버리는데
  // 대기 타이머는 남아서, 그 뒤 첫 탭이 확인 없이 바로 켜짐으로 이어진다.
  if (typeof body.demoMode === 'boolean' && body.demoMode !== demoMode) renderDemo(body)
  setLoading(false)
  renderList()
}

function renderBadge(row) {
  const e = deps.escapeHtml
  // 방금 확실히 실패한 번호(서버가 잠시 보내기 목록에서 빼 둔다). 영영 못 보내는 게 아니라 시간이 지나면 다시 대상이
  // 되므로 '제외' 사유 라벨 대신 언제 다시 되는지를 알려준다.
  if (row.recentFailure) return '<span class="promo-campaign-badge">방금 실패 · 30분 뒤 재시도</span>'
  if (row.status === 'recently_sent') {
    const day = formatMonthDay(row.lastSentAt)
    return `<span class="promo-campaign-badge">${e(day ? `최근 받음 ${day}` : '최근 받음')}</span>`
  }
  const label = STATUS_LABEL[row.status] || row.status || '-'
  return `<span class="promo-campaign-badge${row.status === 'ok' ? ' is-ok' : ''}">${e(label)}</span>`
}

function renderList() {
  const result = el('promo-campaign-result')
  if (!result || !listState) return
  clearConfirm()
  const e = deps.escapeHtml
  const num = (v) => e(String(Number(v) || 0))
  const { body, counts, rows, filter } = listState
  const days = Number(body.minIntervalDays) || 0
  const eligible = previewState ? previewState.eligible : 0
  const visitors = counts.all ?? body.visitors

  const message = body.message
    ? `<pre class="promo-campaign-message">${e(body.message)}</pre>`
    : ''
  const optOutWarn = body.optOutConfigured
    ? ''
    : '<div class="promo-campaign-note blocked">수신거부 안내가 기본 문구("매장으로 연락")입니다. 080 무료수신거부처럼 손님에게 비용이 들지 않는 방법으로 바꾸도록 본사에 알려주세요.</div>'
  const action = body.night
    ? '<div class="promo-campaign-note blocked">지금은 야간이라 보낼 수 없습니다(21시~8시). 낮에 다시 보내주세요.</div>'
    : eligible > 0
      ? `<button class="history-promo-button" id="promo-campaign-send" type="button">${num(eligible)}명에게 보내기</button>
         <div class="promo-campaign-note">한 번 더 눌러야 보내집니다. 보낸 뒤에는 취소할 수 없습니다.</div>`
      : '<div class="promo-campaign-note blocked">보낼 수 있는 손님이 없습니다.</div>'

  const tabs = FILTERS.map(([key, label]) => {
    const on = key === filter
    const count = counts[key] === undefined || counts[key] === null ? '' : `<span class="promo-campaign-tab-count">${num(counts[key])}</span>`
    return `<button type="button" class="promo-campaign-tab${on ? ' is-active' : ''}" data-promo-filter="${e(key)}" aria-pressed="${on}">${e(label)}${count}</button>`
  }).join('')

  const items = rows
    .map((r) => `
      <li class="${r.status === 'ok' ? '' : 'is-muted'}">
        <span class="promo-campaign-phone">${e(r.phone || '-')}</span>
        <span class="promo-campaign-car">${e(r.carNumber || '-')}</span>
        <span class="promo-campaign-visit">${e(formatVisit(r.lastVisitAt))}</span>
        ${renderBadge(r)}
        <button type="button" class="promo-campaign-row-delete${rowDeleteConfirm.has(r.phone) ? ' confirming' : ''}"
                data-promo-delete="${e(r.phone || '')}" ${rowDeleting.has(r.phone) || sending ? 'disabled' : ''}>${rowDeleteConfirm.has(r.phone) ? '정말 삭제?' : '삭제'}</button>
      </li>`)
    .join('')
  const shown = listState.rowsTotal === null ? '' : ` (${num(rows.length)}/${num(listState.rowsTotal)})`
  const more = listState.hasMore
    ? `<button type="button" class="promo-campaign-more" id="promo-campaign-more">더 보기${shown}</button>`
    : ''

  result.innerHTML = `
    <div class="promo-campaign-summary">
      <strong>${e(listState.from)} ~ ${e(listState.to)}</strong> · 방문 <strong>${num(visitors)}</strong>명 · 보낼 수 있음 <strong class="promo-campaign-count">${num(eligible)}</strong>명
      ${body.excluded ? `<div class="promo-campaign-note">${e(excludedText(body.excluded, days))}</div>` : ''}
      ${body.truncated ? '<div class="promo-campaign-note blocked">방문 번호가 너무 많아 일부만 계산했습니다. 기간을 줄여주세요.</div>' : ''}
    </div>
    ${message}
    ${optOutWarn}
    ${action}
    <div class="promo-campaign-tabs">${tabs}</div>
    ${items ? `<ul class="promo-campaign-list">${items}</ul>` : `<div class="promo-campaign-note blocked">${e(EMPTY_TEXT[filter] || EMPTY_TEXT.all)}</div>`}
    ${more}
  `
}

// 목록에서 번호 삭제. 지운 번호는 홍보 목록에서 사라지고 차량별·자동 발송도 막힌다(서버 PromoExclusion).
// 두 번 눌러야 지워진다(되돌리는 화면은 없다).
function handleRowDelete(phone) {
  if (!phone || sending) return
  if (!rowDeleteConfirm.has(phone)) {
    for (const t of rowDeleteConfirm.values()) clearTimeout(t)
    rowDeleteConfirm.clear()
    rowDeleteConfirm.set(phone, setTimeout(() => { rowDeleteConfirm.delete(phone); if (listState) renderList() }, 3000))
    if (listState) renderList()
    return
  }
  clearTimeout(rowDeleteConfirm.get(phone))
  rowDeleteConfirm.delete(phone)
  deleteRow(phone).catch((err) => deps.notify('error', err?.message || String(err)))
}

async function deleteRow(phone) {
  rowDeleting.add(phone)
  if (listState) renderList()
  try {
    let res
    try {
      res = await deps.apiPost('/api/pos/promo/exclude', { phone })
    } catch {
      res = { ok: false, status: 0, body: { error: '서버에 연결하지 못했습니다.' } }
    }
    if (!res.ok) {
      if (res.status === 401) return deps.onUnauthorized(res.body.error)
      return deps.notify('error', res.body.error || '삭제하지 못했습니다.')
    }
    deps.notify('success', `${phone} 번호를 홍보 목록에서 삭제했습니다.`)
    startLoad({ append: false })
  } finally {
    rowDeleting.delete(phone)
    // 시작할 때 [삭제]를 잠근 채 다시 그렸다. 실패하면(서버 오류·네트워크) 목록을 다시 불러오지 않으므로 여기서 그려
    // 풀어주지 않으면 그 버튼이 영영 잠긴 채 남는다. 성공이면 곧 새 목록이 와서 덮어쓴다.
    if (listState) renderList()
  }
}

function handleSendClick(btn) {
  if (!previewState || sending) return
  if (el('promo-campaign-result')?.classList.contains('is-loading')) return
  if (!confirmTimer) {
    btn.classList.add('confirming')
    btn.textContent = `정말 ${previewState.eligible}명에게 보낼까요?`
    confirmTimer = setTimeout(() => {
      confirmTimer = null
      btn.classList.remove('confirming')
      btn.textContent = `${previewState ? previewState.eligible : 0}명에게 보내기`
    }, 3000)
    return
  }
  clearTimeout(confirmTimer)
  confirmTimer = null
  send(btn).catch((err) => setMessage(err?.message || String(err), 'error'))
}

// 발송사(솔라피) 계정 쪽 문제(선불 잔액 부족·발신번호 차단·템플릿 등)로 서버가 발송을 멈췄을 때의 안내. 이때는 30분 뒤 다시 보내도
// 똑같이 실패한다 -- "다시 보내세요"가 아니라 본사 확인이 필요하다고 알린다(서버 stopped:'provider', 수동 발송 reason 'send_failed_provider').
export const PROVIDER_STOP_MESSAGE = '문자 발송 계정(잔액·발신번호·템플릿) 문제로 멈췄습니다. 본사 확인이 필요합니다'

// 결과 문구. failed는 확실히 안 나간 것(나중에 다시 보낼 수 있다), uncertain은 결과를 모르는 것
// (나갔을 수 있어 30일 동안 다시 보내지 않는다).
function summary(t, remaining, reason) {
  const parts = [`보냄 ${t.sent}건`]
  if (t.failed) parts.push(`실패 ${t.failed}건(30분 뒤 [새로고침] 후 다시 보낼 수 있습니다)`)
  if (t.uncertain) parts.push(`결과 확인 안 됨 ${t.uncertain}건(이미 나갔을 수 있어 30일 동안 다시 보내지 않습니다)`)
  if (t.skipped) parts.push(`보내기 직전 제외 ${t.skipped}건`)
  if (remaining) parts.push(`아직 ${remaining}명 남음 — ${reason || '아래 [보내기]를 다시 눌러 이어서 보내세요.'}`)
  return parts.join(' · ')
}

// 한 번 요청에 최대 60건씩 보내고, 남으면 이어서 부른다. 이미 보낸 번호는 30일 제한으로, 방금 실패한
// 번호는 잠시 빠지므로 다시 불러도 같은 번호를 두 번 시도하지 않는다. confirmCount는 처음 본 대상 수에서
// 이미 처리한 수를 뺀 값이라, 그 사이 대상이 늘면 서버가 보내지 않는다.
async function send(btn) {
  const state = previewState
  if (!state) return
  sending = true
  // 날아가 있는 불러오기 응답이 발송 도중에 화면(= 지금 누른 버튼)을 갈아끼우지 못하게 무효로 한다.
  listSeq += 1
  if (dateTimer) clearTimeout(dateTimer)
  dateTimer = null
  let refresh = true
  lockForm(true)
  btn.disabled = true
  btn.classList.remove('confirming')
  const t = { sent: 0, failed: 0, uncertain: 0, skipped: 0 }
  let remaining = state.eligible
  let stopReason = ''
  let errorText = ''
  // 발송사 계정 문제로 서버가 멈췄다(PROVIDER_STOP_MESSAGE). 남은 대상을 더 부르지 않는다.
  let providerStopped = false
  // 서버가 이번 발송 루프에 붙여 준 시작 시각. 첫 응답에서 받아 같은 루프의 다음 요청에 그대로 돌려보낸다(서버가
  // "방금 실패한 번호"를 이 시각 기준으로 가려, 한 루프 안에서 같은 번호를 두 번 시도하지 않게 한다). 지역 변수라
  // 새 발송을 시작하면 자동으로 비워진다 -- 지난 발송의 시각을 새 발송에 붙이면 안 된다.
  let runStartedAt = ''
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const processed = t.sent + t.failed + t.uncertain + t.skipped
      btn.textContent = `보내는 중... ${processed}/${state.eligible}`
      let res
      try {
        res = await deps.apiPost('/api/pos/promo-campaign/send', {
          from: state.from,
          to: state.to,
          confirmCount: Math.max(0, state.eligible - processed),
          ...(runStartedAt ? { runStartedAt } : {}),
        })
      } catch {
        res = { ok: false, status: 0, body: { error: '서버에 연결하지 못했습니다.' } }
      }
      if (!res.ok) {
        if (res.status === 401) {
          refresh = false
          deps.onUnauthorized(res.body.error)
          return
        }
        if (res.body && (res.body.stopped === 'provider' || res.body.reason === 'send_failed_provider')) {
          providerStopped = true
          break
        }
        errorText = res.body.error || '보내지 못했습니다.'
        break
      }
      for (const k of Object.keys(t)) t[k] += res.body[k] || 0
      if (res.body.runStartedAt) runStartedAt = res.body.runStartedAt
      remaining = res.body.remaining
      const progressed = (res.body.sent || 0) + (res.body.failed || 0) + (res.body.uncertain || 0) + (res.body.skipped || 0)
      if (res.body.stopped === 'provider') {
        // 잔액·발신번호·템플릿 문제는 다시 불러도 같은 실패다. 남은 대상은 시도하지 않고 멈춘다.
        providerStopped = true
        break
      }
      if (res.body.stopped === 'night') {
        stopReason = '밤 9시가 가까워 멈췄습니다. 내일 아침 8시 이후 이어서 보내세요.'
        break
      }
      if (!remaining || !progressed) break
    }
    if (providerStopped) {
      // 이때의 실패는 "30분 뒤 다시 보낼 수 있다"가 아니다(같은 이유로 또 실패한다) -- 건수만 붙인다.
      const parts = [`보냄 ${t.sent}건`]
      if (t.failed) parts.push(`실패 ${t.failed}건`)
      if (t.uncertain) parts.push(`결과 확인 안 됨 ${t.uncertain}건(이미 나갔을 수 있어 30일 동안 다시 보내지 않습니다)`)
      if (t.skipped) parts.push(`보내기 직전 제외 ${t.skipped}건`)
      if (remaining) parts.push(`보내지 않은 대상 ${remaining}명`)
      const text = `${PROVIDER_STOP_MESSAGE} (${parts.join(' · ')})`
      setMessage(text, 'error')
      deps.notify('error', `홍보 문자: ${text}`)
      return
    }
    // 끝나면(중간에 멈췄어도) 아래 finally에서 목록을 다시 불러온다 -- 보낸 번호가 '최근 받음'으로 바뀌어 보이고,
    // 남은 건은 지금 기준의 인원수로 다시 보낸다. 목록을 비우고 기다리면 그 사이 빈 화면이 되므로 비우지 않는다.
    if (errorText) {
      const text = `${errorText} (${summary(t, 0)}) 아래 목록에서 남은 대상을 다시 확인하세요.`
      setMessage(text, 'error')
      deps.notify('error', text)
      return
    }
    // 한 건도 처리하지 못했고 남은 것도 없다: 목록을 본 뒤 그 사이 대상이 빠졌다(방금 실패한 번호는 서버가 30분 동안
    // 보내기에서 뺀다). "보냄 0건"을 성공 문구로 보여주면 보낸 줄 안다.
    if (!t.sent && !t.failed && !t.uncertain && !t.skipped && !remaining && !stopReason) {
      const text = '지금 보낼 대상이 없습니다(방금 실패한 번호는 30분 뒤 다시 보낼 수 있습니다)'
      setMessage(text, 'error')
      deps.notify('error', `홍보 문자: ${text}`)
      return
    }
    const clean = !t.failed && !t.uncertain && !remaining
    const text = summary(t, remaining, stopReason)
    setMessage(text, clean ? 'ok' : 'error')
    deps.notify(clean ? 'success' : 'error', `홍보 문자: ${text}`)
  } finally {
    sending = false
    lockForm(false)
    if (refresh) {
      // 새 목록이 올 때까지 버튼은 잠긴 채 둔다(옛 인원수로 다시 누르지 못하게).
      if (document.body.contains(btn)) btn.textContent = '목록을 새로 불러오는 중...'
      startLoad({ quiet: true })
    } else if (document.body.contains(btn)) {
      btn.disabled = false
      btn.textContent = `${previewState ? previewState.eligible : 0}명에게 보내기`
    }
  }
}

// 수신거부 등록도 두 번 눌러 확정한다(잘못 등록하면 그 손님에게 홍보가 영영 안 나간다).
async function handleOptOutSubmit() {
  const input = el('promo-optout-phone')
  const btn = el('promo-optout-submit')
  const phone = String(input?.value || '').replace(/\D/g, '')
  if (!/^01[0-9]{8,9}$/.test(phone)) {
    setOptOutMessage('전화번호를 01012345678 형식으로 입력하세요.', 'error')
    return
  }
  if (!optOutConfirmTimer) {
    btn.classList.add('confirming')
    btn.textContent = '한 번 더 누르면 등록'
    optOutConfirmTimer = setTimeout(() => {
      optOutConfirmTimer = null
      btn.classList.remove('confirming')
      btn.textContent = '수신거부 등록'
    }, 3000)
    return
  }
  clearTimeout(optOutConfirmTimer)
  optOutConfirmTimer = null
  btn.classList.remove('confirming')
  btn.textContent = '수신거부 등록'
  btn.disabled = true
  try {
    let res
    try {
      res = await deps.apiPost('/api/pos/promo/opt-out', { phone })
    } catch {
      res = { ok: false, status: 0, body: { error: '서버에 연결하지 못했습니다.' } }
    }
    if (!res.ok) {
      if (res.status === 401) {
        deps.onUnauthorized(res.body.error)
        return
      }
      setOptOutMessage(res.body.error || '등록하지 못했습니다.', 'error')
      return
    }
    input.value = ''
    setOptOutMessage(`${res.body.phoneMasked} 수신거부를 등록했습니다. 이 번호에는 홍보 문자가 나가지 않습니다.`, 'ok')
    // 목록을 보고 있었다면 그 번호의 상태가 '수신거부'로 바뀌고 보낼 수 있는 수도 줄 수 있다.
    if (listState && !sending) startLoad()
  } finally {
    btn.disabled = false
  }
}
