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
    'TRUNCATE TABLE "ErpCart", "ErpOrder", "TossPayment", "RateLimitHit", "WebhookEvent", "Payment", "Reservation", "QueueCounter", "AdminUser", "Store" RESTART IDENTITY CASCADE'
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
  assert.equal(res.body.code, 'PAID_AFTER_RELEASE')
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

testSerial('영수증: 직원이 [완료]를 누른 뒤에 전산 주문을 넣고 결제해도 그 예약 번호로 영수증이 간다', async () => {
  global.__notifications.length = 0
  const store = await createStore('receipt-after-done')
  const reservation = await prisma.reservation.create({
    data: {
      storeId: store.id, carNumber: '12가3456', phone: '01066667777', serviceType: '엔진오일',
      queueNumber: 4, serviceDate: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
      status: 'completed', completedAt: new Date(),
    },
  })
  const created = await postCart(validBody(store, { payTarget: 'front', carNumber: '12가3456' }))
  assert.equal(created.body.linkedReservation, false) // 끝난 예약에는 접수 때 잇지 않는다
  const paymentKey = newPaymentKey()
  await startFront(store, created.body.cartId, paymentKey)
  const res = await reportFront(store, created.body.cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.body.receipt, 'sent', JSON.stringify(res.body))
  assert.equal(global.__notifications.find((n) => n.method === 'sendReceiptAlimtalk').payload.phone, '01066667777')
  assert.equal((await prisma.erpCart.findUnique({ where: { id: created.body.cartId } })).reservationId, reservation.id)
})

testSerial('영수증: 같은 차가 오늘 두 번 왔으면(끝난 예약 2건) 누구 번호인지 몰라 보내지 않는다', async () => {
  global.__notifications.length = 0
  const store = await createStore('receipt-ambiguous')
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  for (const [i, phone] of [['5', '01011112222'], ['6', '01033334444']]) {
    await prisma.reservation.create({
      data: { storeId: store.id, carNumber: '12가3456', phone, serviceType: '점검', queueNumber: Number(i), serviceDate: today, status: 'completed', completedAt: new Date() },
    })
  }
  const created = await postCart(validBody(store, { payTarget: 'front', carNumber: '12가3456' }))
  const paymentKey = newPaymentKey()
  await startFront(store, created.body.cartId, paymentKey)
  const res = await reportFront(store, created.body.cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.body.receipt, 'no_reservation')
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 0)
})

// --- 탭앱 정리: 최근 결제 숨기기·삭제, 프론트 대기 지우기, 영수증 다시 보내기 -----------------------

async function paidFrontCart(label) {
  const { store, reservation, cartId } = await linkedFrontCart(label)
  const paymentKey = newPaymentKey()
  await startFront(store, cartId, paymentKey)
  await reportFront(store, cartId, { result: 'paid', paymentKey, payment: SAMPLE_CARD_PAYMENT })
  return { store, reservation, cartId }
}

const posPost = (store, path, body = {}) => request(app).post(path).set('X-Store-Token', store.posToken).send(body)
const settledOf = async (store) => (await posQueue(store)).body.settledCarts

testSerial('정리: 숨기면 최근 결제에 hidden으로 오고 정비 이력에서 빠지며, 다시 보이게 할 수 있다', async () => {
  const { store, cartId } = await paidFrontCart('cleanup-hide')
  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/hide`, { hidden: true })).status, 200)
  const settled = await settledOf(store)
  assert.equal(settled.find((c) => c.id === cartId).hidden, true)
  const hist = await request(app).get('/api/pos/history?carNumber=12가3456').set('X-Store-Token', store.posToken)
  assert.equal(hist.body.visits.every((v) => (v.orders || []).every((o) => o.id !== cartId)), true)

  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/hide`, { hidden: false })).status, 200)
  assert.equal((await settledOf(store)).find((c) => c.id === cartId).hidden, false)
  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/hide`, {})).status, 400)
})

testSerial('정리: 삭제하면 최근 결제·오늘 현황·관리자 목록에서 빠지지만 행은 남고 전산 조회는 그대로다', async () => {
  const { store, cartId } = await paidFrontCart('cleanup-delete')
  const before = await request(app).get('/api/pos/summary').set('X-Store-Token', store.posToken)
  assert.equal(before.body.erpCartsPaid, 1)

  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/delete`)).status, 200)
  assert.equal((await settledOf(store)).some((c) => c.id === cartId), false)
  const after = await request(app).get('/api/pos/summary').set('X-Store-Token', store.posToken)
  assert.equal(after.body.erpCartsPaid, 0)
  assert.equal(after.body.paidAmount, 0)
  const row = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.ok(row.deletedAt)
  assert.equal(row.status, 'paid')
  const erp = await getCart(row.referenceId)
  assert.equal(erp.body.status, 'paid')
  // 두 번 삭제하면 404(이미 없는 것으로 본다)
  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/delete`)).status, 404)
})

testSerial('정리: 결제 취소가 진행 중인 건은 삭제할 수 없고, 다른 매장 건은 건드릴 수 없다', async () => {
  const { store, cartId } = await paidFrontCart('cleanup-guard')
  await prisma.erpCart.update({ where: { id: cartId }, data: { status: 'refund_requested', refundRequestedAt: new Date() } })
  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/delete`)).status, 409)
  const other = await createStore('cleanup-guard-other')
  assert.equal((await posPost(other, `/api/pos/erp-carts/${cartId}/hide`, { hidden: true })).status, 404)
})

