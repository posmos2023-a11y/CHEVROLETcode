// 전산 주문을 프론트 플러그인에서 직접 결제하는 경로(payTarget: 'front') 테스트.
// erpCart.test.js와 같은 컨벤션(node:test, supertest, testSerial, 한국어 테스트명)을 따르고,
// 같은 로컬 devdb를 TRUNCATE로 비우므로 package.json의 `--test-concurrency=1`이 필요하다.

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

// 알림(문자) 발송을 가짜로 바꾼다 -- 정비 완료 안내·결제 영수증이 실제 문자 회사로 나가지 않게.
// 보낸 내용은 global.__notifications에 쌓여 테스트가 확인할 수 있다.
const __solapi = require('../src/solapi')
global.__notifications = []
for (const method of ['sendReservationAlimtalk', 'sendQueueTurnAlimtalk', 'sendReceiptAlimtalk', 'sendRepairDoneAlimtalk', 'sendPromoAlimtalk']) {
  __solapi[method] = async (payload) => {
    global.__notifications.push({ method, payload })
    if (global.__failNotification === method) { global.__failNotification = null; throw new Error('강제 실패(테스트 전용)') }
    return { ok: true }
  }
}

const ERP_TOKEN = 'test-erp-cart-front-token-0000'
process.env.ERP_API_TOKEN = ERP_TOKEN
process.env.ERP_STORE_LIMIT_PER_MIN = '1000'
process.env.ERP_IP_LIMIT_PER_MIN = '100000'

const { prisma } = require('../src/store')
const { app } = require('../server')

const testSerial = (name, fn) => test(name, { concurrency: false }, fn)

let sequence = 0
function unique(prefix) {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

function newPaymentKey() {
  return crypto.randomUUID()
}

async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ErpCart", "ErpOrder", "RateLimitHit", "WebhookEvent", "Payment", "Reservation", "QueueCounter", "AdminUser", "Store" RESTART IDENTITY CASCADE'
  )
}

