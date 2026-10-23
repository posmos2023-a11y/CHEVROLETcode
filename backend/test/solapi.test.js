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
  // 요청 한도(429)는 요청을 받지 않았다는 응답이라 확실히 안 나갔다(발송사 쪽 사정 -- classifySendFailure 'provider').
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ClientError', httpStatus: 429 })), true)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ClientError', httpStatus: 408 })), false)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ServerError', httpStatus: 500 })), false)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'NetworkError' })), false)
  assert.equal(solapi.isDefiniteSendFailure(tagged({ _tag: 'ResponseSchemaMismatchError' })), false)
  assert.equal(solapi.isDefiniteSendFailure(new Error('socket hang up')), false)
})

test('실패 분류: 수신자 탓(수신거부·카카오 미사용자 등)과 계정·설정 탓(잔액·키·발신번호·템플릿·한도)과 결과 모름을 가른다', () => {
  const tagged = (props) => Object.assign(new Error('x'), props)
  const notReceived = (...codes) => tagged({ _tag: 'MessageNotReceivedError', failedMessageList: codes.map((statusCode) => ({ statusCode, statusMessage: 'x' })) })
  // 수신자 탓 -- 그 번호로는 다시 보내도 같다.
  for (const code of ['1061', '2061', '3061', '1065', '3010', '3104', '3107']) {
    assert.equal(solapi.classifySendFailure(notReceived(code)), 'recipient', code)
  }
  // 계정·설정 탓 -- 번호와 무관하다(잔액·계정·발신번호·템플릿·변수·스팸 필터·접수 서버 오류).
  for (const code of ['1030', '2230', '1020', '1062', '2062', '1060', '1042', '1043', '1057', '3105', '3101', '2254', '1024']) {
    assert.equal(solapi.classifySendFailure(notReceived(code)), 'provider', code)
  }
  // 표에 없는 코드는 세지 않는 쪽(provider)으로 본다.
  assert.equal(solapi.classifySendFailure(notReceived('9999')), 'provider')
  // 섞여 있으면 수신자 탓만으로 단정하지 않는다.
  assert.equal(solapi.classifySendFailure(notReceived('3104', '1030')), 'provider')
  assert.equal(solapi.classifySendFailure(tagged({ _tag: 'ApiKeyError' })), 'provider')
  assert.equal(solapi.classifySendFailure(tagged({ _tag: 'BadRequestError' })), 'provider')
  assert.equal(solapi.classifySendFailure(tagged({ _tag: 'DefaultError', errorCode: 'AuthError' })), 'provider')
  for (const httpStatus of [400, 401, 402, 403, 404, 429]) {
    assert.equal(solapi.classifySendFailure(tagged({ _tag: 'ClientError', httpStatus })), 'provider', String(httpStatus))
  }
  // 결과 모름
  assert.equal(solapi.classifySendFailure(tagged({ _tag: 'ClientError', httpStatus: 408 })), 'unknown')
  assert.equal(solapi.classifySendFailure(tagged({ _tag: 'ServerError', httpStatus: 503 })), 'unknown')
  assert.equal(solapi.classifySendFailure(tagged({ _tag: 'NetworkError' })), 'unknown')
  assert.equal(solapi.classifySendFailure(tagged({ _tag: 'DefaultError', errorCode: 'ParseError' })), 'unknown')
  assert.equal(solapi.classifySendFailure(tagged({ code: 'SOLAPI_TIMEOUT' })), 'unknown')
  assert.equal(solapi.classifySendFailure(new Error('socket hang up')), 'unknown')
  assert.equal(solapi.classifySendFailure(null), 'unknown')
  // 상태 코드 없는 예전 형식의 접수 거부는 예전처럼 그 번호의 실패다.
  assert.equal(solapi.classifySendFailure(tagged({ definiteFailure: true })), 'recipient')
  assert.equal(solapi.classifySendFailure(tagged({ _tag: 'MessageNotReceivedError' })), 'recipient')
})