testSerial('정리: 프론트 결제 대기 주문을 탭앱에서 바로 지우면 프론트 목록에서 빠진다(결제 중이면 409)', async () => {
  const { store, cartId } = await frontCart('dismiss-front')
  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/dismiss-front`)).status, 200)
  assert.equal((await getFrontCarts(store)).body.carts.length, 0)
  assert.equal((await prisma.erpCart.findUnique({ where: { id: cartId } })).status, 'dismissed')

  const second = await frontCart('dismiss-front-paying')
  await startFront(second.store, second.cartId, newPaymentKey())
  assert.equal((await posPost(second.store, `/api/pos/erp-carts/${second.cartId}/dismiss-front`)).status, 409)
})

testSerial('영수증 다시 보내기: 탭앱에서 다시 보내면 또 한 번 간다, 예약이 없으면 이유를 알려준다', async () => {
  global.__notifications.length = 0
  const { store, cartId } = await paidFrontCart('resend-receipt')
  const res = await posPost(store, `/api/pos/erp-carts/${cartId}/resend-receipt`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 2)

  const none = await frontCart('resend-receipt-none')
  const pk = newPaymentKey()
  await startFront(none.store, none.cartId, pk)
  await reportFront(none.store, none.cartId, { result: 'paid', paymentKey: pk, payment: SAMPLE_CARD_PAYMENT })
  const miss = await posPost(none.store, `/api/pos/erp-carts/${none.cartId}/resend-receipt`)
  assert.equal(miss.status, 409)
  assert.equal(miss.body.receipt, 'no_reservation')
})

testSerial('다시 보내기: POS로 되돌렸다가 다시 프론트로 보내면 frontSentAt이 바뀌어 프론트가 새 주문으로 본다', async () => {
  const store = await createStore('resend-front')
  const created = await postCart(validBody(store))
  const cartId = created.body.cartId
  assert.equal((await sendToFront(store, cartId)).status, 200)
  const first = (await getFrontCarts(store)).body.carts[0].frontSentAt
  assert.ok(first)
  assert.equal((await returnToPos(store, cartId)).status, 200)
  await new Promise((r) => setTimeout(r, 15))
  assert.equal((await sendToFront(store, cartId)).status, 200)
  const second = (await getFrontCarts(store)).body.carts[0].frontSentAt
  assert.ok(second && second !== first)
})

// --- 늦은 /start 막기(묘비) · 갇힌 결제 중 풀기(비상구) · 전산 재전송 초기화 ---------------------------

const logger = require('../src/logger')
// logger.error 호출을 가로채 기록한다(대사가 필요하다는 로그가 실제로 남는지 확인하는 용도).
async function captureLoggerErrors(fn) {
  const original = logger.error
  const calls = []
  logger.error = (message, meta) => { calls.push({ message, meta }) }
  try { await fn() } finally { logger.error = original }
  return calls
}

const rowOf = (id) => prisma.erpCart.findUnique({ where: { id } })
const forceRelease = (store, cartId) => posPost(store, `/api/pos/erp-carts/${cartId}/force-release`)
const elevenMinutesAgo = () => new Date(Date.now() - 11 * 60 * 1000)

for (const result of ['cancelled', 'failed']) {
  testSerial(`묘비: /start보다 ${result} 보고가 먼저 도착하면 그 paymentKey의 늦은 /start는 거절한다`, async () => {
    const { store, cartId } = await frontCart(`tombstone-${result}`)
    const lateKey = newPaymentKey()
    // 프론트는 /start가 시간 초과되자 같은 키로 보고를 보냈고, 그 보고가 서버에 먼저 도착했다(주문은 아직 pending).
    const early = await reportFront(store, cartId, { result, paymentKey: lateKey })
    assert.equal(early.status, 200, JSON.stringify(early.body))
    assert.equal(early.body.alreadyProcessed, true)
    assert.equal(early.body.status, 'pending')
    assert.equal((await rowOf(cartId)).frontReleasedKey, lateKey)

    // 뒤늦게 처리되는 /start -- 예전에는 이걸 paying으로 잡아 프론트는 포기했는데 서버만 영구히 결제 중으로 갇혔다.
    const late = await startFront(store, cartId, lateKey)
    assert.equal(late.status, 409, JSON.stringify(late.body))
    assert.equal(late.body.stale, true)
    const row = await rowOf(cartId)
    assert.equal(row.status, 'pending')
    assert.equal(row.frontPaymentKey, null)

    // 묘비는 그 키에만 적용된다. 새 paymentKey로는 평소처럼 결제할 수 있다.
    assert.equal((await startFront(store, cartId, newPaymentKey())).status, 200)
  })
}

testSerial('묘비: 이미 paying으로 잡힌 뒤의 cancelled 보고는 pending으로 되돌리고, 그 키도 묘비로 남겨 같은 키의 늦은 /start 재전송을 막는다', async () => {
  const { store, cartId } = await frontCart('tombstone-normal')
  const key = newPaymentKey()
  await startFront(store, cartId, key)
  const res = await reportFront(store, cartId, { result: 'cancelled', paymentKey: key })
  assert.equal(res.body.alreadyProcessed, false)
  assert.equal(res.body.status, 'pending')
  assert.equal((await rowOf(cartId)).frontReleasedKey, key)
  const late = await startFront(store, cartId, key)
  assert.equal(late.status, 409)
  assert.equal(late.body.stale, true)
  assert.equal((await startFront(store, cartId, newPaymentKey())).status, 200)
})

testSerial('비상구(결제 중): 10분이 안 지났으면 409와 남은 시간을 주고, 지났으면 pending으로 풀어 옛 키의 늦은 /start를 막는다', async () => {
  const { store, cartId } = await frontCart('force-paying')
  const key = newPaymentKey()
  await startFront(store, cartId, key)

  // 탭앱이 갇힘 여부를 판단하도록 결제 시작 시각이 내려온다.
  const queued = (await posQueue(store)).body.frontCarts.find((c) => c.id === cartId)
  assert.equal(queued.status, 'paying')
  assert.ok(queued.frontPayingAt)

  const early = await forceRelease(store, cartId)
  assert.equal(early.status, 409, JSON.stringify(early.body))
  assert.ok(early.body.retryAfterSec > 0 && early.body.retryAfterSec <= 600, `retryAfterSec=${early.body.retryAfterSec}`)
  assert.equal((await rowOf(cartId)).status, 'paying')

  await prisma.erpCart.update({ where: { id: cartId }, data: { frontPayingAt: elevenMinutesAgo() } })
  const res = await forceRelease(store, cartId)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.previousStatus, 'paying')
  assert.equal(res.body.status, 'pending')
  const row = await rowOf(cartId)
  assert.equal(row.status, 'pending')
  assert.equal(row.frontPaymentKey, null)
  assert.equal(row.frontPayingAt, null)
  assert.equal(row.frontReleasedKey, key)

  // 풀린 옛 시도의 늦은 /start는 거절한다.
  const lateStart = await startFront(store, cartId, key)
  assert.equal(lateStart.status, 409)
  assert.equal(lateStart.body.stale, true)

  // 풀린 뒤에는 새 키로 다시 결제할 수 있다.
  assert.equal((await startFront(store, cartId, newPaymentKey())).status, 200)
})

testSerial('비상구(결제 중): 접수 24시간이 지난 주문은 pending 대신 닫고(dismissed), 그 키의 늦은 승인 보고는 결제 완료로 받는다', async () => {
  const { store, cartId } = await frontCart('force-paying-stale')
  const key = newPaymentKey()
  await startFront(store, cartId, key)
  await prisma.erpCart.update({
    where: { id: cartId },
    data: { frontPayingAt: elevenMinutesAgo(), createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
  })
  // 24시간이 지나도 탭앱의 프론트 결제 목록에는 남아 있어야 풀 수 있다.
  assert.ok((await posQueue(store)).body.frontCarts.some((c) => c.id === cartId))

  const res = await forceRelease(store, cartId)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.status, 'dismissed')
  const row = await rowOf(cartId)
  assert.equal(row.status, 'dismissed')
  assert.equal(row.frontReleasedKey, key)

  // 프론트가 나중에 켜져 그 키의 승인을 보고하면, 손님 돈은 이 주문의 것이므로 결제 완료로 받는다.
  const late = await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(late.status, 200, JSON.stringify(late.body))
  assert.equal(late.body.status, 'paid')
  assert.equal((await rowOf(cartId)).status, 'paid')
})

testSerial('미반영 승인 흔적이 확인 전이면 /start는 409 FRONT_ORPHAN으로 막고, 매장이 확인하면 다시 결제할 수 있다', async () => {
  const { store, cartId } = await frontCart('start-orphan-block')
  await prisma.erpCart.update({
    where: { id: cartId },
    data: { frontOrphanAt: new Date(), frontOrphanApprovalNo: '30019999', frontOrphanAmount: 65000 },
  })
  const blocked = await startFront(store, cartId, newPaymentKey())
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
  assert.equal(blocked.body.code, 'FRONT_ORPHAN')
  assert.equal(blocked.body.frontOrphan.approvalNo, '30019999')
  assert.equal((await rowOf(cartId)).status, 'pending')

  await prisma.erpCart.update({ where: { id: cartId }, data: { frontOrphanAckAt: new Date() } })
  assert.equal((await startFront(store, cartId, newPaymentKey())).status, 200)
})

// --- 풀린 결제 시도의 늦은 승인 보고(PAID_AFTER_RELEASE) ------------------------------------------

const PAID_AFTER_RELEASE_LOG = '[front] 결제가 승인됐지만 주문에 반영하지 못함. 대사 필요'

// 프론트가 승인 직후 꺼져 결과를 못 보낸 채 10분이 지나 직원이 [결제 중 풀기]를 누른 주문
async function forceReleasedFrontCart(label, make = frontCart) {
  const made = await make(label)
  const key = newPaymentKey()
  assert.equal((await startFront(made.store, made.cartId, key)).status, 200)
  await prisma.erpCart.update({ where: { id: made.cartId }, data: { frontPayingAt: elevenMinutesAgo() } })
  assert.equal((await forceRelease(made.store, made.cartId)).status, 200)
  return { ...made, key }
}

testSerial('풀린 뒤 승인 보고: 아무도 다시 잡지 않았으면(프론트 대기) 결제 완료로 받고 예약 완료·영수증까지 처리한다', async () => {
  global.__notifications.length = 0
  const { store, cartId, key, reservation } = await forceReleasedFrontCart('after-release-paid', linkedFrontCart)
  const late = await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(late.status, 200, JSON.stringify(late.body))
  assert.equal(late.body.status, 'paid')
  assert.equal(late.body.alreadyProcessed, false)
  assert.equal(late.body.reservationCompleted, true)
  assert.equal(late.body.receipt, 'sent')

  const row = await rowOf(cartId)
  assert.equal(row.status, 'paid')
  assert.equal(row.frontPaymentKey, key)
  assert.equal(row.frontApprovalNo, '30012345')
  assert.ok(row.paidAt)
  assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'completed')
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 1)
  // 결제 완료가 됐으니 프론트 목록에 다시 뜨지 않는다(같은 주문의 결제창이 다시 뜨지 않는다).
  assert.deepEqual((await getFrontCarts(store)).body.carts, [])

  // 같은 보고의 재시도는 성공(alreadyProcessed)이고 영수증을 다시 보내지 않는다.
  const again = await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyProcessed, true)
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 1)
})

testSerial('풀린 뒤 승인 보고: POS로 되돌린 주문이면 404 대신 409 PAID_AFTER_RELEASE와 대사 필요 로그를 남긴다', async () => {
  const { store, cartId, key } = await forceReleasedFrontCart('after-release-pos')
  assert.equal((await returnToPos(store, cartId)).status, 200)
  let late
  const logs = await captureLoggerErrors(async () => {
    late = await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })
  })
  assert.equal(late.status, 409, JSON.stringify(late.body))
  assert.equal(late.body.code, 'PAID_AFTER_RELEASE')
  assert.equal(late.body.status, 'pending')
  const log = logs.find((l) => l.message === PAID_AFTER_RELEASE_LOG)
  assert.ok(log, '대사 필요 로그가 남지 않았다')
  assert.deepEqual(log.meta, { cartId, status: 'pending', payTarget: 'pos', paymentKey: key, approvalNumber: '30012345', amount: 65000 })
  const row = await rowOf(cartId)
  assert.equal(row.status, 'pending')
  assert.equal(row.payTarget, 'pos')
})

// R5: PAID_AFTER_RELEASE로 거절한 승인은 주문 행에 흔적(frontOrphan)을 남긴다. POS 목록·관리자 웹이 경고로 보여주고 직원이 지운다.
testSerial('미반영 승인 흔적: POS로 되돌린 주문에 늦은 승인이 오면 POS 전산 주문·관리자 목록에 frontOrphan이 실리고, 직원이 지울 수 있다', async () => {
  const { store, cartId, key } = await forceReleasedFrontCart('orphan-pos')
  assert.equal((await returnToPos(store, cartId)).status, 200)
  const before = Date.now()
  const late = await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: { ...SAMPLE_CARD_PAYMENT, amount: 64000 } })
  assert.equal(late.status, 409, JSON.stringify(late.body))
  assert.equal(late.body.code, 'PAID_AFTER_RELEASE')
  const row = await rowOf(cartId)
  assert.ok(row.frontOrphanAt && row.frontOrphanAt.getTime() >= before - 1000)
  assert.equal(row.frontOrphanApprovalNo, '30012345')
  assert.equal(row.frontOrphanAmount, 64000) // 보고에 실린 결제 금액
  assert.equal(row.status, 'pending') // 주문 상태는 바꾸지 않는다

  // POS 전산 주문(/api/pos/queue erpCarts, 구버전 /api/pos/erp-carts)에 실린다.
  const queue = await posQueue(store)
  const card = queue.body.erpCarts.find((c) => c.id === cartId)
  assert.ok(card)
  assert.equal(card.frontOrphan.approvalNo, '30012345')
  assert.equal(card.frontOrphan.amount, 64000)
  assert.ok(card.frontOrphan.at)
  const legacy = await request(app).get('/api/pos/erp-carts').set('X-Store-Token', store.posToken)
  assert.equal(legacy.body.carts.find((c) => c.id === cartId).frontOrphan.approvalNo, '30012345')

  // 관리자 웹 전산 주문 목록
  const { hashPassword, signAdminToken } = require('../src/auth')
  const admin = await prisma.adminUser.create({
    data: { email: `${unique('hq')}@example.test`, passwordHash: await hashPassword('test-password-123'), role: 'hq_admin', storeId: null },
  })
  const adminList = await request(app).get('/api/admin/erp-carts').set('Authorization', `Bearer ${signAdminToken(admin)}`)
  assert.equal(adminList.status, 200)
  assert.equal(adminList.body.carts.find((c) => c.id === cartId).frontOrphan.amount, 64000)

  // [확인했어요]: 다른 매장 토큰은 404, 이 매장은 지우지 않고 확인 시각만 남기며 경고 로그를 남긴다. 다시 눌러도 성공.
  assert.equal(card.frontOrphan.ackAt, null)
  const other = await createStore('orphan-pos-other')
  assert.equal((await posPost(other, `/api/pos/erp-carts/${cartId}/clear-front-orphan`)).status, 404)
  const logger = require('../src/logger')
  const original = logger.warn
  const warns = []
  logger.warn = (message, meta) => { warns.push({ message, meta }) }
  let cleared
  try {
    cleared = await posPost(store, `/api/pos/erp-carts/${cartId}/clear-front-orphan`)
  } finally {
    logger.warn = original
  }
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
  assert.equal(cleared.body.ok, true)
  assert.equal(cleared.body.alreadyProcessed, false)
  assert.ok(cleared.body.frontOrphan.ackAt)
  assert.ok(warns.some((w) => w.message.includes('프론트 미반영 승인 경고를 확인함') && w.meta.cartId === cartId && w.meta.approvalNo === '30012345'))
  // R3: 흔적은 지우지 않는다 -- 관리자 웹의 대사 근거가 남아야 한다.
  const after = await rowOf(cartId)
  assert.ok(after.frontOrphanAt)
  assert.equal(after.frontOrphanApprovalNo, '30012345')
  assert.equal(after.frontOrphanAmount, 64000)
  assert.ok(after.frontOrphanAckAt)
  const ackedCard = (await posQueue(store)).body.erpCarts.find((c) => c.id === cartId).frontOrphan
  assert.equal(ackedCard.approvalNo, '30012345')
  assert.ok(ackedCard.ackAt)
  const adminAfter = await request(app).get('/api/admin/erp-carts').set('Authorization', `Bearer ${signAdminToken(admin)}`)
  assert.ok(adminAfter.body.carts.find((c) => c.id === cartId).frontOrphan.ackAt, '관리자 웹에 매장 확인함으로 계속 보여야 한다')
  const again = await posPost(store, `/api/pos/erp-carts/${cartId}/clear-front-orphan`)
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyProcessed, true)
  assert.equal(new Date(again.body.frontOrphan.ackAt).getTime(), after.frontOrphanAckAt.getTime()) // 확인 시각은 처음 것 그대로
})

testSerial('미반영 승인 흔적: 금액이 없으면 주문 금액으로 남고 프론트 대기·최근 결제에 실린다, 다른 승인으로 결제되면 남기고 같은 승인이 반영되면 지운다', async () => {
  // 묘비에 없는 키의 승인(이 주문에서 결제창이 뜬 적 없음) -- 금액이 보고에 없다.
  const { store, cartId } = await frontCart('orphan-front')
  const stray = await reportFront(store, cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: { ...SAMPLE_CARD_PAYMENT, approvalNumber: '99990000' } })
  assert.equal(stray.body.code, 'PAID_AFTER_RELEASE')
  let row = await rowOf(cartId)
  assert.equal(row.frontOrphanAmount, 65000)
  assert.equal(row.frontOrphanApprovalNo, '99990000')
  const frontCard = (await posQueue(store)).body.frontCarts.find((c) => c.id === cartId)
  assert.deepEqual({ approvalNo: frontCard.frontOrphan.approvalNo, amount: frontCard.frontOrphan.amount }, { approvalNo: '99990000', amount: 65000 })

  // 다른 승인으로 이 주문이 결제됐다 -- 같은 주문을 두 번 받은 것이라 흔적을 남긴다(최근 결제 카드에 실린다).
  // 확인 전 흔적이 있으면 /start가 막히므로(FRONT_ORPHAN), 매장이 확인한 뒤 다시 결제한 경우로 둔다.
  await prisma.erpCart.update({ where: { id: cartId }, data: { frontOrphanAckAt: new Date() } })
  const key = newPaymentKey()
  assert.equal((await startFront(store, cartId, key)).status, 200)
  assert.equal((await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })).status, 200)
  row = await rowOf(cartId)
  assert.equal(row.status, 'paid')
  assert.equal(row.frontOrphanApprovalNo, '99990000')
  const settled = (await posQueue(store)).body.settledCarts.find((c) => c.id === cartId)
  assert.equal(settled.frontOrphan.approvalNo, '99990000')

  // POS로 되돌렸다가 다시 프론트로 보낸 주문에 같은 승인의 보고가 다시 와 결제로 반영되면 흔적을 지운다.
  const second = await forceReleasedFrontCart('orphan-front-same')
  assert.equal((await returnToPos(second.store, second.cartId)).status, 200)
  assert.equal((await reportFront(second.store, second.cartId, { result: 'paid', paymentKey: second.key, payment: SAMPLE_CARD_PAYMENT })).body.code, 'PAID_AFTER_RELEASE')
  assert.ok((await rowOf(second.cartId)).frontOrphanAt)
  assert.equal((await sendToFront(second.store, second.cartId)).status, 200)
  const recorded = await reportFront(second.store, second.cartId, { result: 'paid', paymentKey: second.key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body))
  const secondRow = await rowOf(second.cartId)
  assert.equal(secondRow.status, 'paid')
  assert.equal(secondRow.frontOrphanAt, null)
  assert.equal((await posQueue(second.store)).body.settledCarts.find((c) => c.id === second.cartId).frontOrphan, null)
})

testSerial('풀린 뒤 승인 보고: 새 시도가 이미 잡았거나 지운 주문이면 반영하지 않고 409 PAID_AFTER_RELEASE', async () => {
  // 새 시도가 결제 중이다 -- 옛 키의 보고가 그 시도를 덮으면 안 되고, 새 시도는 끝까지 결제된다.
  const first = await forceReleasedFrontCart('after-release-retaken')
  const newKey = newPaymentKey()
  assert.equal((await startFront(first.store, first.cartId, newKey)).status, 200)
  let late
  const logs = await captureLoggerErrors(async () => {
    late = await reportFront(first.store, first.cartId, { result: 'paid', paymentKey: first.key, payment: SAMPLE_CARD_PAYMENT })
  })
  assert.equal(late.status, 409)
  assert.equal(late.body.code, 'PAID_AFTER_RELEASE')
  assert.equal(late.body.status, 'paying')
  assert.ok(logs.some((l) => l.message === PAID_AFTER_RELEASE_LOG && l.meta.status === 'paying'))
  assert.equal((await rowOf(first.cartId)).frontPaymentKey, newKey)
  assert.equal((await reportFront(first.store, first.cartId, { result: 'paid', paymentKey: newKey, payment: SAMPLE_CARD_PAYMENT })).status, 200)

  // 그 뒤 다른 키로 결제가 끝난 주문에 옛 키의 보고가 와도 같다(같은 주문을 두 번 받은 것).
  const otherKey = await reportFront(first.store, first.cartId, { result: 'paid', paymentKey: first.key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(otherKey.status, 409)
  assert.equal(otherKey.body.code, 'PAID_AFTER_RELEASE')
  assert.equal(otherKey.body.status, 'paid')

  // 직원이 탭앱에서 지운(dismissed) 주문
  const second = await forceReleasedFrontCart('after-release-dismissed')
  assert.equal((await posPost(second.store, `/api/pos/erp-carts/${second.cartId}/dismiss-front`)).status, 200)
  const dismissed = await reportFront(second.store, second.cartId, { result: 'paid', paymentKey: second.key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(dismissed.status, 409)
  assert.equal(dismissed.body.code, 'PAID_AFTER_RELEASE')
  assert.equal(dismissed.body.status, 'dismissed')
  assert.equal((await rowOf(second.cartId)).status, 'dismissed')
})

testSerial('승인 보고: 묘비에 없는 키(이 주문에서 결제창이 뜬 적 없음)는 프론트 대기 주문이어도 결제 완료로 받지 않는다', async () => {
  const { store, cartId } = await frontCart('paid-unknown-key')
  const logs = await captureLoggerErrors(async () => {
    const res = await reportFront(store, cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: SAMPLE_CARD_PAYMENT })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'PAID_AFTER_RELEASE')
  })
  assert.ok(logs.some((l) => l.message === PAID_AFTER_RELEASE_LOG))
  assert.equal((await rowOf(cartId)).status, 'pending')
  // 없는 주문·다른 매장은 그대로 404
  assert.equal((await reportFront(store, crypto.randomUUID(), { result: 'paid', paymentKey: newPaymentKey(), payment: SAMPLE_CARD_PAYMENT })).status, 404)
})

testSerial('승인 보고: 같은 키로 결제된 뒤 취소가 요청된 주문에 온 재보고는 성공(alreadyProcessed)으로 본다', async () => {
  const { store, cartId } = await frontCart('paid-retry-refund')
  const key = newPaymentKey()
  await startFront(store, cartId, key)
  await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/refund-request`)).status, 200)
  const retry = await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(retry.status, 200, JSON.stringify(retry.body))
  assert.equal(retry.body.alreadyProcessed, true)
  assert.equal(retry.body.status, 'refund_requested')
})

