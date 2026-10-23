// 토스 결제내역 매핑(웹훅) + 전산 주문 결제 취소 테스트.
// erpCartFront.test.js와 같은 컨벤션을 따르고, 같은 로컬 devdb를 TRUNCATE로 비우므로
// package.json의 `--test-concurrency=1`이 필요하다.

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

const ERP_TOKEN = 'test-erp-cart-refund-token-0000'
process.env.ERP_API_TOKEN = ERP_TOKEN
process.env.ERP_STORE_LIMIT_PER_MIN = '1000'
process.env.ERP_IP_LIMIT_PER_MIN = '100000'

const { prisma, getDailySummary, kstDateString, kstDateRangeUtc } = require('../src/store')
const logger = require('../src/logger')
const { app } = require('../server')

const testSerial = (name, fn) => test(name, { concurrency: false }, fn)

let sequence = 0
function unique(prefix) {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ErpCart", "ErpOrder", "TossPayment", "RateLimitHit", "WebhookEvent", "Payment", "Reservation", "QueueCounter", "AdminUser", "Store" RESTART IDENTITY CASCADE'
  )
}

async function createStore(label) {
  return prisma.store.create({
    data: {
      merchantId: String(Math.floor(Math.random() * 1e9)),
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

function body(store, overrides = {}) {
  return {
    storeCode: store.erpStoreCode,
    referenceId: unique('ERP-REFUND-REF'),
    items: [{ productId: 'P-1001', name: '엔진오일 5W30 (4L)', category: '부품', unitPrice: 45000, quantity: 1 }],
    totalAmount: 45000,
    memo: '12가3456 김민준님',
    ...overrides,
  }
}

const erp = {
  post: (b) => request(app).post('/api/erp/carts').set('X-ERP-Token', ERP_TOKEN).send(b),
  get: (ref) => request(app).get(`/api/erp/carts/${ref}`).set('X-ERP-Token', ERP_TOKEN),
}

function pos(store, method, path, data) {
  const req = request(app)[method](path).set('X-Store-Token', store.posToken)
  return data === undefined ? req : req.send(data)
}

function webhook(type, payment) {
  return request(app)
    .post('/api/webhooks/toss/payment')
    .set('x-toss-webhook-id', unique('wh'))
    .send({ type, merchantId: Number(payment.merchantId), data: { payment } })
}

function tossPayment(store, overrides = {}) {
  return {
    id: unique('640'),
    merchantId: store.merchantId,
    orderId: unique('620'),
    state: 'APPROVED',
    sourceType: 'CARD',
    paymentMethod: 'CARD',
    amount: 45000,
    approvedNo: '30012345',
    approvedAt: '2026-10-21T10:00:00',
    ...overrides,
  }
}

// 프론트 결제까지 마친 주문을 만든다.
async function frontPaidCart(store, { approvalNumber = '30012345', paymentMethod = 'CARD', isCashReceipt, totalAmount = 45000 } = {}) {
  const b = body(store, { payTarget: 'front', totalAmount, items: [{ productId: 'P', name: '부품', category: '부품', unitPrice: totalAmount, quantity: 1 }] })
  const created = await erp.post(b)
  const paymentKey = crypto.randomUUID()
  await pos(store, 'post', `/api/front/erp-carts/${created.body.cartId}/start`, { paymentKey })
  const payment = { paymentMethod, approvalNumber, timestamp: 1761000000000, installment: 0, vanTransactionKey: 'VAN-1', van: 'KIS' }
  if (isCashReceipt !== undefined) payment.isCashReceipt = isCashReceipt
  const res = await pos(store, 'post', `/api/front/erp-carts/${created.body.cartId}/result`, { result: 'paid', paymentKey, payment })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return { cartId: created.body.cartId, referenceId: b.referenceId, paymentKey }
}

// POS에서 담고 결제까지 마친 주문을 만든다(탭앱이 보고한 토스 결제 ID 포함).
async function posPaidCart(store, paymentId) {
  const created = await erp.post(body(store))
  const cartId = created.body.cartId
  await pos(store, 'post', `/api/pos/erp-carts/${cartId}/consume`, { result: 'loaded' })
  const res = await pos(store, 'post', `/api/pos/erp-carts/${cartId}/paid`, { paymentId, orderId: 'ORDER-1' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return cartId
}

const row = (id) => prisma.erpCart.findUnique({ where: { id } })

// --- 토스 결제내역 매핑 -----------------------------------------------------------

testSerial('매핑: 프론트 결제 후 승인 웹훅이 오면 승인번호+금액으로 이어지고 결제 백업 기록은 만들지 않는다', async () => {
  const store = await createStore('map-after')
  const { cartId, referenceId } = await frontPaidCart(store)
  const tp = tossPayment(store)
  const res = await webhook('payment.payment.approved.v1', tp)
  assert.equal(res.status, 200)

  const cart = await row(cartId)
  assert.equal(cart.tossPaymentId, tp.id)
  assert.equal(cart.tossOrderId, tp.orderId)
  assert.ok(cart.tossVerifiedAt)
  assert.equal(await prisma.payment.count(), 0)
  assert.equal((await erp.get(referenceId)).body.tossVerified, true)
  assert.ok(await prisma.tossPayment.findUnique({ where: { id: tp.id } }))
})

testSerial('매핑: 웹훅이 먼저 오고 프론트 보고가 나중에 와도 이어진다', async () => {
  const store = await createStore('map-before')
  const tp = tossPayment(store, { approvedNo: '55550000' })
  await webhook('payment.payment.approved.v1', tp)
  const { cartId } = await frontPaidCart(store, { approvalNumber: '55550000' })
  const cart = await row(cartId)
  assert.equal(cart.tossPaymentId, tp.id)
  assert.ok(cart.tossVerifiedAt)
})

testSerial('매핑: 금액이 다르면 잇지 않고 기존처럼 결제 백업 기록을 남긴다', async () => {
  const store = await createStore('map-amount')
  const { cartId } = await frontPaidCart(store)
  await webhook('payment.payment.approved.v1', tossPayment(store, { amount: 44000 }))
  const cart = await row(cartId)
  assert.equal(cart.tossPaymentId, null)
  assert.equal(cart.tossVerifiedAt, null)
  assert.equal(await prisma.payment.count(), 1)
})

testSerial('매핑: 같은 승인번호·금액 후보가 둘이면 애매하므로 잇지 않는다', async () => {
  const store = await createStore('map-ambiguous')
  const a = await frontPaidCart(store, { approvalNumber: '77770000' })
  const b = await frontPaidCart(store, { approvalNumber: '77770000' })
  await webhook('payment.payment.approved.v1', tossPayment(store, { approvedNo: '77770000' }))
  assert.equal((await row(a.cartId)).tossPaymentId, null)
  assert.equal((await row(b.cartId)).tossPaymentId, null)
})

testSerial('매핑: 다른 매장의 같은 승인번호 결제와는 잇지 않는다', async () => {
  const store = await createStore('map-store')
  const other = await createStore('map-other')
  const { cartId } = await frontPaidCart(store)
  await webhook('payment.payment.approved.v1', tossPayment(other))
  assert.equal((await row(cartId)).tossPaymentId, null)
})

testSerial('매핑: POS 결제는 탭앱이 보고한 토스 결제 ID로 이어진다(웹훅이 먼저든 나중이든)', async () => {
  const store = await createStore('map-pos')
  const tpLater = tossPayment(store)
  const cartA = await posPaidCart(store, tpLater.id)
  await webhook('payment.payment.approved.v1', tpLater)
  assert.ok((await row(cartA)).tossVerifiedAt)

  const tpFirst = tossPayment(store)
  await webhook('payment.payment.approved.v1', tpFirst)
  const cartB = await posPaidCart(store, tpFirst.id)
  assert.ok((await row(cartB)).tossVerifiedAt)
})

testSerial('매핑: 토스 취소 웹훅이 오면 이어진 주문이 refunded가 된다', async () => {
  const store = await createStore('map-cancel')
  const { cartId, referenceId } = await frontPaidCart(store)
  const tp = tossPayment(store)
  await webhook('payment.payment.approved.v1', tp)
  await webhook('payment.payment.cancelled.v1', { ...tp, state: 'CANCELLED', cancelledAt: '2026-10-21T11:00:00' })
  const cart = await row(cartId)
  assert.equal(cart.status, 'refunded')
  assert.equal(cart.refundNote, '토스 결제 취소 확인')
  assert.equal((await erp.get(referenceId)).body.status, 'refunded')
})

testSerial('매핑: 승인 웹훅을 놓쳤어도 취소 웹훅이 승인번호로 주문을 찾아 refunded로 맞춘다', async () => {
  const store = await createStore('map-cancel-only')
  const { cartId } = await frontPaidCart(store, { approvalNumber: '88880000' })
  const tp = tossPayment(store, { approvedNo: '88880000', state: 'CANCELLED' })
  await webhook('payment.payment.cancelled.v1', tp)
  const cart = await row(cartId)
  assert.equal(cart.status, 'refunded')
  assert.equal(cart.tossPaymentId, tp.id)
})

testSerial('매핑: 취소 웹훅이 프론트 보고보다 먼저 왔으면 보고 때 이어지면서 refunded가 된다', async () => {
  const store = await createStore('map-cancel-first')
  const tp = tossPayment(store, { approvedNo: '66660000' })
  await webhook('payment.payment.approved.v1', tp)
  await webhook('payment.payment.cancelled.v1', { ...tp, state: 'CANCELLED' })
  const { cartId } = await frontPaidCart(store, { approvalNumber: '66660000' })
  assert.equal((await row(cartId)).status, 'refunded')
})

// 현금영수증 없는 현금은 프론트가 승인번호를 받지 못한다 -- 같은 매장·금액·최근 현금 1건이면 잇는다.
async function frontCashCart(store, totalAmount = 45000) {
  return frontPaidCart(store, { paymentMethod: 'CASH', isCashReceipt: false, approvalNumber: null, totalAmount })
}

testSerial('매핑(현금): 프론트 보고 후 현금 웹훅이 오면 같은 금액 1건으로 잇는다', async () => {
  const store = await createStore('cash-after')
  const { cartId } = await frontCashCart(store)
  const tp = tossPayment(store, { sourceType: 'CASH', paymentMethod: 'CASH', approvedNo: '00000000' })
  await webhook('payment.payment.approved.v1', tp)
  const cart = await row(cartId)
  assert.equal(cart.tossPaymentId, tp.id)
  assert.ok(cart.tossVerifiedAt)
})

testSerial('매핑(현금): 현금 웹훅이 먼저 오고 프론트 보고가 나중이어도 잇는다', async () => {
  const store = await createStore('cash-before')
  const tp = tossPayment(store, { sourceType: 'CASH', paymentMethod: 'CASH', approvedNo: '00000000' })
  await webhook('payment.payment.approved.v1', tp)
  const { cartId } = await frontCashCart(store)
  assert.equal((await row(cartId)).tossPaymentId, tp.id)
})

testSerial('매핑(현금): 같은 금액 현금 결제가 둘이면 애매하므로 잇지 않는다', async () => {
  const store = await createStore('cash-ambiguous')
  const a = await frontCashCart(store)
  const b = await frontCashCart(store)
  await webhook('payment.payment.approved.v1', tossPayment(store, { sourceType: 'CASH', approvedNo: '00000000' }))
  assert.equal((await row(a.cartId)).tossPaymentId, null)
  assert.equal((await row(b.cartId)).tossPaymentId, null)
})

testSerial('매핑(현금): 카드 결제 웹훅은 승인번호가 안 맞으면 같은 금액의 현금 주문과 잇지 않는다', async () => {
  const store = await createStore('cash-vs-card')
  const { cartId } = await frontCashCart(store)
  await webhook('payment.payment.approved.v1', tossPayment(store, { sourceType: 'CARD', approvedNo: '12121212' }))
  assert.equal((await row(cartId)).tossPaymentId, null)
})

testSerial('매핑(현금): 이미 다른 주문에 이어진 현금 결제는 다시 쓰지 않는다', async () => {
  const store = await createStore('cash-taken')
  const tp = tossPayment(store, { sourceType: 'CASH', approvedNo: '00000000' })
  const first = await frontCashCart(store)
  await webhook('payment.payment.approved.v1', tp)
  assert.equal((await row(first.cartId)).tossPaymentId, tp.id)
  const second = await frontCashCart(store)
  assert.equal((await row(second.cartId)).tossPaymentId, null)
})

testSerial('웹훅 서명: 서버 비밀키 끝에 줄바꿈이 붙어 있어도 토스가 보낸 서명을 통과시킨다', async () => {
  const store = await createStore('sig-newline')
  const secret = 'GA1k8THAGeGihd_Z0rW0MqpRTDQGYIktHBfmCWbsZn0'
  const original = process.env.TOSS_WEBHOOK_SECRET
  process.env.TOSS_WEBHOOK_SECRET = `${secret}\n` // Secret Manager에 echo로 넣으면 이렇게 된다
  try {
    const raw = JSON.stringify({ type: 'payment.payment.approved.v1', merchantId: Number(store.merchantId), data: { payment: tossPayment(store) } })
    const ts = String(Date.now())
    const sign = (key) => 'v1=' + crypto.createHmac('sha256', key).update(`${ts}.${raw}`).digest('hex')

    const ok = await request(app).post('/api/webhooks/toss/payment')
      .set('Content-Type', 'application/json')
      .set('x-toss-webhook-id', unique('wh')).set('x-toss-timestamp', ts).set('x-toss-signature', sign(secret))
      .send(raw)
    assert.equal(ok.status, 200, JSON.stringify(ok.body))

    const forged = await request(app).post('/api/webhooks/toss/payment')
      .set('Content-Type', 'application/json')
      .set('x-toss-webhook-id', unique('wh')).set('x-toss-timestamp', ts).set('x-toss-signature', sign('wrong-secret'))
      .send(raw)
    assert.equal(forged.status, 401)
  } finally {
    process.env.TOSS_WEBHOOK_SECRET = original
  }
})

// --- 프론트 결제 취소 --------------------------------------------------------------

testSerial('프론트 취소: 요청 → 프론트가 취소 정보를 받아 시작 → 완료되면 refunded', async () => {
  const store = await createStore('refund-front')
  const { cartId, referenceId, paymentKey } = await frontPaidCart(store)

  const req = await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)
  assert.equal(req.status, 200, JSON.stringify(req.body))
  assert.equal((await row(cartId)).status, 'refund_requested')

  const list = await pos(store, 'get', '/api/front/erp-carts')
  assert.equal(list.body.refunds.length, 1)
  const params = list.body.refunds[0].refund
  assert.equal(params.paymentKey, paymentKey)
  assert.equal(params.paymentMethod, 'CARD')
  assert.equal(params.approvalNumber, '30012345')
  assert.equal(params.timestamp, 1761000000000)
  assert.equal(params.tax + params.supplyValue, 45000)

  const start = await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-start`)
  assert.equal(start.status, 200)
  assert.equal((await row(cartId)).status, 'refunding')
  // 다른 프론트는 같은 취소를 다시 잡지 못한다(재시도는 alreadyProcessed로 같은 정보를 받는다).
  const again = await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-start`)
  assert.equal(again.body.alreadyProcessed, true)
  assert.deepEqual((await pos(store, 'get', '/api/front/erp-carts')).body.refunds, [])

  const done = await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-result`, { result: 'refunded' })
  assert.equal(done.status, 200)
  const cart = await row(cartId)
  assert.equal(cart.status, 'refunded')
  assert.equal(cart.refundNote, '프론트에서 결제 취소')
  assert.equal((await erp.get(referenceId)).body.status, 'refunded')
})

testSerial('프론트 취소: 손님이 취소창을 닫으면 결제 완료(paid)로 돌아가 프론트가 같은 취소를 다시 가져가지 않고, 직원이 다시 요청하면 새로 뜬다', async () => {
  const store = await createStore('refund-front-cancel')
  const { cartId } = await frontPaidCart(store)
  await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)
  await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-start`)

  // 취소 진행 중에는 철회할 수 없다.
  assert.equal((await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-withdraw`)).status, 409)

  const closed = await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-result`, { result: 'cancelled' })
  assert.equal(closed.status, 200)
  assert.equal(closed.body.status, 'paid')
  assert.equal(closed.body.alreadyProcessed, false)
  const cart = await row(cartId)
  assert.equal(cart.status, 'paid')
  assert.equal(cart.refundRequestedAt, null)
  assert.equal(cart.errorMessage, '프론트 취소 중단')
  // 예전에는 refund_requested로 돌아가 프론트가 같은 취소를 계속 다시 가져갔다.
  assert.deepEqual((await pos(store, 'get', '/api/front/erp-carts')).body.refunds, [])

  // 같은 보고를 다시 보내도(재시도) 이미 풀린 것으로 끝난다.
  const again = await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-result`, { result: 'cancelled' })
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyProcessed, true)
  assert.equal(again.body.status, 'paid')

  // 직원이 다시 [프론트에서 취소]를 누르면 새 요청으로 뜬다.
  assert.equal((await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)).status, 200)
  const list = await pos(store, 'get', '/api/front/erp-carts')
  assert.equal(list.body.refunds.length, 1)
  assert.ok(list.body.refunds[0].requestedAt)
})

testSerial('프론트 취소: 실패하면 사유를 남기고 결제 완료(paid)로 돌아간다', async () => {
  const store = await createStore('refund-front-fail')
  const { cartId } = await frontPaidCart(store)
  await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)
  await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-start`)
  await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-result`, { result: 'failed', errorMessage: '카드 불일치' })
  const cart = await row(cartId)
  assert.equal(cart.status, 'paid')
  assert.equal(cart.errorMessage, '카드 불일치')
  assert.equal(cart.refundRequestedAt, null)
})

testSerial('프론트 취소: 시작하지 않은 취소를 완료로 보고하면 거부한다(409)', async () => {
  const store = await createStore('refund-front-nostart')
  const { cartId } = await frontPaidCart(store)
  await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)
  const res = await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-result`, { result: 'refunded' })
  assert.equal(res.status, 409)
  assert.equal((await row(cartId)).status, 'refund_requested')
})

testSerial('프론트 취소: POS 결제 건은 프론트 취소를 요청할 수 없다(409)', async () => {
  const store = await createStore('refund-front-pos')
  const cartId = await posPaidCart(store, unique('640'))
  const res = await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)
  assert.equal(res.status, 409)
  assert.equal((await row(cartId)).status, 'paid')
})

testSerial('프론트 취소: 다른 매장 토큰으로는 요청할 수 없다(404)', async () => {
  const store = await createStore('refund-owner')
  const other = await createStore('refund-other')
  const { cartId } = await frontPaidCart(store)
  assert.equal((await pos(other, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)).status, 404)
})

// --- 프론트 취소 시도 구분(attemptId) · 갇힌 취소 풀기(비상구) --------------------------------------------

const attemptId = (label) => `att-${label}-${crypto.randomBytes(4).toString('hex')}`
const refundStart = (store, cartId, id) => pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-start`, id === undefined ? undefined : { attemptId: id })
const refundResult = (store, cartId, data) => pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-result`, data)
const forceRelease = (store, cartId) => pos(store, 'post', `/api/pos/erp-carts/${cartId}/force-release`)

