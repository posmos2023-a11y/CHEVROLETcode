// 기간 지정 홍보 문자(관리자 웹) 테스트.
// 다른 테스트 파일과 같은 로컬 devdb를 TRUNCATE로 비우므로 package.json의 `--test-concurrency=1`이 필요하다.
// 야간(21~08시 KST)에는 발송이 막히므로, 실제 발송을 확인하는 테스트는 낮에만 돈다(erpCart.test.js와 같은 방식).

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
const promoCalls = []
let failNext = null // null | 'error'(확실한 실패) | 'timeout' | 'network'(결과 모름)
// 발송사가 접수를 늘 거부하는 번호(보낼 때마다 확실한 실패)
const rejectedPhones = new Set()
solapi.sendPromoAlimtalk = async (payload) => {
  promoCalls.push(payload)
  if (rejectedPhones.has(payload.phone)) {
    const err = new Error('수신번호 접수 거부(테스트)')
    err.definiteFailure = true
    throw err
  }
  if (failNext === 'error') {
    failNext = null
    const err = new Error('수신번호 오류(테스트)')
    err.definiteFailure = true // solapi.js가 failedMessageList에서 만든 오류와 같은 표시
    throw err
  }
  if (failNext === 'timeout') {
    failNext = null
    const err = new Error('Solapi 발송 시간 초과 (10초)')
    err.code = 'SOLAPI_TIMEOUT'
    throw err
  }
  if (failNext === 'network') { failNext = null; throw new Error('socket hang up') }
  return { ok: true }
}