// --- 묘비 목록(최근 10개) ---------------------------------------------------------------------

const releasedKeysOf = async (cartId) => ((await rowOf(cartId)).frontReleasedKey || '').split(',').filter(Boolean)

testSerial('묘비 목록: 포기 보고가 연달아 먼저 도착해도 앞의 키를 덮어쓰지 않아, 두 키의 늦은 /start를 모두 거절한다', async () => {
  const { store, cartId } = await frontCart('tombstone-multi')
  const b = newPaymentKey()
  const c = newPaymentKey()
  // /start(B) 시간 초과 → cancelled(B) 먼저 처리 → 다시 시작한 /start(C)도 시간 초과 → cancelled(C) 먼저 처리
  assert.equal((await reportFront(store, cartId, { result: 'cancelled', paymentKey: b })).status, 200)
  assert.equal((await reportFront(store, cartId, { result: 'cancelled', paymentKey: c })).status, 200)
  assert.deepEqual(await releasedKeysOf(cartId), [b, c])
  // 예전에는 묘비가 C로 덮여, 늦게 처리된 /start(B)가 주문을 결제 중으로 가뒀다.
  for (const key of [b, c]) {
    const late = await startFront(store, cartId, key)
    assert.equal(late.status, 409, JSON.stringify(late.body))
    assert.equal(late.body.stale, true)
  }
  assert.equal((await rowOf(cartId)).status, 'pending')
})

