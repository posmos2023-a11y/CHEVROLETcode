const assert = require('node:assert/strict')
const { test } = require('node:test')

// solapi.js는 최상위에서 require('solapi')로 SDK를 가져와 SolapiMessageService를 생성한다.
// 실제 네트워크(문자 회사)를 타지 않으면서도 진짜 타임아웃 레이스 로직(withTimeout)을 검증하려면
// api.test.js처럼 sendXxxAlimtalk 함수 자체를 갈아끼우는 게 아니라, SDK 레벨(send 메서드)에서
// 느리게/빠르게 응답하도록 속여야 한다. require 캐시에 가짜 모듈을 먼저 심어 처리한다.
const solapiPkgPath = require.resolve('solapi')
let sendImpl = async () => ({ groupId: 'default' })
require.cache[solapiPkgPath] = {
  id: solapiPkgPath,
  filename: solapiPkgPath,
  loaded: true,
  exports: {
    SolapiMessageService: class {
      constructor() {}
      send(...args) {
        return sendImpl(...args)
      }
    },
  },
}

const solapi = require('../src/solapi')

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

test('send가 오래 걸리면 SOLAPI_TIMEOUT_MS 안에 시간 초과 에러를 던진다', async () => {
  process.env.SOLAPI_TIMEOUT_MS = '50'
  sendImpl = () => delay(2000, { groupId: 'slow' })
  try {
    await assert.rejects(
      () =>
        solapi.sendReceiptAlimtalk({
          phone: '01000000000',
          amount: 1000,
          storeName: '테스트매장',
          storeId: 1,
          paymentId: 1,
        }),
      (err) => {
        assert.match(err.message, /시간 초과/)
        assert.match(err.message, /0\.05초/)
        return true
      }
    )
  } finally {
    delete process.env.SOLAPI_TIMEOUT_MS
  }
})

test('send가 빠르면 타임아웃 없이 정상 결과를 반환한다', async () => {
  process.env.SOLAPI_TIMEOUT_MS = '2000'
  sendImpl = () => delay(10, { groupId: 'fast' })
  try {
    const result = await solapi.sendPromoAlimtalk({
      phone: '01000000000',
      storeName: '테스트매장',
      storeId: 1,
      paymentId: 1,
    })
    assert.equal(result.groupId, 'fast')
  } finally {
    delete process.env.SOLAPI_TIMEOUT_MS
  }
})

test('failedMessageList가 있으면 타임아웃과 무관하게 기존처럼 에러를 던진다', async () => {
  sendImpl = () =>
    Promise.resolve({ failedMessageList: [{ statusMessage: '잔액 부족' }] })
  await assert.rejects(
    () =>
      solapi.sendQueueTurnAlimtalk({
        phone: '01000000000',
        carNumber: '12가1234',
        queueNumber: 1,
        serviceType: '엔진오일',
        storeName: '테스트매장',
        storeId: 1,
        reservationId: 1,
      }),
    /잔액 부족/
  )
})

test('SOLAPI_TIMEOUT_MS에 음수가 들어가도 기본값으로 떨어진다', async () => {
  // 음수를 그대로 쓰면 setTimeout이 즉시 발화해 모든 발송이 죽는다. 오타 하나로 알림이
  // 전부 멈추는 건 실패보다 나쁘다 -- 원인이 안 보이기 때문이다.
  process.env.SOLAPI_TIMEOUT_MS = '-1'
  sendImpl = () => delay(30, { groupId: 'negative' })
  try {
    const result = await solapi.sendPromoAlimtalk({
      phone: '01000000000',
      storeName: '테스트매장',
      storeId: 1,
      paymentId: 1,
    })
    assert.equal(result.groupId, 'negative')
  } finally {
    delete process.env.SOLAPI_TIMEOUT_MS
  }
})

test('failedMessageList 오류와 시간 초과 오류는 확실한 실패/결과 모름으로 구분된다', async () => {
  sendImpl = () => Promise.resolve({ failedMessageList: [{ statusMessage: '수신번호 형식 오류' }] })
  const definite = await solapi.sendPromoAlimtalk({ phone: '01000000000', storeName: '테스트매장', storeId: 1 }).catch((e) => e)
  assert.equal(solapi.isDefiniteSendFailure(definite), true)

  process.env.SOLAPI_TIMEOUT_MS = '20'
  sendImpl = () => delay(500, { groupId: 'slow' })
  try {
    const timeout = await solapi.sendPromoAlimtalk({ phone: '01000000000', storeName: '테스트매장', storeId: 1 }).catch((e) => e)
    assert.equal(timeout.code, 'SOLAPI_TIMEOUT')
    assert.equal(solapi.isDefiniteSendFailure(timeout), false)
  } finally {
    delete process.env.SOLAPI_TIMEOUT_MS
  }
})

test('SDK 오류 태그: 접수 거부·잘못된 요청·4xx만 확실한 실패다', () => {
  const tagged = (props) => Object.assign(new Error('x'), props)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'MessageNotReceivedError' })), true)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'BadRequestError' })), true)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ApiKeyError' })), true)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ClientError', httpStatus: 400 })), true)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ClientError', httpStatus: 429 })), false)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ServerError', httpStatus: 500 })), false)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'NetworkError' })), false)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ResponseSchemaMismatchError' })), false)
  assert.equal(solapi.isDefiniteSendFailure(new Error('socket hang up')), false)
})

test('홍보 문자 본문은 "(광고) 매장명"으로 시작하고 수신거부 안내로 끝난다', () => {
  const text = solapi.buildPromoText('쉐보레 테스트점')
  assert.ok(text.startsWith('(광고) 쉐보레 테스트점\n'), text)
  assert.ok(text.endsWith(process.env.PROMO_OPT_OUT_TEXT || solapi.DEFAULT_PROMO_OPT_OUT_TEXT), text)
})