// 프론트 결제까지 마치고 직원이 [프론트에서 취소]를 눌러 취소 요청(refund_requested)이 된 주문
async function requestedRefund(store) {
  const paid = await frontPaidCart(store)
  assert.equal((await pos(store, 'post', `/api/pos/erp-carts/${paid.cartId}/refund-request`)).status, 200)
  return paid.cartId
}

// logger.error 호출을 가로채 기록한다(대사가 필요하다는 로그가 실제로 남는지 확인하는 용도).
async function captureLoggerErrors(fn) {
  const original = logger.error
  const calls = []
  logger.error = (message, meta) => { calls.push({ message, meta }) }
  try { await fn() } finally { logger.error = original }
  return calls
}

testSerial('취소 시도: 시작하면 attemptId와 시작 시각이 남고, 같은 시도의 재시도는 정보를 다시 받고 다른 시도는 409', async () => {
  const store = await createStore('attempt-start')
  const cartId = await requestedRefund(store)
  const a = attemptId('a')
  const first = await refundStart(store, cartId, a)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.alreadyProcessed, false)
  const cart = await row(cartId)
  assert.equal(cart.status, 'refunding')
  assert.equal(cart.refundAttemptId, a)
  assert.ok(cart.refundStartedAt)

  const retry = await refundStart(store, cartId, a)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.alreadyProcessed, true)
  assert.equal(retry.body.refund.paymentMethod, 'CARD')

  const other = await refundStart(store, cartId, attemptId('b'))
  assert.equal(other.status, 409)
  assert.equal((await row(cartId)).refundAttemptId, a)

  assert.equal((await refundStart(store, cartId, 'short')).status, 400)
})