testSerial('묘비 목록: 다른 키가 결제 중일 때 온 포기 보고도 남기고, 결제 중인 키는 그대로 끝까지 결제된다', async () => {
  const { store, cartId } = await frontCart('tombstone-while-paying')
  const a = newPaymentKey()
  const b = newPaymentKey()
  assert.equal((await startFront(store, cartId, a)).status, 200)
  const stale = await reportFront(store, cartId, { result: 'cancelled', paymentKey: b })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.status, 'paying')
  assert.deepEqual(await releasedKeysOf(cartId), [b])

  // 결제 중인 A가 손님 취소로 풀린 뒤에도, B의 늦은 /start는 이 주문을 잡지 못한다.
  assert.equal((await reportFront(store, cartId, { result: 'cancelled', paymentKey: a })).status, 200)
  const late = await startFront(store, cartId, b)
  assert.equal(late.status, 409)
  assert.equal(late.body.stale, true)

  // 묘비가 있어도 결제 중인 키의 완료는 막지 않는다.
  const c = newPaymentKey()
  assert.equal((await startFront(store, cartId, c)).status, 200)
  await reportFront(store, cartId, { result: 'cancelled', paymentKey: newPaymentKey() })
  const paid = await reportFront(store, cartId, { result: 'paid', paymentKey: c, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  assert.equal(paid.body.status, 'paid')
})

// body를 실행하는 동안 erpCart[method]의 다음 호출 한 번이 끝난 직후 race()를 실행한다(그 사이 다른 요청이 끼어든 것처럼).
async function withRaceAfterNext(method, race, body) {
  const original = prisma.erpCart[method]
  let fired = false
  prisma.erpCart[method] = async (...args) => {
    const result = await original.apply(prisma.erpCart, args)
    if (!fired) {
      fired = true
      await race(result)
    }
    return result
  }
  try {
    return await body()
  } finally {
    prisma.erpCart[method] = original
  }
}

testSerial('묘비 목록: /start가 목록을 읽은 직후 그 키의 포기 보고가 기록되면 /start는 결제 중을 잡지 못한다(확인과 전이가 한 번에)', async () => {
  const { store, cartId } = await frontCart('tombstone-start-race')
  const key = newPaymentKey()
  const res = await withRaceAfterNext('findUnique', async () => {
    assert.equal((await reportFront(store, cartId, { result: 'cancelled', paymentKey: key })).status, 200)
  }, () => startFront(store, cartId, key))
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.stale, true)
  const row = await rowOf(cartId)
  assert.equal(row.status, 'pending')
  assert.equal(row.frontPaymentKey, null)
})