const { prisma } = require('../src/store')
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
    'TRUNCATE TABLE "MarketingOptOut", "PromoSend", "ErpCart", "RateLimitHit", "WebhookEvent", "Payment", "Reservation", "QueueCounter", "AdminUser", "Store" RESTART IDENTITY CASCADE'
  )
  promoCalls.length = 0
  failNext = null
  rejectedPhones.clear()
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`
  await resetDatabase()
})
beforeEach(resetDatabase)
after(async () => {
  await prisma.$disconnect()
})

const DAY = 24 * 60 * 60 * 1000
function kstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * DAY).toISOString().slice(0, 10)
}
function isDaytimeKst() {
  const h = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours()
  return h >= 8 && h < 21
}

async function createStore(label) {
  return prisma.store.create({
    data: {
      merchantId: unique(`m-${label}`),
      name: `테스트 매장 ${label}`,
      posToken: crypto.randomBytes(32).toString('hex'),
    },
  })
}

async function adminToken(role, store) {
  const admin = await prisma.adminUser.create({
    data: {
      email: `${unique(role)}@example.test`,
      passwordHash: await hashPassword('test-password-123'),
      role,
      storeId: store ? store.id : null,
    },
  })
  return { token: signAdminToken(admin), admin }
}

// 방문 기록. daysAgo로 접수 시각을 과거로 둔다.
function visit(store, { phone, carNumber = '12가3456', marketing = true, daysAgo = 1, anonymized = false }) {
  return prisma.reservation.create({
    data: {
      storeId: store.id,
      carNumber,
      phone,
      serviceType: '엔진오일',
      queueNumber: Math.floor(Math.random() * 9000) + 1000,
      serviceDate: kstDate(-daysAgo),
      status: 'completed',
      privacyConsentAt: new Date(),
      marketingConsentAt: marketing ? new Date(Date.now() - daysAgo * DAY) : null,
      createdAt: new Date(Date.now() - daysAgo * DAY),
      anonymizedAt: anonymized ? new Date() : null,
    },
  })
}

function preview(token, query) {
  return request(app).get('/api/admin/promo-campaign/preview').set('Authorization', `Bearer ${token}`).query(query)
}
function send(token, body) {
  return request(app).post('/api/admin/promo-campaign/send').set('Authorization', `Bearer ${token}`).send(body)
}

// --- 미리보기 ---------------------------------------------------------------------

testSerial('미리보기: 기간 안에 방문한 동의자만 대상이고, 기간 밖 방문자와 비동의자는 빠진다', async () => {
  const store = await createStore('basic')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01011110001', daysAgo: 3 })
  await visit(store, { phone: '01011110002', daysAgo: 4, marketing: false })
  await visit(store, { phone: '01011110003', daysAgo: 40 }) // 기간 밖

  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.visitors, 2)
  assert.equal(res.body.eligible, 1)
  assert.equal(res.body.excluded.noConsent, 1)
  assert.equal(res.body.sample[0].phoneMasked, '010-****-0001')
  assert.equal(JSON.stringify(res.body).includes('01011110001'), false) // 전화번호 원문은 내려가지 않는다
})

testSerial('미리보기: 기간 안에서 동의했어도 그 뒤 방문에서 동의하지 않았으면 제외한다(최근 의사 기준)', async () => {
  const store = await createStore('latest')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01022220001', daysAgo: 20, marketing: true })
  await visit(store, { phone: '01022220001', daysAgo: 2, marketing: false })
  const res = await preview(token, { storeId: store.id, from: kstDate(-30), to: kstDate(-10) })
  assert.equal(res.body.visitors, 1)
  assert.equal(res.body.eligible, 0)
  assert.equal(res.body.excluded.noConsent, 1)
})

testSerial('미리보기: 같은 번호는 차가 여러 대여도 한 명으로 센다', async () => {
  const store = await createStore('dedupe')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01033330001', carNumber: '12가1111', daysAgo: 2 })
  await visit(store, { phone: '01033330001', carNumber: '34나2222', daysAgo: 3 })
  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.body.visitors, 1)
  assert.equal(res.body.eligible, 1)
})

testSerial('미리보기: 30일 안에 홍보를 받은 번호는 제외한다', async () => {
  const store = await createStore('recent')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01044440001', daysAgo: 2 })
  await prisma.promoSend.create({ data: { storeId: store.id, phone: '01044440001', carNumber: '12가3456', sentAt: new Date(Date.now() - 10 * DAY) } })
  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.body.eligible, 0)
  assert.equal(res.body.excluded.recentlySent, 1)
})

testSerial('미리보기: 다른 매장 방문·발송 기록과 익명화된 기록은 보지 않는다', async () => {
  const store = await createStore('scope')
  const other = await createStore('scope-other')
  const { token } = await adminToken('hq_admin')
  await visit(other, { phone: '01055550001', daysAgo: 2 })
  await visit(store, { phone: '01055550002', daysAgo: 2, anonymized: true })
  await visit(store, { phone: '01055550003', daysAgo: 2 })
  await prisma.promoSend.create({ data: { storeId: other.id, phone: '01055550003', sentAt: new Date() } })
  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.body.visitors, 1)
  assert.equal(res.body.eligible, 1)
})

testSerial('미리보기: 프론트 결제(Payment)로 방문한 손님도 포함한다', async () => {
  const store = await createStore('payment')
  const { token } = await adminToken('hq_admin')
  await prisma.payment.create({
    data: {
      storeId: store.id, paymentKey: unique('pk'), phone: '01066660001', amount: 10000,
      promoAt: new Date(Date.now() + 90 * DAY), marketingConsentAt: new Date(), privacyConsentAt: new Date(),
      createdAt: new Date(Date.now() - 2 * DAY),
    },
  })
  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.body.eligible, 1)
})

testSerial('권한: 매장 관리자는 다른 매장을 지정해도 자기 매장으로 고정된다', async () => {
  const mine = await createStore('mine')
  const other = await createStore('other')
  const { token } = await adminToken('store_admin', mine)
  await visit(other, { phone: '01077770001', daysAgo: 2 })
  const res = await preview(token, { storeId: other.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, 200)
  assert.equal(res.body.storeName, mine.name)
  assert.equal(res.body.visitors, 0)
})

testSerial('권한: 본사 관리자는 매장을 지정해야 한다(전 매장 일괄 발송 없음)', async () => {
  const { token } = await adminToken('hq_admin')
  const res = await preview(token, { from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, 400)
})

testSerial('권한: 로그인하지 않으면 401', async () => {
  const res = await request(app).get('/api/admin/promo-campaign/preview').query({ from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, 401)
  const sent = await request(app).post('/api/admin/promo-campaign/send').send({ from: kstDate(-7), to: kstDate(0), confirmCount: 1 })
  assert.equal(sent.status, 401)
})

testSerial('기간 검증: 형식 오류·역순·미래·366일 초과는 400', async () => {
  const store = await createStore('dates')
  const { token } = await adminToken('hq_admin')
  for (const [from, to] of [['2026-1-1', kstDate(0)], [kstDate(0), kstDate(-1)], [kstDate(-1), kstDate(1)], [kstDate(-400), kstDate(0)]]) {
    const res = await preview(token, { storeId: store.id, from, to })
    assert.equal(res.status, 400, `${from}~${to}`)
  }
})

// --- 발송 -------------------------------------------------------------------------

testSerial('발송: 대상에게만 보내고 보낸 관리자를 기록하며, 보낸 번호는 다음 미리보기에서 빠진다', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('send')
  const { token, admin } = await adminToken('hq_admin')
  await visit(store, { phone: '01088880001', carNumber: '12가1111', daysAgo: 2 })
  await visit(store, { phone: '01088880002', carNumber: '34나2222', daysAgo: 3 })
  await visit(store, { phone: '01088880003', daysAgo: 3, marketing: false })

  const res = await send(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0), confirmCount: 2 })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.sent, 2)
  assert.equal(res.body.remaining, 0)
  assert.deepEqual(promoCalls.map((c) => c.phone).sort(), ['01088880001', '01088880002'])
  assert.ok(promoCalls.every((c) => c.storeName === store.name))

  const records = await prisma.promoSend.findMany({ where: { storeId: store.id } })
  assert.equal(records.length, 2)
  assert.ok(records.every((r) => r.sentBy === admin.id))

  const again = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(again.body.eligible, 0)
  assert.equal(again.body.excluded.recentlySent, 2)
})

testSerial('발송: 미리보기 이후 대상이 늘었으면 보내지 않는다(409)', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('changed')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01099990001', daysAgo: 2 })
  await visit(store, { phone: '01099990002', daysAgo: 2 })
  const res = await send(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0), confirmCount: 1 })
  assert.equal(res.status, 409)
  assert.equal(res.body.eligible, 2)
  assert.equal(promoCalls.length, 0)
  assert.equal(await prisma.promoSend.count(), 0)
})

testSerial('발송: 확실한 실패는 failed로 남아 나중에 다시 보낼 수 있고, 같은 발송 안에서는 다시 시도하지 않는다', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('fail')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01012120001', daysAgo: 2 })
  const period = { storeId: store.id, from: kstDate(-7), to: kstDate(0) }

  failNext = 'error'
  const first = await send(token, { ...period, confirmCount: 1 })
  assert.equal(first.body.failed, 1)
  assert.equal(first.body.uncertain, 0)
  const record = await prisma.promoSend.findFirst({ where: { storeId: store.id } })
  assert.equal(record.status, 'failed')

  // 30일 제한에는 들어가지 않지만, 30분 동안은 "보낼 수 있음"에 세지 않고 방금 실패로 표시한다
  const retry = await preview(token, period)
  assert.equal(retry.body.eligible, 0)
  assert.equal(retry.body.filterCounts.eligible, 0)
  assert.equal(retry.body.rows[0].status, 'ok')
  assert.equal(retry.body.rows[0].recentFailure, true)

  // 하지만 이어 보내기에서는 방금 실패한 번호를 다시 시도하지 않는다
  const again = await send(token, { ...period, confirmCount: 0 })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.sent, 0)
  assert.equal(promoCalls.length, 1)

  // 30분이 지나면 다시 보낼 수 있다
  await prisma.promoSend.update({ where: { id: record.id }, data: { sentAt: new Date(Date.now() - 31 * 60 * 1000) } })
  const later = await send(token, { ...period, confirmCount: 1 })
  assert.equal(later.body.sent, 1)
  assert.equal(promoCalls.length, 2)
})

testSerial('발송: 시간 초과·알 수 없는 오류는 나갔을 수 있어 unknown으로 남기고 30일 제한에 넣는다', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('uncertain')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01012130001', daysAgo: 2 })
  await visit(store, { phone: '01012130002', daysAgo: 3 })
  const period = { storeId: store.id, from: kstDate(-7), to: kstDate(0) }

  failNext = 'timeout'
  const first = await send(token, { ...period, confirmCount: 2 })
  assert.equal(first.body.sent, 1)
  assert.equal(first.body.uncertain, 1)
  assert.equal(first.body.failed, 0)
  assert.deepEqual((await prisma.promoSend.findMany({ where: { storeId: store.id } })).map((r) => r.status).sort(), ['sent', 'unknown'])

  const after = await preview(token, period)
  assert.equal(after.body.eligible, 0)
  assert.equal(after.body.excluded.recentlySent, 2)
})

testSerial('발송: 태그 없는 일반 오류(네트워크 등)도 결과를 모르는 것으로 본다', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('network')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01012140001', daysAgo: 2 })
  failNext = 'network'
  const res = await send(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0), confirmCount: 1 })
  assert.equal(res.body.uncertain, 1)
  const record = await prisma.promoSend.findFirst({ where: { storeId: store.id } })
  assert.equal(record.status, 'unknown')
})

testSerial('발송: 기록에 경로(via)와 근거 동의 시각(consentAt)을 남긴다', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('audit')
  const { token } = await adminToken('hq_admin')
  const r = await visit(store, { phone: '01012150001', daysAgo: 2 })
  await send(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0), confirmCount: 1 })
  const record = await prisma.promoSend.findFirst({ where: { storeId: store.id } })
  assert.equal(record.via, 'campaign-admin')
  assert.equal(record.status, 'sent')
  assert.equal(record.consentAt.getTime(), r.marketingConsentAt.getTime())
})

// --- 공통 판단: 수신거부·동의 2년·다른 경로 발송 ---------------------------------------

function posOptOut(store, phone) {
  return request(app).post('/api/pos/promo/opt-out').set('X-Store-Token', store.posToken).send({ phone })
}

testSerial('수신거부: 탭앱에서 등록한 번호는 대상에서 빠지고, 그 뒤 새로 동의하면 다시 대상이 된다', async () => {
  const store = await createStore('optout')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01016160001', daysAgo: 5 })
  const period = { storeId: store.id, from: kstDate(-7), to: kstDate(0) }

  const reg = await posOptOut(store, '010-1616-0001')
  assert.equal(reg.status, 200, JSON.stringify(reg.body))
  assert.equal(reg.body.phoneMasked, '010-****-0001')
  const row = await prisma.marketingOptOut.findFirst({ where: { storeId: store.id } })
  assert.equal(row.phone, '01016160001')
  assert.equal(row.via, 'pos')

  const blocked = await preview(token, period)
  assert.equal(blocked.body.eligible, 0)
  assert.equal(blocked.body.excluded.optedOut, 1)

  // 거부 등록 뒤의 방문에서 새로 동의했다
  await prisma.reservation.create({
    data: {
      storeId: store.id, carNumber: '12가3456', phone: '01016160001', serviceType: '엔진오일',
      queueNumber: 4321, serviceDate: kstDate(0), status: 'completed',
      privacyConsentAt: new Date(), marketingConsentAt: new Date(Date.now() + 1000), createdAt: new Date(Date.now() + 1000),
    },
  })
  const again = await preview(token, period)
  assert.equal(again.body.eligible, 1)
})

testSerial('수신거부: 다른 매장에 등록한 거부는 이 매장 대상에 영향이 없다', async () => {
  const store = await createStore('optout-scope')
  const other = await createStore('optout-scope-other')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01016170001', daysAgo: 2 })
  assert.equal((await posOptOut(other, '01016170001')).status, 200)
  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.body.eligible, 1)
})

testSerial('수신거부: 잘못된 번호는 400, 매장 토큰 없으면 401', async () => {
  const store = await createStore('optout-bad')
  assert.equal((await posOptOut(store, '1234')).status, 400)
  assert.equal((await request(app).post('/api/pos/promo/opt-out').send({ phone: '01012345678' })).status, 401)
})

testSerial('수신거부: 관리자 웹 등록은 매장 관리자면 자기 매장으로 고정되고 등록자를 남긴다', async () => {
  const mine = await createStore('optout-admin')
  const other = await createStore('optout-admin-other')
  const { token, admin } = await adminToken('store_admin', mine)
  const res = await request(app).post('/api/admin/promo-opt-out').set('Authorization', `Bearer ${token}`)
    .send({ storeId: other.id, phone: '01016180001' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const row = await prisma.marketingOptOut.findFirst({ where: { phone: '01016180001' } })
  assert.equal(row.storeId, mine.id)
  assert.equal(row.recordedBy, admin.id)

  const hq = await adminToken('hq_admin')
  const noStore = await request(app).post('/api/admin/promo-opt-out').set('Authorization', `Bearer ${hq.token}`).send({ phone: '01016180002' })
  assert.equal(noStore.status, 400)
  assert.equal((await request(app).post('/api/admin/promo-opt-out').send({ phone: '01016180002' })).status, 401)
})

testSerial('동의 2년: 2년이 지난 동의는 대상에서 뺀다', async () => {
  const store = await createStore('expired')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01017170001', daysAgo: 750 })
  await visit(store, { phone: '01017170002', daysAgo: 700 })
  const res = await preview(token, { storeId: store.id, from: kstDate(-800), to: kstDate(-600) })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.visitors, 2)
  assert.equal(res.body.eligible, 1)
  assert.equal(res.body.excluded.consentExpired, 1)
})

testSerial('30일: 자동 홍보(Payment.promoSentAt)로 받은 번호도 빠진다', async () => {
  const store = await createStore('auto-sent')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01018180001', daysAgo: 2 })
  await prisma.payment.create({
    data: {
      storeId: store.id, phone: '01018180001', amount: 10000, promoAt: new Date(Date.now() - 5 * DAY),
      promoSent: true, promoSentAt: new Date(Date.now() - 5 * DAY), marketingConsentAt: new Date(Date.now() - 100 * DAY),
      createdAt: new Date(Date.now() - 100 * DAY),
    },
  })
  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.body.eligible, 0)
  assert.equal(res.body.excluded.recentlySent, 1)
})

testSerial('동시 발송: 같은 번호를 동시에 잡으면 한 건만 기록된다(번호 단위 잠금)', async () => {
  const store = await createStore('race')
  await visit(store, { phone: '01019190001', daysAgo: 2 })
  const { claimPromoSend } = require('../src/store')
  const claims = await Promise.all(Array.from({ length: 4 }, () =>
    claimPromoSend({ storeId: store.id, phone: '01019190001', carNumber: '12가3456', sentBy: null, via: 'campaign-admin' })))
  assert.equal(claims.filter((c) => c.ok).length, 1)
  assert.deepEqual(claims.filter((c) => !c.ok).map((c) => c.status), ['recently_sent', 'recently_sent', 'recently_sent'])
  assert.equal(await prisma.promoSend.count({ where: { storeId: store.id } }), 1)
})

// --- 자동 홍보(결제 3개월 뒤)도 같은 기준을 쓴다 -----------------------------------------

function duePayment(store, phone, overrides = {}) {
  return prisma.payment.create({
    data: {
      storeId: store.id, phone, carNumber: '12가3456', amount: 10000,
      promoAt: new Date(Date.now() - 60 * 1000), marketingConsentAt: new Date(Date.now() - 90 * DAY),
      createdAt: new Date(Date.now() - 90 * DAY), ...overrides,
    },
  })
}

testSerial('자동 홍보: 보내면 PromoSend(auto)를 남겨 다른 경로의 30일 제한에 걸린다', async () => {
  if (!isDaytimeKst()) return // 자동 홍보도 야간에는 보내지 않는다
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-ok')
  const p = await duePayment(store, '01020200001')
  const result = await sendDuePromotions()
  assert.equal(result.sent, 1, JSON.stringify(result))
  const record = await prisma.promoSend.findFirst({ where: { storeId: store.id } })
  assert.equal(record.via, 'auto')
  assert.equal(record.status, 'sent')
  const paid = await prisma.payment.findUnique({ where: { id: p.id } })
  assert.equal(paid.promoSent, true)
  assert.ok(paid.promoSentAt)
})

testSerial('자동 홍보: 수신거부한 번호는 보내지 않고 "보내지 않음"으로 닫는다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-optout')
  const p = await duePayment(store, '01020210001')
  await posOptOut(store, '01020210001')
  const result = await sendDuePromotions()
  assert.equal(result.skipped, 1, JSON.stringify(result))
  assert.equal(promoCalls.length, 0)
  const row = await prisma.payment.findUnique({ where: { id: p.id } })
  assert.equal(row.promoSent, true)
  assert.equal(row.promoSentAt, null)
})

testSerial('자동 홍보: 최근 방문에서 동의하지 않았으면 보내지 않는다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-latest')
  await duePayment(store, '01020220001')
  await visit(store, { phone: '01020220001', daysAgo: 1, marketing: false })
  const result = await sendDuePromotions()
  assert.equal(result.skipped, 1, JSON.stringify(result))
  assert.equal(promoCalls.length, 0)
})

testSerial('자동 홍보: 30일 안에 다른 경로로 받았으면 30일이 끝날 때까지 미룬다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-postpone')
  const p = await duePayment(store, '01020230001')
  const sentAt = new Date(Date.now() - 10 * DAY)
  await prisma.promoSend.create({ data: { storeId: store.id, phone: '01020230001', sentAt } })
  const result = await sendDuePromotions()
  assert.equal(result.skipped, 1, JSON.stringify(result))
  assert.equal(promoCalls.length, 0)
  const row = await prisma.payment.findUnique({ where: { id: p.id } })
  assert.equal(row.promoSent, false)
  assert.equal(row.promoAt.getTime(), sentAt.getTime() + 30 * DAY)
})

testSerial('자동 홍보: 결과를 모르는 실패는 다시 보내지 않고, 확실한 실패는 다음에 다시 보낸다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-fail')
  const a = await duePayment(store, '01020240001')
  failNext = 'timeout'
  await sendDuePromotions()
  const rowA = await prisma.payment.findUnique({ where: { id: a.id } })
  assert.equal(rowA.promoSent, true)

  const store2 = await createStore('auto-fail-2')
  const b = await duePayment(store2, '01020240002')
  failNext = 'error'
  const before = Date.now()
  await sendDuePromotions()
  const rowB = await prisma.payment.findUnique({ where: { id: b.id } })
  assert.equal(rowB.promoSent, false)
  assert.equal(rowB.promoClaimedAt, null)
  // 같은 실행에서 다시 잡히지 않게 하루 뒤로 미룬다.
  assert.ok(rowB.promoAt.getTime() >= before + DAY - 60 * 1000, `promoAt=${rowB.promoAt.toISOString()}`)
  assert.equal(promoCalls.filter((p) => p.phone === '01020240002').length, 1)
})

testSerial('자동 홍보: 발송사가 거부하는 번호가 묶음 크기(100)보다 많아도 한 실행 안에서 뒤의 정상 대상까지 보낸다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-starve')
  const rejected = []
  for (let i = 0; i < 105; i += 1) {
    const phone = `0109${String(1000000 + i).slice(-7)}`
    rejectedPhones.add(phone)
    // 정상 대상보다 차례(promoAt)가 앞선다 -- 예전에는 실패한 이 건들이 매 묶음 맨 앞에 다시 잡혔다.
    rejected.push(await duePayment(store, phone, { promoAt: new Date(Date.now() - 10 * DAY - i * 1000) }))
  }
  const good = []
  for (let i = 0; i < 3; i += 1) good.push(await duePayment(store, `0108${String(1000000 + i).slice(-7)}`))

  const before = Date.now()
  const result = await sendDuePromotions()
  assert.equal(result.sent, 3, JSON.stringify(result))
  assert.equal(result.failed, 105, JSON.stringify(result))
  assert.equal(result.exhausted, false, JSON.stringify(result))
  // 거부 번호마다 한 번씩만 시도했다(같은 실행에서 다시 보내지 않는다).
  assert.equal(promoCalls.length, 108)
  assert.equal(new Set(promoCalls.map((p) => p.phone)).size, 108)
  const goodRows = await prisma.payment.findMany({ where: { id: { in: good.map((p) => p.id) } } })
  assert.ok(goodRows.every((r) => r.promoSent && r.promoSentAt), '정상 대상이 발송되지 않았다')
  const rejectedRows = await prisma.payment.findMany({ where: { id: { in: rejected.map((p) => p.id) } } })
  assert.ok(rejectedRows.every((r) => !r.promoSent && !r.promoClaimedAt && r.promoAt.getTime() >= before + DAY - 60 * 1000))
})

testSerial('자동 홍보: 같은 번호가 7일 안에 3번 확실히 실패하면 더 미루지 않고 "보내지 않음"으로 닫는다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-fail-cap')
  const phone = '01020290001'
  rejectedPhones.add(phone)
  const p = await duePayment(store, phone)
  // 앞선 두 번의 실행에서 이미 두 번 실패했다(8일 전 실패는 세지 않는다).
  for (const daysAgo of [1, 2, 8]) {
    await prisma.promoSend.create({ data: { storeId: store.id, phone, via: 'auto', status: 'failed', sentAt: new Date(Date.now() - daysAgo * DAY) } })
  }
  await sendDuePromotions()
  const row = await prisma.payment.findUnique({ where: { id: p.id } })
  assert.equal(row.promoSent, true)
  assert.equal(row.promoSentAt, null)

  // 7일 안의 실패가 두 번 이하면 하루 뒤로 미루기만 한다.
  const other = await createStore('auto-fail-cap-2')
  const q = await duePayment(other, phone)
  await prisma.promoSend.create({ data: { storeId: other.id, phone, via: 'auto', status: 'failed', sentAt: new Date(Date.now() - DAY) } })
  await sendDuePromotions()
  const rowQ = await prisma.payment.findUnique({ where: { id: q.id } })
  assert.equal(rowQ.promoSent, false)
  assert.ok(rowQ.promoAt.getTime() > Date.now() + DAY - 5 * 60 * 1000)
})

testSerial('자동 홍보: 야간에는 아무것도 잡지 않고 끝낸다(야간에 실행될 때만 확인)', async () => {
  if (isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-night')
  const p = await duePayment(store, '01020250001')
  const result = await sendDuePromotions()
  assert.equal(result.stopped, 'night', JSON.stringify(result))
  assert.equal(promoCalls.length, 0)
  const row = await prisma.payment.findUnique({ where: { id: p.id } })
  assert.equal(row.promoSent, false)
  assert.equal(row.promoClaimedAt, null)
})

testSerial('자동 홍보: 취소된 결제에는 보내지 않는다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-cancelled')
  const p = await duePayment(store, '01020260001', { status: 'cancelled' })
  await sendDuePromotions()
  assert.equal(promoCalls.length, 0)
  const row = await prisma.payment.findUnique({ where: { id: p.id } })
  assert.equal(row.promoClaimedAt, null)
})

testSerial('자동 홍보: 보낸 뒤 같은 번호의 곧 차례가 올 결제는 닫고, 30일 뒤의 결제는 남긴다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-sibling')
  await duePayment(store, '01020270001')
  const soon = await duePayment(store, '01020270001', { promoAt: new Date(Date.now() + 5 * DAY) })
  const later = await duePayment(store, '01020270001', { promoAt: new Date(Date.now() + 60 * DAY) })
  const result = await sendDuePromotions()
  assert.equal(result.sent, 1, JSON.stringify(result))
  const soonRow = await prisma.payment.findUnique({ where: { id: soon.id } })
  assert.equal(soonRow.promoSent, true)
  assert.equal(soonRow.promoSentAt, null)
  const laterRow = await prisma.payment.findUnique({ where: { id: later.id } })
  assert.equal(laterRow.promoSent, false)
})

testSerial('자동 홍보: 시연 모드여도 30일 제한을 그대로 건다', async () => {
  if (!isDaytimeKst()) return
  const { sendDuePromotions } = require('../server')
  const store = await createStore('auto-demo')
  await prisma.store.update({ where: { id: store.id }, data: { promoDemoUntil: new Date(Date.now() + 3600 * 1000) } })
  await duePayment(store, '01020280001')
  await prisma.promoSend.create({ data: { storeId: store.id, phone: '01020280001', sentAt: new Date(Date.now() - DAY) } })
  const result = await sendDuePromotions()
  assert.equal(result.skipped, 1, JSON.stringify(result))
  assert.equal(promoCalls.length, 0)
})

testSerial('수동 홍보: 기간 발송으로 같은 번호에 보냈으면 다른 차여도 30일 동안 막는다', async () => {
  if (!isDaytimeKst()) return // 야간에는 30일 판단 전에 야간으로 막힌다
  const store = await createStore('manual-phone')
  await visit(store, { phone: '01021210001', carNumber: '99하9999', daysAgo: 1 })
  await prisma.promoSend.create({ data: { storeId: store.id, phone: '01021210001', carNumber: '12가3456', sentAt: new Date(Date.now() - 3 * DAY) } })
  const res = await request(app).get('/api/pos/promo/eligibility?carNumber=' + encodeURIComponent('99하9999')).set('X-Store-Token', store.posToken)
  assert.equal(res.body.canSend, false, JSON.stringify(res.body))
  assert.equal(res.body.reason, 'recently_sent')
})

testSerial('수동 홍보: 수신거부한 번호에는 보낼 수 없다', async () => {
  const store = await createStore('manual-optout')
  await visit(store, { phone: '01021220001', carNumber: '88허8888', daysAgo: 1 })
  await posOptOut(store, '01021220001')
  const res = await request(app).post('/api/pos/promo/send').set('X-Store-Token', store.posToken).send({ carNumber: '88허8888' })
  assert.equal(res.status, 403)
  assert.equal(res.body.reason, 'opted_out')
  assert.equal(promoCalls.length, 0)
})

testSerial('수동 홍보: 확실한 실패면 502(send_failed)이고 다시 보낼 수 있다', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('manual-fail')
  await visit(store, { phone: '01021230001', carNumber: '77거7777', daysAgo: 1 })
  failNext = 'error'
  const res = await request(app).post('/api/pos/promo/send').set('X-Store-Token', store.posToken).send({ carNumber: '77거7777' })
  assert.equal(res.status, 502)
  assert.equal(res.body.reason, 'send_failed')
  const el = await request(app).get('/api/pos/promo/eligibility?carNumber=' + encodeURIComponent('77거7777')).set('X-Store-Token', store.posToken)
  assert.equal(el.body.canSend, true, JSON.stringify(el.body))
  const ok = await request(app).post('/api/pos/promo/send').set('X-Store-Token', store.posToken).send({ carNumber: '77거7777' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const statuses = (await prisma.promoSend.findMany({ where: { storeId: store.id }, orderBy: { sentAt: 'asc' } })).map((r) => r.status)
  assert.deepEqual(statuses, ['failed', 'sent'])
})

testSerial('미리보기: 보낼 문구와 수신거부 문구 설정 여부를 함께 준다', async () => {
  const store = await createStore('message')
  const { token } = await adminToken('hq_admin')
  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, 200)
  assert.ok(res.body.message.startsWith(`(광고) ${store.name}`), res.body.message)
  assert.equal(res.body.optOutConfigured, Boolean(process.env.PROMO_OPT_OUT_TEXT))
})

testSerial('발송: confirmCount가 없으면 400', async () => {
  const store = await createStore('noconfirm')
  const { token } = await adminToken('hq_admin')
  const res = await send(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, isDaytimeKst() ? 400 : 403)
})

// --- POS 탭앱 [홍보 문자] ------------------------------------------------------------

function posPreview(store, query) {
  return request(app).get('/api/pos/promo-campaign/preview').set('X-Store-Token', store.posToken).query(query)
}
function posSend(store, body) {
  return request(app).post('/api/pos/promo-campaign/send').set('X-Store-Token', store.posToken).send(body)
}

testSerial('탭앱: 매장 토큰의 매장만 대상이고 storeId를 넣어도 다른 매장으로 바꿀 수 없다', async () => {
  const store = await createStore('pos')
  const other = await createStore('pos-other')
  await visit(store, { phone: '01014140001', daysAgo: 2 })
  await visit(other, { phone: '01014140002', daysAgo: 2 })
  const res = await posPreview(store, { storeId: other.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.storeName, store.name)
  assert.equal(res.body.eligible, 1)
  assert.equal(res.body.sample[0].phoneMasked, '010-****-0001')
})

testSerial('탭앱: 매장 토큰이 없으면 401', async () => {
  const res = await request(app).get('/api/pos/promo-campaign/preview').query({ from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, 401)
})

testSerial('탭앱: 기간이 잘못되면 400', async () => {
  const store = await createStore('pos-dates')
  const res = await posPreview(store, { from: kstDate(0), to: kstDate(-3) })
  assert.equal(res.status, 400)
})

testSerial('탭앱 발송: 그 매장 대상에게 보내고 보낸 사람은 매장 단위(null)로 기록한다', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('pos-send')
  await visit(store, { phone: '01015150001', daysAgo: 2 })
  const res = await posSend(store, { from: kstDate(-7), to: kstDate(0), confirmCount: 1 })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.sent, 1)
  const record = await prisma.promoSend.findFirst({ where: { storeId: store.id } })
  assert.equal(record.sentBy, null)
  assert.equal(record.phone, '01015150001')
})

testSerial('발송: 야간에는 막힌다(야간에 실행될 때만 확인)', async () => {
  if (isDaytimeKst()) return
  const store = await createStore('night')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01013130001', daysAgo: 2 })
  const res = await send(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0), confirmCount: 1 })
  assert.equal(res.status, 403)
  assert.equal(res.body.reason, 'night')
  assert.equal(promoCalls.length, 0)
})

// --- 시연 모드 ---------------------------------------------------------------------

function posDemo(store, enabled) {
  return request(app).post('/api/pos/promo/demo-mode').set('X-Store-Token', store.posToken).send({ enabled })
}

testSerial('시연 모드: 탭앱에서는 켤 수 없고, 본사가 켜면 그날 자정까지 차량별 수동 발송만 30일 제한이 풀린다', async () => {
  if (!isDaytimeKst()) return
  const store = await createStore('demo')
  await visit(store, { phone: '01022220009', daysAgo: 2 })
  await prisma.promoSend.create({ data: { storeId: store.id, phone: '01022220009', sentAt: new Date(Date.now() - 60 * 1000) } })

  const denied = await posDemo(store, true)
  assert.equal(denied.status, 403, JSON.stringify(denied.body))

  const { token } = await adminToken('hq_admin')
  const on = await request(app).post('/api/admin/promo-demo-mode').set('Authorization', `Bearer ${token}`).send({ storeId: store.id, enabled: true })
  assert.equal(on.status, 200, JSON.stringify(on.body))
  assert.equal(on.body.demoMode, true)
  const until = new Date(on.body.demoUntil)
  assert.equal(new Date(until.getTime() + 9 * 3600 * 1000).toISOString().slice(11, 19), '00:00:00') // KST 자정
  assert.ok(until.getTime() > Date.now())

  // 기간 발송은 시연 모드여도 30일 제한 그대로
  const after = await posPreview(store, { from: kstDate(-7), to: kstDate(0) })
  assert.equal(after.body.eligible, 0)
  assert.equal(after.body.minIntervalDays, 30)
  assert.equal(after.body.demoMode, true)

  // 차량별 수동 발송은 30일 제한 없이 나간다
  const manual = await request(app).post('/api/pos/promo/send').set('X-Store-Token', store.posToken).send({ carNumber: '12가3456' })
  assert.equal(manual.status, 200, JSON.stringify(manual.body))

  // 탭앱에서 끌 수는 있다. 끄면 수동 발송도 다시 막힌다
  const off = await posDemo(store, false)
  assert.equal(off.status, 200, JSON.stringify(off.body))
  assert.equal(off.body.demoMode, false)
  const blocked = await request(app).post('/api/pos/promo/send').set('X-Store-Token', store.posToken).send({ carNumber: '12가3456' })
  assert.notEqual(blocked.status, 200, JSON.stringify(blocked.body))
})

testSerial('시연 모드: 끝나는 시각이 지나면 저절로 꺼진다', async () => {
  const store = await createStore('demo-expired')
  await visit(store, { phone: '01022220010', daysAgo: 2 })
  await prisma.promoSend.create({ data: { storeId: store.id, phone: '01022220010', sentAt: new Date(Date.now() - 60 * 1000) } })
  await prisma.store.update({ where: { id: store.id }, data: { promoDemoUntil: new Date(Date.now() - 1000) } })
  const res = await request(app).get('/api/pos/promo/demo-mode').set('X-Store-Token', store.posToken)
  assert.equal(res.body.demoMode, false)
  const preview = await posPreview(store, { from: kstDate(-7), to: kstDate(0) })
  assert.equal(preview.body.eligible, 0)
})

testSerial('시연 모드: 수신거부·미동의는 시연 모드에서도 빠진다', async () => {
  const store = await createStore('demo-guard')
  await visit(store, { phone: '01022220011', daysAgo: 2 })
  await visit(store, { phone: '01022220012', daysAgo: 2, marketing: false })
  await posOptOut(store, '01022220011')
  await prisma.store.update({ where: { id: store.id }, data: { promoDemoUntil: new Date(Date.now() + 3600 * 1000) } })
  const res = await posPreview(store, { from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.body.eligible, 0)
  assert.equal(res.body.excluded.optedOut, 1)
  assert.equal(res.body.excluded.noConsent, 1)
})

testSerial('시연 모드: 잘못된 값은 400, 토큰 없으면 401, 매장 관리자는 켤 수 없고 자기 매장만 끈다', async () => {
  const store = await createStore('demo-auth')
  const other = await createStore('demo-auth-other')
  assert.equal((await request(app).post('/api/pos/promo/demo-mode').set('X-Store-Token', store.posToken).send({ enabled: 'yes' })).status, 400)
  assert.equal((await request(app).post('/api/pos/promo/demo-mode').send({ enabled: true })).status, 401)

  const { token } = await adminToken('store_admin', store)
  const denied = await request(app).post('/api/admin/promo-demo-mode').set('Authorization', `Bearer ${token}`).send({ storeId: store.id, enabled: true })
  assert.equal(denied.status, 403, JSON.stringify(denied.body))
  assert.equal((await prisma.store.findUnique({ where: { id: store.id } })).promoDemoUntil, null)

  const soon = new Date(Date.now() + 3600 * 1000)
  await prisma.store.update({ where: { id: store.id }, data: { promoDemoUntil: soon } })
  await prisma.store.update({ where: { id: other.id }, data: { promoDemoUntil: soon } })
  // storeId에 다른 매장을 넣어도 매장 관리자는 자기 매장만 바뀐다
  const off = await request(app).post('/api/admin/promo-demo-mode').set('Authorization', `Bearer ${token}`).send({ storeId: other.id, enabled: false })
  assert.equal(off.status, 200, JSON.stringify(off.body))
  assert.equal((await prisma.store.findUnique({ where: { id: store.id } })).promoDemoUntil, null)
  assert.ok((await prisma.store.findUnique({ where: { id: other.id } })).promoDemoUntil)
  assert.equal((await request(app).post('/api/admin/promo-demo-mode').send({ storeId: store.id, enabled: true })).status, 401)
})

// --- 미리보기: 방문자 전체 목록(rows) ---------------------------------------------------

// 최근 방문순으로 0001(보낼 수 있음) 0002(보낼 수 있음) 0003(미동의) 0004(수신거부) 0005(10일 전 발송).
async function seedPromoRows(store) {
  await visit(store, { phone: '01011110001', carNumber: '11가1111', daysAgo: 1 })
  await visit(store, { phone: '01011110002', carNumber: '22나2222', daysAgo: 2 })
  await visit(store, { phone: '01011110003', carNumber: '33다3333', daysAgo: 3, marketing: false })
  await visit(store, { phone: '01011110004', carNumber: '44라4444', daysAgo: 4 })
  const optOut = await posOptOut(store, '01011110004')
  assert.equal(optOut.status, 200, JSON.stringify(optOut.body))
  await visit(store, { phone: '01011110005', carNumber: '55마5555', daysAgo: 5 })
  const sentAt = new Date(Date.now() - 10 * DAY)
  await prisma.promoSend.create({ data: { storeId: store.id, phone: '01011110005', carNumber: '55마5555', sentAt } })
  return { sentAt }
}

testSerial('미리보기 rows: 기간 안 방문자 전부를 상태와 함께 최근 방문순으로, 전체 번호 형식으로 준다', async () => {
  const store = await createStore('rows')
  const { token } = await adminToken('hq_admin')
  const { sentAt } = await seedPromoRows(store)

  const res = await preview(token, { storeId: store.id, from: kstDate(-10), to: kstDate(0) })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.filterCounts, { all: 5, eligible: 2, excluded: 3 })
  assert.equal(res.body.rowsTotal, 5)
  assert.equal(res.body.hasMore, false)
  assert.deepEqual(
    res.body.rows.map((r) => [r.phone, r.status]),
    [
      ['010-1111-0001', 'ok'],
      ['010-1111-0002', 'ok'],
      ['010-1111-0003', 'no_consent'],
      ['010-1111-0004', 'opted_out'],
      ['010-1111-0005', 'recently_sent'],
    ]
  )
  assert.equal(res.body.rows[0].carNumber, '11가1111')
  assert.ok(res.body.rows[0].lastVisitAt)
  assert.equal(res.body.rows[0].lastSentAt, null)
  assert.equal(new Date(res.body.rows[4].lastSentAt).getTime(), sentAt.getTime())
  assert.equal(JSON.stringify(res.body).includes('01011110001'), false) // 하이픈 없는 원문은 내려가지 않는다

  // 기존 필드는 그대로다 -- 관리자 웹이 쓴다.
  assert.equal(res.body.visitors, 5)
  assert.equal(res.body.eligible, 2)
  assert.equal(res.body.sample.length, 2)
  assert.equal(res.body.sample[0].phoneMasked, '010-****-0001')
})

testSerial('미리보기 rows: filter=eligible은 보낼 수 있는 사람만, excluded는 나머지만 주고 filterCounts는 그대로다', async () => {
  const store = await createStore('rows-filter')
  const { token } = await adminToken('hq_admin')
  await seedPromoRows(store)
  const period = { storeId: store.id, from: kstDate(-10), to: kstDate(0) }

  const eligible = await preview(token, { ...period, filter: 'eligible' })
  assert.equal(eligible.status, 200, JSON.stringify(eligible.body))
  assert.deepEqual(eligible.body.rows.map((r) => r.phone), ['010-1111-0001', '010-1111-0002'])
  assert.ok(eligible.body.rows.every((r) => r.status === 'ok'))
  assert.equal(eligible.body.rowsTotal, 2)
  assert.equal(eligible.body.hasMore, false)
  assert.deepEqual(eligible.body.filterCounts, { all: 5, eligible: 2, excluded: 3 })

  const excluded = await preview(token, { ...period, filter: 'excluded' })
  assert.deepEqual(excluded.body.rows.map((r) => [r.phone, r.status]), [
    ['010-1111-0003', 'no_consent'],
    ['010-1111-0004', 'opted_out'],
    ['010-1111-0005', 'recently_sent'],
  ])
  assert.equal(excluded.body.rowsTotal, 3)
  assert.equal(excluded.body.hasMore, false)
  assert.deepEqual(excluded.body.filterCounts, { all: 5, eligible: 2, excluded: 3 })
})

testSerial('미리보기 rows: limit·offset으로 쪼개 받으면 겹침·누락 없이 이어지고 hasMore가 마지막 쪽에서 꺼진다', async () => {
  const store = await createStore('rows-paging')
  const { token } = await adminToken('hq_admin')
  await seedPromoRows(store)
  const period = { storeId: store.id, from: kstDate(-10), to: kstDate(0) }

  const first = await preview(token, { ...period, limit: 2, offset: 0 })
  assert.equal(first.body.rows.length, 2)
  assert.equal(first.body.rowsTotal, 5)
  assert.equal(first.body.hasMore, true)

  const middle = await preview(token, { ...period, limit: 2, offset: 2 })
  assert.equal(middle.body.rows.length, 2)
  assert.equal(middle.body.hasMore, true)

  const last = await preview(token, { ...period, limit: 2, offset: 4 })
  assert.equal(last.body.rows.length, 1)
  assert.equal(last.body.hasMore, false)

  const phones = [...first.body.rows, ...middle.body.rows, ...last.body.rows].map((r) => r.phone)
  assert.deepEqual(phones, ['010-1111-0001', '010-1111-0002', '010-1111-0003', '010-1111-0004', '010-1111-0005'])

  const beyond = await preview(token, { ...period, limit: 2, offset: 50 })
  assert.deepEqual(beyond.body.rows, [])
  assert.equal(beyond.body.rowsTotal, 5)
  assert.equal(beyond.body.hasMore, false)

  // filter와 함께 쓰면 filter를 건 뒤의 목록을 쪼갠다
  const filtered = await preview(token, { ...period, filter: 'excluded', limit: 2, offset: 2 })
  assert.deepEqual(filtered.body.rows.map((r) => r.phone), ['010-1111-0005'])
  assert.equal(filtered.body.rowsTotal, 3)
  assert.equal(filtered.body.hasMore, false)
})

testSerial('미리보기 rows: 잘못된 filter·limit·offset은 기본값으로 바로잡고 limit은 500까지만 허용한다', async () => {
  const store = await createStore('rows-sanitize')
  const { token } = await adminToken('hq_admin')
  await seedPromoRows(store)
  const period = { storeId: store.id, from: kstDate(-10), to: kstDate(0) }

  const bad = await preview(token, { ...period, filter: 'everything', limit: 'abc', offset: '-3' })
  assert.equal(bad.status, 200, JSON.stringify(bad.body))
  assert.equal(bad.body.rows.length, 5) // filter는 all, limit은 100, offset은 0
  assert.equal(bad.body.rows[0].phone, '010-1111-0001')
  assert.equal(bad.body.rowsTotal, 5)

  const fractional = await preview(token, { ...period, limit: '2.5', offset: '1.5' })
  assert.equal(fractional.body.rows.length, 2) // limit은 소수점을 버리고, 정수가 아닌 offset은 0
  assert.equal(fractional.body.rows[0].phone, '010-1111-0001')

  const zero = await preview(token, { ...period, limit: 0 })
  assert.equal(zero.body.rows.length, 1) // 1 미만은 1로

  const huge = await preview(token, { ...period, limit: 99999 })
  assert.equal(huge.body.rows.length, 5)
  assert.equal(huge.body.hasMore, false)
})

testSerial('미리보기 rows: 기간 안 방문자가 없으면 빈 목록이다', async () => {
  const store = await createStore('rows-empty')
  const { token } = await adminToken('hq_admin')
  await visit(store, { phone: '01011110001', daysAgo: 40 }) // 기간 밖
  const res = await preview(token, { storeId: store.id, from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.filterCounts, { all: 0, eligible: 0, excluded: 0 })
  assert.deepEqual(res.body.rows, [])
  assert.equal(res.body.rowsTotal, 0)
  assert.equal(res.body.hasMore, false)
})

testSerial('탭앱 미리보기도 rows를 주고, 다른 매장 방문자는 섞이지 않는다', async () => {
  const store = await createStore('pos-rows')
  const other = await createStore('pos-rows-other')
  await seedPromoRows(store)
  await visit(other, { phone: '01099990001', daysAgo: 1 })

  const res = await posPreview(store, { from: kstDate(-10), to: kstDate(0), filter: 'excluded', limit: 2 })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.filterCounts, { all: 5, eligible: 2, excluded: 3 })
  assert.deepEqual(res.body.rows.map((r) => [r.phone, r.status]), [
    ['010-1111-0003', 'no_consent'],
    ['010-1111-0004', 'opted_out'],
  ])
  assert.equal(res.body.rowsTotal, 3)
  assert.equal(res.body.hasMore, true)
  assert.equal(res.body.sample.length, 2) // 가린 번호 sample은 그대로
})

// --- 홍보 목록 [삭제]와 정비 이력 삭제 반영 -------------------------------------------------

testSerial('홍보 목록 삭제: 지운 번호는 목록·방문 수에서 빠지고 차량별 발송도 막힌다', async () => {
  const store = await createStore('promo-exclude')
  await visit(store, { phone: '01031310001', carNumber: '31가3131', daysAgo: 2 })
  await visit(store, { phone: '01031310002', carNumber: '32가3232', daysAgo: 3 })
  const before = await posPreview(store, { from: kstDate(-7), to: kstDate(0) })
  assert.equal(before.body.filterCounts.all, 2)

  const del = await request(app).post('/api/pos/promo/exclude').set('X-Store-Token', store.posToken).send({ phone: '010-3131-0001' })
  assert.equal(del.status, 200, JSON.stringify(del.body))
  const after = await posPreview(store, { from: kstDate(-7), to: kstDate(0) })
  assert.equal(after.body.filterCounts.all, 1)
  assert.equal(after.body.visitors, 1)
  assert.equal(after.body.rows.some((r) => r.phone === '010-3131-0001'), false)

  const el = await request(app).get('/api/pos/promo/eligibility?carNumber=' + encodeURIComponent('31가3131')).set('X-Store-Token', store.posToken)
  assert.equal(el.body.canSend, false)
  assert.equal(el.body.reason, 'staff_excluded')
  assert.equal((await request(app).post('/api/pos/promo/exclude').set('X-Store-Token', store.posToken).send({ phone: '12' })).status, 400)
  assert.equal((await request(app).post('/api/pos/promo/exclude').send({ phone: '01031310001' })).status, 401)
})

testSerial('정비 이력에서 삭제한 방문은 홍보 목록의 방문으로 세지 않는다', async () => {
  const store = await createStore('promo-hist-deleted')
  const r = await visit(store, { phone: '01032320001', carNumber: '33가3333', daysAgo: 2 })
  assert.equal((await posPreview(store, { from: kstDate(-7), to: kstDate(0) })).body.filterCounts.all, 1)
  const del = await request(app).post('/api/pos/history/delete').set('X-Store-Token', store.posToken).send({ reservationId: r.id })
  assert.equal(del.status, 200, JSON.stringify(del.body))
  assert.equal((await posPreview(store, { from: kstDate(-7), to: kstDate(0) })).body.filterCounts.all, 0)
})

testSerial('정비 이력 삭제: 지운 마지막 방문이 광고 거부였다면 옛 동의가 되살아나지 않는다', async () => {
  const store = await createStore('promo-hist-consent')
  await visit(store, { phone: '01033330001', carNumber: '34가3434', daysAgo: 5, marketing: true })
  const latest = await visit(store, { phone: '01033330001', carNumber: '34가3434', daysAgo: 1, marketing: false })
  await request(app).post('/api/pos/history/delete').set('X-Store-Token', store.posToken).send({ reservationId: latest.id })
  const res = await posPreview(store, { from: kstDate(-7), to: kstDate(0) })
  assert.equal(res.body.filterCounts.eligible, 0)
  assert.equal(res.body.rows[0].status, 'no_consent')
})