testSerial('취소 시도: attemptId를 안 보내는 옛 프론트도 예전처럼 시작하고 끝낸다', async () => {
  const store = await createStore('attempt-legacy')
  const cartId = await requestedRefund(store)
  assert.equal((await refundStart(store, cartId)).status, 200)
  const cart = await row(cartId)
  assert.equal(cart.refundAttemptId, null)
  assert.ok(cart.refundStartedAt)
  assert.equal((await refundResult(store, cartId, { result: 'refunded' })).body.status, 'refunded')
})

testSerial('취소 시도: 지금 쥐고 있는 시도가 아닌 보고는 409(stale)로 거절하고, 맞는 시도의 보고는 받는다', async () => {
  const store = await createStore('attempt-stale')
  const cartId = await requestedRefund(store)
  const a = attemptId('a')
  const b = attemptId('b')
  await refundStart(store, cartId, a)

  const logs = await captureLoggerErrors(async () => {
    const staleRefunded = await refundResult(store, cartId, { result: 'refunded', attemptId: b })
    assert.equal(staleRefunded.status, 409)
    assert.equal(staleRefunded.body.stale, true)
  })
  // 다른 시도의 '취소 완료'는 카드가 실제로 취소됐을 수 있어 사람이 대사하도록 오류로 남긴다.
  assert.ok(logs.some((l) => l.message.includes('다른 시도의 결제 취소 완료 보고')), '대사 필요 로그가 남지 않았다')

  const staleCancelled = await refundResult(store, cartId, { result: 'cancelled', attemptId: b })
  assert.equal(staleCancelled.status, 409)
  assert.equal(staleCancelled.body.stale, true)
  assert.equal((await row(cartId)).status, 'refunding')

  const done = await refundResult(store, cartId, { result: 'refunded', attemptId: a })
  assert.equal(done.status, 200)
  assert.equal(done.body.status, 'refunded')
})