testSerial('묘비 목록: 포기 보고의 첫 되돌리기가 실패한 직후 그 키의 /start가 먼저 잡았으면, 기록 뒤 다시 되돌린다', async () => {
  const { store, cartId } = await frontCart('tombstone-release-race')
  const key = newPaymentKey()
  const res = await withRaceAfterNext('updateMany', async (first) => {
    assert.equal(first.count, 0) // 아직 pending이라 되돌릴 게 없었다
    assert.equal((await startFront(store, cartId, key)).status, 200)
  }, () => reportFront(store, cartId, { result: 'cancelled', paymentKey: key }))
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.status, 'pending')
  const row = await rowOf(cartId)
  assert.equal(row.status, 'pending')
  assert.equal(row.frontPaymentKey, null)
  assert.deepEqual(await releasedKeysOf(cartId), [key])
})

testSerial('묘비 목록: 최근 10개만 남긴다', async () => {
  const { store, cartId } = await frontCart('tombstone-limit')
  const keys = Array.from({ length: 12 }, () => newPaymentKey())
  for (const key of keys) {
    assert.equal((await reportFront(store, cartId, { result: 'failed', paymentKey: key })).status, 200)
  }
  assert.deepEqual(await releasedKeysOf(cartId), keys.slice(-10))
  assert.equal((await startFront(store, cartId, keys[11])).body.stale, true)
})

testSerial('비상구: 결제 중·취소 중이 아닌 주문은 409, 다른 매장 토큰은 404', async () => {
  const { store, cartId } = await frontCart('force-wrong')
  const res = await forceRelease(store, cartId)
  assert.equal(res.status, 409)
  assert.equal(res.body.status, 'pending')
  assert.equal(typeof res.body.retryAfterSec, 'number')

  await startFront(store, cartId, newPaymentKey())
  await prisma.erpCart.update({ where: { id: cartId }, data: { frontPayingAt: elevenMinutesAgo() } })
  const other = await createStore('force-other')
  assert.equal((await forceRelease(other, cartId)).status, 404)
  assert.equal((await rowOf(cartId)).status, 'paying')
})