async function createStore(label) {
  return prisma.store.create({
    data: {
      merchantId: unique(`merchant-${label}`),
      name: `테스트 매장 ${label}`,
      posToken: crypto.randomBytes(32).toString('hex'),
      erpStoreCode: unique(`ERP-${label}`).toUpperCase().replace(/[^A-Z0-9-]/g, '-'),
    },
  })
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`
  await resetDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

after(async () => {
  await prisma.$disconnect()
})

function validBody(store, overrides = {}) {
  return {
    storeCode: store.erpStoreCode,
    referenceId: unique('ERP-FRONT-REF'),
    items: [
      { productId: 'P-1001', name: '엔진오일 5W30 (4L)', category: '부품', unitPrice: 45000, quantity: 1 },
      { productId: 'L-2001', name: '엔진오일 교환 공임', category: '공임', unitPrice: 20000, quantity: 1 },
    ],
    totalAmount: 65000,
    memo: '12가3456 김민준님',
    ...overrides,
  }
}

function postCart(body) {
  return request(app).post('/api/erp/carts').set('X-ERP-Token', ERP_TOKEN).send(body)
}

function getCart(referenceId) {
  return request(app).get(`/api/erp/carts/${referenceId}`).set('X-ERP-Token', ERP_TOKEN)
}

function getFrontCarts(store) {
  return request(app).get('/api/front/erp-carts').set('X-Store-Token', store.posToken)
}

function startFront(store, cartId, paymentKey) {
  return request(app).post(`/api/front/erp-carts/${cartId}/start`).set('X-Store-Token', store.posToken).send({ paymentKey })
}

function reportFront(store, cartId, body) {
  return request(app).post(`/api/front/erp-carts/${cartId}/result`).set('X-Store-Token', store.posToken).send(body)
}

async function frontCart(label, overrides = {}) {
  const store = await createStore(label)
  const body = validBody(store, { payTarget: 'front', ...overrides })
  const res = await postCart(body)
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return { store, body, cartId: res.body.cartId }
}

const SAMPLE_CARD_PAYMENT = {
  paymentMethod: 'CARD',
  approvalNumber: '30012345',
  timestamp: 1761000000000,
  installment: 0,
  vanTransactionKey: 'VAN-0001',
  tid: 'CAT-01',
  maskedCardNumber: '12345678********', // 서버가 저장하지 않아야 한다
}

// --- 전산 → 서버: payTarget ---------------------------------------------------

testSerial('payTarget: 안 보내면 기존처럼 pos로 저장된다', async () => {
  const store = await createStore('target-default')
  const res = await postCart(validBody(store))
  assert.equal(res.status, 201)
  assert.equal(res.body.payTarget, 'pos')
  const row = await prisma.erpCart.findUnique({ where: { id: res.body.cartId } })
  assert.equal(row.payTarget, 'pos')
})

testSerial("payTarget: 'front'로 보내면 프론트 결제 건으로 저장된다", async () => {
  const { cartId, body } = await frontCart('target-front')
  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.payTarget, 'front')
  const status = await getCart(body.referenceId)
  assert.equal(status.body.payTarget, 'front')
  assert.equal(status.body.status, 'pending')
})

testSerial('payTarget: 모르는 값이면 400으로 거부한다(조용히 pos로 바꾸지 않는다)', async () => {
  const store = await createStore('target-bad')
  const res = await postCart(validBody(store, { payTarget: 'kiosk' }))
  assert.equal(res.status, 400)
  assert.equal(await prisma.erpCart.count(), 0)
})

// --- 목록 분리 ----------------------------------------------------------------

testSerial('목록 분리: 프론트 건은 POS 목록에 안 나오고 프론트 목록에만 나온다', async () => {
  const store = await createStore('split')
  const posRes = await postCart(validBody(store))
  const frontRes = await postCart(validBody(store, { payTarget: 'front' }))

  const posList = await request(app).get('/api/pos/erp-carts').set('X-Store-Token', store.posToken)
  assert.deepEqual(posList.body.carts.map((c) => c.id), [posRes.body.cartId])

  const queue = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.deepEqual(queue.body.erpCarts.map((c) => c.id), [posRes.body.cartId])

  const frontList = await getFrontCarts(store)
  assert.equal(frontList.status, 200)
  assert.deepEqual(frontList.body.carts.map((c) => c.id), [frontRes.body.cartId])
  assert.equal(frontList.body.carts[0].totalAmount, 65000)
  assert.equal(frontList.body.carts[0].items.length, 2)
})

testSerial('인증: 매장 토큰 없이 프론트 목록을 부르면 401', async () => {
  const res = await request(app).get('/api/front/erp-carts')
  assert.equal(res.status, 401)
})

testSerial('인증: 다른 매장 토큰으로는 그 매장 주문이 안 보이고 시작도 못 한다', async () => {
  const { cartId } = await frontCart('owner')
  const other = await createStore('other')
  const list = await getFrontCarts(other)
  assert.deepEqual(list.body.carts, [])
  const start = await startFront(other, cartId, newPaymentKey())
  assert.equal(start.status, 404)
})

// --- 결제 시작 ----------------------------------------------------------------

testSerial('시작: paying으로 바뀌고 서버 기준 금액과 부가세를 돌려준다', async () => {
  const { store, cartId, body } = await frontCart('start')
  const paymentKey = newPaymentKey()
  const res = await startFront(store, cartId, paymentKey)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.totalAmount, 65000)
  assert.equal(res.body.tax, Math.round(65000 / 11))
  assert.equal(res.body.tax + res.body.supplyValue, 65000)
  assert.equal(res.body.paymentKey, paymentKey)

  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'paying')
  assert.equal(row.frontPaymentKey, paymentKey)
  assert.ok(row.frontPayingAt)

  // 결제 중인 건은 다른 프론트 목록에서 사라지고, 전산은 paying을 본다.
  assert.deepEqual((await getFrontCarts(store)).body.carts, [])
  assert.equal((await getCart(body.referenceId)).body.status, 'paying')
})

testSerial('시작: 이미 결제 중인 주문은 다른 프론트가 다시 시작할 수 없다(409)', async () => {
  const { store, cartId } = await frontCart('start-twice')
  assert.equal((await startFront(store, cartId, newPaymentKey())).status, 200)
  const second = await startFront(store, cartId, newPaymentKey())
  assert.equal(second.status, 409)
  assert.equal(second.body.status, 'paying')
})

testSerial('시작: POS 결제 건은 프론트에서 시작할 수 없다(404)', async () => {
  const store = await createStore('start-pos')
  const res = await postCart(validBody(store))
  const start = await startFront(store, res.body.cartId, newPaymentKey())
  assert.equal(start.status, 404)
  const row = await prisma.erpCart.findUnique({ where: { id: res.body.cartId } })
  assert.equal(row.status, 'pending')
})

testSerial('시작: paymentKey 형식이 틀리면 400', async () => {
  const { store, cartId } = await frontCart('start-badkey')
  for (const bad of ['', 'short', 'has space in key', 'x'.repeat(65), '한글키한글키한글키']) {
    const res = await startFront(store, cartId, bad)
    assert.equal(res.status, 400, `paymentKey=${bad}`)
  }
})

testSerial('시작: 다른 주문에 쓴 paymentKey를 재사용하면 409', async () => {
  const store = await createStore('start-reuse')
  const a = await postCart(validBody(store, { payTarget: 'front' }))
  const b = await postCart(validBody(store, { payTarget: 'front' }))
  const paymentKey = newPaymentKey()
  assert.equal((await startFront(store, a.body.cartId, paymentKey)).status, 200)
  const res = await startFront(store, b.body.cartId, paymentKey)
  assert.equal(res.status, 409)
  const row = await prisma.erpCart.findUnique({ where: { id: b.body.cartId } })
  assert.equal(row.status, 'pending')
})

// --- 결제 결과 ----------------------------------------------------------------

testSerial('결과 paid: 결제 완료로 기록되고 전산이 paid를 본다', async () => {
  const { store, cartId, body } = await frontCart('paid')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  const res = await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.status, 'paid')
  assert.equal(res.body.alreadyProcessed, false)

  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'paid')
  assert.ok(row.paidAt)
  const saved = JSON.parse(row.frontPaymentJson)
  assert.equal(saved.paymentMethod, 'CARD')
  assert.equal(saved.approvalNumber, '30012345')
  assert.equal(saved.timestamp, 1761000000000)
  assert.equal(saved.vanTransactionKey, 'VAN-0001')
  assert.equal('maskedCardNumber' in saved, false)
  assert.equal(row.frontPaymentJson.includes('12345678'), false)

  const status = await getCart(body.referenceId)
  assert.equal(status.body.status, 'paid')
  assert.ok(status.body.paidAt)
})

testSerial('결과 paid: 같은 보고를 다시 보내면 성공(alreadyProcessed)으로 돌려준다', async () => {
  const { store, cartId } = await frontCart('paid-retry')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  const retry = await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.alreadyProcessed, true)
})

testSerial('결과 paid: paymentKey가 다르면 기록하지 않는다(409)', async () => {
  const { store, cartId } = await frontCart('paid-wrongkey')
  await startFront(store, cartId, newPaymentKey())
  const res = await reportFront(store, cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.status, 409)
  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'paying')
})

testSerial('결과 paid: 시작하지 않은 주문은 결제 완료로 기록할 수 없다(409)', async () => {
  const { store, cartId } = await frontCart('paid-nostart')
  const res = await reportFront(store, cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.status, 409)
  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'pending')
})

testSerial('결과 paid: 다른 매장 토큰으로는 보고할 수 없다(404)', async () => {
  const { store, cartId } = await frontCart('paid-owner')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  const other = await createStore('paid-other')
  const res = await reportFront(other, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.status, 404)
})

testSerial('결과 cancelled: 다시 pending이 되어 새 paymentKey로 다시 결제할 수 있다', async () => {
  const { store, cartId } = await frontCart('cancelled')
  const firstKey = newPaymentKey()
  await startFront(store, cartId, firstKey)
  const res = await reportFront(store, cartId, { result: 'cancelled', paymentKey: firstKey })
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'pending')

  let row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'pending')
  assert.equal(row.frontPaymentKey, null)
  assert.equal((await getFrontCarts(store)).body.carts.length, 1)

  // 같은 취소 보고의 재시도는 성공으로 처리된다.
  const retry = await reportFront(store, cartId, { result: 'cancelled', paymentKey: firstKey })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.alreadyProcessed, true)

  const secondKey = newPaymentKey()
  assert.equal((await startFront(store, cartId, secondKey)).status, 200)
  assert.equal((await reportFront(store, cartId, { result: 'paid', paymentKey: secondKey, payment: SAMPLE_CARD_PAYMENT })).status, 200)
  row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'paid')
})

testSerial('결과 cancelled: 이전 시도의 늦은 취소 보고가 현재 시도를 되돌리지 못한다', async () => {
  const { store, cartId } = await frontCart('cancel-stale')
  const firstKey = newPaymentKey()
  await startFront(store, cartId, firstKey)
  await reportFront(store, cartId, { result: 'cancelled', paymentKey: firstKey })
  const secondKey = newPaymentKey()
  await startFront(store, cartId, secondKey)

  const stale = await reportFront(store, cartId, { result: 'cancelled', paymentKey: firstKey })
  assert.equal(stale.status, 409)
  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'paying')
  assert.equal(row.frontPaymentKey, secondKey)
})

testSerial('결과 failed: pending으로 되돌리고 사유를 남긴다', async () => {
  const { store, cartId } = await frontCart('failed')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  const res = await reportFront(store, cartId, { result: 'failed', paymentKey, errorMessage: '카드 한도 초과' })
  assert.equal(res.status, 200)
  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'pending')
  assert.equal(row.errorMessage, '카드 한도 초과')
})

testSerial('결과: result 값이 틀리면 400', async () => {
  const { store, cartId } = await frontCart('result-bad')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  const res = await reportFront(store, cartId, { result: 'done', paymentKey })
  assert.equal(res.status, 400)
})

// --- 전산 취소와의 관계 ---------------------------------------------------------

testSerial('전산 취소: 프론트에서 결제 중인 주문은 전산이 취소할 수 없다(409)', async () => {
  const { store, cartId, body } = await frontCart('erp-cancel-paying')
  await startFront(store, cartId, newPaymentKey())
  const res = await request(app).post(`/api/erp/carts/${body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN)
  assert.equal(res.status, 409)
  assert.equal(res.body.status, 'paying')
})