testSerial('취소 시도: refund-start가 시간 초과로 늦게 처리돼도, 프론트가 먼저 알린 포기(cancelled)의 시도는 거절한다', async () => {
  const store = await createStore('attempt-late-start')
  const cartId = await requestedRefund(store)
  const a = attemptId('late')
  // 프론트는 start가 시간 초과되자 같은 attemptId로 cancelled를 보냈고, 그 보고가 서버에 먼저 도착했다(주문은 아직 refund_requested).
  const early = await refundResult(store, cartId, { result: 'cancelled', attemptId: a })
  assert.equal(early.status, 200, JSON.stringify(early.body))
  assert.equal(early.body.alreadyProcessed, true)
  assert.equal(early.body.status, 'refund_requested')
  assert.equal((await row(cartId)).refundReleasedAttemptId, a)

  // 뒤늦게 처리되는 start -- 받아주면 프론트는 접었는데 서버만 취소 중으로 갇힌다.
  const late = await refundStart(store, cartId, a)
  assert.equal(late.status, 409, JSON.stringify(late.body))
  assert.equal(late.body.stale, true)
  const cart = await row(cartId)
  assert.equal(cart.status, 'refund_requested')
  assert.equal(cart.refundAttemptId, null)

  // 새 시도는 평소처럼 시작한다.
  assert.equal((await refundStart(store, cartId, attemptId('new'))).status, 200)
})

