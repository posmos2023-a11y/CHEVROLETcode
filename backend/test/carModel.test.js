// 손님 접수의 차종(carModel, 선택 입력) 테스트: 서버 정리 규칙(공백·제어문자·30자·빈 값), 저장, 같은 차·같은 번호 재접수 때 고치기,
// POS 대기열·정비 이력·관리자 목록 응답, 파기(익명화).
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
// 한도는 server.js가 모듈 로드 시점에 읽는다 -- 이 파일은 한도를 시험하지 않으므로 require보다 먼저 넉넉히 둔다.
process.env.RESERVATION_STORE_LIMIT_PER_10MIN = '100000'
process.env.RESERVATION_PHONE_LIMIT_PER_10MIN = '100000'
process.env.RESERVATION_IP_LIMIT_PER_MIN = '100000'
process.env.POS_WRITE_LIMIT_PER_MIN = '100000'

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

const { hashPassword, signAdminToken } = require('../src/auth')
const { prisma, purgeExpiredPersonalData } = require('../src/store')
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

async function createStore(label) {
  return prisma.store.create({
    data: {
      merchantId: unique(`merchant-${label}`),
      name: `테스트 매장 ${label}`,
      posToken: crypto.randomBytes(32).toString('hex'),
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

// 손님 접수. body.carModel을 아예 빼려면 { carModel: undefined }를 넘긴다(JSON에서 빠진다 -- 옛 프론트·웹 접수와 같다).
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

function posGet(store, path) {
  return request(app).get(path).set('X-Store-Token', store.posToken)
}

async function storedCarModel(id) {
  return (await prisma.reservation.findUnique({ where: { id } })).carModel
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`
  await resetDatabase()
})

beforeEach(resetDatabase)

after(async () => {
  await prisma.$disconnect()
})

// --- 서버 정리 규칙 --------------------------------------------------------------------------

testSerial('차종: 앞뒤 공백을 지우고 안쪽 공백·줄바꿈·탭은 띄어쓰기 하나로 모으며, 제어·서식 문자는 지우고 NFC로 맞춰 저장한다', async () => {
  const store = await createStore('car-model-normalize')
  const cases = [
    ['  트랙스  ', '트랙스'],
    [' 더 뉴\t\n트레일블레이저 ', '더 뉴 트레일블레이저'],
    ['올 뉴　말리부 LT', '올 뉴 말리부 LT'],
    ['말리\u0000부‮', '말리부'],
    ['스​파크﻿', '스파크'],
    ['a \u0007 b', 'a b'],
    ['트랙스'.normalize('NFD'), '트랙스'],
  ]
  for (const [i, [input, expected]] of cases.entries()) {
    const res = await intake(store, { carNumber: `1${i}가100${i}`, phone: `0102000000${i}`, carModel: input })
    assert.equal(res.status, 200, `${JSON.stringify(input)} ${JSON.stringify(res.body)}`)
    assert.equal(await storedCarModel(res.body.id), expected, JSON.stringify(input))
    // 새 접수 응답에는 차종을 싣지 않는다(손님 화면이 쓰지 않는다).
    assert.equal(res.body.carModel, undefined)
  }
})

testSerial('차종: 30자(글자 수)까지 받고 31자부터는 400과 해요체 안내를 주며 접수를 만들지 않는다, 글자가 아닌 값도 400', async () => {
  const store = await createStore('car-model-length')
  const ok = [
    ['가'.repeat(30), '가'.repeat(30)],
    [`  ${'나'.repeat(30)}  `, '나'.repeat(30)], // 앞뒤 공백은 지운 뒤 센다
    ['🚗'.repeat(30), '🚗'.repeat(30)], // UTF-16으로는 60이지만 30글자
    [`${'a'.repeat(20)}${'\u0000'.repeat(20)}`, 'a'.repeat(20)], // 지운 문자는 세지 않는다
  ]
  for (const [i, [input, expected]] of ok.entries()) {
    const res = await intake(store, { carNumber: `2${i}가200${i}`, phone: `0103000000${i}`, carModel: input })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(await storedCarModel(res.body.id), expected)
  }
  const before = await prisma.reservation.count({ where: { storeId: store.id } })
  const notified = global.__notifications.length

  const tooLong = await intake(store, { carNumber: '29가2009', phone: '01030000009', carModel: '가'.repeat(31) })
  assert.equal(tooLong.status, 400)
  assert.deepEqual(tooLong.body, { ok: false, error: '차종은 30자 안으로 입력해주세요. 예) 트랙스' })

  for (const bad of [123, { name: '트랙스' }, ['트랙스'], true]) {
    const res = await intake(store, { carNumber: '29가2009', phone: '01030000009', carModel: bad })
    assert.equal(res.status, 400, JSON.stringify(bad))
    assert.equal(res.body.error, '차종을 다시 확인해주세요. 예) 트랙스')
  }
  assert.equal(await prisma.reservation.count({ where: { storeId: store.id } }), before)
  assert.equal(global.__notifications.length, notified, '거절한 접수에는 문자를 보내지 않는다')
})

testSerial('차종: 비우거나 공백·보이지 않는 문자뿐이면 null로 저장하고, 보내지 않는 옛 클라이언트(undefined·null)도 그대로 접수된다', async () => {
  const store = await createStore('car-model-empty')
  const inputs = ['', '   ', '​​', '\n\t', null, undefined]
  for (const [i, input] of inputs.entries()) {
    const res = await intake(store, { carNumber: `3${i}가300${i}`, phone: `0104000000${i}`, carModel: input })
    assert.equal(res.status, 200, `${JSON.stringify(input)} ${JSON.stringify(res.body)}`)
    assert.equal(await storedCarModel(res.body.id), null, JSON.stringify(input))
  }
  // 옛 프론트 본문(carModel 키 자체가 없음) 그대로
  const legacy = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId, carNumber: '39가3009', phone: '01040000009', serviceType: 'oil', privacyConsent: true,
  })
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body))
  assert.equal(await storedCarModel(legacy.body.id), null)
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReservationAlimtalk').length, inputs.length + 1)
})

// --- 같은 차·같은 번호 재접수 -----------------------------------------------------------------

testSerial('차종: 같은 차·같은 번호로 다시 접수하면 차종이 없거나 다를 때만 이번 값으로 고치고, 비워 두면 기존 값을 지우지 않으며 응답 본문은 그대로다', async () => {
  const store = await createStore('car-model-duplicate')
  const car = { carNumber: '45라6789', phone: '01050000001' }
  const first = await intake(store, { ...car })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(await storedCarModel(first.body.id), null)

  const added = await intake(store, { ...car, carModel: '트랙스' })
  assert.equal(added.body.duplicate, true, JSON.stringify(added.body))
  assert.deepEqual(Object.keys(added.body).sort(), ['duplicate', 'ok', 'peopleAhead', 'queueNumber', 'status'])
  assert.equal(added.body.queueNumber, first.body.queueNumber)
  assert.equal(await storedCarModel(first.body.id), '트랙스')

  // 건너뛰기(빈 값)·옛 프론트(키 없음)는 기존 차종을 지우지 않는다.
  for (const skipped of ['', '  ', null, undefined]) {
    const again = await intake(store, { ...car, carNumber: '45라 6789', carModel: skipped })
    assert.equal(again.body.duplicate, true, JSON.stringify(again.body))
    assert.equal(await storedCarModel(first.body.id), '트랙스', JSON.stringify(skipped))
  }

  const changed = await intake(store, { ...car, carModel: '  말리부 ' })
  assert.equal(changed.body.duplicate, true)
  assert.equal(await storedCarModel(first.body.id), '말리부')
  const same = await intake(store, { ...car, carModel: '말리부' })
  assert.equal(same.body.duplicate, true)
  assert.equal(await storedCarModel(first.body.id), '말리부')

  // 너무 긴 차종은 중복 경로에서도 400이고 기존 값은 그대로다.
  const tooLong = await intake(store, { ...car, carModel: '가'.repeat(31) })
  assert.equal(tooLong.status, 400)
  assert.equal(await storedCarModel(first.body.id), '말리부')

  // 번호가 다르면 새 접수이고, 기존 접수의 차종은 건드리지 않는다.
  const other = await intake(store, { carNumber: '45라6789', phone: '01050000002', carModel: '스파크' })
  assert.equal(other.body.duplicate, undefined, JSON.stringify(other.body))
  assert.equal(await storedCarModel(other.body.id), '스파크')
  assert.equal(await storedCarModel(first.body.id), '말리부')
  assert.equal(await prisma.reservation.count({ where: { storeId: store.id } }), 2)
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReservationAlimtalk').length, 2, '중복 접수에는 문자를 다시 보내지 않는다')
})

testSerial('차종: 같은 Idempotency-Key 재시도는 처음 접수의 차종을 그대로 둔다', async () => {
  const store = await createStore('car-model-idem')
  const key = unique('idem')
  const first = await intake(store, { carNumber: '56다7890', phone: '01060000001', carModel: '트랙스' }, { 'Idempotency-Key': key })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const retry = await intake(store, { carNumber: '56다7890', phone: '01060000001', carModel: '트랙스' }, { 'Idempotency-Key': key })
  assert.equal(retry.body.duplicate, true)
  assert.deepEqual(Object.keys(retry.body).sort(), ['duplicate', 'ok', 'peopleAhead', 'queueNumber', 'status'])
  assert.equal(await storedCarModel(first.body.id), '트랙스')
  assert.equal(await prisma.reservation.count({ where: { storeId: store.id } }), 1)
})

// --- 응답에 싣기 -----------------------------------------------------------------------------

testSerial('차종: POS 대기열 항목에 carModel이 실린다(없으면 null, 서버는 원문 그대로 주고 이스케이프는 화면이 한다)', async () => {
  const store = await createStore('car-model-queue')
  const a = await intake(store, { carNumber: '12가1212', phone: '01070000001', carModel: '트랙스' })
  const b = await intake(store, { carNumber: '34가3434', phone: '01070000002' })
  const c = await intake(store, { carNumber: '56가5656', phone: '01070000003', carModel: '<b>말리부</b>' })
  const queue = await posGet(store, '/api/pos/queue')
  assert.equal(queue.status, 200)
  const byId = new Map(queue.body.reservations.map((r) => [r.id, r]))
  assert.equal(byId.get(a.body.id).carModel, '트랙스')
  assert.equal(byId.get(b.body.id).carModel, null)
  assert.equal(byId.get(c.body.id).carModel, '<b>말리부</b>')
  // 이월 건을 함께 받는 새 탭앱 요청도 같다.
  const carried = await posGet(store, '/api/pos/queue?carriedOver=1')
  assert.equal(carried.body.reservations.find((r) => r.id === a.body.id).carModel, '트랙스')
})

testSerial('차종: 정비 이력(차량번호 조회·최근 목록)의 접수 방문에 carModel이 실리고, 전산 주문에 이어진 접수의 차종은 주문 줄에도 실린다', async () => {
  const store = await createStore('car-model-history')
  const done = async (body) => {
    const r = await intake(store, body)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal((await posPost(store, `/api/pos/queue/${r.body.id}/complete`)).status, 200)
    return r.body
  }
  const trax = await done({ carNumber: '12가3456', phone: '01080000001', carModel: '트랙스' })
  const malibu = await done({ carNumber: '34나5678', phone: '01080000002', carModel: '말리부' })
  await done({ carNumber: '56다7890', phone: '01080000003' })
  // 말리부 접수에 이어진 결제된 전산 주문, 그리고 접수 없이 온 주문
  await prisma.erpCart.create({
    data: {
      storeId: store.id, referenceId: unique('ref-linked'), itemsJson: JSON.stringify([{ name: '엔진오일', quantity: 1, unitPrice: 45000 }]),
      totalAmount: 45000, status: 'paid', paidAt: new Date(), carNumber: '34나5678', reservationId: malibu.id,
    },
  })
  await prisma.erpCart.create({
    data: {
      storeId: store.id, referenceId: unique('ref-alone'), itemsJson: JSON.stringify([{ name: '와이퍼', quantity: 1, unitPrice: 15000 }]),
      totalAmount: 15000, status: 'paid', paidAt: new Date(), carNumber: '78라9012',
    },
  })

  const byCar = await posGet(store, `/api/pos/history?carNumber=${encodeURIComponent('12가3456')}`)
  assert.equal(byCar.status, 200, JSON.stringify(byCar.body))
  assert.equal(byCar.body.visits.length, 1)
  assert.equal(byCar.body.visits[0].kind, 'reservation')
  assert.equal(byCar.body.visits[0].reservationId, trax.id)
  assert.equal(byCar.body.visits[0].carModel, '트랙스')

  const linked = await posGet(store, `/api/pos/history?carNumber=${encodeURIComponent('34나5678')}`)
  assert.equal(linked.body.visits[0].carModel, '말리부')
  assert.equal(linked.body.visits[0].orders.length, 1)

  const none = await posGet(store, `/api/pos/history?carNumber=${encodeURIComponent('56다7890')}`)
  assert.equal(none.body.visits[0].carModel, null)
  const alone = await posGet(store, `/api/pos/history?carNumber=${encodeURIComponent('78라9012')}`)
  assert.equal(alone.body.visits[0].kind, 'order')
  assert.equal(alone.body.visits[0].carModel, null)

  const recent = await posGet(store, '/api/pos/history/recent')
  assert.equal(recent.status, 200, JSON.stringify(recent.body))
  const find = (car) => recent.body.visits.filter((v) => v.carNumber === car)
  assert.deepEqual(find('12가3456').map((v) => [v.kind, v.carModel]), [['reservation', '트랙스']])
  // 주문이 이어진 접수는 주문 줄이 그 방문을 대신한다 -- 차종은 주문 줄에 붙는다.
  assert.deepEqual(find('34나5678').map((v) => [v.kind, v.carModel]), [['order', '말리부']])
  assert.deepEqual(find('56다7890').map((v) => [v.kind, v.carModel]), [['reservation', null]])
  assert.deepEqual(find('78라9012').map((v) => [v.kind, v.carModel]), [['order', null]])
})

testSerial('차종: 관리자 접수 목록(/api/reservations)과 발송실패 목록(/api/reservations/failed)에 carModel이 실린다', async () => {
  const store = await createStore('car-model-admin')
  const auth = await hqAuth()
  const a = await intake(store, { carNumber: '12가1111', phone: '01090000001', carModel: '트랙스' })
  global.__failNotification = { method: 'sendReservationAlimtalk', error: new Error('강제 실패(테스트 전용)') }
  const b = await intake(store, { carNumber: '12가2222', phone: '01090000002', carModel: '말리부' })
  const c = await intake(store, { carNumber: '12가3333', phone: '01090000003' })
  for (const r of [a, b, c]) assert.equal(r.status, 200, JSON.stringify(r.body))

  const list = await request(app).get(`/api/reservations?storeId=${store.id}`).set('Authorization', auth)
  assert.equal(list.status, 200, JSON.stringify(list.body))
  const byId = new Map(list.body.reservations.map((r) => [r.id, r]))
  assert.equal(byId.get(a.body.id).carModel, '트랙스')
  assert.equal(byId.get(b.body.id).carModel, '말리부')
  assert.equal(byId.get(c.body.id).carModel, null)

  const failed = await request(app).get(`/api/reservations/failed?storeId=${store.id}`).set('Authorization', auth)
  assert.equal(failed.status, 200, JSON.stringify(failed.body))
  assert.deepEqual(failed.body.reservations.map((r) => [r.id, r.carModel]), [[b.body.id, '말리부']])
})

// --- 파기 -----------------------------------------------------------------------------------

testSerial('차종: 보관기간이 지나 파기(익명화)하면 차종도 지운다(손님이 자유롭게 적는 칸이다)', async () => {
  const store = await createStore('car-model-purge')
  const old = await prisma.reservation.create({
    data: {
      storeId: store.id, carNumber: '12가4444', carModel: '트랙스 김철수', phone: '01011112222', serviceType: '엔진오일 교체',
      queueNumber: 1, serviceDate: '2021-01-04', status: 'completed', createdAt: new Date('2021-01-04T01:00:00.000Z'),
    },
  })
  const fresh = await intake(store, { carNumber: '12가5555', phone: '01011113333', carModel: '말리부' })
  const result = await purgeExpiredPersonalData()
  assert.ok(result.reservations >= 1, JSON.stringify(result))
  const purged = await prisma.reservation.findUnique({ where: { id: old.id } })
  assert.ok(purged.anonymizedAt)
  assert.equal(purged.carModel, null)
  assert.equal(await storedCarModel(fresh.body.id), '말리부', '보관기간 안의 접수는 그대로다')
})