testSerial('정리: 취소가 진행 중인 건은 숨길 수도 없다(409)', async () => {
  const { store, cartId } = await paidFrontCart('cleanup-hide-refunding')
  await prisma.erpCart.update({ where: { id: cartId }, data: { status: 'refunding', refundStartedAt: new Date() } })
  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/hide`, { hidden: true })).status, 409)
  assert.equal((await rowOf(cartId)).hiddenAt, null)
})

testSerial('POS 결제 통보: 프론트 결제 대기 주문은 결제 완료로 기록할 수 없다(409)', async () => {
  const { store, cartId } = await frontCart('pos-paid-front')
  const logs = await captureLoggerErrors(async () => {
    const res = await posPost(store, `/api/pos/erp-carts/${cartId}/paid`, { paymentId: 'p-1' })
    assert.equal(res.status, 409)
  })
  // POS에서 돈이 나갔다는 통보이므로 대사가 필요하다고 남긴다.
  assert.ok(logs.some((l) => l.message.includes('프론트 결제 주문에 POS 결제 통보')))
  assert.equal((await rowOf(cartId)).status, 'pending')
})

testSerial('POS 결제 통보: 프론트에서 이미 결제된 주문에 온 POS 결제는 처리됨이 아니라 409 ALREADY_PAID_OTHER(이중 결제)', async () => {
  const { store, cartId } = await paidFrontCart('pos-paid-after-front')
  const logs = await captureLoggerErrors(async () => {
    const res = await posPost(store, `/api/pos/erp-carts/${cartId}/paid`, { paymentId: 'pos-pay-2' })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.equal(res.body.code, 'ALREADY_PAID_OTHER')
    assert.equal(res.body.status, 'paid')
  })
  const log = logs.find((l) => l.message.includes('이미 결제된 주문에 다른 결제 통보'))
  assert.ok(log, '대사 필요 로그가 남지 않았다')
  assert.equal(log.meta.payTarget, 'front')
  assert.equal(log.meta.reportedPaymentId, 'pos-pay-2')
})

testSerial('삭제 되살리기: 삭제 표시된 주문이 프론트 결제 완료로 확정되면 다시 보인다', async () => {
  const { store, cartId } = await frontCart('revive-front')
  const key = newPaymentKey()
  await startFront(store, cartId, key)
  // 예전 버전은 결제 전 주문도 정비 이력 삭제로 deletedAt이 찍혔다(데이터가 그렇게 남아 있을 수 있다).
  await prisma.erpCart.update({ where: { id: cartId }, data: { deletedAt: new Date() } })
  const res = await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal((await rowOf(cartId)).deletedAt, null)
  assert.ok((await settledOf(store)).some((c) => c.id === cartId))
})

testSerial('전산 재전송: 취소됐던 주문을 같은 referenceId로 다시 담으면 숨김·삭제·시도 흔적이 지워진다', async () => {
  const store = await createStore('resend-reset')
  const body = validBody(store, { payTarget: 'front' })
  const created = await postCart(body)
  assert.equal(created.status, 201)
  const cancel = await request(app).post(`/api/erp/carts/${body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN)
  assert.equal(cancel.status, 200)
  await prisma.erpCart.update({
    where: { id: created.body.cartId },
    data: {
      hiddenAt: new Date(), deletedAt: new Date(), receiptStatus: 'sent', frontReleasedKey: 'old-released-key',
      refundAttemptId: 'old-refund-attempt', refundReleasedAttemptId: 'old-released-attempt', refundStartedAt: new Date(),
      consumeAttemptId: 'old-consume-attempt', frontSentAt: null,
    },
  })

  const again = await postCart(body)
  assert.equal(again.status, 201, JSON.stringify(again.body))
  const row = await rowOf(created.body.cartId)
  for (const field of ['hiddenAt', 'deletedAt', 'receiptStatus', 'frontReleasedKey', 'refundAttemptId', 'refundReleasedAttemptId', 'refundStartedAt', 'consumeAttemptId']) {
    assert.equal(row[field], null, `${field}가 지워지지 않았다`)
  }
  assert.ok(row.frontSentAt, '프론트 결제로 다시 담았으면 보낸 시각이 새로 찍혀야 한다')

  // POS 결제로 다시 담으면 프론트로 보낸 시각은 비운다.
  await request(app).post(`/api/erp/carts/${body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN)
  const asPos = await postCart({ ...body, payTarget: 'pos' })
  assert.equal(asPos.status, 201)
  assert.equal((await rowOf(created.body.cartId)).frontSentAt, null)
})

// --- R3: 경고된 프론트 승인을 이 주문의 결제로 기록(record-front-orphan) ---------------------------------------

const recordOrphan = (store, cartId) => posPost(store, `/api/pos/erp-carts/${cartId}/record-front-orphan`)
const ackOrphan = (store, cartId) => posPost(store, `/api/pos/erp-carts/${cartId}/clear-front-orphan`)
const SANITIZED_SAMPLE_PAYMENT = {
  paymentMethod: 'CARD', approvalNumber: '30012345', timestamp: 1761000000000, installment: 0, vanTransactionKey: 'VAN-0001',
  van: null, tid: 'CAT-01', isCashReceipt: null, isSelfIssuance: null, easyPayProvider: null,
}

testSerial('미반영 승인 기록: POS로 되돌린 주문에 남은 승인을 결제 완료로 기록하면 프론트 결제가 되고, 토스 기록 잇기·예약 완료·영수증까지 처리한다', async () => {
  global.__notifications.length = 0
  const { store, cartId, key, reservation } = await forceReleasedFrontCart('record-orphan', linkedFrontCart)
  assert.equal((await returnToPos(store, cartId)).status, 200)
  assert.equal((await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })).body.code, 'PAID_AFTER_RELEASE')
  let row = await rowOf(cartId)
  // 거절한 승인의 결제 정보(카드번호 등 필요 없는 값은 빼고)와 paymentKey를 흔적과 함께 남긴다.
  assert.deepEqual(JSON.parse(row.frontOrphanPaymentJson), SANITIZED_SAMPLE_PAYMENT)
  assert.equal(row.frontOrphanPaymentKey, key)

  // 웹훅이 먼저 와서 토스 결제 기록과 결제 백업 기록(phone 없음)이 있다.
  const tp = await prisma.tossPayment.create({
    data: { id: unique('640'), merchantId: store.merchantId, storeId: store.id, orderId: unique('620'), state: 'APPROVED', sourceType: 'CARD', amount: 65000, approvedNo: '30012345' },
  })
  await prisma.payment.create({ data: { storeId: store.id, paymentKey: tp.orderId, amount: 65000, promoAt: new Date(), status: 'requested' } })

  const original = logger.warn
  const warns = []
  logger.warn = (message, meta) => { warns.push({ message, meta }) }
  let res
  try {
    res = await recordOrphan(store, cartId)
  } finally {
    logger.warn = original
  }
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual({ ok: res.body.ok, status: res.body.status, wasStatus: res.body.wasStatus }, { ok: true, status: 'paid', wasStatus: 'pending' })
  assert.equal(res.body.reservationCompleted, true)
  assert.equal(res.body.receipt, 'sent')
  const log = warns.find((w) => w.message.includes('프론트 미반영 승인을 이 주문의 결제로 기록'))
  assert.ok(log, '기록 경고 로그가 남지 않았다')
  assert.deepEqual({ cartId: log.meta.cartId, wasStatus: log.meta.wasStatus, approvalNo: log.meta.approvalNo, amount: log.meta.amount }, { cartId, wasStatus: 'pending', approvalNo: '30012345', amount: 65000 })

  row = await rowOf(cartId)
  assert.equal(row.status, 'paid')
  assert.equal(row.payTarget, 'front')
  assert.ok(row.paidAt)
  assert.equal(row.frontApprovalNo, '30012345')
  assert.equal(row.frontPaymentKey, key)
  assert.deepEqual(JSON.parse(row.frontPaymentJson), SANITIZED_SAMPLE_PAYMENT)
  for (const field of ['frontOrphanAt', 'frontOrphanApprovalNo', 'frontOrphanAmount', 'frontOrphanAckAt', 'frontOrphanPaymentJson', 'frontOrphanPaymentKey']) {
    assert.equal(row[field], null, `${field}가 지워지지 않았다`)
  }
  // 토스 결제와 잇고, 웹훅 백업 기록은 집계에서 뺀다.
  assert.equal(row.tossPaymentId, tp.id)
  assert.ok(row.tossVerifiedAt)
  assert.equal((await prisma.payment.findFirst({ where: { paymentKey: tp.orderId } })).status, 'erp_linked')
  assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'completed')
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 1)

  // 탭앱: 전산 주문(대기)에서 빠지고 최근 결제에 프론트 결제로 뜬다. 전산 조회도 결제 완료.
  const queue = (await posQueue(store)).body
  assert.equal(queue.erpCarts.some((c) => c.id === cartId), false)
  const settled = queue.settledCarts.find((c) => c.id === cartId)
  assert.deepEqual({ status: settled.status, payTarget: settled.payTarget, frontOrphan: settled.frontOrphan }, { status: 'paid', payTarget: 'front', frontOrphan: null })
  const erpStatus = await getCart(row.referenceId)
  assert.equal(erpStatus.body.status, 'paid')
  assert.equal(erpStatus.body.frontOrphan, null)

  // 같은 승인의 보고가 다시 와도(프론트 재시작 복구) 처리됨이고, 흔적을 다시 남기지 않는다.
  const again = await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.alreadyProcessed, true)
  assert.equal((await rowOf(cartId)).frontOrphanAt, null)
  // 다시 누르면 기록할 흔적이 없다.
  const twice = await recordOrphan(store, cartId)
  assert.equal(twice.status, 409)
  assert.equal(twice.body.code, 'NO_FRONT_ORPHAN')
  assert.equal(twice.body.status, 'paid')

  // 프론트에서 취소할 수 있다: 취소 정보에 원결제 paymentKey·승인번호가 실린다.
  assert.equal((await posPost(store, `/api/pos/erp-carts/${cartId}/refund-request`)).status, 200)
  const refund = (await getFrontCarts(store)).body.refunds.find((r) => r.id === cartId).refund
  assert.deepEqual({ paymentKey: refund.paymentKey, approvalNumber: refund.approvalNumber, totalAmount: refund.totalAmount }, { paymentKey: key, approvalNumber: '30012345', totalAmount: 65000 })
})

testSerial('미반영 승인 경고 목록: 지운 주문·전산 취소된 주문의 확인 전 흔적은 frontOrphans로 따로 내려가고, 결제로 기록하거나 확인하면 빠진다', async () => {
  // 직원이 [결제 중 풀기] 뒤 [지우기]를 누른 주문에 늦은 승인이 왔다 -- 이 주문은 POS 어느 목록에도 실리지 않는다.
  const dismissed = await forceReleasedFrontCart('orphan-list-dismissed')
  assert.equal((await posPost(dismissed.store, `/api/pos/erp-carts/${dismissed.cartId}/dismiss-front`)).status, 200)
  assert.equal((await reportFront(dismissed.store, dismissed.cartId, { result: 'paid', paymentKey: dismissed.key, payment: SAMPLE_CARD_PAYMENT })).body.code, 'PAID_AFTER_RELEASE')
  let queue = (await posQueue(dismissed.store)).body
  assert.equal(queue.frontOrphans.length, 1)
  const alert = queue.frontOrphans[0]
  assert.deepEqual(
    { id: alert.id, referenceId: alert.referenceId, totalAmount: alert.totalAmount, status: alert.status, payTarget: alert.payTarget },
    { id: dismissed.cartId, referenceId: dismissed.body.referenceId, totalAmount: 65000, status: 'dismissed', payTarget: 'front' }
  )
  assert.equal('carNumber' in alert, true)
  assert.deepEqual({ approvalNo: alert.frontOrphan.approvalNo, amount: alert.frontOrphan.amount, ackAt: alert.frontOrphan.ackAt }, { approvalNo: '30012345', amount: 65000, ackAt: null })
  for (const list of ['erpCarts', 'frontCarts', 'settledCarts']) assert.equal(queue[list].some((c) => c.id === dismissed.cartId), false, list)

  // 그 승인으로 결제 완료를 기록하면 경고 목록에서 빠지고 최근 결제에 뜬다.
  const recorded = await recordOrphan(dismissed.store, dismissed.cartId)
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body))
  assert.equal(recorded.body.wasStatus, 'dismissed')
  queue = (await posQueue(dismissed.store)).body
  assert.deepEqual(queue.frontOrphans, [])
  assert.equal(queue.settledCarts.find((c) => c.id === dismissed.cartId).status, 'paid')

  // 전산이 먼저 취소한 프론트 대기 주문에 늦게 보고된 승인
  const cancelled = await frontCart('orphan-list-cancelled')
  assert.equal((await request(app).post(`/api/erp/carts/${cancelled.body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN)).status, 200)
  assert.equal((await reportFront(cancelled.store, cancelled.cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: SAMPLE_CARD_PAYMENT })).body.code, 'PAID_AFTER_RELEASE')
  assert.equal((await posQueue(cancelled.store)).body.frontOrphans[0].status, 'cancelled')
  // 7일이 지난 흔적은 탭앱 목록에서 빼고 관리자 웹 대사로 넘긴다.
  await prisma.erpCart.update({ where: { id: cancelled.cartId }, data: { frontOrphanAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } })
  assert.deepEqual((await posQueue(cancelled.store)).body.frontOrphans, [])
  await prisma.erpCart.update({ where: { id: cancelled.cartId }, data: { frontOrphanAt: new Date() } })
  // 확인하면 목록에서 빠지지만 흔적은 남는다.
  assert.equal((await ackOrphan(cancelled.store, cancelled.cartId)).status, 200)
  assert.deepEqual((await posQueue(cancelled.store)).body.frontOrphans, [])
  const row = await rowOf(cancelled.cartId)
  assert.ok(row.frontOrphanAt && row.frontOrphanAckAt)
  // 늦은 승인이 또 오면 새 흔적은 확인 전으로 돌아가 다시 목록에 뜬다.
  assert.equal((await reportFront(cancelled.store, cancelled.cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: { ...SAMPLE_CARD_PAYMENT, approvalNumber: '30019999' } })).body.code, 'PAID_AFTER_RELEASE')
  const again = (await posQueue(cancelled.store)).body.frontOrphans
  assert.equal(again.length, 1)
  assert.deepEqual({ approvalNo: again[0].frontOrphan.approvalNo, ackAt: again[0].frontOrphan.ackAt }, { approvalNo: '30019999', ackAt: null })
})