testSerial('취소 시도: 결제 완료(paid) 상태에서 온 포기 보고도 시도를 기록하고, 같은 시도로 다시 요청된 취소는 시작하지 못한다', async () => {
  const store = await createStore('attempt-paid-release')
  const cartId = await requestedRefund(store)
  const a = attemptId('a')
  assert.equal((await refundStart(store, cartId, a)).status, 200)
  const closed = await refundResult(store, cartId, { result: 'cancelled', attemptId: a })
  assert.equal(closed.body.status, 'paid')
  assert.equal((await row(cartId)).refundReleasedAttemptId, a)

  // 이미 풀린 뒤에 같은 보고가 다시 와도 성공(alreadyProcessed)으로 끝난다.
  const again = await refundResult(store, cartId, { result: 'failed', attemptId: a, errorMessage: '재시도' })
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyProcessed, true)
  assert.equal(again.body.status, 'paid')

  // 직원이 다시 요청했을 때 옛 시도의 늦은 start 재시도가 취소를 가로채지 못한다.
  assert.equal((await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)).status, 200)
  assert.equal((await refundStart(store, cartId, a)).status, 409)
  assert.equal((await row(cartId)).status, 'refund_requested')
  // 이전 시도의 기록(refundAttemptId=a)이 남아 있어도 새 시도의 포기 보고를 거절하지 않는다.
  const b = attemptId('b')
  const early = await refundResult(store, cartId, { result: 'cancelled', attemptId: b })
  assert.equal(early.status, 200)
  assert.equal((await row(cartId)).refundReleasedAttemptId, b)
})

testSerial('비상구(취소 중): 10분이 안 지났으면 409와 남은 시간을 주고, 지났으면 paid로 풀어 그 시도의 늦은 start·완료 보고를 막는다', async () => {
  const store = await createStore('force-refunding')
  const cartId = await requestedRefund(store)
  const a = attemptId('a')
  await refundStart(store, cartId, a)

  // 탭앱이 갇힘 여부를 판단하도록 취소 요청·시작 시각이 내려온다. 진행 중인 취소라 결제 시각이 오래돼도 목록에 남는다.
  await prisma.erpCart.update({ where: { id: cartId }, data: { paidAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } })
  const listed = (await pos(store, 'get', '/api/pos/queue')).body.settledCarts.find((c) => c.id === cartId)
  assert.ok(listed, '진행 중인 취소가 최근 결제 목록에서 빠졌다')
  assert.equal(listed.status, 'refunding')
  assert.ok(listed.refundRequestedAt)
  assert.ok(listed.refundStartedAt)

  const early = await forceRelease(store, cartId)
  assert.equal(early.status, 409, JSON.stringify(early.body))
  assert.ok(early.body.retryAfterSec > 0 && early.body.retryAfterSec <= 600, `retryAfterSec=${early.body.retryAfterSec}`)
  assert.equal((await row(cartId)).status, 'refunding')

  await prisma.erpCart.update({ where: { id: cartId }, data: { refundStartedAt: new Date(Date.now() - 11 * 60 * 1000) } })
  const res = await forceRelease(store, cartId)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.previousStatus, 'refunding')
  assert.equal(res.body.status, 'paid')
  const cart = await row(cartId)
  assert.equal(cart.status, 'paid')
  assert.equal(cart.refundRequestedAt, null)
  assert.equal(cart.refundStartedAt, null)
  assert.equal(cart.refundReleasedAttemptId, a)
  assert.equal(cart.errorMessage, '프론트 취소 상태를 직원이 풀었음')

  // 풀린 시도의 늦은 완료 보고는 반영되지 않고 대사가 필요하다는 로그가 남는다. 늦은 start도 거절된다.
  const logs = await captureLoggerErrors(async () => {
    const late = await refundResult(store, cartId, { result: 'refunded', attemptId: a })
    assert.equal(late.status, 409)
  })
  assert.ok(logs.some((l) => l.message.includes('결제 취소 완료 보고를 반영하지 못했습니다')))
  assert.equal((await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)).status, 200)
  assert.equal((await refundStart(store, cartId, a)).status, 409)
})