test('실패 분류: failedMessageList로 거부되면 그 상태 코드를 오류에 실어 분류한다', async () => {
  sendImpl = () => Promise.resolve({ failedMessageList: [{ statusCode: '1030', statusMessage: '잔액 부족' }] })
  const balance = await solapi.sendPromoAlimtalk({ phone: '01000000000', storeName: '테스트매장', storeId: 1 }).catch((e) => e)
  assert.equal(balance.statusCode, '1030')
  assert.equal(solapi.classifySendFailure(balance), 'provider')
  assert.equal(solapi.isDefiniteSendFailure(balance), true)

  sendImpl = () => Promise.resolve({ failedMessageList: [{ statusCode: 3104, statusMessage: '카카오톡 미사용자' }] })
  const nonUser = await solapi.sendPromoAlimtalk({ phone: '01000000000', storeName: '테스트매장', storeId: 1 }).catch((e) => e)
  assert.equal(nonUser.statusCode, '3104')
  assert.equal(solapi.classifySendFailure(nonUser), 'recipient')
})

// --- R3: 실패 로그에 SDK 오류 메시지를 그대로 남기지 않는다 ----------------------------------------------------

// SOLAPI_SENDER 형식 오류 때 SDK가 내는 BadRequestError 모양(실측: message 약 46KB, 끝에 요청 전체가 붙는다)
function fakeBadRequestError(phone) {
  const actual = `actual {"to":"${phone}","from":"+82 2 1234","text":"(광고) 테스트매장\\n본문"}`
  return Object.assign(new Error(`${'Expected ReadonlyArray<...> '.repeat(1500)}${actual}`), {
    _tag: 'BadRequestError',
    validationErrors: [
      'from: 전화번호는 숫자 및 특수문자 - 외 문자를 포함할 수 없습니다.',
      'from: Expected undefined, actual "+82 2 1234"',
      `(root): Expected ReadonlyArray<{ readonly text?: string }>, ${actual}`,
    ],
  })
}

test('실패 로그 요약: BadRequestError는 검증에 걸린 필드 경로만, 그 밖에는 300자로 자르고 전화번호를 가린다', () => {
  const bad = solapi.summarizeSendError(fakeBadRequestError('01012345678'))
  assert.deepEqual(bad, { tag: 'BadRequestError', httpStatus: null, statusCode: null, error: 'validation: from,(root)' })

  const long = solapi.summarizeSendError(new Error(`수신번호 010-1234-5678, 01098765432 접수 실패 ${'가'.repeat(1000)}`))
  assert.equal(long.error.length, 300)
  assert.ok(long.error.startsWith('수신번호 [번호], [번호] 접수 실패'), long.error)
  assert.equal(/\d{9,}/.test(long.error.replace(/-/g, '')), false)
  // 상태 코드(4자리)·날짜는 그대로 둔다.
  assert.equal(solapi.summarizeSendError(new Error('1030 2061 2026-10-23')).error, '1030 2061 2026-10-23')

  const notReceived = Object.assign(new Error('1개의 메시지가 접수되지 못했습니다.'), {
    _tag: 'MessageNotReceivedError', failedMessageList: [{ statusCode: 1030, to: '01012345678' }],
  })
  assert.deepEqual(solapi.summarizeSendError(notReceived), { tag: 'MessageNotReceivedError', httpStatus: null, statusCode: '1030', error: '1개의 메시지가 접수되지 못했습니다.' })
  const limited = solapi.summarizeSendError(Object.assign(new Error('TooManyRequests: 요청 한도'), { _tag: 'ClientError', httpStatus: 429 }))
  assert.deepEqual({ tag: limited.tag, httpStatus: limited.httpStatus }, { tag: 'ClientError', httpStatus: 429 })
  const timeout = solapi.summarizeSendError(Object.assign(new Error('Solapi 발송 시간 초과 (10초)'), { code: 'SOLAPI_TIMEOUT' }))
  assert.equal(timeout.tag, 'SOLAPI_TIMEOUT')
  assert.equal(solapi.summarizeSendError(null).tag, null)
})