testSerial('전산 취소: 아직 시작 전이면 취소되고 프론트 목록에서 사라진다', async () => {
  const { store, body } = await frontCart('erp-cancel-pending')
  const res = await request(app).post(`/api/erp/carts/${body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN)
  assert.equal(res.status, 200)
  assert.deepEqual((await getFrontCarts(store)).body.carts, [])
})

// --- 예약 자동완료 --------------------------------------------------------------

testSerial('예약 연결: 프론트 결제가 끝나면 이어진 예약도 정비완료로 넘어간다', async () => {
  const store = await createStore('reservation')
  const reservation = await prisma.reservation.create({
    data: {
      storeId: store.id,
      carNumber: '12가3456',
      phone: '01012345678',
      serviceType: '엔진오일',
      queueNumber: 1,
      serviceDate: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
      status: 'called',
    },
  })
  const created = await postCart(validBody(store, { payTarget: 'front', carNumber: '12가3456' }))
  assert.equal(created.body.linkedReservation, true)

  const paymentKey = newPaymentKey()
  await startFront(store, created.body.cartId, paymentKey)
  const res = await reportFront(store, created.body.cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.body.reservationCompleted, true)
  const after = await prisma.reservation.findUnique({ where: { id: reservation.id } })
  assert.equal(after.status, 'completed')
})

// --- POS 탭앱에서 프론트로 넘기기 / 되돌리기 ---------------------------------------

function sendToFront(store, cartId) {
  return request(app).post(`/api/pos/erp-carts/${cartId}/send-to-front`).set('X-Store-Token', store.posToken)
}

function returnToPos(store, cartId) {
  return request(app).post(`/api/pos/erp-carts/${cartId}/return-to-pos`).set('X-Store-Token', store.posToken)
}

function posQueue(store) {
  return request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
}

testSerial('넘기기: POS 건을 프론트로 넘기면 POS 목록에서 빠지고 프론트 목록과 frontCarts에 나온다', async () => {
  const store = await createStore('handoff')
  const created = await postCart(validBody(store))
  const cartId = created.body.cartId

  const res = await sendToFront(store, cartId)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.payTarget, 'front')

  const queue = await posQueue(store)
  assert.deepEqual(queue.body.erpCarts, [])
  assert.equal(queue.body.frontCarts.length, 1)
  assert.equal(queue.body.frontCarts[0].id, cartId)
  assert.equal(queue.body.frontCarts[0].status, 'pending')
  // 직원이 넘긴 주문의 품목을 대기열에서 그대로 확인할 수 있어야 한다.
  assert.deepEqual(
    queue.body.frontCarts[0].items.map((i) => [i.name, i.quantity, i.unitPrice]),
    [['엔진오일 5W30 (4L)', 1, 45000], ['엔진오일 교환 공임', 1, 20000]]
  )
  assert.deepEqual((await getFrontCarts(store)).body.carts.map((c) => c.id), [cartId])

  // 전산은 상태 조회로 프론트로 넘어간 걸 안다.
  const status = await getCart(created.body.referenceId)
  assert.equal(status.body.payTarget, 'front')
  assert.equal(status.body.status, 'pending')
})

testSerial('넘기기: 같은 요청을 다시 보내면 성공(alreadyProcessed)', async () => {
  const store = await createStore('handoff-twice')
  const created = await postCart(validBody(store))
  await sendToFront(store, created.body.cartId)
  const again = await sendToFront(store, created.body.cartId)
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyProcessed, true)
})

testSerial('넘기기: 이미 POS에 담긴 건은 넘길 수 없다(409)', async () => {
  const store = await createStore('handoff-loaded')
  const created = await postCart(validBody(store))
  await request(app).post(`/api/pos/erp-carts/${created.body.cartId}/consume`).set('X-Store-Token', store.posToken).send({ result: 'loaded' })
  const res = await sendToFront(store, created.body.cartId)
  assert.equal(res.status, 409)
  assert.equal(res.body.status, 'loaded')
})

testSerial('넘기기: 다른 매장 토큰으로는 넘길 수 없다(404)', async () => {
  const store = await createStore('handoff-owner')
  const created = await postCart(validBody(store))
  const other = await createStore('handoff-other')
  assert.equal((await sendToFront(other, created.body.cartId)).status, 404)
  const row = await prisma.erpCart.findUnique({ where: { id: created.body.cartId } })
  assert.equal(row.payTarget, 'pos')
})

testSerial('넘기기: 프론트로 넘긴 건은 POS가 담거나 지울 수 없다(409)', async () => {
  const store = await createStore('handoff-consume')
  const created = await postCart(validBody(store))
  await sendToFront(store, created.body.cartId)
  for (const result of ['loaded', 'dismissed', 'failed']) {
    const res = await request(app).post(`/api/pos/erp-carts/${created.body.cartId}/consume`).set('X-Store-Token', store.posToken).send({ result })
    assert.equal(res.status, 409, result)
  }
  const row = await prisma.erpCart.findUnique({ where: { id: created.body.cartId } })
  assert.equal(row.status, 'pending')
})

testSerial('넘기기 후 결제: 탭앱에서 넘긴 건도 프론트에서 끝까지 결제된다', async () => {
  const store = await createStore('handoff-pay')
  const created = await postCart(validBody(store))
  await sendToFront(store, created.body.cartId)
  const paymentKey = newPaymentKey()
  assert.equal((await startFront(store, created.body.cartId, paymentKey)).status, 200)

  const queue = await posQueue(store)
  assert.equal(queue.body.frontCarts[0].status, 'paying')

  assert.equal((await reportFront(store, created.body.cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })).status, 200)
  assert.equal((await getCart(created.body.referenceId)).body.status, 'paid')
  assert.deepEqual((await posQueue(store)).body.frontCarts, [])
})

testSerial('되돌리기: 프론트가 시작하기 전이면 POS로 돌아온다', async () => {
  const store = await createStore('return')
  const created = await postCart(validBody(store))
  await sendToFront(store, created.body.cartId)
  const res = await returnToPos(store, created.body.cartId)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.payTarget, 'pos')

  const queue = await posQueue(store)
  assert.deepEqual(queue.body.erpCarts.map((c) => c.id), [created.body.cartId])
  assert.deepEqual(queue.body.frontCarts, [])
  assert.deepEqual((await getFrontCarts(store)).body.carts, [])
})

testSerial('되돌리기: 손님이 프론트에서 결제 중이면 되돌릴 수 없다(409)', async () => {
  const store = await createStore('return-paying')
  const created = await postCart(validBody(store))
  await sendToFront(store, created.body.cartId)
  await startFront(store, created.body.cartId, newPaymentKey())
  const res = await returnToPos(store, created.body.cartId)
  assert.equal(res.status, 409)
  assert.equal(res.body.status, 'paying')
  const row = await prisma.erpCart.findUnique({ where: { id: created.body.cartId } })
  assert.equal(row.payTarget, 'front')
})

testSerial('되돌리기: 전산이 처음부터 프론트로 보낸 건도 POS로 가져올 수 있다', async () => {
  const { store, cartId } = await frontCart('return-direct')
  const res = await returnToPos(store, cartId)
  assert.equal(res.status, 200)
  assert.deepEqual((await posQueue(store)).body.erpCarts.map((c) => c.id), [cartId])
})

// --- 재전송 초기화 ---------------------------------------------------------------

testSerial('재전송: 취소된 referenceId를 다시 보내면 이전 프론트 결제 흔적이 지워진다', async () => {
  const store = await createStore('resend')
  const body = validBody(store, { payTarget: 'front' })
  const first = await postCart(body)
  await request(app).post(`/api/erp/carts/${body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN)
  const again = await postCart({ ...body, payTarget: 'pos' })
  assert.equal(again.status, 201)
  assert.equal(again.body.cartId, first.body.cartId)
  const row = await prisma.erpCart.findUnique({ where: { id: first.body.cartId } })
  assert.equal(row.payTarget, 'pos')
  assert.equal(row.frontPaymentKey, null)
  assert.equal(row.frontPaymentJson, null)
})

// --- 결제 영수증 알림톡 ---------------------------------------------------------------

async function linkedFrontCart(label) {
  const store = await createStore(label)
  const reservation = await prisma.reservation.create({
    data: {
      storeId: store.id, carNumber: '12가3456', phone: '01012345678', serviceType: '엔진오일',
      queueNumber: 1, serviceDate: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10), status: 'called',
    },
  })
  const created = await postCart(validBody(store, { payTarget: 'front', carNumber: '12가3456' }))
  assert.equal(created.body.linkedReservation, true)
  return { store, reservation, cartId: created.body.cartId }
}