testSerial('비상구(취소 중): 시작 시각이 없으면 취소 요청 시각을 기준으로 하고, 다른 매장·다른 상태는 풀 수 없다', async () => {
  const store = await createStore('force-refunding-fallback')
  const cartId = await requestedRefund(store)
  // 취소 중이 아니면(요청됨) 풀 대상이 아니다.
  const notYet = await forceRelease(store, cartId)
  assert.equal(notYet.status, 409)
  assert.equal(notYet.body.status, 'refund_requested')

  await refundStart(store, cartId) // 옛 프론트: attemptId 없음
  await prisma.erpCart.update({ where: { id: cartId }, data: { refundStartedAt: null, refundRequestedAt: new Date(Date.now() - 11 * 60 * 1000) } })
  const other = await createStore('force-refunding-other')
  assert.equal((await forceRelease(other, cartId)).status, 404)
  assert.equal((await forceRelease(store, cartId)).status, 200)
  assert.equal((await row(cartId)).status, 'paid')
})

testSerial('진행 중인 취소는 결제한 지 7일이 지나도 최근 결제에 남고 숨길 수 없다, 7일 지난 보통 결제는 나오지 않는다', async () => {
  const store = await createStore('settled-refund-visible')
  const cartId = await requestedRefund(store)
  const plain = await frontPaidCart(store)
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  await prisma.erpCart.update({ where: { id: cartId }, data: { paidAt: old } })
  await prisma.erpCart.update({ where: { id: plain.cartId }, data: { paidAt: old } })
  const ids = (await pos(store, 'get', '/api/pos/queue')).body.settledCarts.map((c) => c.id)
  assert.deepEqual(ids, [cartId])
  assert.equal((await pos(store, 'post', `/api/pos/erp-carts/${cartId}/hide`, { hidden: true })).status, 409)
  assert.equal((await row(cartId)).hiddenAt, null)
})

// --- 현금 환불 / POS 취소 기록 ---------------------------------------------------------

testSerial('현금 환불: 현금영수증 없는 현금은 프론트 취소 대신 기록으로만 환불 처리한다', async () => {
  const store = await createStore('refund-cash')
  const { cartId } = await frontPaidCart(store, { paymentMethod: 'CASH', isCashReceipt: false, approvalNumber: null })

  const req = await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)
  assert.equal(req.status, 409)
  assert.equal(req.body.code, 'CASH_NO_RECEIPT')

  const res = await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refunded`, { method: 'cash' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const cart = await row(cartId)
  assert.equal(cart.status, 'refunded')
  assert.equal(cart.refundNote, '현금 환불(기록만)')
})

testSerial('현금 환불: 카드 결제는 기록만으로 환불 처리할 수 없다(409)', async () => {
  const store = await createStore('refund-cash-card')
  const { cartId } = await frontPaidCart(store)
  const res = await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refunded`, { method: 'cash' })
  assert.equal(res.status, 409)
  assert.equal((await row(cartId)).status, 'paid')
})

testSerial('POS 취소: 같은 POS 결제로 함께 결제된 주문은 함께 refunded가 된다', async () => {
  const store = await createStore('refund-pos-shared')
  const paymentId = unique('640')
  const a = await posPaidCart(store, paymentId)
  const b = await posPaidCart(store, paymentId)
  const res = await pos(store, 'post', `/api/pos/erp-carts/${a}/refunded`, { method: 'pos' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.refundedCartIds.sort(), [a, b].sort())
  assert.equal((await row(a)).status, 'refunded')
  assert.equal((await row(b)).status, 'refunded')
})

testSerial('POS 취소: 프론트 결제 건은 POS 취소로 기록할 수 없다(409)', async () => {
  const store = await createStore('refund-pos-front')
  const { cartId } = await frontPaidCart(store)
  const res = await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refunded`, { method: 'pos' })
  assert.equal(res.status, 409)
})

testSerial('POS 취소: method 값이 틀리면 400', async () => {
  const store = await createStore('refund-bad')
  const cartId = await posPaidCart(store, unique('640'))
  assert.equal((await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refunded`, { method: 'card' })).status, 400)
})

// --- 정비 대기열 "최근 결제" 목록 ------------------------------------------------------

