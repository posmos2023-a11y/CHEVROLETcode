// [홍보 문자] 화면: 기간을 정해 그 기간에 방문한 손님에게 홍보 문자를 한 번에 보낸다.
//
// 규칙은 전부 서버가 정한다(관리자 웹과 같은 로직): 가장 최근 방문에서 광고 수신에 동의한 번호만,
// 같은 번호는 한 번만, 수신거부·동의 2년 경과·최근 30일 안에 받은 번호 제외, 야간(21~8시) 금지.
// 이 화면은 [대상 확인]으로 몇 명에게 가는지 보여주고, 두 번 눌러 확정해야 보낸다.
// 아래쪽 [수신거부 등록]은 손님이 거부를 알려왔을 때 번호를 등록한다.
//
// 확인을 window.confirm 대신 두 번 누르기로 하는 이유: POS 탭 화면(iframe)에서는 브라우저 확인창이
// 막히거나 POS 화면을 멈출 수 있다. 대기열의 호출·완료와 같은 방식이라 직원에게도 익숙하다.

let deps = null
let previewState = null // { from, to, eligible }
let confirmTimer = null
let sending = false
let optOutConfirmTimer = null

// 이어 보내기 상한. 탭앱은 한 번에 60건씩이라 넉넉히 둔다(남으면 화면에 남은 수를 알린다).
const MAX_ROUNDS = 100

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

function resetPreview() {
  previewState = null
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = null
  const result = el('promo-campaign-result')
  if (result) result.innerHTML = ''
}

// 보내는 동안에는 기간·대상 확인을 잠근다(같은 매장에 발송이 겹치거나 화면이 바뀌지 않게).
function lockForm(locked) {
  for (const id of ['promo-campaign-from', 'promo-campaign-to', 'promo-campaign-preview']) {
    const node = el(id)
    if (node) node.disabled = locked
  }
}

