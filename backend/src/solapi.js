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

// 카카오 알림톡용 pfId/템플릿ID가 아직 없으면(템플릿 승인 전) 일반 문자(SMS/LMS)로 대신 보낸다.
// 알림톡 템플릿이 승인되고 .env에 SOLAPI_KAKAO_PFID + 템플릿ID를 채우면 자동으로 알림톡으로 전환된다.
async function sendAlimtalk({ phone, text, templateId, variables, storeId, recordId, recordType }) {
  const pfId = process.env.SOLAPI_KAKAO_PFID
  const useKakao = Boolean(pfId && templateId)

  try {
    const result = await getService().send({
      to: phone,
      from: process.env.SOLAPI_SENDER,
      text,
      ...(useKakao
        ? { kakaoOptions: { pfId, templateId, variables, disableSms: true } }
        : {}),
    })

    const failed = result?.failedMessageList ?? result?.failed
    if (failed?.length) {
      const firstErr = failed[0]
      const msg = firstErr?.resultMessage ?? firstErr?.statusMessage ?? firstErr?.reason ?? JSON.stringify(firstErr)
      throw new Error(msg)
    }
    logger.info('[solapi] 알림 발송 성공', {
      channel: useKakao ? 'alimtalk' : 'sms',
      storeId,
      recordId,
      recordType,
    })
    return result
  } catch (error) {
    logger.error('[solapi] 알림 발송 실패', {
      channel: useKakao ? 'alimtalk' : 'sms',
      storeId,
      recordId,
      recordType,
      error: error.message,
    })
    throw error
  }
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

async function sendPromoAlimtalk({ phone, carNumber, storeName, storeId, paymentId }) {
  const optOutText = process.env.PROMO_OPT_OUT_TEXT || DEFAULT_PROMO_OPT_OUT_TEXT
  const body = `그동안 ${storeName || '저희 매장'}을 이용해주셔서 감사합니다. 지금 다시 방문하시면 혜택을 드립니다.`
  return sendAlimtalk({
    phone,
    storeId,
    recordId: paymentId,
    recordType: 'payment',
    text: `(광고)\n${body}\n\n${optOutText}`,
    templateId: process.env.SOLAPI_KAKAO_TEMPLATE_PROMO,
    variables: {
      '#{매장명}': storeName || '',
      '#{차량번호}': carNumber || '',
      '#{수신거부}': optOutText,
    },
  })
}

module.exports = {
  sendReservationAlimtalk,
  sendQueueTurnAlimtalk,
  sendReceiptAlimtalk,
  sendPromoAlimtalk,
}
