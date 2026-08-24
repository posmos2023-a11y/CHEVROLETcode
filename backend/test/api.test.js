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

const solapi = require('../src/solapi')
const notificationCalls = []
// forceFailureFor: 다음 호출 한 번만 해당 메서드가 실패하도록 만드는 스위치. 재발송(retry-notify/
// retry-receipt)의 성공/실패 경로를 둘 다 테스트하려면 solapi 호출을 선택적으로 실패시킬 수 있어야
// 한다 — 기본 동작(항상 성공)은 기존 테스트들을 위해 그대로 유지한다.
let forceFailureFor = null
for (const method of [
  'sendReservationAlimtalk',
  'sendQueueTurnAlimtalk',
  'sendReceiptAlimtalk',
  'sendPromoAlimtalk',
]) {
  solapi[method] = async (payload) => {
    notificationCalls.push({ method, payload })
    if (forceFailureFor === method) {
      forceFailureFor = null
      throw new Error(`강제 실패(테스트 전용): ${method}`)
    }
    return { ok: true }
  }
}

const { prisma, claimDuePromotions, kstDateString } = require('../src/store')
const { hashPassword, signAdminToken } = require('../src/auth')
const { app } = require('../server')

const testSerial = (name, fn) => test(name, { concurrency: false }, fn)

let sequence = 0
function unique(prefix) {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RateLimitHit", "WebhookEvent", "Payment", "Reservation", "QueueCounter", "AdminUser", "Store" RESTART IDENTITY CASCADE'
  )
  notificationCalls.length = 0
  forceFailureFor = null
}

// posToken을 매번 자동 생성해준다 — 실제 운영에서는 모든 매장이 posToken을 갖고 있으므로(마이그레이션
// 백필 + createStore 자동 생성) 테스트 매장도 기본으로 유효한 POS 토큰을 갖게 하는 편이 실제 환경에
// 가깝고, POS 관련 테스트에서 매번 별도로 채워줄 필요가 없다. overrides로 다른 필드도 덮어쓸 수 있다.
async function createStore(label, overrides = {}) {
  return prisma.store.create({
    data: {
      merchantId: unique(`merchant-${label}`),
      name: `테스트 매장 ${label}`,
      posToken: crypto.randomBytes(32).toString('hex'),
      ...overrides,
    },
  })
}

async function createHqAdmin(label = 'hq') {
  return prisma.adminUser.create({
    data: {
      email: `${unique(label)}@example.test`,
      passwordHash: await hashPassword('test-password-123'),
      role: 'hq_admin',
      storeId: null,
    },
  })
}

async function createStoreAdmin(store, label = 'store-admin') {
  return prisma.adminUser.create({
    data: {
      email: `${unique(label)}@example.test`,
      passwordHash: await hashPassword('test-password-123'),
      role: 'store_admin',
      storeId: store.id,
    },
  })
}

function authHeader(admin) {
  return `Bearer ${signAdminToken(admin)}`
}