testSerial('영수증: 예약과 이어진 주문을 프론트에서 결제하면 손님 번호로 영수증이 한 번 간다', async () => {
  global.__notifications.length = 0
  const { store, cartId } = await linkedFrontCart('receipt')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  const res = await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.body.receipt, 'sent', JSON.stringify(res.body))
  const receipts = global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].payload.phone, '01012345678')
  assert.equal(receipts[0].payload.amount, 65000)
  assert.equal(receipts[0].payload.carNumber, '12가3456')
  assert.equal(receipts[0].payload.serviceType, '엔진오일 5W30 (4L) 외 1건')
  assert.equal(receipts[0].payload.storeName, store.name)

  // 같은 보고를 다시 보내도(프론트 재시도) 영수증은 다시 가지 않는다
  const again = await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(again.body.alreadyProcessed, true)
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 1)
  // 결제 뒤 자동 완료에서는 정비 완료 안내를 보내지 않는다(손님이 이미 카운터에 있다)
  assert.equal(global.__notifications.filter((n) => n.method === 'sendRepairDoneAlimtalk').length, 0)
})

testSerial('영수증: 예약과 이어지지 않은 주문은 번호를 모르므로 보내지 않는다', async () => {
  global.__notifications.length = 0
  const { store, cartId } = await frontCart('receipt-none')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  const res = await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.body.status, 'paid')
  assert.equal(res.body.receipt, 'no_reservation')
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 0)
})

