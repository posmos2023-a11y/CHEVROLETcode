// 정비 대기 카드 한 장을 그리는 규칙: 상태별로 보여 줄 버튼, 접수 시각·경과 시간, 어제 넘어온 접수 표시,
// 그리고 버튼을 누른 뒤의 안내 문구.
//
// app.js에서 떼어 둔 이유: DOM·폴링·토큰과 상관없는 순수한 규칙이라 따로 두면 하네스로 바로 확인할 수 있다.
// 화면에 붙이는 일(클릭 처리, 두 번 누르기 확인 상태, 서버 요청)은 여전히 app.js가 한다.

// 상태 배지. 예전 '호출완료'는 바로 옆 [완료] 버튼 때문에 "정비가 끝난 건"으로 읽혀서 '호출됨'으로 바꿨다.
// '알림 실패'는 알림톡·문자 어느 쪽으로 나갔든(템플릿 설정에 따라 다르다) 손님에게 호출 알림이 안 갔다는 뜻이다.
export const STATUS_LABEL = { waiting: '대기 중', called: '호출됨', notify_failed: '알림 실패', cancelled: '취소됨' }

// 대기 손님이 접수한 뒤 이 시간(분)을 넘기면 경과 시간과 카드 띠를 주황색으로 바꾼다.
export const OVERDUE_AFTER_MIN = 30

// 버튼 글자. 두 번 누르기 확인 중에는 "한 번 더 누르면 ~돼요"로 바꿔, 첫 탭으로는 아무 일도 안 일어났다는 것과
// 다음 탭에 무엇이 일어나는지를 같이 보여 준다(회의록 디자인 'POS 지금 할 것').
// [정비완료]는 서버가 손님께 완료 알림을 보낸다 -- 예전 확인 문구('완료 처리돼요')에는 그 말이 없어 직원은 알림이 가는지 몰랐다.
//   twice: 결과를 모르는 알림(unknown)을 다시 보낼 때 평소 확인 앞에 한 번 더 받는 확인(app.js handleActionClick).
const ACTION_TEXT = {
  call: { idle: '호출', confirm: '한 번 더 누르면 호출돼요', aria: '호출' },
  retry: {
    idle: '알림 다시 보내기',
    confirm: '한 번 더 누르면 다시 보내요',
    twice: '손님이 두 번 받을 수 있어요. 그래도 다시 보낼까요?',
    aria: '호출 알림 다시 보내기',
  },
  complete: { idle: '정비완료', confirm: '한 번 더 누르면 완료되고 손님께 알림이 가요', aria: '정비완료 처리(손님께 완료 알림)' },
  cancel: { idle: '취소', confirm: '한 번 더 누르면 취소돼요', aria: '대기열에서 취소(되돌릴 수 없음)' },
}
// 어제 넘어온 '대기 중' 접수의 [정비완료]. 완료 알림 없이 정리한다(completesSilently) -- 버튼과 확인 문구에서 그걸 밝힌다.
const SILENT_COMPLETE_TEXT = { idle: '정비완료 (알림 없이)', confirm: '한 번 더 누르면 완료돼요 · 손님께 알림은 안 가요', aria: '정비완료 처리(손님 알림 없음)' }

