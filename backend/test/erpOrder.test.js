// 쉐보레 전산(ERP) -> 우리 -> 토스 POS 주문 연동 테스트 (ERP_CONTRACT_V1 §6).
// api.test.js와 같은 컨벤션(node:test, supertest, testSerial, 한국어 테스트명)을 따르되,
// 이 파일 하나만 소유한다 -- api.test.js는 절대 건드리지 않는다.
//
// ⚠️ package.json의 test 스크립트에 붙은 `--test-concurrency=1`을 절대 지우지 말 것.
// node --test는 기본적으로 테스트 "파일"들을 병렬로 돌리는데, 이 파일과 api.test.js는 둘 다
// 같은 로컬 devdb에 대고 beforeEach마다 TRUNCATE ... CASCADE로 전체를 비운다. 병렬로 돌면 한 파일의
// 리셋이 다른 파일이 방금 만든 로우를 지워버려서 404/401/FK 위반이 무작위로 터진다(실제로 병렬
// 실행 시 54개 중 23개 실패를 재현했다). 테스트 파일이 하나뿐이던 시절엔 드러나지 않던 문제이며,
// 파일이 둘 이상이 된 지금은 직렬 실행이 필수다. 근본 해결(파일별 스키마 분리 등)을 하기 전까지는
// 이 플래그가 유일한 방어선이다.
//
// ⚠️ 계약서 §6 원문은 chargePrice를 "합계와 같은 숫자"처럼 서술하지만, 실제 구현
// (backend/src/tossOrderClient.js)과 실호출 검증(scripts/verify-toss-order.js)으로 확정된 스펙은
// 다음과 같이 다르다 -- 이 파일은 계약서 원문이 아니라 실제 구현을 기준으로 검증한다:
//   - diningOption은 'HERE'다('FOR_HERE' 아님)
//   - item.category는 필수 객체 { title }다(기본값 '정비')
//   - itemPrice.title도 필수다('기본')
//   - chargePrice는 숫자가 아니라 객체이며, taxAmount = round(total/11), supplyAmount = total - taxAmount

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
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

// ERP 연동 관련 환경변수 -- server.js를 require하기 전에 미리 세팅해둔다. ERP_API_TOKEN은
// requireErpToken이 요청마다 process.env에서 읽으므로 테스트 중간에 지웠다 되돌리는 식으로도
// 쓸 수 있다(§6 "토큰 없음 → 503" 케이스).
const ERP_TOKEN = 'test-erp-shared-token-0000'
process.env.ERP_API_TOKEN = ERP_TOKEN
// 목 서버 주소는 아래 before()에서 실제 포트를 알고 난 뒤 채워 넣는다.
process.env.TOSS_OPENAPI_ACCESS_KEY = 'test-access-key'
process.env.TOSS_OPENAPI_SECRET_KEY = 'test-secret-key'

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
  // ErpOrder를 TRUNCATE 목록에 포함해야 한다(§6) -- FK가 Store를 참조하므로 Store보다 먼저(혹은
  // CASCADE로) 지워야 한다. TRUNCATE ... CASCADE라 순서는 문제되지 않는다.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ErpOrder", "RateLimitHit", "WebhookEvent", "Payment", "Reservation", "QueueCounter", "AdminUser", "Store" RESTART IDENTITY CASCADE'
  )
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

function authHeader(admin) {
  return `Bearer ${signAdminToken(admin)}`
}

// --- 로컬 목 토스 서버 (node:http, 포트 0) ---
// tossOrderClient.js는 TOSS_OPENAPI_BASE_URL을 호출 시점에 process.env에서 읽으므로, 이 목 서버를
// 한 번만 띄우고 주소를 그 환경변수에 고정해두면 모든 테스트가 이 서버로 요청을 보낸다.
const MOCK_TOSS_ERROR_TEXT = '내부전용-토스-원본에러-절대노출금지-CHARGE_PRICE_INVALID'

let mockToss
function startMockTossServer() {
  const state = { calls: [], mode: 'success', counter: 0 }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw) } catch { body = null }
      state.calls.push({ url: req.url, headers: req.headers, body })

      if (state.mode === 'fail') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: MOCK_TOSS_ERROR_TEXT }))
        return
      }
      state.counter += 1
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ order: { id: `mock-toss-order-${state.counter}` } }))
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }))
  })
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`
  mockToss = await startMockTossServer()
  process.env.TOSS_OPENAPI_BASE_URL = `http://127.0.0.1:${mockToss.port}`
  await resetDatabase()
})

beforeEach(async () => {
  await resetDatabase()
  mockToss.state.calls.length = 0
  mockToss.state.mode = 'success'
  mockToss.state.counter = 0
})

after(async () => {
  await prisma.$disconnect()
  await new Promise((resolve) => mockToss.server.close(resolve))
})