testSerial('영수증: 발송에 실패해도 결제 완료 기록은 그대로다', async () => {
  global.__notifications.length = 0
  const { store, cartId } = await linkedFrontCart('receipt-fail')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  global.__failNotification = 'sendReceiptAlimtalk'
  const res = await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.status, 200)
  assert.equal(res.body.receipt, 'failed')
  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.status, 'paid')
})

testSerial('영수증: 전산 주문을 먼저 넣고 나중에 예약해도 결제할 때 예약과 이어져 영수증이 간다', async () => {
  global.__notifications.length = 0
  const store = await createStore('receipt-late-link')
  const created = await postCart(validBody(store, { payTarget: 'front', carNumber: '12가3456' }))
  assert.equal(created.body.linkedReservation, false) // 접수 때는 이을 예약이 없었다
  const reservation = await prisma.reservation.create({
    data: {
      storeId: store.id, carNumber: '12가3456', phone: '01077778888', serviceType: '엔진오일',
      queueNumber: 3, serviceDate: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10), status: 'waiting',
    },
  })
  const paymentKey = newPaymentKey()
  await startFront(store, created.body.cartId, paymentKey)
  const res = await reportFront(store, created.body.cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.body.receipt, 'sent', JSON.stringify(res.body))
  assert.equal(res.body.reservationCompleted, true)
  const receipts = global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk')
  assert.equal(receipts[0].payload.phone, '01077778888')
  const row = await prisma.erpCart.findUnique({ where: { id: created.body.cartId } })
  assert.equal(row.reservationId, reservation.id)
  assert.equal(row.receiptStatus, 'sent')
})

testSerial('영수증: 예약이 없으면 receiptStatus=no_reservation으로 남는다', async () => {
  const { store, cartId } = await frontCart('receipt-status-none')
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(row.receiptStatus, 'no_reservation')
})