export function initPromoCampaign(injected) {
  deps = injected
  const from = el('promo-campaign-from')
  const to = el('promo-campaign-to')
  const form = el('promo-campaign-form')
  if (!from || !to || !form) return

  from.value = kstDate(-30)
  to.value = kstDate(0)
  from.max = to.max = kstDate(0)

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (sending) return
    preview().catch((err) => setMessage(err?.message || String(err), 'error'))
  })
  for (const input of [from, to]) {
    input.addEventListener('change', () => {
      if (sending) return
      resetPreview()
      setMessage('')
    })
  }

  el('promo-campaign-result')?.addEventListener('click', (e) => {
    const btn = e.target.closest('#promo-campaign-send')
    if (!btn || btn.disabled) return
    handleSendClick(btn)
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
// 켜면 그날 자정까지 이 매장의 "같은 번호 30일 내 재발송 금지"가 꺼진다(서버가 자정에 저절로 끈다).
// 수신 동의·수신거부·야간 금지는 그대로다. 켜는 건 안전장치를 끄는 일이라 두 번 눌러야 켜진다.
let demoMode = false
let demoConfirmTimer = null

function formatTime(value) {
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function renderDemo(body) {
  demoMode = Boolean(body.demoMode)
  const card = el('promo-demo-card')
  const status = el('promo-demo-status')
  const btn = el('promo-demo-toggle')
  if (!card || !status || !btn) return
  card.classList.toggle('is-on', demoMode)
  status.textContent = demoMode
    ? `켜짐 — 같은 번호로 바로 다시 보낼 수 있습니다. ${formatTime(body.demoUntil)}에 저절로 꺼집니다.`
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
    const s = el('promo-demo-status')
    if (s) s.textContent = '시연 모드 상태를 확인하지 못했습니다.'
    return
  }
  renderDemo(body)
}

async function handleDemoToggle() {
  const btn = el('promo-demo-toggle')
  if (!btn || btn.disabled) return
  const enabling = !demoMode
  if (enabling && !demoConfirmTimer) {
    btn.classList.add('confirming')
    btn.textContent = '한 번 더 누르면 켜짐'
    demoConfirmTimer = setTimeout(() => {
      demoConfirmTimer = null
      btn.classList.remove('confirming')
      btn.textContent = '켜기'
    }, 3000)
    return
  }
  if (demoConfirmTimer) clearTimeout(demoConfirmTimer)
  demoConfirmTimer = null
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
  // 대상 수가 바뀌므로(30일 제외가 풀리거나 다시 걸림) 미리보기를 다시 하게 한다.
  if (previewState && !sending) {
    resetPreview()
    setMessage('시연 모드가 바뀌어 대상이 달라졌습니다. [대상 확인]을 다시 눌러주세요.')
  }
}

function excludedText(ex, days) {
  return [
    ex.optedOut ? `수신거부 ${ex.optedOut}` : '',
    `광고 미동의 ${ex.noConsent}`,
    ex.consentExpired ? `동의 2년 경과 ${ex.consentExpired}` : '',
    days > 0 ? `최근 ${days}일 내 받은 번호 ${ex.recentlySent}` : '',
  ].filter(Boolean).join(' · ') + ' 제외' + (days > 0 ? '' : ' (시연 모드: 30일 제한 꺼짐)')
}

async function preview() {
  resetPreview()
  const from = el('promo-campaign-from').value
  const to = el('promo-campaign-to').value
  setMessage('대상을 확인하는 중...')
  const params = new URLSearchParams({ from, to })
  const { ok, status, body } = await deps.apiGet(`/api/pos/promo-campaign/preview?${params.toString()}`)
  if (!ok) {
    if (status === 401) {
      deps.onUnauthorized(body.error)
      return
    }
    setMessage(body.error || '대상을 확인하지 못했습니다.', 'error')
    return
  }
  setMessage('')
  previewState = { from: body.from, to: body.to, eligible: body.eligible }
  if (typeof body.demoMode === 'boolean') renderDemo(body)
  const rows = (body.sample || [])
    .map((r) => `
      <li>
        <span class="promo-campaign-phone">${deps.escapeHtml(r.phoneMasked)}</span>
        <span class="promo-campaign-car">${deps.escapeHtml(r.carNumber || '-')}</span>
        <span class="promo-campaign-visit">${deps.escapeHtml(formatVisit(r.lastVisitAt))}</span>
      </li>`)
    .join('')
  const more = body.eligible > (body.sample || []).length ? `<div class="promo-campaign-note">외 ${body.eligible - body.sample.length}명</div>` : ''
  const action = body.night
    ? '<div class="promo-campaign-note blocked">지금은 야간이라 보낼 수 없습니다(21시~8시). 낮에 다시 보내주세요.</div>'
    : body.eligible > 0
      ? `<button class="history-promo-button" id="promo-campaign-send" type="button">${body.eligible}명에게 보내기</button>
         <div class="promo-campaign-note">한 번 더 눌러야 보내집니다. 보낸 뒤에는 취소할 수 없습니다.</div>`
      : '<div class="promo-campaign-note blocked">보낼 수 있는 손님이 없습니다.</div>'
  const message = body.message
    ? `<pre class="promo-campaign-message">${deps.escapeHtml(body.message)}</pre>`
    : ''
  const optOutWarn = body.optOutConfigured
    ? ''
    : '<div class="promo-campaign-note blocked">수신거부 안내가 기본 문구("매장으로 연락")입니다. 080 무료수신거부처럼 손님에게 비용이 들지 않는 방법으로 바꾸도록 본사에 알려주세요.</div>'

  el('promo-campaign-result').innerHTML = `
    <div class="promo-campaign-summary">
      <strong>${deps.escapeHtml(body.from)} ~ ${deps.escapeHtml(body.to)}</strong> 방문 손님<br>
      방문한 번호 <strong>${body.visitors}</strong>개 중 보낼 수 있는 번호 <strong class="promo-campaign-count">${body.eligible}</strong>개
      <div class="promo-campaign-note">${deps.escapeHtml(excludedText(body.excluded, body.minIntervalDays))}</div>
      ${body.truncated ? '<div class="promo-campaign-note blocked">방문 번호가 너무 많아 일부만 계산했습니다. 기간을 줄여주세요.</div>' : ''}
    </div>
    ${message}
    ${optOutWarn}
    ${rows ? `<ul class="promo-campaign-list">${rows}</ul>${more}` : ''}
    ${action}
  `
}

function handleSendClick(btn) {
  if (!previewState || sending) return
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

// 결과 문구. failed는 확실히 안 나간 것(나중에 다시 보낼 수 있다), uncertain은 결과를 모르는 것
// (나갔을 수 있어 30일 동안 다시 보내지 않는다).
function summary(t, remaining, reason) {
  const parts = [`보냄 ${t.sent}건`]
  if (t.failed) parts.push(`실패 ${t.failed}건(30분 뒤 [대상 확인]으로 다시 보낼 수 있습니다)`)
  if (t.uncertain) parts.push(`결과 확인 안 됨 ${t.uncertain}건(이미 나갔을 수 있어 30일 동안 다시 보내지 않습니다)`)
  if (t.skipped) parts.push(`보내기 직전 제외 ${t.skipped}건`)
  if (remaining) parts.push(`아직 ${remaining}명 남음 — ${reason || '[대상 확인]을 다시 눌러 이어서 보내세요.'}`)
  return parts.join(' · ')
}

// 한 번 요청에 최대 60건씩 보내고, 남으면 이어서 부른다. 이미 보낸 번호는 30일 제한으로, 방금 실패한
// 번호는 잠시 빠지므로 다시 불러도 같은 번호를 두 번 시도하지 않는다. confirmCount는 처음 본 대상 수에서
// 이미 처리한 수를 뺀 값이라, 그 사이 대상이 늘면 서버가 보내지 않는다.
async function send(btn) {
  const state = previewState
  if (!state) return
  sending = true
  lockForm(true)
  btn.disabled = true
  btn.classList.remove('confirming')
  const t = { sent: 0, failed: 0, uncertain: 0, skipped: 0 }
  let remaining = state.eligible
  let stopReason = ''
  let errorText = ''
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const processed = t.sent + t.failed + t.uncertain + t.skipped
      btn.textContent = `보내는 중... ${processed}/${state.eligible}`
      let res
      try {
        res = await deps.apiPost('/api/pos/promo-campaign/send', {
          from: state.from, to: state.to, confirmCount: Math.max(0, state.eligible - processed),
        })
      } catch {
        res = { ok: false, status: 0, body: { error: '서버에 연결하지 못했습니다.' } }
      }
      if (!res.ok) {
        if (res.status === 401) {
          deps.onUnauthorized(res.body.error)
          return
        }
        errorText = res.body.error || '보내지 못했습니다.'
        break
      }
      for (const k of Object.keys(t)) t[k] += res.body[k] || 0
      remaining = res.body.remaining
      const progressed = (res.body.sent || 0) + (res.body.failed || 0) + (res.body.uncertain || 0) + (res.body.skipped || 0)
      if (res.body.stopped === 'night') {
        stopReason = '밤 9시가 가까워 멈췄습니다. 내일 아침 8시 이후 [대상 확인]으로 이어서 보내세요.'
        break
      }
      if (!remaining || !progressed) break
    }
    // 끝나면(중간에 멈췄어도) 미리보기를 지운다 -- 남은 건은 [대상 확인]으로 지금 기준을 다시 보고 보낸다.
    resetPreview()
    if (errorText) {
      const text = `${errorText} (${summary(t, 0)}) [대상 확인]으로 남은 대상을 다시 확인하세요.`
      setMessage(text, 'error')
      deps.notify('error', text)
      return
    }
    const clean = !t.failed && !t.uncertain && !remaining
    const text = summary(t, remaining, stopReason)
    setMessage(text, clean ? 'ok' : 'error')
    deps.notify(clean ? 'success' : 'error', `홍보 문자: ${text}`)
  } finally {
    sending = false
    lockForm(false)
    if (document.body.contains(btn)) {
      btn.disabled = false
      if (previewState) btn.textContent = `${previewState.eligible}명에게 보내기`
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
    // 미리보기를 보고 있었다면 대상 수가 바뀌었을 수 있다.
    if (previewState && !sending) {
      resetPreview()
      setMessage('수신거부가 등록되어 대상이 바뀌었을 수 있습니다. [대상 확인]을 다시 눌러주세요.')
    }
  } finally {
    btn.disabled = false
  }
}