testSerial('최근 결제 목록: 최근 7일 결제는 나오고 그보다 오래된 결제는 나오지 않는다', async () => {
  const store = await createStore('settled-window')
  const recent = await posPaidCart(store, unique('640'))
  const old = await posPaidCart(store, unique('640'))
  const day = 24 * 60 * 60 * 1000
  await prisma.erpCart.update({ where: { id: recent }, data: { paidAt: new Date(Date.now() - 3 * day) } })
  await prisma.erpCart.update({ where: { id: old }, data: { paidAt: new Date(Date.now() - 8 * day) } })
  const queue = await pos(store, 'get', '/api/pos/queue')
  assert.deepEqual(queue.body.settledCarts.map((c) => c.id), [recent])
})

testSerial('오늘 결제 목록: 결제·취소된 주문이 품목, 결제 위치, 함께 결제된 건수와 함께 내려온다', async () => {
  const store = await createStore('settled')
  const paymentId = unique('640')
  await posPaidCart(store, paymentId)
  await posPaidCart(store, paymentId)
  const cash = await frontPaidCart(store, { paymentMethod: 'CASH', isCashReceipt: false, approvalNumber: null })
  await pos(store, 'post', `/api/pos/erp-carts/${cash.cartId}/refunded`, { method: 'cash' })

  const queue = await pos(store, 'get', '/api/pos/queue')
  assert.equal(queue.status, 200)
  const settled = queue.body.settledCarts
  assert.equal(settled.length, 3)
  const posRows = settled.filter((c) => c.payTarget === 'pos')
  assert.equal(posRows.length, 2)
  assert.ok(posRows.every((c) => c.sharedPaymentCount === 2 && c.tossPaymentId === paymentId && c.tossOrderId === 'ORDER-1'))
  assert.ok(posRows.every((c) => c.items.length === 1 && c.items[0].name === '엔진오일 5W30 (4L)'))
  const cashRow = settled.find((c) => c.id === cash.cartId)
  assert.equal(cashRow.status, 'refunded')
  assert.equal(cashRow.cashWithoutReceipt, true)
  assert.equal(cashRow.paymentMethod, 'CASH')
})

testSerial('함께 결제된 건수: 같이 결제된 주문이 7일 밖이거나 삭제됐어도 센다(다른 매장은 세지 않는다)', async () => {
  const store = await createStore('shared-count')
  const paymentId = unique('640')
  const shown = await posPaidCart(store, paymentId)
  const old = await posPaidCart(store, paymentId)
  const deleted = await posPaidCart(store, paymentId)
  await prisma.erpCart.update({ where: { id: old }, data: { paidAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } })
  await prisma.erpCart.update({ where: { id: deleted }, data: { deletedAt: new Date() } })
  // 같은 토스 결제 ID를 다른 매장이 보고해도(잘못이든 위조든) 이 매장의 취소 범위에 들어가지 않는다.
  const other = await createStore('shared-count-other')
  await posPaidCart(other, paymentId)

  const settled = (await pos(store, 'get', '/api/pos/queue')).body.settledCarts
  assert.deepEqual(settled.map((c) => c.id), [shown])
  assert.equal(settled[0].sharedPaymentCount, 3)
})

// --- 웹훅이 먼저 와서 생긴 Payment 백업 기록의 이중 집계 ---------------------------------------------

function summaryOf(store) {
  const date = kstDateString()
  const { start, end } = kstDateRangeUtc(date)
  return getDailySummary({ storeId: store.id, date, dateStart: start, dateEnd: end })
}

testSerial('백업 기록: 웹훅이 먼저 와서 생긴 Payment 기록은 프론트 결과 보고로 이어지면 erp_linked가 되어 결제 합계에서 빠진다', async () => {
  const store = await createStore('backup-front')
  const tp = tossPayment(store, { approvedNo: '44440000' })
  await webhook('payment.payment.approved.v1', tp)
  assert.equal(await prisma.payment.count(), 1)
  const before = await summaryOf(store)
  assert.equal(before.payments.total, 1)
  assert.equal(before.payments.amountSum, 45000)

  const { cartId } = await frontPaidCart(store, { approvalNumber: '44440000' })
  assert.equal((await row(cartId)).tossPaymentId, tp.id)
  const backup = await prisma.payment.findFirst()
  assert.equal(backup.status, 'erp_linked')

  // 같은 돈이 Payment와 전산 주문 양쪽에서 한 번씩 집계되던 것이 전산 주문 쪽에만 남는다.
  const after = await summaryOf(store)
  assert.equal(after.payments.total, 0)
  assert.equal(after.payments.amountSum, 0)
  assert.equal(after.erpCarts.paid, 1)
  assert.equal(after.erpCarts.paidAmount, 45000)
})

testSerial('백업 기록: POS 결제 통보로 이어져도 erp_linked가 된다', async () => {
  const store = await createStore('backup-pos')
  const tp = tossPayment(store)
  await webhook('payment.payment.approved.v1', tp)
  assert.equal((await summaryOf(store)).payments.total, 1)
  await posPaidCart(store, tp.id)
  assert.equal((await prisma.payment.findFirst()).status, 'erp_linked')
  assert.equal((await summaryOf(store)).payments.total, 0)
})