async function postWebhook(webhookId, payment) {
  return request(app)
    .post('/api/webhooks/toss/payment')
    .set('x-toss-webhook-id', webhookId)
    .send({ type: payment.type, data: { payment: payment.data } })
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`
  await resetDatabase()
})

beforeEach(resetDatabase)

after(async () => {
  await prisma.$disconnect()
})

testSerial('관리자 로그인은 짧은 시간 안에 설정된 limit을 초과하면 429를 반환한다', async () => {
  const ip = '198.51.100.10'
  const responses = []
  for (let attempt = 0; attempt < 11; attempt += 1) {
    responses.push(
      await request(app)
        .post('/api/admin/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'missing-admin@example.test', password: 'wrong-password' })
    )
  }

  assert.deepEqual(responses.slice(0, 10).map((response) => response.status), Array(10).fill(401))
  assert.equal(responses[10].status, 429)
})

testSerial('관리자 로그인 실패가 5회 누적되면 6번째 요청은 423으로 잠긴다', async () => {
  // IP 레이트리밋(위 테스트)과 다른 X-Forwarded-For를 써서 서로 다른 한도를 소모하도록 분리한다.
  const email = `${unique('lockout')}@example.test`
  await prisma.adminUser.create({
    data: { email, passwordHash: await hashPassword('correct-password-1'), role: 'hq_admin', storeId: null },
  })
  const ip = '203.0.113.50'

  const attempts = []
  for (let i = 0; i < 5; i += 1) {
    attempts.push(
      await request(app).post('/api/admin/login').set('X-Forwarded-For', ip).send({ email, password: 'wrong-password' })
    )
  }
  assert.deepEqual(attempts.map((response) => response.status), Array(5).fill(401))

  // 6번째는 비밀번호가 맞아도 잠금 상태이므로 423이어야 한다.
  const sixth = await request(app)
    .post('/api/admin/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: 'correct-password-1' })
  assert.equal(sixth.status, 423)
  assert.match(sixth.body.error, /15분/)
})

testSerial('로그인 성공 시 누적된 실패 카운터가 초기화된다', async () => {
  const email = `${unique('lockout-reset')}@example.test`
  const created = await prisma.adminUser.create({
    data: { email, passwordHash: await hashPassword('correct-password-2'), role: 'hq_admin', storeId: null },
  })
  const ip = '203.0.113.60'

  for (let i = 0; i < 3; i += 1) {
    const attempt = await request(app)
      .post('/api/admin/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'wrong-password' })
    assert.equal(attempt.status, 401)
  }
  const beforeSuccess = await prisma.adminUser.findUnique({ where: { id: created.id } })
  assert.equal(beforeSuccess.failedLoginCount, 3)

  const success = await request(app)
    .post('/api/admin/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: 'correct-password-2' })
  assert.equal(success.status, 200)

  const afterSuccess = await prisma.adminUser.findUnique({ where: { id: created.id } })
  assert.equal(afterSuccess.failedLoginCount, 0)
  assert.equal(afterSuccess.lockedUntil, null)

  // 리셋 후 실패 카운트가 3에서 이어지지 않고 1부터 다시 쌓이는지 확인한다.
  const oneMoreWrong = await request(app)
    .post('/api/admin/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: 'wrong-password' })
  assert.equal(oneMoreWrong.status, 401)
  const finalState = await prisma.adminUser.findUnique({ where: { id: created.id } })
  assert.equal(finalState.failedLoginCount, 1)
})

testSerial('승인 웹훅은 Payment를 만들고 알림톡을 호출하지 않으며 중복은 건너뛴다', async () => {
  const store = await createStore('webhook-approved')
  const paymentKey = unique('order')
  const webhookId = unique('webhook')
  const payment = {
    type: 'payment.payment.approved.v1',
    data: { orderId: paymentKey, merchantId: store.merchantId, amount: '12000' },
  }

  const first = await postWebhook(webhookId, payment)
  assert.equal(first.status, 200)
  // 계약 §3.23-3: 본 처리가 응답보다 먼저 끝나도록 순서가 바뀌었으므로, 응답을 받은 시점엔 이미
  // Payment가 커밋돼 있다 — 더 이상 폴링(waitFor)이 필요 없다.
  const recorded = await prisma.payment.findUnique({ where: { paymentKey } })
  assert.ok(recorded)
  assert.equal(recorded.storeId, store.id)
  assert.equal(recorded.amount, 12000)
  assert.equal(recorded.phone, null)
  assert.equal(notificationCalls.length, 0)

  const duplicate = await postWebhook(webhookId, payment)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.skipped, 'duplicate')
  assert.equal(await prisma.payment.count({ where: { paymentKey } }), 1)
  assert.equal(notificationCalls.length, 0)
})

testSerial('취소 웹훅은 기존 Payment 상태를 cancelled로 변경한다', async () => {
  const store = await createStore('webhook-cancelled')
  const paymentKey = unique('order')
  const existing = await prisma.payment.create({
    data: {
      storeId: store.id,
      paymentKey,
      phone: '01012345678',
      status: 'requested',
      promoAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  })

  const response = await postWebhook(unique('webhook'), {
    type: 'payment.payment.cancelled.v1',
    data: { orderId: paymentKey, merchantId: store.merchantId },
  })
  assert.equal(response.status, 200)
  const cancelled = await prisma.payment.findUnique({ where: { id: existing.id } })
  assert.equal(cancelled.status, 'cancelled')
})

testSerial('웹훅 처리 중 예외가 발생하면 500을 반환하고 WebhookEvent 기록을 되돌려 재시도가 가능하게 한다', async () => {
  const store = await createStore('webhook-error')
  const paymentKey = unique('order')
  const webhookId = unique('webhook')
  const payload = {
    type: 'payment.payment.approved.v1',
    data: { orderId: paymentKey, merchantId: store.merchantId, amount: '9900' },
  }
  const secretMessage = '내부전용-DB-오류-절대노출금지'

  // processWebhookPayment 내부에서 쓰는 createPayment가 던지도록 prisma.payment.create를 일시적으로
  // 가로챈다 — server.js가 store.js의 함수를 destructure해서 들고 있어 직접 monkeypatch가 안 되지만,
  // prisma 객체 자체는 공유 싱글턴이라 이 방식으로 내부에서 발생하는 실패를 재현할 수 있다.
  const originalCreate = prisma.payment.create.bind(prisma.payment)
  prisma.payment.create = async () => {
    throw new Error(secretMessage)
  }
  let response
  try {
    response = await postWebhook(webhookId, payload)
  } finally {
    prisma.payment.create = originalCreate
  }

  assert.equal(response.status, 500)
  assert.equal(response.body.ok, false)
  assert.ok(!JSON.stringify(response.body).includes(secretMessage))

  // 실패한 이벤트는 WebhookEvent에서 지워져 있어야 토스가 재시도했을 때 "이미 처리됨"으로
  // 건너뛰지 않는다.
  assert.equal(await prisma.webhookEvent.findUnique({ where: { id: webhookId } }), null)
  assert.equal(await prisma.payment.count({ where: { paymentKey } }), 0)

  // 재시도(같은 webhookId)가 이번엔 정상 처리되는지도 함께 확인한다.
  const retry = await postWebhook(webhookId, payload)
  assert.equal(retry.status, 200)
  assert.equal(await prisma.payment.count({ where: { paymentKey } }), 1)
})

testSerial('store_admin은 다른 매장의 예약을 호출·완료·삭제할 수 없다', async () => {
  const ownStore = await createStore('scope-own')
  const otherStore = await createStore('scope-other')
  const admin = await createStoreAdmin(ownStore)
  const reservation = await prisma.reservation.create({
    data: {
      storeId: otherStore.id,
      carNumber: '12가3456',
      phone: '01012345678',
      serviceType: '정비',
      queueNumber: 1,
      serviceDate: kstDateString(),
      status: 'waiting',
    },
  })
  const authorization = authHeader(admin)

  const call = await request(app).post(`/api/reservations/${reservation.id}/call`).set('Authorization', authorization)
  const complete = await request(app)
    .post(`/api/reservations/${reservation.id}/complete`)
    .set('Authorization', authorization)
  const remove = await request(app).delete(`/api/reservations/${reservation.id}`).set('Authorization', authorization)

  assert.equal(call.status, 403)
  assert.equal(complete.status, 403)
  assert.equal(remove.status, 403)
  const untouched = await prisma.reservation.findUnique({ where: { id: reservation.id } })
  assert.equal(untouched.status, 'waiting')
})

testSerial('전화번호가 없거나 마케팅 수신동의가 없는 결제는 프로모션 클레임에서 제외된다', async () => {
  const store = await createStore('promotion')
  const dueAt = new Date(Date.now() - 60 * 1000)
  const consentAt = new Date(Date.now() - 120 * 1000)
  const missingPhone = await prisma.payment.create({
    data: { storeId: store.id, phone: null, promoAt: dueAt, marketingConsentAt: consentAt },
  })
  const blankPhone = await prisma.payment.create({
    data: { storeId: store.id, phone: '', promoAt: dueAt, marketingConsentAt: consentAt },
  })
  // 전화번호는 있지만 광고 수신에 동의하지 않은 결제 — 정보통신망법 제50조 대응(계약 §4)으로
  // claimDuePromotions는 이제 이런 건도 대상에서 제외해야 한다.
  const noConsent = await prisma.payment.create({
    data: { storeId: store.id, phone: '01012345678', promoAt: dueAt, marketingConsentAt: null },
  })
  const eligible = await prisma.payment.create({
    data: { storeId: store.id, phone: '01012345679', promoAt: dueAt, marketingConsentAt: consentAt },
  })

  const claimed = await claimDuePromotions()
  assert.deepEqual(claimed.map((payment) => payment.id), [eligible.id])
  assert.equal((await prisma.payment.findUnique({ where: { id: missingPhone.id } })).promoClaimedAt, null)
  assert.equal((await prisma.payment.findUnique({ where: { id: blankPhone.id } })).promoClaimedAt, null)
  assert.equal((await prisma.payment.findUnique({ where: { id: noConsent.id } })).promoClaimedAt, null)
})

// --- POS 인증 (계약 §2.2) ---

testSerial('POS 라우트는 유효한 X-Store-Token 없이는 401을 반환하고 올바른 토큰이면 통과한다', async () => {
  const store = await createStore('pos-auth')

  const missing = await request(app).get('/api/pos/queue')
  assert.equal(missing.status, 401)
  assert.equal(missing.body.code, 'STORE_TOKEN_REQUIRED')

  const invalid = await request(app).get('/api/pos/queue').set('X-Store-Token', 'not-a-real-token')
  assert.equal(invalid.status, 401)
  assert.equal(invalid.body.code, 'INVALID_STORE_TOKEN')

  const valid = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.equal(valid.status, 200)
  assert.equal(valid.body.ok, true)
})

testSerial('POS 대기열 조회는 전화번호를 마스킹해서 내려주고 원본 전화번호를 응답에 노출하지 않는다', async () => {
  const store = await createStore('pos-mask')
  const phone = '01055559999'
  const created = await request(app)
    .post('/api/reservations')
    .send({ merchantId: store.merchantId, carNumber: '12가3456', phone, serviceType: 'oil', privacyConsent: true })
  assert.equal(created.status, 200)

  const queue = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.equal(queue.status, 200)
  assert.equal(queue.body.reservations.length, 1)
  assert.equal(queue.body.reservations[0].phoneMasked, '010-****-9999')
  assert.ok(!JSON.stringify(queue.body).includes(phone))
})

testSerial('매장 A의 POS 토큰으로 매장 B의 예약을 호출·완료·취소할 수 없다', async () => {
  const storeA = await createStore('pos-scope-a')
  const storeB = await createStore('pos-scope-b')
  const reservation = await prisma.reservation.create({
    data: {
      storeId: storeB.id,
      carNumber: '12가3456',
      phone: '01011112222',
      serviceType: '정비',
      queueNumber: 1,
      serviceDate: kstDateString(),
      status: 'waiting',
    },
  })

  const call = await request(app).post(`/api/pos/queue/${reservation.id}/call`).set('X-Store-Token', storeA.posToken)
  const complete = await request(app)
    .post(`/api/pos/queue/${reservation.id}/complete`)
    .set('X-Store-Token', storeA.posToken)
  const cancel = await request(app).post(`/api/pos/queue/${reservation.id}/cancel`).set('X-Store-Token', storeA.posToken)

  assert.equal(call.status, 404)
  assert.equal(complete.status, 404)
  assert.equal(cancel.status, 404)
  const untouched = await prisma.reservation.findUnique({ where: { id: reservation.id } })
  assert.equal(untouched.status, 'waiting')
})

// --- 크래시 방지 (계약 §5) ---

testSerial('라우트 핸들러에서 예외가 발생해도 프로세스가 죽지 않고 500 JSON을 반환하며 내부 에러 메시지를 노출하지 않는다', async () => {
  const admin = await createHqAdmin()
  const authorization = authHeader(admin)
  const secretMessage = '내부전용-DB-연결-실패-절대노출금지'

  const originalFindMany = prisma.reservation.findMany.bind(prisma.reservation)
  prisma.reservation.findMany = async () => {
    throw new Error(secretMessage)
  }
  let response
  try {
    response = await request(app).get('/api/reservations').set('Authorization', authorization)
  } finally {
    prisma.reservation.findMany = originalFindMany
  }

  assert.equal(response.status, 500)
  assert.equal(response.body.ok, false)
  assert.ok(!JSON.stringify(response.body).includes(secretMessage))

  // 프로세스가 실제로 살아있는지 이어지는 요청으로 확인한다(죽었다면 이 요청 자체가 실패한다).
  const followUp = await request(app).get('/health')
  assert.equal(followUp.status, 200)
})

// --- 개인정보 동의 (계약 §3.1) ---

testSerial('개인정보 수집 동의 없이는 예약 접수를 거부하고, 마케팅 동의 시각은 동의한 경우에만 기록한다', async () => {
  const store = await createStore('consent')

  const noConsent = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01044445555',
    serviceType: 'oil',
    privacyConsent: false,
  })
  assert.equal(noConsent.status, 400)
  assert.equal(await prisma.reservation.count({ where: { storeId: store.id } }), 0)

  const withoutMarketing = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01044445555',
    serviceType: 'oil',
    privacyConsent: true,
  })
  assert.equal(withoutMarketing.status, 200)
  const reservation1 = await prisma.reservation.findUnique({ where: { id: withoutMarketing.body.id } })
  assert.ok(reservation1.privacyConsentAt)
  assert.equal(reservation1.marketingConsentAt, null)

  const withMarketing = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '34나5678',
    phone: '01044445556',
    serviceType: 'oil',
    privacyConsent: true,
    marketingConsent: true,
  })
  assert.equal(withMarketing.status, 200)
  const reservation2 = await prisma.reservation.findUnique({ where: { id: withMarketing.body.id } })
  assert.ok(reservation2.marketingConsentAt)
})

// --- 결제금액 검증 (계약 §3.2) ---

testSerial('결제금액이 정수가 아니거나 범위를 벗어나면 400을 반환한다', async () => {
  const store = await createStore('amount-validation')
  const base = { merchantId: store.merchantId, phone: '01022223333', privacyConsent: true }

  const notInteger = await request(app).post('/api/payments').send({ ...base, amount: 1000.5 })
  assert.equal(notInteger.status, 400)

  const tooLarge = await request(app).post('/api/payments').send({ ...base, amount: 100000001 })
  assert.equal(tooLarge.status, 400)

  const negative = await request(app).post('/api/payments').send({ ...base, amount: -1 })
  assert.equal(negative.status, 400)

  const ok = await request(app).post('/api/payments').send({ ...base, amount: 55000, paymentKey: unique('pay') })
  assert.equal(ok.status, 200)
})

// --- serviceDate day-scope (계약 §3.1, §3.6, §3.13) ---

testSerial('peopleAhead와 POS 대기열은 오늘(KST) serviceDate만 집계하고, call-next도 어제 건은 호출하지 않는다', async () => {
  const store = await createStore('day-scope')
  const yesterday = kstDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const staleReservation = await prisma.reservation.create({
    data: {
      storeId: store.id,
      carNumber: '12가3456',
      phone: '01012340000',
      serviceType: '정비',
      queueNumber: 1,
      serviceDate: yesterday,
      status: 'waiting',
    },
  })

  // 1) POS 대기열에 어제 건이 보이면 안 된다.
  const queue = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.equal(queue.status, 200)
  assert.deepEqual(queue.body.reservations, [])

  // 2) 오늘 첫 접수의 peopleAhead는 어제 건의 영향을 받지 않고 0이어야 한다. queueNumber도
  // 날짜별로 분리된 QueueCounter 덕분에 어제 채번과 무관하게 1부터 시작한다.
  const created = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '34나5678',
    phone: '01012340001',
    serviceType: 'oil',
    privacyConsent: true,
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.peopleAhead, 0)
  assert.equal(created.body.queueNumber, 1)

  // 3) call-next은 어제 건을 건드리지 않고 오늘 접수분만 호출해야 한다.
  const admin = await createHqAdmin()
  const authorization = authHeader(admin)
  const callNext = await request(app).post(`/api/queue/call-next?storeId=${store.id}`).set('Authorization', authorization)
  assert.equal(callNext.status, 200)
  assert.equal(callNext.body.id, created.body.id)
  const staleAfter = await prisma.reservation.findUnique({ where: { id: staleReservation.id } })
  assert.equal(staleAfter.status, 'waiting')

  // 4) 오늘 접수분을 완료 처리하고 나면(어제 건만 waiting으로 남음) call-next은 404여야 한다.
  await request(app).post(`/api/reservations/${created.body.id}/complete`).set('Authorization', authorization)
  const noneLeft = await request(app).post(`/api/queue/call-next?storeId=${store.id}`).set('Authorization', authorization)
  assert.equal(noneLeft.status, 404)
})

// --- 취소 (계약 §3.9, §3.16) ---

testSerial('예약 취소는 waiting/called/notify_failed만 허용하고 대기열/앞사람 수에서 제외한다', async () => {
  const store = await createStore('cancel-flow')
  const admin = await createStoreAdmin(store)
  const authorization = authHeader(admin)

  const created = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01066667777',
    serviceType: 'oil',
    privacyConsent: true,
  })
  const id = created.body.id

  const cancelled = await request(app).post(`/api/reservations/${id}/cancel`).set('Authorization', authorization)
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.status, 'cancelled')

  const again = await request(app).post(`/api/reservations/${id}/cancel`).set('Authorization', authorization)
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyCancelled, true)

  const queue = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.equal(queue.body.reservations.length, 0)

  const second = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01066667778',
    serviceType: 'oil',
    privacyConsent: true,
  })
  assert.equal(second.body.peopleAhead, 0)

  // completed 상태는 취소 대상이 아니다(409).
  const third = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01066667779',
    serviceType: 'oil',
    privacyConsent: true,
  })
  const thirdId = third.body.id
  await request(app).post(`/api/reservations/${thirdId}/call`).set('Authorization', authorization)
  await request(app).post(`/api/reservations/${thirdId}/complete`).set('Authorization', authorization)
  const completedCancelAttempt = await request(app)
    .post(`/api/reservations/${thirdId}/cancel`)
    .set('Authorization', authorization)
  assert.equal(completedCancelAttempt.status, 409)
})

testSerial('POS 취소 엔드포인트는 노쇼 손님을 대기열에서 제거하고 재취소 요청은 alreadyProcessed를 반환한다', async () => {
  const store = await createStore('pos-cancel')
  const created = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01077778888',
    serviceType: 'oil',
    privacyConsent: true,
  })
  const id = created.body.id

  const cancelled = await request(app).post(`/api/pos/queue/${id}/cancel`).set('X-Store-Token', store.posToken)
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.status, 'cancelled')

  const queue = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.equal(queue.body.reservations.length, 0)

  const again = await request(app).post(`/api/pos/queue/${id}/cancel`).set('X-Store-Token', store.posToken)
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyProcessed, true)
})

// --- 재발송 (계약 §3.10, §3.11) ---

testSerial('알림 재발송(retry-notify)이 성공하면 called 상태로 되돌리고 sent:true를 반환한다', async () => {
  const store = await createStore('retry-notify-ok')
  const admin = await createHqAdmin()
  const authorization = authHeader(admin)

  const created = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01088889999',
    serviceType: 'oil',
    privacyConsent: true,
  })
  const id = created.body.id

  forceFailureFor = 'sendQueueTurnAlimtalk'
  const call = await request(app).post(`/api/reservations/${id}/call`).set('Authorization', authorization)
  assert.equal(call.status, 200)
  assert.equal(call.body.status, 'notify_failed')

  const retry = await request(app).post(`/api/reservations/${id}/retry-notify`).set('Authorization', authorization)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.sent, true)
  assert.equal(retry.body.status, 'called')
})

testSerial('알림 재발송(retry-notify)이 다시 실패해도 200과 sent:false를 반환하고 notify_failed를 유지한다', async () => {
  const store = await createStore('retry-notify-fail')
  const admin = await createHqAdmin()
  const authorization = authHeader(admin)

  const created = await request(app).post('/api/reservations').send({
    merchantId: store.merchantId,
    carNumber: '12가3456',
    phone: '01088880000',
    serviceType: 'oil',
    privacyConsent: true,
  })
  const id = created.body.id

  forceFailureFor = 'sendQueueTurnAlimtalk'
  await request(app).post(`/api/reservations/${id}/call`).set('Authorization', authorization)

  forceFailureFor = 'sendQueueTurnAlimtalk'
  const retry = await request(app).post(`/api/reservations/${id}/retry-notify`).set('Authorization', authorization)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.sent, false)
  assert.equal(retry.body.status, 'notify_failed')

  const stored = await prisma.reservation.findUnique({ where: { id } })
  assert.equal(stored.status, 'notify_failed')
})

testSerial('전자영수증 재발송(retry-receipt)이 성공하면 receipt_sent 상태와 sent:true를 반환한다', async () => {
  const store = await createStore('retry-receipt-ok')
  const admin = await createHqAdmin()
  const authorization = authHeader(admin)

  forceFailureFor = 'sendReceiptAlimtalk'
  const created = await request(app).post('/api/payments').send({
    merchantId: store.merchantId,
    phone: '01099990000',
    amount: 10000,
    privacyConsent: true,
  })
  assert.equal(created.status, 200)
  const stored = await prisma.payment.findUnique({ where: { id: created.body.id } })
  assert.equal(stored.status, 'receipt_failed')

  const retry = await request(app).post(`/api/payments/${created.body.id}/retry-receipt`).set('Authorization', authorization)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.sent, true)
  assert.equal(retry.body.status, 'receipt_sent')
})

testSerial('전자영수증 재발송이 다시 실패해도 sent:false를 반환하고 receipt_failed를 유지한다', async () => {
  const store = await createStore('retry-receipt-fail')
  const admin = await createHqAdmin()
  const authorization = authHeader(admin)

  forceFailureFor = 'sendReceiptAlimtalk'
  const created = await request(app).post('/api/payments').send({
    merchantId: store.merchantId,
    phone: '01099990001',
    amount: 10000,
    privacyConsent: true,
  })
  assert.equal(created.status, 200)

  forceFailureFor = 'sendReceiptAlimtalk'
  const retry = await request(app).post(`/api/payments/${created.body.id}/retry-receipt`).set('Authorization', authorization)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.sent, false)
  assert.equal(retry.body.status, 'receipt_failed')
})

// --- 페이지네이션 (계약 §3.3) ---

testSerial('예약 목록은 최신순으로 정렬되고 limit/offset/total/hasMore를 정확히 계산한다', async () => {
  const store = await createStore('pagination-order')
  const admin = await createHqAdmin()
  const authorization = authHeader(admin)

  // createdAt을 명시적으로 지정해 타이밍(sleep) 없이 정렬 순서를 결정적으로 만든다.
  const base = Date.now() - 10_000
  const created = []
  for (let i = 0; i < 3; i += 1) {
    created.push(
      await prisma.reservation.create({
        data: {
          storeId: store.id,
          carNumber: '12가3456',
          phone: '01000000001',
          serviceType: '정비',
          queueNumber: i + 1,
          serviceDate: kstDateString(),
          status: 'waiting',
          createdAt: new Date(base + i * 1000),
        },
      })
    )
  }

  const page1 = await request(app)
    .get(`/api/reservations?storeId=${store.id}&limit=2&offset=0`)
    .set('Authorization', authorization)
  assert.equal(page1.body.total, 3)
  assert.equal(page1.body.count, 2)
  assert.equal(page1.body.hasMore, true)
  assert.deepEqual(page1.body.reservations.map((r) => r.id), [created[2].id, created[1].id])

  const page2 = await request(app)
    .get(`/api/reservations?storeId=${store.id}&limit=2&offset=2`)
    .set('Authorization', authorization)
  assert.equal(page2.body.count, 1)
  assert.equal(page2.body.hasMore, false)
  assert.deepEqual(page2.body.reservations.map((r) => r.id), [created[0].id])
})

testSerial('limit은 최대 500으로 클램프된다', async () => {
  const store = await createStore('limit-clamp')
  const admin = await createHqAdmin()
  const authorization = authHeader(admin)

  const rows = Array.from({ length: 501 }, (_, i) => ({
    storeId: store.id,
    carNumber: '12가3456',
    phone: '01000000000',
    serviceType: '정비',
    queueNumber: i + 1,
    serviceDate: kstDateString(),
    status: 'waiting',
  }))
  await prisma.reservation.createMany({ data: rows })

  const response = await request(app)
    .get(`/api/reservations?storeId=${store.id}&limit=99999`)
    .set('Authorization', authorization)
  assert.equal(response.status, 200)
  assert.equal(response.body.total, 501)
  assert.equal(response.body.count, 500)
  assert.equal(response.body.reservations.length, 500)
  assert.equal(response.body.hasMore, true)
})

// --- 동시성(레이스 컨디션) ---

testSerial('같은 매장에 동시에 여러 예약이 접수돼도 대기번호가 충돌하지 않는다', async () => {
  // QueueCounter 원자적 채번(INSERT ... ON CONFLICT DO UPDATE)이 없던 시절엔 오늘 첫 두 손님이
  // 거의 동시에 접수하면 하나가 unique 제약(P2002)에 걸려 500을 돌려주는 버그가 있었다.
  const store = await createStore('concurrent')
  const requests = Array.from({ length: 5 }, () =>
    request(app).post('/api/reservations').send({
      merchantId: store.merchantId,
      carNumber: '12가3456',
      phone: '01099998888',
      serviceType: 'oil',
      privacyConsent: true,
    })
  )
  const responses = await Promise.all(requests)

  for (const response of responses) {
    assert.equal(response.status, 200)
  }
  const queueNumbers = responses.map((r) => r.body.queueNumber).sort((a, b) => a - b)
  assert.deepEqual(queueNumbers, [1, 2, 3, 4, 5])
})
