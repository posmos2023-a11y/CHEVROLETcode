// 2026-10-23 운영 개선 묶음 테스트: 손님 접수 한도·같은 차 중복 접수(C1), POS 대기열 이월·경과 시간(C2), 대기 접수 바로 완료(C3),
// POS 호출 알림 다시 보내기(C4), 프론트에 다시 띄우기(C5), 프론트 폴링 간격(C6), 직접 지정 토큰 기준·전체 인증 실패 기록(A2),
// 한도를 인증 뒤로(A3), 일일 배치 단계 격리(A8), 고정 이벤트 코드(A9), 응답 압축(A5).
//
// 다른 테스트 파일과 같은 컨벤션(node:test, supertest, testSerial, 로컬 devdb만, beforeEach TRUNCATE)을 따른다.
// ⚠️ package.json의 `--test-concurrency=1`을 지우지 말 것 -- 파일들이 같은 devdb를 TRUNCATE한다.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { after, before, beforeEach, test } = require('node:test')
const { URL } = require('node:url')
const request = require('supertest')

function requireLocalTestDatabase() {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) {
    throw new Error(
      'DATABASE_URL이 필요합니다. 운영 DB를 절대 사용하지 말고 localhost의 devdb를 실행한 뒤 npm test를 실행하세요.'
    )
  }
  const databaseUrl = new URL(rawUrl)
  const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
  const databaseName = databaseUrl.pathname.replace(/^\//, '')
  if (!localHosts.has(databaseUrl.hostname) || databaseName !== 'devdb' || process.env.NODE_ENV === 'production') {
    throw new Error('테스트는 localhost/devdb에서만 실행됩니다. 운영 Cloud SQL DATABASE_URL을 거부했습니다.')
  }
}

requireLocalTestDatabase()
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'local-test-jwt-secret'
process.env.TOSS_WEBHOOK_SECRET = ''

// 문자 발송을 가짜로 바꾼다. global.__failNotification = { method, error }면 그 메서드의 다음 호출 한 번만 그 오류로 실패한다.
const __solapi = require('../src/solapi')
global.__notifications = []
global.__failNotification = null
for (const method of ['sendReservationAlimtalk', 'sendQueueTurnAlimtalk', 'sendReceiptAlimtalk', 'sendRepairDoneAlimtalk', 'sendPromoAlimtalk']) {
  __solapi[method] = async (payload) => {
    global.__notifications.push({ method, payload })
    const fail = global.__failNotification
    if (fail && fail.method === method) {
      global.__failNotification = null
      throw fail.error
    }
    return { ok: true }
  }
}

const ERP_TOKEN = 'test-intake-ops-erp-token-0000'
process.env.ERP_API_TOKEN = ERP_TOKEN
process.env.PROMOTION_JOB_TOKEN = 'test-intake-ops-job-token'
// 한도는 server.js가 모듈 로드 시점에 읽는다 -- require보다 먼저, 테스트하기 좋게 낮춘다(DB 기반 한도는 beforeEach TRUNCATE로 리셋).
// 메모리 기반 IP 한도는 이 파일 전체에서 누적되므로 넉넉히 둔다.
process.env.RESERVATION_STORE_LIMIT_PER_10MIN = '6'
process.env.RESERVATION_PHONE_LIMIT_PER_10MIN = '3'
process.env.RESERVATION_IP_LIMIT_PER_MIN = '100000'
process.env.POS_WRITE_LIMIT_PER_MIN = '5'
process.env.ERP_STORE_LIMIT_PER_MIN = '3'
process.env.ERP_IP_LIMIT_PER_MIN = '100000'

const logger = require('../src/logger')
const { hashPassword, signAdminToken } = require('../src/auth')
const { prisma, kstDateString, purgeExpiredPersonalData } = require('../src/store')
const { app } = require('../server')

const testSerial = (name, fn) => test(name, { concurrency: false }, fn)

let sequence = 0
function unique(prefix) {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ErpCart", "ErpOrder", "RateLimitHit", "WebhookEvent", "Payment", "Reservation", "QueueCounter", "AdminUser", "Store" RESTART IDENTITY CASCADE'
  )
  global.__notifications.length = 0
  global.__failNotification = null
}

async function createStore(label, overrides = {}) {
  return prisma.store.create({
    data: {
      merchantId: unique(`merchant-${label}`),
      name: `테스트 매장 ${label}`,
      posToken: crypto.randomBytes(32).toString('hex'),
      erpStoreCode: unique(`ERP-${label}`).toUpperCase().replace(/[^A-Z0-9-]/g, '-'),
      ...overrides,
    },
  })
}

async function hqAuth() {
  const admin = await prisma.adminUser.create({
    data: {
      email: `${unique('hq')}@example.test`,
      passwordHash: await hashPassword('test-password-123'),
      role: 'hq_admin',
      storeId: null,
    },
  })
  return `Bearer ${signAdminToken(admin)}`
}

function intake(store, body = {}, headers = {}) {
  const req = request(app).post('/api/reservations')
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  return req.send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01012345678',
    serviceType: 'oil',
    privacyConsent: true,
    ...body,
  })
}

function posPost(store, path, body = {}) {
  return request(app).post(path).set('X-Store-Token', store.posToken).send(body)
}

function posQueue(store, query = '') {
  return request(app).get(`/api/pos/queue${query}`).set('X-Store-Token', store.posToken)
}

function postCart(body, token = ERP_TOKEN) {
  return request(app).post('/api/erp/carts').set('X-ERP-Token', token).send(body)
}

function validCart(store, overrides = {}) {
  return {
    storeCode: store.erpStoreCode,
    referenceId: unique('ERP-OPS-REF'),
    items: [{ productId: 'P-1001', name: '엔진오일 5W30 (4L)', category: '부품', unitPrice: 45000, quantity: 1 }],
    totalAmount: 45000,
    memo: '12가3456',
    ...overrides,
  }
}