// 유효한 기본 요청 바디를 만든다. items 합계와 totalAmount를 항상 일치시켜둔다.
function validBody(store, overrides = {}) {
  return {
    storeCode: store.erpStoreCode,
    referenceId: unique('ERP-REF'),
    items: [{ productId: 'P-10021', name: '엔진오일 5W30', unitPrice: 45000, quantity: 2 }],
    totalAmount: 90000,
    memo: '김OO / 12가3456',
    ...overrides,
  }
}

function postDraftOrder(body, token = ERP_TOKEN) {
  const req = request(app).post('/api/erp/draft-orders')
  if (token !== null) req.set('X-ERP-Token', token)
  return req.send(body)
}

// --- 인증 (§6) ---

testSerial('X-ERP-Token: ERP_API_TOKEN이 설정되지 않은 환경에서는 503을 반환한다', async () => {
  const store = await createStore('auth-503')
  const saved = process.env.ERP_API_TOKEN
  delete process.env.ERP_API_TOKEN
  try {
    const res = await postDraftOrder(validBody(store))
    assert.equal(res.status, 503)
    assert.equal(res.body.ok, false)
  } finally {
    process.env.ERP_API_TOKEN = saved
  }
})

testSerial('X-ERP-Token: 헤더 없이 요청하면 401을 반환한다', async () => {
  const store = await createStore('auth-missing')
  const res = await postDraftOrder(validBody(store), null)
  assert.equal(res.status, 401)
  assert.equal(res.body.ok, false)
})

testSerial('X-ERP-Token: 틀린 토큰이면 401을 반환한다', async () => {
  const store = await createStore('auth-wrong')
  const res = await postDraftOrder(validBody(store), 'wrong-token-value')
  assert.equal(res.status, 401)
})

testSerial('X-ERP-Token: 올바른 토큰이면 인증을 통과해 201까지 진행된다', async () => {
  const store = await createStore('auth-ok')
  const res = await postDraftOrder(validBody(store))
  assert.equal(res.status, 201)
  assert.equal(res.body.ok, true)
})

// --- 검증 (§4.2, §6) ---

testSerial('totalAmount가 항목 합계와 일치하지 않으면 400을 반환한다', async () => {
  const store = await createStore('validate-total')
  const res = await postDraftOrder(validBody(store, { totalAmount: 90001 }))
  assert.equal(res.status, 400)
  assert.match(res.body.error, /totalAmount/)
})

testSerial('items가 빈 배열이면 400을 반환한다', async () => {
  const store = await createStore('validate-empty-items')
  const res = await postDraftOrder(validBody(store, { items: [], totalAmount: 0 }))
  assert.equal(res.status, 400)
})

testSerial('quantity가 0이면 400을 반환한다', async () => {
  const store = await createStore('validate-qty-zero')
  const res = await postDraftOrder(
    validBody(store, {
      items: [{ name: '엔진오일', unitPrice: 45000, quantity: 0 }],
      totalAmount: 0,
    })
  )
  assert.equal(res.status, 400)
})

testSerial('unitPrice가 정수가 아니면(소수) 400을 반환한다', async () => {
  const store = await createStore('validate-unitprice-float')
  const res = await postDraftOrder(
    validBody(store, {
      items: [{ name: '엔진오일', unitPrice: 1000.5, quantity: 1 }],
      totalAmount: 1000.5,
    })
  )
  assert.equal(res.status, 400)
})

testSerial('unitPrice가 상한(100,000,000)을 초과하면 400을 반환한다', async () => {
  const store = await createStore('validate-unitprice-overlimit')
  const res = await postDraftOrder(
    validBody(store, {
      items: [{ name: '고가부품', unitPrice: 100000001, quantity: 1 }],
      totalAmount: 100000001,
    })
  )
  assert.equal(res.status, 400)
})

testSerial('quantity가 상한(10,000)을 초과하면 400을 반환한다', async () => {
  const store = await createStore('validate-qty-overlimit')
  const res = await postDraftOrder(
    validBody(store, {
      items: [{ name: '소모품', unitPrice: 100, quantity: 10001 }],
      totalAmount: 1000100,
    })
  )
  assert.equal(res.status, 400)
})

testSerial('totalAmount가 상한(1,000,000,000)을 초과하면 400을 반환한다', async () => {
  const store = await createStore('validate-total-overlimit')
  const res = await postDraftOrder(
    validBody(store, {
      items: [{ name: '고가정비', unitPrice: 100000000, quantity: 11 }],
      totalAmount: 1100000000,
    })
  )
  assert.equal(res.status, 400)
})

testSerial('등록되지 않은 storeCode면 404를 반환한다', async () => {
  const store = await createStore('validate-unknown-store')
  const res = await postDraftOrder(validBody(store, { storeCode: 'NO-SUCH-STORE-CODE-XYZ' }))
  assert.equal(res.status, 404)
})