testSerial('미반영 승인 기록: 금액이 다르면 409 AMOUNT_MISMATCH, 결제 중·결제 완료 주문은 409 NOT_RECORDABLE, 흔적이 없거나 다른 매장이면 거절한다', async () => {
  const { store, cartId, key } = await forceReleasedFrontCart('record-orphan-guard')
  assert.equal((await returnToPos(store, cartId)).status, 200)
  await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: { ...SAMPLE_CARD_PAYMENT, amount: 64000 } })
  const mismatch = await recordOrphan(store, cartId)
  assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body))
  assert.equal(mismatch.body.code, 'AMOUNT_MISMATCH')
  assert.deepEqual({ orphanAmount: mismatch.body.orphanAmount, cartAmount: mismatch.body.cartAmount, status: mismatch.body.status }, { orphanAmount: 64000, cartAmount: 65000, status: 'pending' })
  let row = await rowOf(cartId)
  assert.equal(row.status, 'pending')
  assert.ok(row.frontOrphanAt)
  const other = await createStore('record-orphan-guard-other')
  assert.equal((await recordOrphan(other, cartId)).status, 404)

  // 묘비에 없는 키의 승인이 남은 프론트 대기 주문을 다른 키로 결제 중·결제 완료하면 기록할 수 없다(같은 주문을 두 번 받은 것).
  const twice = await frontCart('record-orphan-paid')
  await reportFront(twice.store, twice.cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: { ...SAMPLE_CARD_PAYMENT, approvalNumber: '99990000' } })
  // 확인 전 흔적이 있으면 /start가 막히므로 매장이 확인한 뒤 다시 결제한 경우로 둔다(확인해도 기록 대상인 흔적은 남는다).
  await prisma.erpCart.update({ where: { id: twice.cartId }, data: { frontOrphanAckAt: new Date() } })
  const k2 = newPaymentKey()
  assert.equal((await startFront(twice.store, twice.cartId, k2)).status, 200)
  const paying = await recordOrphan(twice.store, twice.cartId)
  assert.equal(paying.status, 409)
  assert.deepEqual({ code: paying.body.code, status: paying.body.status }, { code: 'NOT_RECORDABLE', status: 'paying' })
  assert.equal((await reportFront(twice.store, twice.cartId, { result: 'paid', paymentKey: k2, payment: SAMPLE_CARD_PAYMENT })).status, 200)
  const paid = await recordOrphan(twice.store, twice.cartId)
  assert.deepEqual({ status: paid.status, code: paid.body.code, cartStatus: paid.body.status }, { status: 409, code: 'NOT_RECORDABLE', cartStatus: 'paid' })
  row = await rowOf(twice.cartId)
  assert.equal(row.frontPaymentKey, k2)
  assert.ok(row.frontOrphanAt) // 이중 결제 흔적은 그대로 남는다

  // 흔적이 없는 주문
  const none = await frontCart('record-orphan-none')
  const noOrphan = await recordOrphan(none.store, none.cartId)
  assert.deepEqual({ status: noOrphan.status, code: noOrphan.body.code }, { status: 409, code: 'NO_FRONT_ORPHAN' })
})

