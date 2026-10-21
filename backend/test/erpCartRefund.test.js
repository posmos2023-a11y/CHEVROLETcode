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

const ERP_TOKEN = 'test-erp-cart-refund-token-0000'
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

testSerial('프론트 취소: 손님이 취소창을 닫으면 다시 요청 상태가 되고, 직원이 요청을 철회할 수 있다', async () => {
  const store = await createStore('refund-front-cancel')
  const { cartId } = await frontPaidCart(store)
  await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)
  await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-start`)

  // 취소 진행 중에는 철회할 수 없다.
  assert.equal((await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-withdraw`)).status, 409)

  const closed = await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-result`, { result: 'cancelled' })
  assert.equal(closed.body.status, 'refund_requested')

  const withdraw = await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-withdraw`)
  assert.equal(withdraw.status, 200)
  assert.equal((await row(cartId)).status, 'paid')
})

testSerial('프론트 취소: 실패하면 사유를 남기고 다시 요청 상태가 된다', async () => {
  const store = await createStore('refund-front-fail')
  const { cartId } = await frontPaidCart(store)
  await pos(store, 'post', `/api/pos/erp-carts/${cartId}/refund-request`)
  await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-start`)
  await pos(store, 'post', `/api/front/erp-carts/${cartId}/refund-result`, { result: 'failed', errorMessage: '카드 불일치' })
  const cart = await row(cartId)
  assert.equal(cart.status, 'refund_requested')
  assert.equal(cart.errorMessage, '카드 불일치')
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