testSerial('비활성화된(status !== active) 매장이면 403을 반환한다', async () => {
  const store = await createStore('validate-inactive-store', { status: 'inactive' })
  const res = await postDraftOrder(validBody(store))
  assert.equal(res.status, 403)
})

// --- 정상 생성 + 토스 요청 바디 계약 (§0, §3, §6) ---

testSerial('정상 생성: 201 + ErpOrder 저장 + 목 서버가 받은 body가 확정된 토스 스펙을 정확히 따른다', async () => {
  const store = await createStore('happy-path')
  const body = validBody(store, {
    items: [{ productId: 'P-10021', name: '엔진오일 5W30', unitPrice: 45000, quantity: 2 }],
    totalAmount: 90000,
  })

  const res = await postDraftOrder(body)
  assert.equal(res.status, 201)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.referenceId, body.referenceId)
  assert.equal(res.body.status, 'OPENED')
  assert.ok(res.body.tossOrderId)

  const stored = await prisma.erpOrder.findUnique({ where: { referenceId: body.referenceId } })
  assert.ok(stored)
  assert.equal(stored.status, 'created')
  assert.equal(stored.storeId, store.id)
  assert.equal(stored.totalAmount, 90000)
  assert.equal(stored.tossOrderKey, `erp-${body.referenceId}`)
  assert.equal(stored.tossOrderId, res.body.tossOrderId)

  // 목 서버가 실제로 정확히 한 번 호출됐는지, 그리고 그 body가 확정 스펙과 일치하는지 검사한다
  // -- 이번 연동의 핵심 계약이므로 반드시 확인한다.
  assert.equal(mockToss.state.calls.length, 1)
  const sentBody = mockToss.state.calls[0].body
  assert.deepEqual(sentBody.payments, [])
  assert.equal(sentBody.order.orderKey, `erp-${body.referenceId}`)

  const lineItem = sentBody.order.lineItems[0]
  assert.equal(lineItem.targetType, 'AD_HOC')
  assert.equal(lineItem.diningOption, 'HERE')
  assert.ok(lineItem.item.category && lineItem.item.category.title)
  assert.ok(lineItem.itemPrice.title)
  assert.equal(lineItem.itemPrice.title, '기본')
  assert.equal(lineItem.quantity, 2)
  assert.equal(lineItem.itemPrice.priceValue, 45000)

  // chargePrice는 숫자가 아니라 객체다 -- totalAmount와 부가세 역산(taxAmount = round(total/11),
  // supplyAmount = total - taxAmount) 규칙을 그대로 검사한다.
  const chargePrice = sentBody.order.chargePrice
  assert.equal(typeof chargePrice, 'object')
  assert.equal(chargePrice.totalAmount, 90000)
  const expectedTax = Math.round(90000 / 11)
  assert.equal(chargePrice.taxAmount, expectedTax)
  assert.equal(chargePrice.supplyAmount, 90000 - expectedTax)
})

// --- 멱등 (§4.2-2, §6) ---

testSerial('멱등: 같은 referenceId로 두 번 호출하면 두 번째는 duplicate:true이고 목 서버는 1회만 호출된다', async () => {
  const store = await createStore('idempotent')
  const body = validBody(store)

  const first = await postDraftOrder(body)
  assert.equal(first.status, 201)
  assert.equal(mockToss.state.calls.length, 1)

  const second = await postDraftOrder(body)
  assert.equal(second.status, 200)
  assert.equal(second.body.ok, true)
  assert.equal(second.body.duplicate, true)
  assert.equal(second.body.tossOrderId, first.body.tossOrderId)
  assert.equal(mockToss.state.calls.length, 1) // 토스가 다시 호출되지 않아야 한다.

  const count = await prisma.erpOrder.count({ where: { referenceId: body.referenceId } })
  assert.equal(count, 1)
})

// --- 토스 실패 (§4.2-4, §6) ---

testSerial('토스 실패: 목 서버가 400을 주면 502를 반환하고 ErpOrder가 failed로 저장되며 토스 원본 에러가 응답에 새지 않는다', async () => {
  const store = await createStore('toss-fail')
  const body = validBody(store)
  mockToss.state.mode = 'fail'

  const res = await postDraftOrder(body)
  assert.equal(res.status, 502)
  assert.equal(res.body.ok, false)
  assert.ok(!JSON.stringify(res.body).includes(MOCK_TOSS_ERROR_TEXT))
  assert.equal(res.body.referenceId, body.referenceId)

  const stored = await prisma.erpOrder.findUnique({ where: { referenceId: body.referenceId } })
  assert.ok(stored)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.tossOrderId, null)
  assert.ok(stored.errorMessage)
  assert.ok(stored.tossRawJson && stored.tossRawJson.includes(MOCK_TOSS_ERROR_TEXT)) // 감사용 로그에는 원본을 남겨둔다.
})

