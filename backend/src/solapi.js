const { SolapiMessageService } = require('solapi')
const logger = require('./logger')

let service = null
function getService() {
  if (!service) {
    service = new SolapiMessageService(
      process.env.SOLAPI_API_KEY,
      process.env.SOLAPI_API_SECRET
    )
  }
  return service
}

const DEFAULT_TIMEOUT_MS = 10000

// solapi SDK는 fetch를 직접 호출하지 않아 AbortController를 그대로 넘길 수 없다(tossOrderClient.js와
// 다른 이유). 대신 타이머로 감싸 레이스시킨다 -- 문자 회사가 응답을 안 주면 요청 경로가 무한정
// 매달려 Cloud Run 슬롯을 잠가버리고, 400개 가맹점이 슬롯을 공유하므로 POS 폴링까지 멈춘다.
//
// 한계: 우리가 기다리기를 그만둘 뿐, SDK가 띄운 요청 자체는 계속 살아 있다(취소할 방법이 없다).
// 목적은 "요청 경로를 풀어주는 것"이라 이걸로 충분하지만, 문자 회사가 오래 죽어 있으면 소켓이
// 쌓인다. 그때는 SDK를 걷어내고 fetch로 직접 부르면서 AbortController를 써야 한다.
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Solapi 발송 시간 초과 (${timeoutMs / 1000}초)`)
      err.code = 'SOLAPI_TIMEOUT'
      reject(err)
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// 카카오 알림톡용 pfId/템플릿ID가 아직 없으면(템플릿 승인 전) 일반 문자(SMS/LMS)로 대신 보낸다.
// 알림톡 템플릿이 승인되고 .env에 SOLAPI_KAKAO_PFID + 템플릿ID를 채우면 자동으로 알림톡으로 전환된다.
async function sendAlimtalk({ phone, text, templateId, variables, storeId, recordId, recordType }) {
  const pfId = process.env.SOLAPI_KAKAO_PFID
  const useKakao = Boolean(pfId && templateId)
  // 0/빈값/글자는 기본값으로 빠지지만 음수는 그대로 통과해 setTimeout이 즉시 발화한다.
  // 그러면 모든 발송이 시간 초과로 죽는데, 로그만 보면 "문자 회사가 느리다"로 읽혀서
  // 환경변수 오타 하나가 원인이라는 걸 찾기 어렵다. 양수만 받는다.
  const configured = Number(process.env.SOLAPI_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS

  try {
    const result = await withTimeout(
      getService().send({
        to: phone,
        from: process.env.SOLAPI_SENDER,
        text,
        ...(useKakao
          ? { kakaoOptions: { pfId, templateId, variables, disableSms: true } }
          : {}),
      }),
      timeoutMs
    )

    const failed = result?.failedMessageList ?? result?.failed
    if (failed?.length) {
      const firstErr = failed[0]
      const msg = firstErr?.resultMessage ?? firstErr?.statusMessage ?? firstErr?.reason ?? JSON.stringify(firstErr)
      const err = new Error(msg)
      // 문자 회사가 접수를 거부했다고 응답한 것 -- 확실히 안 나갔다.
      err.definiteFailure = true
      // 상태 코드로 수신자 탓인지 계정·설정 탓인지 가린다(classifySendFailure).
      if (firstErr?.statusCode !== undefined && firstErr?.statusCode !== null) err.statusCode = String(firstErr.statusCode)
      throw err
    }
    logger.info('[solapi] 알림 발송 성공', {
      channel: useKakao ? 'alimtalk' : 'sms',
      storeId,
      recordId,
      recordType,
    })
    return result
  } catch (error) {
    const summary = attachLogSummary(error)
    logger.error('[solapi] 알림 발송 실패', {
      channel: useKakao ? 'alimtalk' : 'sms',
      storeId,
      recordId,
      recordType,
      ...summary,
    })
    throw error
  }
}

// --- 실패 로그 요약 ---------------------------------------------------------------
//
// 발송 실패의 error.message를 로그에 그대로 남기지 않는다. SDK의 BadRequestError(입력 검증 실패 -- 예: SOLAPI_SENDER에 공백·'+')는
// message가 수십 KB이고 끝에 요청 전체(받는 번호·본문)가 그대로 붙는다. 그대로 남기면 건마다 손님 전화번호와 광고 본문이 Cloud
// Logging에 쌓인다(호출부가 한 번 더 남기면 두 번). 그래서 요약값만 남긴다:
//   tag        SDK 오류 종류(_tag) 또는 우리 오류 코드(SOLAPI_TIMEOUT)
//   httpStatus 요청 전체를 거절한 응답의 HTTP 상태(ClientError)
//   statusCode 솔라피 메시지 상태 코드(우리 오류의 statusCode 또는 failedMessageList[0]) -- 원인(잔액·발신번호 등)을 가리는 열쇠
//   error      BadRequestError면 검증에 걸린 필드 경로만(값은 빼고, 예: 'from,(root)'), 그 밖에는 message를 300자로 자르고 전화번호를 가린 값
// 호출부(server.js)도 이 값(error.logSummary)을 쓴다 -- sendFailureLog.
const LOG_MESSAGE_MAX_LENGTH = 300
// 국내 전화번호 모양(0 또는 +82로 시작, 국번·가운데·끝자리, 사이 하이픈·공백 허용) -- 01012345678, 010-1234-5678, 02 1234 5678,
// +82 10-1234-5678. 다른 숫자에 붙어 있으면(긴 ID의 일부) 건드리지 않고, 상태 코드(1030)·날짜(2026-10-23)도 그대로 둔다.
const PHONE_LIKE_RE = /(?<!\d)(?:\+?82[-\s]?0?|0)\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}(?!\d)/g

function maskPhoneLike(text) {
  return String(text ?? '').replace(PHONE_LIKE_RE, '[번호]')
}

function summarizeSendError(error) {
  if (!error || typeof error !== 'object') {
    return { tag: null, httpStatus: null, statusCode: null, error: maskPhoneLike(error).slice(0, LOG_MESSAGE_MAX_LENGTH) }
  }
  const statusCode = error.statusCode ?? error.failedMessageList?.[0]?.statusCode ?? null
  let message
  if (error._tag === 'BadRequestError') {
    // validationErrors는 'from: 전화번호는 …' / '(root): Expected …, actual {"to":"010…"}' 모양이다. ':' 앞의 경로만 남긴다.
    const paths = Array.isArray(error.validationErrors)
      ? [...new Set(error.validationErrors.map((v) => String(v).split(':')[0].trim()).filter(Boolean))]
      : []
    message = paths.length ? `validation: ${paths.join(',')}`.slice(0, LOG_MESSAGE_MAX_LENGTH) : 'validation'
  } else {
    // 자르기 전에 가린다 -- 자른 끝에 번호 일부가 남지 않게.
    message = maskPhoneLike(error.message).slice(0, LOG_MESSAGE_MAX_LENGTH)
  }
  const httpStatus = Number(error.httpStatus)
  return {
    tag: error._tag || error.code || null,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
    statusCode: statusCode === null || statusCode === undefined || statusCode === '' ? null : String(statusCode),
    error: message,
  }
}

// 요약을 만들어 오류에 붙인다(error.logSummary). 이미 붙어 있으면 그대로 쓴다. 붙이지 못하는 값(문자열 throw 등)이면 요약만 돌려준다.
function attachLogSummary(error) {
  if (error && typeof error === 'object' && error.logSummary) return error.logSummary
  const summary = summarizeSendError(error)
  if (error && typeof error === 'object') {
    try { error.logSummary = summary } catch { /* 얼린 객체 등 -- 요약만 돌려준다 */ }
  }
  return summary
}

// server.js의 발송 실패 로그용. { tag, httpStatus, statusCode, error } -- 로그 meta에 펼쳐 넣는다.
function sendFailureLog(error) {
  return attachLogSummary(error)
}

// Design Ref: docs/01-plan/features/multi-store-support.plan.md §7.2 (알림톡 발신 정책)
// Phase 4: 발신번호/카카오채널은 브랜드 전체 공용(SOLAPI_SENDER/SOLAPI_KAKAO_PFID 그대로) — 매장 구분은
// #{매장명} 변수로만 한다. 매장별 발신번호가 필요해지면(프랜차이즈 개별 사업자 전환 시) 이 함수들에
// storeId 인자를 추가해 store.phone_sender를 조회하도록 확장하면 된다.

// 예약 접수 완료 (대기번호 발급). 앞에 대기자가 없어도 호출 알림은 보내지 않고
// 모든 예약에 접수 알림만 보낸다. 순서 호출은 직원의 명시적인 호출 동작에서만 보낸다.
async function sendReservationAlimtalk({ phone, carNumber, queueNumber, peopleAhead, serviceType, storeName, storeId, reservationId }) {
  const waitingMessage = peopleAhead === 0
    ? '현재 대기 중이며 직원 호출 후 순서 안내를 드립니다.'
    : `앞으로 ${peopleAhead}명 남았습니다.`
  return sendAlimtalk({
    phone,
    storeId,
    recordId: reservationId,
    recordType: 'reservation',
    text: `[${storeName || '예약 접수'}]\n차량번호 ${carNumber} · ${serviceType} 예약이 접수되었습니다.\n대기번호 ${queueNumber}번, ${waitingMessage}`,
    templateId: process.env.SOLAPI_KAKAO_TEMPLATE_RESERVATION,
    variables: {
      '#{매장명}': storeName || '',
      '#{차량번호}': carNumber,
      '#{전화번호}': phone,
      '#{대기번호}': String(queueNumber),
      '#{대기인원}': String(peopleAhead),
      '#{정비항목}': serviceType,
    },
  })
}

// 순서가 되어 고객을 호출할 때
async function sendQueueTurnAlimtalk({ phone, carNumber, queueNumber, serviceType, storeName, storeId, reservationId }) {
  return sendAlimtalk({
    phone,
    storeId,
    recordId: reservationId,
    recordType: 'reservation',
    text: `[${storeName || '순서 안내'}]\n${queueNumber}번, 고객님의 순서입니다. (차량번호 ${carNumber} · ${serviceType})`,
    templateId: process.env.SOLAPI_KAKAO_TEMPLATE_QUEUE_TURN,
    variables: {
      '#{매장명}': storeName || '',
      '#{차량번호}': carNumber,
      '#{대기번호}': String(queueNumber),
      '#{정비항목}': serviceType,
    },
  })
}

// 정비 완료(출고) 안내. 직원이 [완료]를 누를 때 보낸다. 카카오 템플릿(SOLAPI_KAKAO_TEMPLATE_REPAIR_DONE)이
// 승인되기 전에는 일반 문자로 나간다(sendAlimtalk 참고).
async function sendRepairDoneAlimtalk({ phone, carNumber, serviceType, storeName, storeId, reservationId }) {
  return sendAlimtalk({
    phone,
    storeId,
    recordId: reservationId,
    recordType: 'reservation',
    text: `[${storeName || '정비 완료'}]\n차량번호 ${carNumber} 정비가 완료되었습니다. 차량을 찾으러 와주세요.`,
    templateId: process.env.SOLAPI_KAKAO_TEMPLATE_REPAIR_DONE,
    variables: {
      '#{매장명}': storeName || '',
      '#{차량번호}': carNumber,
      '#{정비항목}': serviceType || '',
    },
  })
}

// 결제 완료 전자영수증. carNumber/serviceType은 결제 화면에서 다시 입력받는 게 아니라
// 전화번호로 찾은 예약 기록에서 가져온 값이라 없을 수도 있다(예약 없이 바로 결제한 손님).
async function sendReceiptAlimtalk({ phone, carNumber, serviceType, amount, storeName, storeId, paymentId }) {
  const amountText = amount != null ? `${Number(amount).toLocaleString('ko-KR')}원` : ''
  return sendAlimtalk({
    phone,
    storeId,
    recordId: paymentId,
    recordType: 'payment',
    text: `[${storeName || '전자영수증'}]\n결제가 완료되었습니다.${carNumber ? `\n차량번호 ${carNumber}` : ''}${serviceType ? `\n정비항목 ${serviceType}` : ''}${amountText ? `\n결제금액 ${amountText}` : ''}`,
    templateId: process.env.SOLAPI_KAKAO_TEMPLATE_RECEIPT,
    variables: {
      '#{매장명}': storeName || '',
      '#{차량번호}': carNumber || '',
      '#{정비항목}': serviceType || '',
      '#{결제금액}': amountText,
    },
  })
}

// 결제 3개월 후 자동 홍보 알림톡. 정보통신망법 제50조(영리목적 광고성 정보 전송 제한)에 따라
// (1) 본문 맨 앞에 "(광고)" 표시, (2) 수신거부 방법을 본문 끝에 명시해야 한다 — 접수/순서/영수증
// 알림(sendReservationAlimtalk 등)은 거래에 부수하는 정보성 메시지라 이 규제 대상이 아니지만,
// 프로모션은 순수 광고이므로 반드시 붙인다(계약 §4). 문구는 PROMO_OPT_OUT_TEXT로 바꿀 수 있다
// (법무 검토 전 기본값이라 운영 반영 전 확정 필요 — .env.example 참고).
const DEFAULT_PROMO_OPT_OUT_TEXT = '무료수신거부: 매장으로 연락 주시면 즉시 처리해 드립니다.'

function promoOptOutText() {
  return process.env.PROMO_OPT_OUT_TEXT || DEFAULT_PROMO_OPT_OUT_TEXT
}

// 문자(SMS/LMS)로 나갈 때의 본문. 알림톡으로 나갈 때는 카카오에 승인된 템플릿 문구가 쓰인다.
// "(광고)" 바로 뒤에 전송자 명칭(매장명)을 둔다(정보통신망법 시행령 제61조 명시사항).
function buildPromoText(storeName) {
  const name = storeName || '저희 매장'
  return `(광고) ${name}\n그동안 ${name}을 이용해주셔서 감사합니다. 지금 다시 방문하시면 혜택을 드립니다.\n\n${promoOptOutText()}`
}

async function sendPromoAlimtalk({ phone, carNumber, storeName, storeId, paymentId }) {
  const optOutText = promoOptOutText()
  return sendAlimtalk({
    phone,
    storeId,
    recordId: paymentId,
    recordType: 'payment',
    text: buildPromoText(storeName),
    templateId: process.env.SOLAPI_KAKAO_TEMPLATE_PROMO,
    variables: {
      '#{매장명}': storeName || '',
      '#{차량번호}': carNumber || '',
      '#{수신거부}': optOutText,
    },
  })
}

// 발송 실패의 종류. 광고 발송 기록을 실패로 돌려 다시 보낼지, 그 번호의 실패로 셀지 정하는 데 쓴다.
//   'unknown'   결과를 모름 -- 시간 초과·네트워크 오류·5xx·응답 해석 실패·408. 문자 회사가 받아서 보냈을 수 있다(다시 보내면
//               같은 광고가 두 번 갈 수 있다).
//   'recipient' 이 수신자 때문에 확실히 안 나감 -- 수신거부(080·발신자 거부), 없는 번호·단말 사정, 카카오 미사용자·알림톡 차단.
//               그 번호로는 다시 보내도 같은 결과라 자동 홍보가 실패 횟수로 센다.
//   'provider'  발송사 계정·설정 탓으로 확실히 안 나감 -- 잔액 부족, API 키·인증 오류(ApiKeyError, 401·403), 발신번호 미등록·차단,
//               알림톡 템플릿·변수 불일치, 요청 한도(429), 요청 형식 오류(BadRequestError·4xx), 접수 서버 오류. 번호와 무관해
//               세면 안 된다(며칠 이어지면 그동안 차례가 온 손님들의 홍보가 영구히 닫힌다). 미루기만 하고, 이어지면 실행을 멈춘다.
// 상태 코드는 솔라피 메시지 상태 코드표 기준(1xxx 접수 단계, 2xxx 플랫폼 처리, 3xxx 통신사·카카오 결과). 아래 목록에 없는 코드는
// 'provider'로 본다 -- 세지 않고 미루는 쪽이 되돌릴 수 있다(목록에 없는 수신자 탓 코드라면 그 결제는 하루마다 다시 시도될 뿐이다).
const RECIPIENT_STATUS_CODES = new Set([
  '1061', '2061', '3061', // 080 무료 수신거부
  '1065', '2065', // 발신자 수신거부
  '3010', // 수신번호 형식 오류
  '3031', '3032', '3041', '3042', '3043', '3044', '3045', '3046', '3047', '3050', '3051', '3062', // 단말·가입자 사정
  '3055', // 수신자가 스팸 차단 등록한 번호
  '3102', '3104', '3107', // 카카오: 친구 아님·카카오톡 미사용자·72시간 미사용 또는 알림톡 차단
])

// 오류에 실린 상태 코드들(solapi.js가 만든 오류의 statusCode, SDK MessageNotReceivedError의 failedMessageList).
function failureStatusCodes(error) {
  const codes = []
  if (error.statusCode !== undefined && error.statusCode !== null && error.statusCode !== '') codes.push(String(error.statusCode))
  if (Array.isArray(error.failedMessageList)) {
    for (const m of error.failedMessageList) {
      if (m?.statusCode !== undefined && m?.statusCode !== null && m?.statusCode !== '') codes.push(String(m.statusCode))
    }
  }
  return codes
}

function classifySendFailure(error) {
  if (!error) return 'unknown'
  if (error.code === 'SOLAPI_TIMEOUT') return 'unknown'
  const codes = failureStatusCodes(error)
  if (codes.length) return codes.every((c) => RECIPIENT_STATUS_CODES.has(c)) ? 'recipient' : 'provider'
  // 보내기 전에 SDK가 거절했다(키 없음·요청 형식). 번호는 정규화된 값만 쓰므로 설정 탓으로 본다.
  if (error._tag === 'ApiKeyError' || error._tag === 'BadRequestError') return 'provider'
  // HMAC 서명을 만들지 못했다(보내기 전).
  if (error._tag === 'DefaultError' && error.errorCode === 'AuthError') return 'provider'
  if (error._tag === 'ClientError') {
    const status = Number(error.httpStatus)
    if (status === 408) return 'unknown'
    // 요청 전체를 거절한 응답(인증·권한·잔액·한도·형식) -- 수신자와 무관하다.
    if (status >= 400 && status < 500) return 'provider'
    return 'unknown'
  }
  // 상태 코드 없이 접수 거부만 알 수 있는 경우(예전 형식)는 예전처럼 그 번호의 실패로 본다.
  if (error._tag === 'MessageNotReceivedError' || error.definiteFailure === true) return 'recipient'
  return 'unknown'
}

// 발송 실패가 "확실히 안 나간" 것인지(수신자 탓이든 계정·설정 탓이든). 광고 발송 기록을 실패로 돌려 다시 보낼 수 있게 할지 정한다.
// 429(요청 한도)도 확실한 실패다 -- 요청 자체를 받지 않았다는 응답이라, 예전처럼 "결과 모름"으로 두면 안 나간 광고를 보낸 것으로
// 닫거나 그 번호를 30일 동안 막는다.
function isDefiniteSendFailure(error) {
  return classifySendFailure(error) !== 'unknown'
}

module.exports = {
  sendReservationAlimtalk,
  sendQueueTurnAlimtalk,
  sendReceiptAlimtalk,
  sendRepairDoneAlimtalk,
  sendPromoAlimtalk,
  buildPromoText,
  isDefiniteSendFailure,
  classifySendFailure,
  summarizeSendError,
  sendFailureLog,
  DEFAULT_PROMO_OPT_OUT_TEXT,
}