// 'YYYY-MM-DD'의 하루 전 날짜. 형식이 틀리면 null.
function previousDate(ymd) {
  const t = Date.parse(`${ymd}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  return new Date(t - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// 서버 시각(ISO)을 한국 시각으로 쪼갠다. 한국은 일광 절약 시간이 없어 +9시간이면 정확하다 -- Intl의 timeZone
// 지원 여부를 단말기 웹뷰마다 따지지 않아도 된다.
function kstParts(value) {
  const t = Date.parse(value || '')
  if (!Number.isFinite(t)) return null
  const d = new Date(t + 9 * 60 * 60 * 1000)
  return {
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    clock: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
  }
}

// 어제(또는 그 전) 접수해 오늘 대기열에 남아 있는 건인지. 서버가 carriedOver:true를 붙여 주는 건(어제 '대기 중'으로 넘어온 접수)과,
// 예전부터 내려오던 이월 건(어제 이전에 호출됐거나 알림이 실패한 건 -- serviceDate가 오늘과 다르다)을 함께 본다.
export function isCarriedOver(r, todayServiceDate) {
  if (!r) return false
  if (r.carriedOver === true) return true
  return Boolean(r.serviceDate) && Boolean(todayServiceDate) && r.serviceDate !== todayServiceDate
}

// 넘어온 접수의 배지 글자. 어제 것은 '어제', 그보다 오래된 것은 접수한 날짜(10/21).
// 예전에는 '이월'이라고만 써서(회계 용어) 정비사가 바로 알아듣기 어려웠고, 날짜는 터치 단말에서 안 보이는 툴팁에만 있었다.
export function carriedOverLabel(r, todayServiceDate) {
  if (!r.serviceDate || (todayServiceDate && r.serviceDate === previousDate(todayServiceDate))) return '어제'
  const [, m, d] = String(r.serviceDate).split('-')
  return m && d ? `${Number(m)}/${Number(d)}` : '어제'
}

function elapsedText(minutes) {
  if (minutes < 1) return '방금 접수'
  if (minutes < 60) return `${minutes}분째`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}시간 ${m}분째` : `${h}시간째`
}

// 카드의 시각 줄. 오늘 대기 손님: '09:12 접수 · 23분째'(30분이 넘으면 overdue). 호출한 손님: '09:12 접수 · 09:40 호출'.
// 넘어온 접수: '10/22 17:50 접수'(경과 시간은 하루를 넘겨 의미가 없다). 서버가 createdAt을 안 주면 줄을 그리지 않는다.
export function queueMeta(r, { now = Date.now(), todayServiceDate = null } = {}) {
  const created = kstParts(r.createdAt)
  if (!created) return { text: '', overdue: false }
  if (isCarriedOver(r, todayServiceDate)) {
    return { text: `${created.month}/${created.day} ${created.clock} 접수`, overdue: false }
  }
  if (r.status !== 'waiting') {
    const called = kstParts(r.calledAt)
    if (called) return { text: `${created.clock} 접수 · ${called.clock} 호출`, overdue: false }
  }
  // 단말기 시계가 서버보다 늦으면 음수가 나올 수 있다 -- 0으로 본다.
  const minutes = Math.max(0, Math.floor((now - Date.parse(r.createdAt)) / 60000))
  return {
    text: `${created.clock} 접수 · ${elapsedText(minutes)}`,
    overdue: r.status === 'waiting' && minutes >= OVERDUE_AFTER_MIN,
  }
}

// 지금 상태에서 누를 수 있는 버튼만 고른다. 예전에는 못 누르는 버튼도 회색으로 다 그려 두어 카드가 복잡했다.
//   - 대기 중: [호출] [정비완료] [취소]. 손님이 이미 카운터 앞에 있으면 호출 알림 없이 바로 완료할 수 있다(서버 C3).
//   - 넘어온 대기 중: [정비완료] [취소]만. 호출은 오늘 접수만 받는다(서버가 다른 날 접수의 호출을 거절한다). [정비완료]는 완료 알림 없이 정리한다(completesSilently).
//   - 호출됨: [정비완료] [취소].
//   - 알림 실패: [알림 다시 보내기] [정비완료] [취소]. 넘어온 건에는 다시 보내기를 두지 않는다(하루 지난 "순서입니다" 알림은 손님을 헷갈리게 한다).
export function queueActionsFor(r, todayServiceDate) {
  const carried = isCarriedOver(r, todayServiceDate)
  switch (r && r.status) {
    case 'waiting': return carried ? ['complete', 'cancel'] : ['call', 'complete', 'cancel']
    case 'called': return ['complete', 'cancel']
    case 'notify_failed': return carried ? ['complete', 'cancel'] : ['retry', 'complete', 'cancel']
    default: return []
  }
}

// [정비완료]를 완료 알림 없이 보낼 접수인지(app.js runAction이 바디에 notify:false를 싣는다). 어제 넘어온 '대기 중' 접수만이다 --
// 어제 정비를 끝내고 손님이 차를 찾아갔는데 POS만 정리하지 않은 경우가 흔해서, 그대로 알림을 보내면 하루 늦게 '차량을 찾으러 와주세요'가 간다.
// 어제 호출한(호출됨·알림 실패) 접수는 밤새 맡긴 차라 완료 알림이 필요해서 예전처럼 보낸다.
export function completesSilently(r, todayServiceDate) {
  return Boolean(r) && r.status === 'waiting' && isCarriedOver(r, todayServiceDate)
}

// 카드 한 장의 HTML.
//   confirmingAction: 이 카드에서 두 번 누르기 확인 중인 동작(없으면 null). 'retry-twice'는 결과를 모르는 알림을 다시 보내기 전의
//                     추가 확인 단계다(버튼은 [알림 다시 보내기] 그대로, 글자만 바뀐다).
//   busyAction: 이 카드에서 서버 응답을 기다리는 동작(없으면 null) -- 그동안 그 카드의 버튼은 모두 잠근다
//   notifyUnknown: 이 단말기에서 다시 보낸 호출 알림의 결과를 모른다(app.js가 기억한다, 서버 retry-notify notify 'unknown').
//                  손님이 이미 받았을 수 있어 '보내지 못했어요'라고 단정하지 않고, [알림 다시 보내기]도 눈에 덜 띄게 그린다.
export function queueCardHtml(r, { todayServiceDate = null, now = Date.now(), confirmingAction = null, busyAction = null, notifyUnknown = false, escapeHtml }) {
  const e = escapeHtml
  const statusClass = ['waiting', 'called', 'notify_failed'].includes(r.status) ? r.status : 'waiting'
  const unsure = notifyUnknown && r.status === 'notify_failed'
  const statusLabel = unsure ? '전달 여부 확인 필요' : STATUS_LABEL[r.status] || '확인 필요'
  const carried = isCarriedOver(r, todayServiceDate)
  const silentComplete = completesSilently(r, todayServiceDate)
  const meta = queueMeta(r, { now, todayServiceDate })
  const carriedBadge = carried
    ? `<span class="badge carried-over">${e(carriedOverLabel(r, todayServiceDate))}</span>`
    : ''
  // 꼭 해야 할 일은 몇 초 뒤 사라지는 토스트가 아니라 카드에 남긴다(흐름 QA #5·#11).
  let warn = ''
  if (unsure) {
    warn = '<div class="queue-warn">알림이 갔는지 확인하지 못했어요. 두 번 갈 수 있으니 다시 보내기 전에 손님께 먼저 연락해주세요. 연락처는 [이력]에서 볼 수 있어요.</div>'
  } else if (r.status === 'notify_failed') {
    warn = '<div class="queue-warn">호출 알림을 보내지 못했어요. 손님을 직접 불러주세요. 연락처는 [이력]에서 볼 수 있어요.</div>'
  } else if (silentComplete) {
    warn = '<div class="queue-warn carried">어제 호출하지 않은 접수예요. [정비완료]로 정리해도 손님께 완료 알림은 가지 않아요. 알려야 하면 정리한 뒤 [이력]에서 완료 알림을 다시 보내주세요. 손님이 오지 않았으면 [취소]로 정리해주세요.</div>'
  }
  const buttons = queueActionsFor(r, todayServiceDate).map((action) => {
    const text = action === 'complete' && silentComplete ? SILENT_COMPLETE_TEXT : ACTION_TEXT[action]
    const twice = action === 'retry' && confirmingAction === 'retry-twice'
    const confirming = confirmingAction === action || twice
    const busy = busyAction === action
    const confirmText = twice ? text.twice : text.confirm
    const label = busy ? '처리 중...' : confirming ? confirmText : text.idle
    // 결과를 모르는 알림의 [알림 다시 보내기]는 채운 파랑(가장 먼저 할 일)이 아니라 보조 모양으로 둔다(index.html .retry.unsure).
    const extra = action === 'retry' && unsure ? ' unsure' : ''
    return `<button class="action-button ${action}${extra}${confirming ? ' confirm' : ''}" type="button"
              data-id="${e(r.id)}" data-action="${action}"
              aria-label="${e(confirming ? confirmText : text.aria)} ${e(r.carNumber)}"
              ${busyAction ? 'disabled' : ''}>${e(label)}</button>`
  }).join('')
  const classes = [
    'queue-item',
    `status-${statusClass}`,
    meta.overdue ? 'is-overdue' : '',
    carried ? 'is-carried' : '',
  ].filter(Boolean).join(' ')
  return `
    <article class="${classes}" data-reservation-id="${e(r.id)}">
      <div class="queue-number">#${e(r.queueNumber)}</div>
      <div class="queue-main">
        <div class="queue-top">
          <strong class="car-number">${e(r.carNumber)}</strong>
          ${carriedBadge}
          <span class="badge ${statusClass}">${e(statusLabel)}</span>
        </div>
        <div class="service">${e(r.serviceType || '-')}</div>
        ${meta.text ? `<div class="queue-meta${meta.overdue ? ' overdue' : ''}">${e(meta.text)}</div>` : ''}
        <div class="phone">${e(r.phoneMasked || '-')}</div>
        ${warn}
      </div>
      <div class="actions">
        ${buttons}
        <button class="history-button" type="button" data-history="${e(r.carNumber)}"
          aria-label="${e(r.carNumber)} 정비 이력 보기">이력</button>
      </div>
    </article>
  `
}

// 버튼을 누른 뒤 서버 응답(ok)에 맞는 안내. [kind, message]를 돌려준다(kind는 POS 토스트 종류).
//   call: 서버는 알림 발송이 실패해도 ok:true에 status:'notify_failed'를 준다 -- 그때 "보냈어요"라고 하면 직원이 손님을 따로 부르지 않는다.
//   complete: 이미 완료된 건은 alreadyCompleted로 온다(alreadyProcessed가 아니다). 다른 POS나 프론트 결제가 먼저 완료한 경우도 같다 --
//             app.js runAction이 ok가 아니어도 alreadyCompleted면 여기로 보낸다.
//             silent(완료 알림 없이 보낸 요청, completesSilently)면 notified:false는 실패가 아니라 요청한 대로다.
//   retry: 서버 C4 응답 notify 'sent' | 'failed' | 'unknown'. 결과를 모르면 다시 보내기보다 직접 연락을 먼저 권한다(두 번 나갈 수 있다).
//          'sent'만 200 ok:true로 오고, 'failed'·'unknown'은 502 ok:false로 온다 -- app.js runAction이 그 둘도 여기로 보낸다.
export function actionResultMessage(action, body, { silent = false } = {}) {
  const b = body || {}
  const already = Boolean(b.alreadyProcessed || b.alreadyCompleted)
  switch (action) {
    case 'call':
      if (already) return ['success', '이미 호출한 손님이에요.']
      if (b.status === 'notify_failed') return ['error', '호출했지만 알림을 보내지 못했어요. 손님을 직접 불러주세요.']
      return ['success', '호출 알림을 보냈어요.']
    case 'complete':
      if (already) return ['success', '이미 정비완료된 손님이에요.']
      // 알림 없이 정리했는데 서버가 그래도 보냈다면(notify:false를 모르는 옛 서버) 사실대로 알린다.
      if (silent) return b.notified === true
        ? ['success', '정비완료로 처리하고 손님께 완료 알림을 보냈어요.']
        : ['success', '정비완료로 처리했어요. 손님께 완료 알림은 보내지 않았어요.']
      if (b.notified === false) {
        return ['error', '정비완료로 처리했지만 완료 알림을 보내지 못했어요. [정비 이력]에서 다시 보내거나 손님께 직접 연락해주세요.']
      }
      if (b.notified === true) return ['success', '정비완료로 처리하고 손님께 완료 알림을 보냈어요.']
      return ['success', '정비완료로 처리했어요.']
    case 'cancel':
      return already ? ['success', '이미 취소된 접수예요.'] : ['success', '대기열에서 뺐어요.']
    case 'retry': {
      // 계약은 notify 'sent'|'failed'|'unknown'이다. 관리자 웹 재발송처럼 sent(boolean)·status만 오는 응답도 같은 뜻으로 읽는다.
      const notify = b.notify || (b.sent === true ? 'sent' : b.sent === false ? 'failed' : b.status === 'called' ? 'sent' : 'failed')
      if (notify === 'sent') return ['success', '호출 알림을 다시 보냈어요.']
      if (notify === 'unknown') {
        return ['warn', '알림이 갔는지 확인하지 못했어요. 두 번 갈 수 있으니 다시 보내기 전에 손님께 직접 연락해주세요.']
      }
      return ['error', '이번에도 알림을 보내지 못했어요. 손님을 직접 불러주세요.']
    }
    default:
      return ['success', '처리했어요.']
  }
}

// 서버가 거절했을 때(ok:false)의 안내. 401은 호출부가 토큰 화면으로 보내므로 여기 오지 않는다.
export function actionErrorMessage(action, status, body) {
  const error = body && body.error
  if (action === 'retry') {
    // 새 경로를 모르는 옛 서버는 본문 없는 404를 준다.
    if (status === 404 && !error) return '서버가 아직 알림 다시 보내기를 지원하지 않아요. 손님을 직접 불러주세요.'
    if (status === 409) return `${error || '지금은 다시 보낼 수 없는 상태예요.'} 목록을 새로 불러올게요.`
  }
  return error || '처리하지 못했어요. 잠시 후 다시 시도해주세요.'
}