testSerial('미반영 승인 기록: 읽은 뒤 프론트가 결제를 시작하면 기록하지 않는다(상태·흔적 확인과 전이가 한 번에)', async () => {
  const { store, cartId } = await frontCart('record-orphan-race')
  await reportFront(store, cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: SAMPLE_CARD_PAYMENT })
  // 확인 전 흔적이 있으면 /start가 막히므로, 다른 단말기에서 매장이 확인하고 프론트가 곧바로 결제를 시작한 경우로 끼워 넣는다.
  const res = await withRaceAfterNext('findUnique', async () => {
    await prisma.erpCart.update({ where: { id: cartId }, data: { frontOrphanAckAt: new Date() } })
    assert.equal((await startFront(store, cartId, newPaymentKey())).status, 200)
  }, () => recordOrphan(store, cartId))
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.deepEqual({ code: res.body.code, status: res.body.status }, { code: 'CHANGED', status: 'paying' })
  const row = await rowOf(cartId)
  assert.equal(row.status, 'paying')
  assert.ok(row.frontOrphanAt)
})

testSerial('전산 취소·조회: 확인 전 미반영 승인이 있는 대기 주문은 취소를 409 FRONT_ORPHAN으로 막고, 조회·취소 응답에 frontOrphan을 싣는다', async () => {
  const { store, cartId, key, body } = await forceReleasedFrontCart('erp-cancel-orphan')
  const cancelCart = () => request(app).post(`/api/erp/carts/${body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN)
  assert.equal((await getCart(body.referenceId)).body.frontOrphan, null)
  assert.equal((await returnToPos(store, cartId)).status, 200)
  await reportFront(store, cartId, { result: 'paid', paymentKey: key, payment: SAMPLE_CARD_PAYMENT })

  const status = await getCart(body.referenceId)
  assert.equal(status.body.status, 'pending')
  assert.deepEqual({ approvalNo: status.body.frontOrphan.approvalNo, amount: status.body.frontOrphan.amount, ackAt: status.body.frontOrphan.ackAt }, { approvalNo: '30012345', amount: 65000, ackAt: null })
  assert.ok(status.body.frontOrphan.at)

  const blocked = await cancelCart()
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
  assert.equal(blocked.body.code, 'FRONT_ORPHAN')
  assert.equal(blocked.body.status, 'pending')
  assert.equal(blocked.body.frontOrphan.approvalNo, '30012345')
  assert.equal((await rowOf(cartId)).status, 'pending')

  // 매장이 확인하면 전산이 취소할 수 있다(응답에 확인된 흔적이 실린다). 끝난 주문의 취소는 예전처럼 409지만 frontOrphan을 싣는다.
  assert.equal((await ackOrphan(store, cartId)).status, 200)
  const cancelled = await cancelCart()
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
  assert.equal(cancelled.body.status, 'cancelled')
  assert.ok(cancelled.body.frontOrphan.ackAt)
  const late = await cancelCart()
  assert.equal(late.status, 409)
  assert.equal(late.body.status, 'cancelled')
  assert.equal(late.body.frontOrphan.approvalNo, '30012345')
})

testSerial('전산 취소: 읽은 뒤 늦은 승인이 흔적을 남기면 취소하지 않고 409 FRONT_ORPHAN(확인과 전이가 한 번에)', async () => {
  const { store, cartId, body } = await frontCart('erp-cancel-orphan-race')
  const res = await withRaceAfterNext('findUnique', async () => {
    assert.equal((await reportFront(store, cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: SAMPLE_CARD_PAYMENT })).body.code, 'PAID_AFTER_RELEASE')
  }, () => request(app).post(`/api/erp/carts/${body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN))
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'FRONT_ORPHAN')
  assert.equal((await rowOf(cartId)).status, 'pending')
})

testSerial('만료: 확인 전 미반영 승인이 있는 대기 주문은 하루가 지나도 만료하지 않고 POS 목록에 계속 보인다(프론트 단말에는 안 띄운다), 확인하면 만료된다', async () => {
  const { expireStaleErpCarts } = require('../src/store')
  // POS로 되돌린 주문
  const posSide = await forceReleasedFrontCart('expire-orphan-pos')
  assert.equal((await returnToPos(posSide.store, posSide.cartId)).status, 200)
  await reportFront(posSide.store, posSide.cartId, { result: 'paid', paymentKey: posSide.key, payment: SAMPLE_CARD_PAYMENT })
  // 프론트 대기 주문(묘비에 없는 키의 승인) -- 프론트 단말 목록에도 frontOrphan이 실린다.
  const frontSide = await frontCart('expire-orphan-front')
  await reportFront(frontSide.store, frontSide.cartId, { result: 'paid', paymentKey: newPaymentKey(), payment: SAMPLE_CARD_PAYMENT })
  assert.equal((await getFrontCarts(frontSide.store)).body.carts.find((c) => c.id === frontSide.cartId).frontOrphan.approvalNo, '30012345')
  // 경고가 없는 주문
  const plain = await postCart(validBody(posSide.store))
  const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
  await prisma.erpCart.updateMany({ where: { id: { in: [posSide.cartId, frontSide.cartId, plain.body.cartId] } }, data: { createdAt: dayAgo } })

  assert.equal(await expireStaleErpCarts(), 1)
  assert.equal((await rowOf(plain.body.cartId)).status, 'expired')
  assert.equal((await rowOf(posSide.cartId)).status, 'pending')
  assert.equal((await rowOf(frontSide.cartId)).status, 'pending')
  // POS 탭앱(전산 주문·프론트 대기)에는 하루가 지나도 보인다. 손님이 보는 프론트 단말에는 띄우지 않는다.
  assert.ok((await posQueue(posSide.store)).body.erpCarts.find((c) => c.id === posSide.cartId).frontOrphan)
  assert.ok((await request(app).get('/api/pos/erp-carts').set('X-Store-Token', posSide.store.posToken)).body.carts.some((c) => c.id === posSide.cartId))
  assert.ok((await posQueue(frontSide.store)).body.frontCarts.find((c) => c.id === frontSide.cartId).frontOrphan)
  assert.equal((await getFrontCarts(frontSide.store)).body.carts.some((c) => c.id === frontSide.cartId), false)

  // 확인하면 목록에서 빠지고 다음 만료 잡이 닫는다. 확인한 흔적은 경고 목록에도 올리지 않는다.
  assert.equal((await ackOrphan(posSide.store, posSide.cartId)).status, 200)
  assert.equal((await posQueue(posSide.store)).body.erpCarts.some((c) => c.id === posSide.cartId), false)
  assert.equal(await expireStaleErpCarts(), 1)
  assert.equal((await rowOf(posSide.cartId)).status, 'expired')
  assert.deepEqual((await posQueue(posSide.store)).body.frontOrphans, [])
})

testSerial('전산 재전송: 취소된 주문을 같은 referenceId로 다시 보내면 접수 시각이 새로 찍혀 POS에 바로 뜨고 만료되지 않는다', async () => {
  const { expireStaleErpCarts } = require('../src/store')
  const store = await createStore('resend-created-at')
  const body = validBody(store)
  const created = await postCart(body)
  assert.equal(created.status, 201)
  assert.equal((await request(app).post(`/api/erp/carts/${body.referenceId}/cancel`).set('X-ERP-Token', ERP_TOKEN)).status, 200)
  // 이틀 전에 접수했다가 취소한 주문
  await prisma.erpCart.update({ where: { id: created.body.cartId }, data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } })

  const before = Date.now()
  const again = await postCart(body)
  assert.equal(again.status, 201, JSON.stringify(again.body))
  assert.equal(again.body.cartId, created.body.cartId) // 같은 행을 다시 쓴다
  const row = await rowOf(created.body.cartId)
  assert.ok(row.createdAt.getTime() >= before - 1000, `createdAt=${row.createdAt.toISOString()}`)
  assert.ok((await posQueue(store)).body.erpCarts.some((c) => c.id === created.body.cartId))
  assert.equal(await expireStaleErpCarts(), 0)
  assert.equal((await getCart(body.referenceId)).body.status, 'pending')
})