test('실패 로그 요약: 발송 실패 로그는 요약만 남기고 오류에 logSummary를 붙여 호출부가 같은 값을 쓴다', async () => {
  const logger = require('../src/logger')
  const original = logger.error
  const logs = []
  logger.error = (message, meta) => { logs.push({ message, meta }) }
  sendImpl = () => Promise.reject(fakeBadRequestError('01055556666'))
  let err
  try {
    err = await solapi.sendPromoAlimtalk({ phone: '01055556666', storeName: '테스트매장', storeId: 's1' }).catch((e) => e)
  } finally {
    logger.error = original
  }
  assert.equal(err._tag, 'BadRequestError') // 오류 자체는 그대로 던진다(분류는 호출부가 한다)
  assert.deepEqual(err.logSummary, { tag: 'BadRequestError', httpStatus: null, statusCode: null, error: 'validation: from,(root)' })
  assert.equal(solapi.sendFailureLog(err), err.logSummary)
  const log = logs.find((l) => l.message === '[solapi] 알림 발송 실패')
  assert.ok(log)
  assert.equal(log.meta.error, 'validation: from,(root)')
  const dumped = JSON.stringify(logs)
  assert.equal(dumped.includes('01055556666'), false, '로그에 손님 번호가 남았다')
  assert.ok(dumped.length < 1000, `로그가 너무 길다(${dumped.length}자)`)

  // failedMessageList로 거절된 경우는 상태 코드가 요약에 남는다.
  logs.length = 0
  logger.error = (message, meta) => { logs.push({ message, meta }) }
  sendImpl = () => Promise.resolve({ failedMessageList: [{ statusCode: '1062', statusMessage: '발신번호 미등록 01011112222' }] })
  try {
    err = await solapi.sendPromoAlimtalk({ phone: '01011112222', storeName: '테스트매장', storeId: 's1' }).catch((e) => e)
  } finally {
    logger.error = original
  }
  assert.deepEqual({ statusCode: err.logSummary.statusCode, error: err.logSummary.error }, { statusCode: '1062', error: '발신번호 미등록 [번호]' })
  assert.equal(JSON.stringify(logs).includes('01011112222'), false)
})

test('부팅 검사: SOLAPI_SENDER에 숫자·하이픈 말고 다른 글자가 있으면 경고한다(값은 남기지 않는다)', () => {
  const { spawnSync } = require('node:child_process')
  const path = require('node:path')
  const boot = (sender) => spawnSync(process.execPath, ['-e', "require('./server'); process.exit(0)"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', JWT_SECRET: 'boot-check', SOLAPI_SENDER: sender },
    encoding: 'utf8',
    timeout: 30000,
  })
  const bad = boot('+82 2-1234-5678')
  assert.equal(bad.status, 0, bad.stderr)
  assert.match(bad.stdout, /\[boot\] SOLAPI_SENDER에 숫자와 하이픈/)
  assert.equal(bad.stdout.includes('+82 2-1234-5678'), false)
  const good = boot('02-1234-5678')
  assert.equal(good.status, 0, good.stderr)
  assert.equal(good.stdout.includes('[boot] SOLAPI_SENDER'), false)
})

test('홍보 문자 본문은 "(광고) 매장명"으로 시작하고 수신거부 안내로 끝난다', () => {
  const text = solapi.buildPromoText('쉐보레 테스트점')
  assert.ok(text.startsWith('(광고) 쉐보레 테스트점\n'), text)
  assert.ok(text.endsWith(process.env.PROMO_OPT_OUT_TEXT || solapi.DEFAULT_PROMO_OPT_OUT_TEXT), text)
})