function sent(method) {
  return global.__notifications.filter((n) => n.method === method)
}

// logger의 한 수준(error/warn/info)을 잠시 가로채 남긴 호출을 돌려준다.
async function captureLogs(level, fn) {
  const original = logger[level]
  const calls = []
  logger[level] = (message, meta) => { calls.push({ message, meta: meta || {} }) }
  try { await fn() } finally { logger[level] = original }
  return calls
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`
  await resetDatabase()
})

beforeEach(resetDatabase)

after(async () => {
  await prisma.$disconnect()
})

// --- C1 같은 차 중복 접수 -------------------------------------------------------------------

testSerial('C1 같은 차: 오늘 대기 중인 같은 차·같은 번호가 다시 접수하면 새 번호 없이 duplicate:true(대기번호·앞 대기 수·상태만)를 주고 알림도 다시 보내지 않는다', async () => {
  const store = await createStore('same-car')
  const first = await intake(store, { carNumber: '12가3456', phone: '01011110001' })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.queueNumber, 1)
  assert.equal(first.body.duplicate, undefined)

  // 띄어 쓰거나 하이픈을 넣어도 같은 차·같은 번호로 본다(정규화).
  const again = await intake(store, { carNumber: '12가 3456', phone: '010-1111-0001' })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.duplicate, true)
  assert.equal(again.body.queueNumber, 1)
  assert.equal(again.body.status, 'waiting')
  assert.equal(again.body.peopleAhead, 0)
  // 공개 경로라 기존 접수의 id·정비 항목·날짜는 싣지 않는다.
  assert.deepEqual(Object.keys(again.body).sort(), ['duplicate', 'ok', 'peopleAhead', 'queueNumber', 'status'])

  assert.equal(await prisma.reservation.count({ where: { storeId: store.id } }), 1)
  assert.equal(sent('sendReservationAlimtalk').length, 1)
  const stored = await prisma.reservation.findUnique({ where: { id: first.body.id } })
  assert.equal(stored.carNumber, '12가3456')
  assert.equal(stored.phone, '01011110001')
})

testSerial('C1 같은 차: 번호가 다르면 예전처럼 새 접수를 만들고 새 번호로 접수 문자를 보낸다(기존 접수의 번호는 그대로다)', async () => {
  const store = await createStore('same-car-other-phone')
  const first = await intake(store, { carNumber: '12가3456', phone: '01011110001' })
  assert.equal(first.status, 200, JSON.stringify(first.body))

  // 처음에 번호를 잘못 눌러 접수 문자를 못 받은 손님이 바른 번호로 다시 접수하는 경우다.
  const fixed = await intake(store, { carNumber: '12가-3456', phone: '01011110002' })
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body))
  assert.equal(fixed.body.duplicate, undefined)
  assert.notEqual(fixed.body.id, first.body.id)
  assert.equal(fixed.body.queueNumber, 2)
  assert.equal(fixed.body.status, 'waiting')

  assert.equal(await prisma.reservation.count({ where: { storeId: store.id } }), 2)
  assert.deepEqual(sent('sendReservationAlimtalk').map((n) => n.payload.phone), ['01011110001', '01011110002'])
  assert.equal((await prisma.reservation.findUnique({ where: { id: first.body.id } })).phone, '01011110001')
  assert.equal((await prisma.reservation.findUnique({ where: { id: fixed.body.id } })).phone, '01011110002')
})

testSerial('C1 같은 차: 같은 번호로 다시 접수하면 이번 광고 수신 선택을 기존 접수에 반영한다(동의 → 동의 시각, 거절 → 지움)', async () => {
  const store = await createStore('same-car-consent')
  const first = await intake(store, { carNumber: '45라6789', phone: '01033330001', marketingConsent: true })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const consentAt = (await prisma.reservation.findUnique({ where: { id: first.body.id } })).marketingConsentAt
  assert.ok(consentAt)

  const declined = await intake(store, { carNumber: '45라6789', phone: '01033330001', marketingConsent: false })
  assert.equal(declined.body.duplicate, true, JSON.stringify(declined.body))
  assert.equal((await prisma.reservation.findUnique({ where: { id: first.body.id } })).marketingConsentAt, null)

  const given = await intake(store, { carNumber: '45라6789', phone: '01033330001', marketingConsent: true })
  assert.equal(given.body.duplicate, true, JSON.stringify(given.body))
  const regiven = (await prisma.reservation.findUnique({ where: { id: first.body.id } })).marketingConsentAt
  assert.ok(regiven)
  assert.ok(regiven.getTime() >= consentAt.getTime())
  assert.equal(await prisma.reservation.count({ where: { storeId: store.id } }), 1)
  assert.equal(sent('sendReservationAlimtalk').length, 1)
})

testSerial('C1 같은 차: 호출된(called) 접수도 같은 차로 보고, 끝난(completed·cancelled) 접수 뒤에는 새로 접수한다', async () => {
  const store = await createStore('same-car-called')
  const first = await intake(store, { carNumber: '34나5678', phone: '01022220001' })
  assert.equal((await posPost(store, `/api/pos/queue/${first.body.id}/call`)).status, 200)

  const whileCalled = await intake(store, { carNumber: '34나5678', phone: '01022220001' })
  assert.equal(whileCalled.body.duplicate, true)
  assert.equal(whileCalled.body.queueNumber, first.body.queueNumber)
  assert.equal(whileCalled.body.status, 'called')
  assert.equal(whileCalled.body.peopleAhead, 0)

  assert.equal((await posPost(store, `/api/pos/queue/${first.body.id}/complete`)).status, 200)
  const afterDone = await intake(store, { carNumber: '34나5678', phone: '01022220001' })
  assert.equal(afterDone.status, 200)
  assert.equal(afterDone.body.duplicate, undefined)
  assert.notEqual(afterDone.body.id, first.body.id)
  assert.equal(afterDone.body.queueNumber, 2)
})

testSerial('C1 같은 차: 동시에 들어온 같은 차·같은 번호 접수는 하나만 만들어지고 모두 같은 번호를 받는다(번호가 다르면 각각 만든다)', async () => {
  const store = await createStore('same-car-race')
  // 이 파일은 같은 번호 한도를 10분 3건으로 낮춰 뒀다 -- 3건까지만 보낸다.
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => intake(store, { carNumber: '56다7890', phone: '01033330000' }))
  )
  for (const r of responses) assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([...new Set(responses.map((r) => r.body.queueNumber))], [1])
  assert.equal(responses.filter((r) => r.body.duplicate === true).length, 2)
  assert.equal(await prisma.reservation.count({ where: { storeId: store.id } }), 1)
  assert.equal(sent('sendReservationAlimtalk').length, 1)

  const others = await Promise.all(
    ['01033330001', '01033330002'].map((phone) => intake(store, { carNumber: '67마8901', phone }))
  )
  for (const r of others) {
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.duplicate, undefined)
  }
  assert.deepEqual(others.map((r) => r.body.queueNumber).sort(), [2, 3])
  assert.equal(await prisma.reservation.count({ where: { storeId: store.id, carNumber: '67마8901' } }), 2)
})

testSerial('C1 앞 대기 수(peopleAhead)는 아직 호출되지 않은 대기 손님만 센다', async () => {
  const store = await createStore('people-ahead')
  const a = await intake(store, { carNumber: '11가1111', phone: '01044440001' })
  const b = await intake(store, { carNumber: '22가2222', phone: '01044440002' })
  const c = await intake(store, { carNumber: '33가3333', phone: '01044440003' })
  assert.deepEqual([a.body.peopleAhead, b.body.peopleAhead, c.body.peopleAhead], [0, 1, 2])
  assert.equal((await posPost(store, `/api/pos/queue/${a.body.id}/call`)).status, 200)

  // A는 호출돼 정비 중이라 세지 않는다 -- B, C만 앞에 있다.
  const d = await intake(store, { carNumber: '44가4444', phone: '01044440004' })
  assert.equal(d.body.peopleAhead, 2)
  assert.equal(sent('sendReservationAlimtalk').at(-1).payload.peopleAhead, 2)
  // 같은 차 재접수(C)의 앞 대기 수는 C보다 먼저 접수한 대기 손님(B)만이다.
  const cAgain = await intake(store, { carNumber: '33가3333', phone: '01044440003' })
  assert.equal(cAgain.body.duplicate, true, JSON.stringify(cAgain.body))
  assert.equal(cAgain.body.peopleAhead, 1)
  // Idempotency-Key 재시도도 같은 기준이다. 매장 한도(이 파일은 10분 6건)를 넘지 않게 다른 매장에서 본다.
  const store2 = await createStore('people-ahead-idem')
  const x = await intake(store2, { carNumber: '66가6666', phone: '01044440006' })
  assert.equal((await posPost(store2, `/api/pos/queue/${x.body.id}/call`)).status, 200)
  await intake(store2, { carNumber: '77가7777', phone: '01044440007' })
  const key = unique('idem')
  const e = await intake(store2, { carNumber: '55가5555', phone: '01044440005' }, { 'Idempotency-Key': key })
  const eRetry = await intake(store2, { carNumber: '55가5555', phone: '01044440005' }, { 'Idempotency-Key': key })
  assert.equal(e.body.peopleAhead, 1)
  assert.equal(eRetry.body.duplicate, true, JSON.stringify(eRetry.body))
  assert.equal(eRetry.body.queueNumber, e.body.queueNumber)
  assert.equal(eRetry.body.peopleAhead, 1)
  // Idempotency-Key 재시도도 중복 응답이라 같은 모양이다(id 등 세부값 없음).
  assert.deepEqual(Object.keys(eRetry.body).sort(), ['duplicate', 'ok', 'peopleAhead', 'queueNumber', 'status'])
})

// --- C1 접수 한도 ---------------------------------------------------------------------------

testSerial('C1 한도: 매장 한도를 넘으면 429 RATE_LIMITED(retryAfterSec)를 주고, 다른 매장은 같은 IP여도 접수된다', async () => {
  const storeA = await createStore('limit-a')
  const storeB = await createStore('limit-b')
  const codes = []
  let limited = null
  for (let i = 0; i < 7; i += 1) {
    const r = await intake(storeA, { carNumber: `7${i}가100${i}`, phone: `0105555000${i}` })
    codes.push(r.status)
    if (r.status === 429) limited = r
  }
  // 이 파일은 매장 한도를 10분 6건으로 낮춰 뒀다.
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429])
  assert.equal(limited.body.ok, false)
  assert.equal(limited.body.code, 'RATE_LIMITED')
  assert.equal(Number.isInteger(limited.body.retryAfterSec) && limited.body.retryAfterSec > 0, true, JSON.stringify(limited.body))
  assert.equal(typeof limited.body.error, 'string')
  assert.ok(limited.headers['retry-after'])
  assert.equal(await prisma.reservation.count({ where: { storeId: storeA.id } }), 6)

  // 예전에는 IP 하나로 셌다 -- 공인 IP를 같이 쓰는 다른 매장은 영향이 없어야 한다.
  const other = await intake(storeB, { carNumber: '80가8000', phone: '01055559999' })
  assert.equal(other.status, 200, JSON.stringify(other.body))
})

testSerial('C1 한도: 같은 번호로 계속 접수하면 번호 한도에서 429 RATE_LIMITED를 주고, 다른 번호는 같은 매장에서 접수된다', async () => {
  const store = await createStore('limit-phone')
  const codes = []
  for (let i = 0; i < 4; i += 1) {
    codes.push((await intake(store, { carNumber: `9${i}가900${i}`, phone: '01066660000' })).status)
  }
  // 번호 한도를 10분 3건으로 낮춰 뒀다.
  assert.deepEqual(codes, [200, 200, 200, 429])
  assert.equal(sent('sendReservationAlimtalk').length, 3)
  const otherPhone = await intake(store, { carNumber: '99가9999', phone: '01066660001' })
  assert.equal(otherPhone.status, 200)
})

testSerial('C1 한도: 본문 검증에 실패한 요청(400)은 매장 한도를 쓰지 않는다 -- 빈 본문을 계속 보내도 그 매장 접수는 막히지 않는다', async () => {
  const store = await createStore('limit-invalid')
  // 이 파일의 매장(+IP) 한도는 10분 6건이다. 그보다 많이 보내도 400만 나와야 한다.
  for (let i = 0; i < 10; i += 1) {
    const bad = await request(app).post('/api/reservations').send({ merchantId: store.merchantId })
    assert.equal(bad.status, 400, JSON.stringify(bad.body))
  }
  const noConsent = await intake(store, { carNumber: '12가1001', phone: '01077000001', privacyConsent: false })
  assert.equal(noConsent.status, 400)
  const ok = await intake(store, { carNumber: '12가1002', phone: '01077000002' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const hits = await prisma.rateLimitHit.findMany({ where: { key: { startsWith: 'reservation-store:' } } })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].count, 1)
})

testSerial('C1 한도: 매장 한도는 매장+IP 단위다 -- 한 IP가 한도를 다 써도 같은 매장의 다른 IP 접수는 된다', async () => {
  const store = await createStore('limit-store-ip')
  const attacker = { 'X-Forwarded-For': '203.0.113.10' }
  const codes = []
  for (let i = 0; i < 7; i += 1) {
    codes.push((await intake(store, { carNumber: `8${i}가200${i}`, phone: `0108800000${i}` }, attacker)).status)
  }
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429])
  const shop = await intake(store, { carNumber: '89가2009', phone: '01088000009' }, { 'X-Forwarded-For': '198.51.100.20' })
  assert.equal(shop.status, 200, JSON.stringify(shop.body))
})

testSerial('C1 한도: 등록되지 않은 매장 요청은 한도보다 매장 확인이 먼저라 404를 받는다', async () => {
  const res = await request(app).post('/api/reservations').send({
    merchantId: 'no-such-merchant', carNumber: '12가3456', phone: '01012345678', serviceType: 'oil', privacyConsent: true,
  })
  assert.equal(res.status, 404)
  assert.equal(res.body.error, '아직 등록되지 않은 매장이에요. 직원에게 문의해주세요.')
})

// --- C2 POS 대기열 항목 ---------------------------------------------------------------------

testSerial('C2 대기열: 항목에 createdAt·calledAt·carriedOver가 실린다(오늘 접수분은 carriedOver false)', async () => {
  const store = await createStore('queue-fields')
  const a = await intake(store, { carNumber: '12가1212', phone: '01077770001' })
  await intake(store, { carNumber: '34가3434', phone: '01077770002' })
  assert.equal((await posPost(store, `/api/pos/queue/${a.body.id}/call`)).status, 200)
  const queue = await posQueue(store)
  assert.equal(queue.status, 200)
  const called = queue.body.reservations.find((r) => r.id === a.body.id)
  assert.ok(called.createdAt)
  assert.ok(called.calledAt)
  assert.equal(called.carriedOver, false)
  const waiting = queue.body.reservations.find((r) => r.id !== a.body.id)
  assert.equal(waiting.calledAt, null)
  assert.equal(waiting.carriedOver, false)
})

testSerial('C2 대기열: 어제 waiting은 ?carriedOver=1일 때만 carriedOver로 보이고(옛 탭앱에는 싣지 않는다), 호출은 404이고 취소는 된다', async () => {
  const store = await createStore('queue-carry')
  const yesterday = kstDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const r = await prisma.reservation.create({
    data: { storeId: store.id, carNumber: '12가9999', phone: '01088880000', serviceType: '정비', queueNumber: 7, serviceDate: yesterday, status: 'waiting' },
  })
  const calledYesterday = await prisma.reservation.create({
    data: { storeId: store.id, carNumber: '12가8888', phone: '01088880001', serviceType: '정비', queueNumber: 6, serviceDate: yesterday, status: 'called', calledAt: new Date() },
  })
  // carriedOver를 모르는 옛 탭앱(값 없음·다른 값)에는 예전처럼 어제 waiting을 싣지 않는다. 어제 called 이월은 그대로 실린다.
  for (const query of ['', '?carriedOver=0', '?carriedOver=true']) {
    const legacy = await posQueue(store, query)
    assert.equal(legacy.status, 200)
    const ids = legacy.body.reservations.map((x) => x.id)
    assert.ok(!ids.includes(r.id), query)
    assert.ok(ids.includes(calledYesterday.id), query)
  }
  const queue = await posQueue(store, '?carriedOver=1')
  const item = queue.body.reservations.find((x) => x.id === r.id)
  assert.equal(item.carriedOver, true)
  assert.equal(queue.body.reservations.find((x) => x.id === calledYesterday.id).carriedOver, false)
  assert.equal((await posPost(store, `/api/pos/queue/${r.id}/call`)).status, 404)
  assert.equal(sent('sendQueueTurnAlimtalk').length, 0)
  const cancel = await posPost(store, `/api/pos/queue/${r.id}/cancel`)
  assert.equal(cancel.status, 200)
  assert.equal(cancel.body.status, 'cancelled')
})

// --- C3 POS 정비완료 -------------------------------------------------------------------------

testSerial('C3 정비완료: 본문 notify:false면 완료 문자 없이 완료하고 notified:false를 준다(어제 넘어온 대기 정리)', async () => {
  const store = await createStore('complete-quiet')
  const yesterday = kstDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const r = await prisma.reservation.create({
    data: { storeId: store.id, carNumber: '12가7777', phone: '01066667777', serviceType: '정비', queueNumber: 3, serviceDate: yesterday, status: 'waiting' },
  })
  const res = await posPost(store, `/api/pos/queue/${r.id}/complete`, { notify: false })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.ok, true)
  assert.equal(res.body.status, 'completed')
  assert.equal(res.body.notified, false)
  assert.equal(sent('sendRepairDoneAlimtalk').length, 0)
  assert.equal((await prisma.reservation.findUnique({ where: { id: r.id } })).status, 'completed')

  // 본문이 없거나 notify:false가 아니면 예전처럼 완료 문자를 보낸다.
  const today = await intake(store, { carNumber: '34가7777', phone: '01066667778' })
  const loud = await posPost(store, `/api/pos/queue/${today.body.id}/complete`, { notify: 'false' })
  assert.equal(loud.status, 200, JSON.stringify(loud.body))
  assert.equal(loud.body.notified, true)
  assert.equal(sent('sendRepairDoneAlimtalk').length, 1)
})

testSerial('C3 정비완료: 이미 완료된 접수는 200 alreadyCompleted이고, 처음 읽은 뒤 다른 쪽이 먼저 완료한 경우도 같다(취소된 줄로 안내하지 않는다)', async () => {
  const store = await createStore('complete-race')
  const first = await intake(store, { carNumber: '12가4444', phone: '01044445555' })
  assert.equal((await posPost(store, `/api/pos/queue/${first.body.id}/call`)).status, 200)
  global.__notifications.length = 0

  // 이 요청이 상태를 읽은 뒤(called) 바꾸기 직전에 다른 POS가 먼저 완료한 상황을 만든다.
  const originalUpdateMany = prisma.reservation.updateMany
  let raced = false
  prisma.reservation.updateMany = async (args) => {
    if (!raced && args?.data?.status === 'completed') {
      raced = true
      await prisma.reservation.update({ where: { id: first.body.id }, data: { status: 'completed', completedAt: new Date() } })
    }
    return originalUpdateMany.call(prisma.reservation, args)
  }
  let res
  try {
    res = await posPost(store, `/api/pos/queue/${first.body.id}/complete`)
  } finally {
    prisma.reservation.updateMany = originalUpdateMany
  }
  assert.ok(raced)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.ok, true)
  assert.equal(res.body.alreadyCompleted, true)
  assert.equal(res.body.status, 'completed')
  assert.equal(sent('sendRepairDoneAlimtalk').length, 0)

  // 순서대로 다시 눌러도 같다.
  const again = await posPost(store, `/api/pos/queue/${first.body.id}/complete`)
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyCompleted, true)
  assert.equal(again.body.status, 'completed')

  // 그사이 취소된 경우만 '취소된 접수' 409다.
  const second = await intake(store, { carNumber: '12가4445', phone: '01044445556' })
  prisma.reservation.updateMany = async (args) => {
    if (args?.data?.status === 'completed') {
      await prisma.reservation.update({ where: { id: second.body.id }, data: { status: 'cancelled' } })
    }
    return originalUpdateMany.call(prisma.reservation, args)
  }
  let cancelled
  try {
    cancelled = await posPost(store, `/api/pos/queue/${second.body.id}/complete`)
  } finally {
    prisma.reservation.updateMany = originalUpdateMany
  }
  assert.equal(cancelled.status, 409)
  assert.equal(cancelled.body.status, 'cancelled')
  assert.match(cancelled.body.error, /취소된 접수/)
  assert.equal(sent('sendRepairDoneAlimtalk').length, 0)
})

// --- C4 POS 호출 알림 다시 보내기 -----------------------------------------------------------

async function notifyFailedReservation(store) {
  const r = await intake(store, { carNumber: '12가5555', phone: '01099990000' })
  global.__failNotification = { method: 'sendQueueTurnAlimtalk', error: Object.assign(new Error('강제 실패(테스트 전용)'), { definiteFailure: true }) }
  const call = await posPost(store, `/api/pos/queue/${r.body.id}/call`)
  assert.equal(call.body.status, 'notify_failed', JSON.stringify(call.body))
  global.__notifications.length = 0
  return r.body.id
}

testSerial('C4 다시 보내기: 호출 알림이 실패한 접수를 POS에서 다시 보내면 called로 바뀌고 notify:sent를 준다', async () => {
  const store = await createStore('retry-ok')
  const id = await notifyFailedReservation(store)
  const res = await posPost(store, `/api/pos/queue/${id}/retry-notify`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body, { ok: true, status: 'called', notify: 'sent' })
  assert.equal(sent('sendQueueTurnAlimtalk').length, 1)
  assert.equal((await prisma.reservation.findUnique({ where: { id } })).status, 'called')

  // 이미 보냈으면 409(다시 보낼 상태가 아니다)
  const again = await posPost(store, `/api/pos/queue/${id}/retry-notify`)
  assert.equal(again.status, 409)
  assert.equal(again.body.status, 'called')
  assert.equal(sent('sendQueueTurnAlimtalk').length, 1)
})

testSerial('C4 다시 보내기: 두 POS가 동시에 눌러도 한 번만 나간다', async () => {
  const store = await createStore('retry-race')
  const id = await notifyFailedReservation(store)
  const [a, b] = await Promise.all([
    posPost(store, `/api/pos/queue/${id}/retry-notify`),
    posPost(store, `/api/pos/queue/${id}/retry-notify`),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  assert.equal(sent('sendQueueTurnAlimtalk').length, 1)
})

testSerial('C4 다시 보내기: 다시 실패하면 notify_failed로 되돌리고 확실한 실패는 failed, 결과를 모르면 unknown을 준다', async () => {
  const store = await createStore('retry-fail')
  const id = await notifyFailedReservation(store)
  global.__failNotification = { method: 'sendQueueTurnAlimtalk', error: Object.assign(new Error('수신번호 오류'), { definiteFailure: true, statusCode: '3010' }) }
  const failed = await posPost(store, `/api/pos/queue/${id}/retry-notify`)
  assert.equal(failed.status, 502)
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.status, 'notify_failed')
  assert.equal(failed.body.notify, 'failed')
  assert.equal(typeof failed.body.error, 'string')
  assert.equal((await prisma.reservation.findUnique({ where: { id } })).status, 'notify_failed')

  global.__failNotification = { method: 'sendQueueTurnAlimtalk', error: Object.assign(new Error('시간 초과'), { code: 'SOLAPI_TIMEOUT' }) }
  const unknown = await posPost(store, `/api/pos/queue/${id}/retry-notify`)
  assert.equal(unknown.status, 502)
  assert.equal(unknown.body.ok, false)
  assert.equal(unknown.body.notify, 'unknown')
  assert.equal(unknown.body.status, 'notify_failed')
  assert.equal((await prisma.reservation.findUnique({ where: { id } })).status, 'notify_failed')
})

testSerial('C4 다시 보내기: 결과를 모르는(unknown) 발송이 진행 중일 때 다른 POS가 눌러도 409이고 한 번만 나간다', async () => {
  const store = await createStore('retry-unknown-lock')
  const id = await notifyFailedReservation(store)
  const original = __solapi.sendQueueTurnAlimtalk
  let release
  const gate = new Promise((resolve) => { release = resolve })
  __solapi.sendQueueTurnAlimtalk = async (payload) => {
    global.__notifications.push({ method: 'sendQueueTurnAlimtalk', payload })
    await gate
    throw Object.assign(new Error('시간 초과'), { code: 'SOLAPI_TIMEOUT' })
  }
  let first, second
  try {
    const firstP = posPost(store, `/api/pos/queue/${id}/retry-notify`).then((r) => r)
    // 첫 요청이 잠금(notify_failed → called)을 잡고 발송을 기다리는 중이 될 때까지 기다린다.
    for (let i = 0; i < 200 && sent('sendQueueTurnAlimtalk').length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(sent('sendQueueTurnAlimtalk').length, 1)
    second = await posPost(store, `/api/pos/queue/${id}/retry-notify`)
    release()
    first = await firstP
  } finally {
    release()
    __solapi.sendQueueTurnAlimtalk = original
  }
  assert.equal(second.status, 409)
  assert.equal(second.body.status, 'called')
  assert.equal(first.status, 502)
  assert.equal(first.body.ok, false)
  assert.equal(first.body.notify, 'unknown')
  assert.equal(first.body.status, 'notify_failed')
  assert.equal(sent('sendQueueTurnAlimtalk').length, 1)
  assert.equal((await prisma.reservation.findUnique({ where: { id } })).status, 'notify_failed')
})

testSerial('C4 다시 보내기: 대기 중인 접수는 409, 다른 매장 토큰은 404, 토큰이 없으면 401', async () => {
  const store = await createStore('retry-guard')
  const other = await createStore('retry-guard-other')
  const r = await intake(store, { carNumber: '12가6666', phone: '01012120000' })
  const waiting = await posPost(store, `/api/pos/queue/${r.body.id}/retry-notify`)
  assert.equal(waiting.status, 409)
  assert.equal(waiting.body.status, 'waiting')
  assert.equal((await posPost(other, `/api/pos/queue/${r.body.id}/retry-notify`)).status, 404)
  assert.equal((await request(app).post(`/api/pos/queue/${r.body.id}/retry-notify`)).status, 401)
  assert.equal(sent('sendQueueTurnAlimtalk').length, 0)
})

// --- C5·C6 프론트 ---------------------------------------------------------------------------

testSerial('C5 프론트에 다시 띄우기: 프론트 결제 대기 주문의 frontSentAt을 지금으로 바꾸고, 그 밖은 409와 상태를 준다', async () => {
  const store = await createStore('resend-front')
  const front = await postCart(validCart(store, { payTarget: 'front' }))
  assert.equal(front.status, 201, JSON.stringify(front.body))
  const before = await prisma.erpCart.findUnique({ where: { id: front.body.cartId } })
  await prisma.erpCart.update({ where: { id: before.id }, data: { frontSentAt: new Date(Date.now() - 5 * 60 * 1000) } })

  const res = await posPost(store, `/api/pos/erp-carts/${before.id}/resend-front`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.ok, true)
  assert.equal(res.body.status, 'pending')
  const after = await prisma.erpCart.findUnique({ where: { id: before.id } })
  assert.ok(after.frontSentAt.getTime() > Date.now() - 60 * 1000, '방금으로 바뀌어야 합니다')
  // 프론트 목록에도 새 값이 실린다(프론트가 쉬기 열쇠로 쓴다).
  const list = await request(app).get('/api/front/erp-carts').set('X-Store-Token', store.posToken)
  assert.equal(new Date(list.body.carts[0].frontSentAt).getTime(), after.frontSentAt.getTime())

  // 결제 중이면 409
  await prisma.erpCart.update({ where: { id: before.id }, data: { status: 'paying' } })
  const paying = await posPost(store, `/api/pos/erp-carts/${before.id}/resend-front`)
  assert.equal(paying.status, 409)
  assert.equal(paying.body.status, 'paying')

  // POS 결제 주문이면 409
  const pos = await postCart(validCart(store))
  const posRes = await posPost(store, `/api/pos/erp-carts/${pos.body.cartId}/resend-front`)
  assert.equal(posRes.status, 409)
  assert.equal(posRes.body.status, 'pending')
  assert.equal(posRes.body.payTarget, 'pos')

  // 다른 매장 토큰은 404
  const other = await createStore('resend-front-other')
  assert.equal((await posPost(other, `/api/pos/erp-carts/${before.id}/resend-front`)).status, 404)
})

testSerial('C6 프론트 폴링 응답에 pollMs(3000)가 실린다', async () => {
  const store = await createStore('poll-ms')
  const res = await request(app).get('/api/front/erp-carts').set('X-Store-Token', store.posToken)
  assert.equal(res.status, 200)
  assert.equal(res.body.pollMs, 3000)
})

// --- A2 토큰 ----------------------------------------------------------------------------------

testSerial('A2 직접 지정 토큰: 12자 미만이거나 영문·숫자가 섞이지 않으면 거절하고, 이미 발급된 짧은 토큰은 그대로 쓰이며 목록에 약한 토큰으로 표시된다', async () => {
  const authorization = await hqAuth()
  const store = await createStore('token-rule')
  const setToken = (posToken) => request(app).post(`/api/admin/stores/${store.id}/pos-token`).set('Authorization', authorization).send({ posToken })

  for (const bad of ['gn01', 'abcdefghijkl', '123456789012', 'gangnam 01pos']) {
    const res = await setToken(bad)
    assert.equal(res.status, 400, `${bad}: ${JSON.stringify(res.body)}`)
  }
  const good = await setToken('gangnam01pos')
  assert.equal(good.status, 200, JSON.stringify(good.body))
  assert.equal(good.body.posToken, 'gangnam01pos')

  // 예전 기준(4자)으로 지정해 둔 토큰은 계속 동작한다.
  const legacy = await createStore('token-legacy', { posToken: 'gn01' })
  assert.equal((await request(app).get('/api/pos/queue').set('X-Store-Token', 'gn01')).status, 200)

  const list = await request(app).get('/api/admin/stores').set('Authorization', authorization)
  const byId = new Map(list.body.stores.map((s) => [s.id, s]))
  assert.equal(byId.get(legacy.id).weakPosToken, true)
  assert.equal(byId.get(store.id).weakPosToken, false)
  assert.ok(!JSON.stringify(list.body).includes('gn01'), '목록에 토큰 값이 실리면 안 됩니다')
})

testSerial('A2 전체 인증 실패 수가 15분에 300회를 넘으면 pos_auth_bruteforce 오류 로그를 남긴다(막지는 않는다)', async () => {
  await prisma.$executeRaw`INSERT INTO "RateLimitHit" ("key", "windowStart", "count") VALUES ('pos-auth-global:all', ${new Date()}, 300)`
  const logs = await captureLogs('error', async () => {
    const res = await request(app).get('/api/pos/queue').set('X-Store-Token', 'definitely-wrong-token')
    assert.equal(res.status, 401)
  })
  const alert = logs.find((l) => l.meta.event === 'pos_auth_bruteforce')
  assert.ok(alert, JSON.stringify(logs))
  assert.equal(alert.meta.failures, 301)
  // 다음 실패(302)는 다시 남기지 않는다(넘는 순간 한 번, 그 뒤 100회마다).
  const quiet = await captureLogs('error', async () => {
    await request(app).get('/api/pos/queue').set('X-Store-Token', 'definitely-wrong-token-2')
  })
  assert.equal(quiet.filter((l) => l.meta.event === 'pos_auth_bruteforce').length, 0)
})

// --- A3 한도를 인증 뒤로 -------------------------------------------------------------------

testSerial('A3 POS 상태 변경 한도는 매장 단위다: 한 매장이 한도를 넘겨도 같은 IP의 다른 매장은 그대로 된다', async () => {
  const storeA = await createStore('pos-limit-a')
  const storeB = await createStore('pos-limit-b')
  const codesA = []
  // 이 파일은 POS 상태 변경 한도를 분당 5회로 낮춰 뒀다. 없는 주문 지우기는 404지만 한도는 센다.
  for (let i = 0; i < 6; i += 1) codesA.push((await posPost(storeA, '/api/pos/queue/no-such-id/cancel')).status)
  assert.deepEqual(codesA, [404, 404, 404, 404, 404, 429])
  const resB = await posPost(storeB, '/api/pos/queue/no-such-id/cancel')
  assert.equal(resB.status, 404, '다른 매장은 한도에 걸리지 않아야 합니다')
})

testSerial('A3 전산 매장 한도는 토큰 확인 뒤에 센다: 토큰이 틀린 요청이 매장 한도를 써버리지 못한다', async () => {
  const store = await createStore('erp-after-auth')
  for (let i = 0; i < 5; i += 1) {
    const res = await postCart(validCart(store), 'wrong-erp-token')
    assert.equal(res.status, 401)
    assert.equal(res.body.error, 'ERP 토큰이 올바르지 않아요.')
  }
  // 매장 한도(이 파일은 분당 3회)를 남이 써버렸다면 여기서 429가 난다.
  const real = await postCart(validCart(store))
  assert.equal(real.status, 201, JSON.stringify(real.body))
})

// --- A8 일일 배치 -----------------------------------------------------------------------------

testSerial('A8 파기 배치: 한 단계가 실패해도 나머지 단계(만료 포함)는 끝까지 돌고, 실패는 errors에 남는다', async () => {
  const store = await createStore('purge-isolate')
  const stale = await postCart(validCart(store))
  await prisma.erpCart.update({ where: { id: stale.body.cartId }, data: { createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) } })
  const old = new Date(Date.now() - 4000 * 24 * 60 * 60 * 1000)
  const order = await prisma.erpOrder.create({
    data: {
      storeId: store.id, referenceId: unique('ERP-ORDER'), tossOrderKey: unique('toss-key'), totalAmount: 1000,
      itemsJson: JSON.stringify([{ name: '12가3456 김민준님', unitPrice: 1000, quantity: 1 }]), memo: '12가3456 김민준님',
      tossRawJson: JSON.stringify({ memo: '12가3456 김민준님' }), errorMessage: '토스 오류: 12가3456', createdAt: old,
    },
  })

  const originalFindMany = prisma.reservation.findMany
  prisma.reservation.findMany = async () => { throw new Error('canceling statement due to statement timeout') }
  let result
  try {
    result = await purgeExpiredPersonalData()
  } finally {
    prisma.reservation.findMany = originalFindMany
  }
  assert.equal(result.reservations, null)
  assert.match(result.errors.reservations, /statement timeout/)
  assert.equal(result.expiredErpCarts, 1)
  assert.equal(result.erpOrders, 1)
  assert.equal((await prisma.erpCart.findUnique({ where: { id: stale.body.cartId } })).status, 'expired')
  const purged = await prisma.erpOrder.findUnique({ where: { id: order.id } })
  assert.equal(purged.memo, null)
  assert.equal(purged.tossRawJson, null)
  assert.equal(purged.errorMessage, null)
  assert.equal(purged.itemsJson, '[]')

  const clean = await purgeExpiredPersonalData()
  assert.equal(clean.errors, undefined)
})

testSerial('A8 배치 경로: 성공하면 job_finished 로그와 200, 단계가 실패하면 job_failed 로그와 500(재시도용)을 준다', async () => {
  const job = () => request(app).post('/internal/jobs/purge-expired').set('X-Promotion-Job-Token', process.env.PROMOTION_JOB_TOKEN)
  const okLogs = await captureLogs('info', async () => {
    const res = await job()
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.ok, true)
  })
  const finished = okLogs.find((l) => l.meta.event === 'job_finished')
  assert.ok(finished)
  assert.equal(finished.meta.job, 'purge-expired')

  const originalFindMany = prisma.payment.findMany
  prisma.payment.findMany = async () => { throw new Error('강제 실패(테스트 전용)') }
  let failLogs
  try {
    failLogs = await captureLogs('error', async () => {
      const res = await job()
      assert.equal(res.status, 500)
      assert.equal(res.body.ok, false)
      assert.match(res.body.errors.payments, /강제 실패/)
      assert.equal(typeof res.body.reservations, 'number')
    })
  } finally {
    prisma.payment.findMany = originalFindMany
  }
  assert.ok(failLogs.find((l) => l.meta.event === 'job_failed' && l.meta.job === 'purge-expired'))

  const promoLogs = await captureLogs('info', async () => {
    const res = await request(app).post('/internal/jobs/send-promotions').set('X-Promotion-Job-Token', process.env.PROMOTION_JOB_TOKEN)
    assert.equal(res.status, 200)
  })
  assert.ok(promoLogs.find((l) => l.meta.event === 'job_finished' && l.meta.job === 'send-promotions'))
})

// --- A9 고정 이벤트 코드 ---------------------------------------------------------------------

testSerial('A9 전산 주문: 201에 storeName이 실리고, 등록되지 않은 전산 코드는 erp_rejected 경고를 남긴다', async () => {
  const store = await createStore('erp-event')
  const created = await postCart(validCart(store))
  assert.equal(created.status, 201)
  assert.equal(created.body.storeName, store.name)

  const body = validCart(store, { storeCode: 'NO-SUCH-CODE' })
  const logs = await captureLogs('warn', async () => {
    const res = await postCart(body)
    assert.equal(res.status, 404)
    assert.equal(res.body.error, '등록되지 않은 전산 코드예요.')
  })
  const rejected = logs.find((l) => l.meta.event === 'erp_rejected')
  assert.ok(rejected, JSON.stringify(logs))
  assert.equal(rejected.meta.status, 404)
  assert.equal(rejected.meta.storeCode, 'NO-SUCH-CODE')
  assert.equal(rejected.meta.referenceId, body.referenceId)
  assert.ok(!JSON.stringify(rejected.meta).includes('12가3456'), '거절 기록에 차량번호(memo)를 남기면 안 됩니다')
})

testSerial('A9 전산 주문: 전산 코드로 찾은 매장과 사업자번호가 다르면 erp_store_mismatch 경고만 남기고 주문은 받는다', async () => {
  const store = await createStore('erp-mismatch', { businessNumber: '123-45-67890' })
  const logs = await captureLogs('warn', async () => {
    const res = await postCart(validCart(store, { businessNumber: '9876543210' }))
    assert.equal(res.status, 201, JSON.stringify(res.body))
  })
  const mismatch = logs.find((l) => l.meta.event === 'erp_store_mismatch')
  assert.ok(mismatch, JSON.stringify(logs))
  assert.equal(mismatch.meta.storeId, store.id)

  const sameLogs = await captureLogs('warn', async () => {
    assert.equal((await postCart(validCart(store, { businessNumber: '1234567890' }))).status, 201)
  })
  assert.equal(sameLogs.filter((l) => l.meta.event === 'erp_store_mismatch').length, 0)
})

testSerial('A9 웹훅 서명이 틀리면 webhook_signature_failed 오류 로그를 남긴다', async () => {
  const previous = process.env.TOSS_WEBHOOK_SECRET
  process.env.TOSS_WEBHOOK_SECRET = 'intake-ops-webhook-secret'
  let logs
  try {
    logs = await captureLogs('error', async () => {
      const res = await request(app)
        .post('/api/webhooks/toss/payment')
        .set('x-toss-webhook-id', unique('wh'))
        .set('x-toss-timestamp', String(Date.now()))
        .set('x-toss-signature', 'v1=deadbeef')
        .send({ type: 'payment.payment.approved.v1', data: { payment: {} } })
      assert.equal(res.status, 401)
    })
  } finally {
    process.env.TOSS_WEBHOOK_SECRET = previous
  }
  assert.ok(logs.find((l) => l.meta.event === 'webhook_signature_failed'), JSON.stringify(logs))
})

// --- A5 응답 압축 ---------------------------------------------------------------------------

testSerial('A5 1KB가 넘는 응답은 Accept-Encoding: gzip이면 압축하고, 작은 응답은 그대로 보낸다', async () => {
  const big = await request(app).get('/admin.html').set('Accept-Encoding', 'gzip')
  assert.equal(big.status, 200)
  assert.equal(big.headers['content-encoding'], 'gzip')
  const small = await request(app).get('/health').set('Accept-Encoding', 'gzip')
  assert.equal(small.status, 200)
  assert.equal(small.headers['content-encoding'], undefined)
})