// --- 재시도 (§4.2-2, §6) ---

testSerial('재시도: failed 이후 같은 referenceId로 재호출하면 다시 토스를 호출해 성공 시 created로 갱신된다', async () => {
  const store = await createStore('toss-retry')
  const body = validBody(store)

  mockToss.state.mode = 'fail'
  const failedRes = await postDraftOrder(body)
  assert.equal(failedRes.status, 502)
  assert.equal(mockToss.state.calls.length, 1)

  mockToss.state.mode = 'success'
  const retryRes = await postDraftOrder(body)
  assert.equal(retryRes.status, 201)
  assert.equal(retryRes.body.status, 'OPENED')
  assert.equal(mockToss.state.calls.length, 2) // 재시도이므로 목 서버가 다시 호출돼야 한다.

  const stored = await prisma.erpOrder.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.status, 'created')
  assert.ok(stored.tossOrderId)
  assert.equal(stored.tossOrderKey, `erp-${body.referenceId}`) // 재시도해도 orderKey는 동일해야 한다.
})

// --- 조회 API (§4.3, §6) ---

testSerial('조회: 존재하지 않는 referenceId는 404를 반환한다', async () => {
  const res = await request(app)
    .get(`/api/erp/draft-orders/${unique('no-such-ref')}`)
    .set('X-ERP-Token', ERP_TOKEN)
  assert.equal(res.status, 404)
})

testSerial('조회: 존재하는 referenceId는 200과 함께 기대한 필드를 반환한다', async () => {
  const store = await createStore('lookup-ok')
  const body = validBody(store)
  const created = await postDraftOrder(body)
  assert.equal(created.status, 201)

  const res = await request(app)
    .get(`/api/erp/draft-orders/${body.referenceId}`)
    .set('X-ERP-Token', ERP_TOKEN)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.referenceId, body.referenceId)
  assert.equal(res.body.tossOrderId, created.body.tossOrderId)
  // 주의: 조회 응답의 status는 ErpOrder 내부 상태값(created/failed/paid)이며, POST 응답의
  // status:'OPENED'(토스 쪽 주문 상태 표현)와는 다른 값이다.
  assert.equal(res.body.status, 'created')
  assert.equal(res.body.totalAmount, 90000)
  assert.ok(res.body.createdAt)
  assert.equal(res.body.paidAt, null)
})

// --- 관리자 erp-code 등록 (§4.4, §6) ---

testSerial('관리자 erp-code: 형식(영문/숫자/-/_ 외 문자)을 위반하면 400을 반환한다', async () => {
  const store = await createStore('admin-code-badformat')
  const admin = await createHqAdmin()
  const res = await request(app)
    .post(`/api/admin/stores/${store.id}/erp-code`)
    .set('Authorization', authHeader(admin))
    .send({ erpStoreCode: '잘못된 코드 !!' })
  assert.equal(res.status, 400)
})

testSerial('관리자 erp-code: 다른 매장이 이미 쓰는 코드면 409를 반환한다', async () => {
  const taken = await createStore('admin-code-taken', { erpStoreCode: 'CHEV-DUP-001' })
  const target = await createStore('admin-code-target')
  const admin = await createHqAdmin()
  const res = await request(app)
    .post(`/api/admin/stores/${target.id}/erp-code`)
    .set('Authorization', authHeader(admin))
    .send({ erpStoreCode: taken.erpStoreCode })
  assert.equal(res.status, 409)
})

testSerial('관리자 erp-code: 정상 등록은 200과 함께 erpStoreCode를 반환한다', async () => {
  const store = await createStore('admin-code-ok', { erpStoreCode: null })
  const admin = await createHqAdmin()
  const res = await request(app)
    .post(`/api/admin/stores/${store.id}/erp-code`)
    .set('Authorization', authHeader(admin))
    .send({ erpStoreCode: 'CHEV-UJB-001' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.storeId, store.id)
  assert.equal(res.body.erpStoreCode, 'CHEV-UJB-001')

  const stored = await prisma.store.findUnique({ where: { id: store.id } })
  assert.equal(stored.erpStoreCode, 'CHEV-UJB-001')
})

testSerial('관리자 erp-code: 빈 문자열을 보내면 코드가 해제(null)된다', async () => {
  const store = await createStore('admin-code-clear', { erpStoreCode: 'CHEV-CLEAR-001' })
  const admin = await createHqAdmin()
  const res = await request(app)
    .post(`/api/admin/stores/${store.id}/erp-code`)
    .set('Authorization', authHeader(admin))
    .send({ erpStoreCode: '' })
  assert.equal(res.status, 200)
  assert.equal(res.body.erpStoreCode, null)

  const stored = await prisma.store.findUnique({ where: { id: store.id } })
  assert.equal(stored.erpStoreCode, null)
})