testSerial('백업 기록: 손님이 직접 낸 결제(전화번호 있음)나 이어지지 않은 백업 기록은 그대로 집계된다', async () => {
  const store = await createStore('backup-keep')
  const tp = tossPayment(store, { approvedNo: '44441111' })
  // 같은 paymentKey(=토스 orderId)라도 손님 동의로 만든 결제(phone 있음)는 건드리지 않는다.
  await prisma.payment.create({
    data: { storeId: store.id, paymentKey: tp.orderId, phone: '01012341234', amount: 45000, status: 'receipt_sent', promoAt: new Date() },
  })
  await webhook('payment.payment.approved.v1', tp)
  await frontPaidCart(store, { approvalNumber: '44441111' })
  assert.equal((await prisma.payment.findFirst()).status, 'receipt_sent')
  assert.equal((await summaryOf(store)).payments.total, 1)

  // 금액이 달라 이어지지 않은 웹훅 백업 기록도 그대로 센다.
  const other = await createStore('backup-unlinked')
  await frontPaidCart(other)
  await webhook('payment.payment.approved.v1', tossPayment(other, { amount: 44000 }))
  assert.equal((await summaryOf(other)).payments.total, 1)
})

// --- 토스 결제 상태 되돌림 ----------------------------------------------------------------------------

testSerial('웹훅: 늦게 재전송된 승인 웹훅이 취소된 토스 결제를 승인으로 되돌리지 않고, 이어진 주문은 취소로 맞춘다', async () => {
  const store = await createStore('late-approved')
  const tp = tossPayment(store, { approvedNo: '33330000' })
  await webhook('payment.payment.approved.v1', tp)
  await webhook('payment.payment.cancelled.v1', { ...tp, state: 'CANCELLED', cancelledAt: '2026-10-21T11:00:00' })
  // 토스가 승인 웹훅을 늦게 다시 보냈다(새 webhook id).
  const late = await webhook('payment.payment.approved.v1', tp)
  assert.equal(late.status, 200)
  const stored = await prisma.tossPayment.findUnique({ where: { id: tp.id } })
  assert.equal(stored.state, 'CANCELLED')
  assert.ok(stored.cancelledAt)
  assert.equal(stored.approvedNo, '33330000') // 나머지 값은 갱신된다

  // 취소된 토스 결제에 뒤늦게 이어지는 주문도 승인으로 남지 않는다.
  const { cartId } = await frontPaidCart(store, { approvalNumber: '33330000' })
  assert.equal((await row(cartId)).status, 'refunded')
})

testSerial('웹훅: 승인 웹훅이 취소된 토스 결제에 주문을 처음 이을 때도 주문을 취소로 맞춘다', async () => {
  const store = await createStore('late-approved-link')
  const { cartId } = await frontPaidCart(store, { approvalNumber: '33331111' })
  const tp = tossPayment(store, { approvedNo: '33331111' })
  // 보고 때는 토스 기록이 없었고, 취소된 결제 기록이 따로 생겨 있다가 승인 웹훅이 뒤늦게 도착한다.
  await prisma.tossPayment.create({
    data: { id: tp.id, merchantId: store.merchantId, storeId: store.id, orderId: tp.orderId, state: 'CANCELLED', sourceType: 'CARD', amount: 45000, approvedNo: '33331111', cancelledAt: new Date() },
  })
  await webhook('payment.payment.approved.v1', tp)
  assert.equal((await prisma.tossPayment.findUnique({ where: { id: tp.id } })).state, 'CANCELLED')
  const cart = await row(cartId)
  assert.equal(cart.tossPaymentId, tp.id)
  assert.equal(cart.status, 'refunded')
})

// --- POS 결제 통보 뒤 처리 ----------------------------------------------------------------------------

async function calledReservation(store, carNumber) {
  return prisma.reservation.create({
    data: {
      storeId: store.id, carNumber, phone: '01055556666', serviceType: '엔진오일', queueNumber: 77,
      serviceDate: kstDateString(), status: 'called', calledAt: new Date(),
    },
  })
}

testSerial('POS 결제 통보: 이미 취소된 토스 결제로 이어져 refunded가 되면 예약 완료·영수증을 처리하지 않는다', async () => {
  global.__notifications.length = 0
  const store = await createStore('paid-cancelled-toss')
  const reservation = await calledReservation(store, '55마5555')
  const tp = tossPayment(store)
  await webhook('payment.payment.approved.v1', tp)
  await webhook('payment.payment.cancelled.v1', { ...tp, state: 'CANCELLED', cancelledAt: '2026-10-21T11:00:00' })

  const created = await erp.post(body(store, { carNumber: '55마5555' }))
  assert.equal(created.body.linkedReservation, true)
  await pos(store, 'post', `/api/pos/erp-carts/${created.body.cartId}/consume`, { result: 'loaded' })
  const res = await pos(store, 'post', `/api/pos/erp-carts/${created.body.cartId}/paid`, { paymentId: tp.id, orderId: 'ORDER-1' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.status, 'refunded')
  assert.equal(res.body.reservationCompleted, false)
  assert.equal((await row(created.body.cartId)).status, 'refunded')
  assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'called')
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 0)
})

testSerial('POS 결제 통보: 정상 결제는 예약 완료·영수증이 그대로 처리된다', async () => {
  global.__notifications.length = 0
  const store = await createStore('paid-normal-after')
  const reservation = await calledReservation(store, '56마5656')
  const created = await erp.post(body(store, { carNumber: '56마5656' }))
  await pos(store, 'post', `/api/pos/erp-carts/${created.body.cartId}/consume`, { result: 'loaded' })
  const res = await pos(store, 'post', `/api/pos/erp-carts/${created.body.cartId}/paid`, { paymentId: unique('640') })
  assert.equal(res.body.status, 'paid')
  assert.equal(res.body.reservationCompleted, true)
  assert.equal(res.body.receipt, 'sent')
  assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'completed')
  assert.equal(global.__notifications.filter((n) => n.method === 'sendReceiptAlimtalk').length, 1)
})

