// 쉐보레 전산(ERP) "물건 담기" -> POS 플러그인 장바구니 중계 테스트 (POS-CART-BRIDGE §1).
// erpOrder.test.js와 같은 컨벤션(node:test, supertest, testSerial, 한국어 테스트명)을 따르되,
// 이 파일 하나만 소유한다 -- api.test.js/erpOrder.test.js는 절대 건드리지 않는다.
//
// ⚠️ package.json의 test 스크립트에 붙은 `--test-concurrency=1`을 절대 지우지 말 것. 이 파일도
// 다른 테스트 파일들과 같은 로컬 devdb를 beforeEach마다 TRUNCATE ... CASCADE로 비우기 때문에
// 병렬 실행 시 다른 파일의 로우를 지워버릴 수 있다(erpOrder.test.js 상단 주석 참고).
//
// 이 파일이 검증하는 경로는 /api/erp/draft-orders(토스 Open API로 주문 자체를 생성)와는
// 완전히 별개다 -- ErpCart는 토스와 아무것도 통신하지 않는, 전산 -> POS 플러그인 사이의 순수한
// 중계 큐다.

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

// ERP 연동 관련 환경변수 -- server.js를 require하기 전에 미리 세팅해둔다. 이 파일은 토스를
// 전혀 호출하지 않지만(ErpCart 라우트는 토스 API와 무관), server.js 모듈이 로드되는 시점에
// tossOrderClient 관련 설정이 없어도 부팅에는 지장이 없으므로 최소한만 채운다.
const ERP_TOKEN = 'test-erp-cart-shared-token-0000'
process.env.ERP_API_TOKEN = ERP_TOKEN

const { hashPassword, signAdminToken } = require('../src/auth')
const { prisma } = require('../src/store')
const { app } = require('../server')

const testSerial = (name, fn) => test(name, { concurrency: false }, fn)

let sequence = 0
function unique(prefix) {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

async function resetDatabase() {
  // ErpCart를 TRUNCATE 목록에 포함해야 한다 -- FK가 Store를 참조하므로 CASCADE로 함께 지운다.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ErpCart", "ErpOrder", "RateLimitHit", "WebhookEvent", "Payment", "Reservation", "QueueCounter", "AdminUser", "Store" RESTART IDENTITY CASCADE'
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

// 본사 관리자 토큰. erpOrder.test.js와 같은 방식(직접 서명)으로 만든다 -- 로그인 API를 거치면
// 레이트리밋(adminLoginLimiter)에 걸려 테스트가 순서에 따라 불안정해진다.
async function hqToken() {
  const admin = await prisma.adminUser.create({
    data: {
      email: `${unique('hq')}@example.test`,
      passwordHash: await hashPassword('test-password-123'),
      role: 'hq_admin',
      storeId: null,
    },
  })
  return signAdminToken(admin)
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

// 유효한 기본 요청 바디를 만든다. items 합계와 totalAmount를 항상 일치시켜둔다.
function validBody(store, overrides = {}) {
  return {
    storeCode: store.erpStoreCode,
    referenceId: unique('ERP-CART-REF'),
    items: [{ productId: 'P-1001', name: '엔진오일 5W30 (4L)', category: '부품', unitPrice: 45000, quantity: 1 }],
    totalAmount: 45000,
    memo: '12가3456 김민준님',
    ...overrides,
  }
}

function postCart(body, token = ERP_TOKEN) {
  const req = request(app).post('/api/erp/carts')
  if (token !== null) req.set('X-ERP-Token', token)
  return req.send(body)
}

function getCart(referenceId, token = ERP_TOKEN) {
  const req = request(app).get(`/api/erp/carts/${referenceId}`)
  if (token !== null) req.set('X-ERP-Token', token)
  return req
}

function cancelCart(referenceId, token = ERP_TOKEN) {
  const req = request(app).post(`/api/erp/carts/${referenceId}/cancel`)
  if (token !== null) req.set('X-ERP-Token', token)
  return req
}

function getPosCarts(store) {
  return request(app).get('/api/pos/erp-carts').set('X-Store-Token', store.posToken)
}

function consumeCart(store, cartId, body) {
  return request(app).post(`/api/pos/erp-carts/${cartId}/consume`).set('X-Store-Token', store.posToken).send(body)
}

// --- 인증 (전산 측: X-ERP-Token) ---

testSerial('X-ERP-Token: 헤더 없이 요청하면 401을 반환한다', async () => {
  const store = await createStore('auth-missing')
  const res = await postCart(validBody(store), null)
  assert.equal(res.status, 401)
  assert.equal(res.body.ok, false)
})

testSerial('X-ERP-Token: 틀린 토큰이면 401을 반환한다', async () => {
  const store = await createStore('auth-wrong')
  const res = await postCart(validBody(store), 'wrong-token-value')
  assert.equal(res.status, 401)
})

// --- 인증 (POS 측: X-Store-Token) ---

testSerial('X-Store-Token: 헤더 없이 요청하면 401을 반환한다', async () => {
  const res = await request(app).get('/api/pos/erp-carts')
  assert.equal(res.status, 401)
  assert.equal(res.body.ok, false)
})

testSerial('X-Store-Token: 틀린 토큰이면 401을 반환한다', async () => {
  const res = await request(app).get('/api/pos/erp-carts').set('X-Store-Token', 'wrong-store-token')
  assert.equal(res.status, 401)
})

// --- 생성 (POST /api/erp/carts) ---

testSerial('생성 성공: 201을 반환하고 status는 pending이다', async () => {
  const store = await createStore('create-ok')
  const res = await postCart(validBody(store))
  assert.equal(res.status, 201)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.status, 'pending')
  assert.ok(res.body.cartId)

  const stored = await prisma.erpCart.findUnique({ where: { id: res.body.cartId } })
  assert.ok(stored)
  assert.equal(stored.storeId, store.id)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.autoPay, true)
})

testSerial('생성: autoPay를 명시적으로 false로 보내면 그대로 저장된다', async () => {
  const store = await createStore('create-autopay-false')
  const res = await postCart(validBody(store, { autoPay: false }))
  assert.equal(res.status, 201)

  const stored = await prisma.erpCart.findUnique({ where: { id: res.body.cartId } })
  assert.equal(stored.autoPay, false)
})

testSerial('멱등: 같은 referenceId 재전송은 200 duplicate:true이고 DB에는 1건만 남는다', async () => {
  const store = await createStore('idempotent')
  const body = validBody(store)

  const first = await postCart(body)
  assert.equal(first.status, 201)

  const second = await postCart(body)
  assert.equal(second.status, 200)
  assert.equal(second.body.ok, true)
  assert.equal(second.body.duplicate, true)
  assert.equal(second.body.cartId, first.body.cartId)

  const count = await prisma.erpCart.count({ where: { referenceId: body.referenceId } })
  assert.equal(count, 1)
})

testSerial('검증: totalAmount가 항목 합계와 일치하지 않으면 400을 반환한다', async () => {
  const store = await createStore('validate-total')
  const res = await postCart(validBody(store, { totalAmount: 45001 }))
  assert.equal(res.status, 400)
  assert.match(res.body.error, /totalAmount/)
})

testSerial('검증: 등록되지 않은 storeCode면 404를 반환한다', async () => {
  const store = await createStore('validate-unknown-store')
  const res = await postCart(validBody(store, { storeCode: 'NO-SUCH-STORE-CODE-XYZ' }))
  assert.equal(res.status, 404)
})

testSerial('검증: 비활성화된 매장이면 403을 반환한다', async () => {
  const store = await createStore('validate-inactive', { status: 'inactive' })
  const res = await postCart(validBody(store))
  assert.equal(res.status, 403)
})

// --- 조회 (GET /api/erp/carts/:referenceId) ---

testSerial('조회: 존재하지 않는 referenceId는 404를 반환한다', async () => {
  const res = await getCart(unique('no-such-ref'))
  assert.equal(res.status, 404)
})

testSerial('조회: 존재하는 referenceId는 200과 함께 기대한 필드를 반환한다', async () => {
  const store = await createStore('lookup-ok')
  const body = validBody(store)
  const created = await postCart(body)
  assert.equal(created.status, 201)

  const res = await getCart(body.referenceId)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.referenceId, body.referenceId)
  assert.equal(res.body.status, 'pending')
  assert.equal(res.body.totalAmount, 45000)
  assert.equal(res.body.autoPay, true)
  assert.ok(res.body.createdAt)
  assert.equal(res.body.loadedAt, null)
})

// --- POS 목록 조회 (GET /api/pos/erp-carts) ---

testSerial('POS 목록: pending 건만 나오고, 다른 매장 것은 나오지 않는다', async () => {
  const storeA = await createStore('list-a')
  const storeB = await createStore('list-b')

  const bodyA = validBody(storeA)
  const created = await postCart(bodyA)
  assert.equal(created.status, 201)

  const bodyB = validBody(storeB)
  await postCart(bodyB)

  // storeA의 cart 하나를 loaded로 만들어서 pending 목록에서 빠지는지도 함께 확인한다.
  const bodyA2 = validBody(storeA)
  const created2 = await postCart(bodyA2)
  await consumeCart(storeA, created2.body.cartId, { result: 'loaded' })

  const res = await getPosCarts(storeA)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.carts.length, 1)
  assert.equal(res.body.carts[0].referenceId, bodyA.referenceId)
  assert.equal(res.body.carts[0].totalAmount, 45000)
  assert.equal(res.body.carts[0].autoPay, true)
  assert.equal(res.body.carts[0].items[0].name, '엔진오일 5W30 (4L)')
  assert.equal(res.body.carts[0].items[0].category, '부품')

  // storeB의 장바구니가 storeA 목록에 섞여 들어오면 안 된다.
  const referenceIds = res.body.carts.map((c) => c.referenceId)
  assert.ok(!referenceIds.includes(bodyB.referenceId))
})

// --- POS consume (POST /api/pos/erp-carts/:id/consume) ---

testSerial('consume loaded: status가 loaded로 바뀌고 loadedAt이 설정된다', async () => {
  const store = await createStore('consume-loaded')
  const created = await postCart(validBody(store))
  assert.equal(created.status, 201)

  const res = await consumeCart(store, created.body.cartId, { result: 'loaded' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.alreadyProcessed, false)
  assert.equal(res.body.status, 'loaded')

  const stored = await prisma.erpCart.findUnique({ where: { id: created.body.cartId } })
  assert.equal(stored.status, 'loaded')
  assert.ok(stored.loadedAt)
})

testSerial('consume 두 번: 두 번째 호출은 alreadyProcessed:true를 반환한다', async () => {
  const store = await createStore('consume-twice')
  const created = await postCart(validBody(store))

  const first = await consumeCart(store, created.body.cartId, { result: 'loaded' })
  assert.equal(first.status, 200)
  assert.equal(first.body.alreadyProcessed, false)

  const second = await consumeCart(store, created.body.cartId, { result: 'loaded' })
  assert.equal(second.status, 200)
  assert.equal(second.body.ok, true)
  assert.equal(second.body.alreadyProcessed, true)
  assert.equal(second.body.status, 'loaded')
})

testSerial('consume: 다른 매장 토큰으로 consume하면 404를 반환한다', async () => {
  const storeA = await createStore('consume-cross-a')
  const storeB = await createStore('consume-cross-b')
  const created = await postCart(validBody(storeA))

  const res = await consumeCart(storeB, created.body.cartId, { result: 'loaded' })
  assert.equal(res.status, 404)

  // storeB가 실패하도록 시도해도 storeA의 cart 상태는 그대로 pending이어야 한다.
  const stored = await prisma.erpCart.findUnique({ where: { id: created.body.cartId } })
  assert.equal(stored.status, 'pending')
})

testSerial('consume failed: status가 failed로 바뀌고 errorMessage가 저장된다', async () => {
  const store = await createStore('consume-failed')
  const created = await postCart(validBody(store))

  const res = await consumeCart(store, created.body.cartId, { result: 'failed', errorMessage: 'POS SDK addLineItem 실패' })
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'failed')

  const stored = await prisma.erpCart.findUnique({ where: { id: created.body.cartId } })
  assert.equal(stored.status, 'failed')
  assert.equal(stored.errorMessage, 'POS SDK addLineItem 실패')
})

testSerial('consume: result가 loaded/failed가 아니면 400을 반환한다', async () => {
  const store = await createStore('consume-bad-result')
  const created = await postCart(validBody(store))

  const res = await consumeCart(store, created.body.cartId, { result: 'weird' })
  assert.equal(res.status, 400)
})

// --- 취소 (POST /api/erp/carts/:referenceId/cancel) ---

testSerial('취소: pending 상태에서 취소하면 200과 status:cancelled를 반환한다', async () => {
  const store = await createStore('cancel-ok')
  const body = validBody(store)
  await postCart(body)

  const res = await cancelCart(body.referenceId)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.status, 'cancelled')

  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.status, 'cancelled')
})

testSerial('취소: loaded 상태에서 취소를 시도하면 409를 반환한다', async () => {
  const store = await createStore('cancel-loaded-conflict')
  const body = validBody(store)
  const created = await postCart(body)
  await consumeCart(store, created.body.cartId, { result: 'loaded' })

  const res = await cancelCart(body.referenceId)
  assert.equal(res.status, 409)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.status, 'loaded')
})

testSerial('취소: 존재하지 않는 referenceId는 404를 반환한다', async () => {
  const res = await cancelCart(unique('no-such-cancel-ref'))
  assert.equal(res.status, 404)
})

testSerial('재생성: cancelled 뒤 같은 referenceId로 재전송하면 새로 생성된다(duplicate 아님)', async () => {
  const store = await createStore('recreate-after-cancel')
  const body = validBody(store)
  const created = await postCart(body)
  assert.equal(created.status, 201)

  const cancelRes = await cancelCart(body.referenceId)
  assert.equal(cancelRes.status, 200)

  const recreated = await postCart(body)
  assert.equal(recreated.status, 201)
  assert.equal(recreated.body.ok, true)
  assert.notEqual(recreated.body.duplicate, true)
  // referenceId가 unique라 같은 로우를 재사용(upsert)한다 -- cartId 자체는 이전과 동일할 수
  // 있지만, 응답이 진짜 "새로 생성"(201, duplicate 아님)으로 취급되는지가 핵심이다.
  assert.equal(recreated.body.cartId, created.body.cartId)
  assert.equal(recreated.body.status, 'pending')

  const count = await prisma.erpCart.count({ where: { referenceId: body.referenceId } })
  assert.equal(count, 1) // referenceId가 unique이므로 같은 로우가 pending으로 되돌아간 것이지 새 로우가 아니다.
  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.status, 'pending')
  assert.equal(stored.id, recreated.body.cartId)
})

// --- 매장 격리: referenceId는 전역 유일이라 매장끼리 충돌할 수 있다 ---

testSerial('충돌: 다른 매장이 이미 쓴 referenceId로 보내면 409를 반환한다', async () => {
  // referenceId가 매장별이 아니라 전역 @unique라, 이 방어가 없으면 B매장 요청이 A매장의
  // 장바구니를 duplicate로 돌려받는다 -- B는 성공 응답을 받았는데 실제로는 자기 매장에
  // 아무것도 담기지 않는, 조용히 사라지는 실패가 된다.
  const storeA = await createStore('collide-a')
  const storeB = await createStore('collide-b')

  const bodyA = validBody(storeA)
  const createdA = await postCart(bodyA)
  assert.equal(createdA.status, 201)

  const resB = await postCart({ ...bodyA, storeCode: storeB.erpStoreCode })
  assert.equal(resB.status, 409)
  assert.equal(resB.body.ok, false)

  // A의 장바구니가 B에게 넘어가지 않았는지 확인한다.
  const stored = await prisma.erpCart.findUnique({ where: { referenceId: bodyA.referenceId } })
  assert.equal(stored.storeId, storeA.id)
  // B매장 폴링에는 아무것도 보이지 않아야 한다.
  const posB = await getPosCarts(storeB)
  assert.equal(posB.body.carts.length, 0)
})

testSerial('충돌: 다른 매장이 취소한 referenceId도 재사용할 수 없다', async () => {
  // cancelled 건을 그냥 두면 createErpCart(upsert)가 그 로우의 storeId를 다른 매장으로
  // 바꿔치기해버린다 -- A매장 이력이 조용히 B매장 것으로 둔갑한다.
  const storeA = await createStore('collide-cancelled-a')
  const storeB = await createStore('collide-cancelled-b')

  const bodyA = validBody(storeA)
  assert.equal((await postCart(bodyA)).status, 201)
  assert.equal((await cancelCart(bodyA.referenceId)).status, 200)

  const resB = await postCart({ ...bodyA, storeCode: storeB.erpStoreCode })
  assert.equal(resB.status, 409)

  const stored = await prisma.erpCart.findUnique({ where: { referenceId: bodyA.referenceId } })
  assert.equal(stored.storeId, storeA.id)
  assert.equal(stored.status, 'cancelled')
})

// --- autoPay 파싱 ---

testSerial('autoPay: 문자열 "false"도 거짓으로 해석한다', async () => {
  // 외부 전산이 JSON 불리언 대신 문자열을 보내는 일이 흔한데 Boolean('false')는 true라,
  // 그대로 두면 "자동결제 끄기"가 조용히 무시된 채 결제창이 떠버린다. 돈이 오가는 분기다.
  const store = await createStore('autopay-string')
  const body = validBody(store, { autoPay: 'false' })
  const res = await postCart(body)
  assert.equal(res.status, 201)

  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.autoPay, false)
})

testSerial('autoPay: 문자열 "true"는 참으로 해석한다', async () => {
  const store = await createStore('autopay-string-true')
  const body = validBody(store, { autoPay: 'true' })
  assert.equal((await postCart(body)).status, 201)

  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.autoPay, true)
})

testSerial('autoPay: null을 보내면 기본값 true가 된다', async () => {
  const store = await createStore('autopay-null')
  const body = validBody(store, { autoPay: null })
  assert.equal((await postCart(body)).status, 201)

  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.autoPay, true)
})

// --- 사업자번호 자동 연결 ---------------------------------------------------
// 전산 코드가 아직 등록되지 않은 매장이라도, 전산이 사업자번호를 함께 보내면 서버가 그걸로
// 매장을 찾아 코드를 붙여준다. 잘못 이어지면 남의 매장으로 주문이 가고 결제까지 이어지므로
// 경계 조건을 촘촘히 본다.

async function createStoreWithBiz(label, businessNumber, overrides = {}) {
  return prisma.store.create({
    data: {
      merchantId: unique(`merchant-${label}`),
      name: `테스트 매장 ${label}`,
      posToken: crypto.randomBytes(32).toString('hex'),
      businessNumber,
      ...overrides,
    },
  })
}

testSerial('자동연결: 코드가 없어도 사업자번호가 맞으면 매장을 찾아 코드를 붙인다', async () => {
  const store = await createStoreWithBiz('autobind', '123-45-67890')
  const body = {
    storeCode: 'AUTO-CHV-001',
    referenceId: unique('ERP-AUTO'),
    items: [{ productId: 'P-1', name: '엔진오일', category: '부품', unitPrice: 45000, quantity: 1 }],
    totalAmount: 45000,
    businessNumber: '123-45-67890',
  }
  const res = await postCart(body)
  assert.equal(res.status, 201, JSON.stringify(res.body))

  const after = await prisma.store.findUnique({ where: { id: store.id } })
  assert.equal(after.erpStoreCode, 'AUTO-CHV-001')

  // 붙은 뒤에는 사업자번호 없이 코드만 보내도 찾아져야 한다.
  const second = await postCart({ ...body, referenceId: unique('ERP-AUTO2'), businessNumber: undefined })
  assert.equal(second.status, 201, JSON.stringify(second.body))
})

testSerial('자동연결: 하이픈 없는 표기로 보내도 하이픈으로 저장된 매장을 찾는다', async () => {
  const store = await createStoreWithBiz('autobind-nohyphen', '123-45-67890')
  const res = await postCart({
    storeCode: 'AUTO-NOHYPHEN',
    referenceId: unique('ERP-AUTO'),
    items: [{ productId: 'P-1', name: '오일필터', category: '부품', unitPrice: 12000, quantity: 1 }],
    totalAmount: 12000,
    businessNumber: '1234567890',
  })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const after = await prisma.store.findUnique({ where: { id: store.id } })
  assert.equal(after.erpStoreCode, 'AUTO-NOHYPHEN')
})

testSerial('자동연결: 이미 다른 코드가 붙은 매장은 덮어쓰지 않고 409', async () => {
  // 사업자번호만 아는 쪽이 남의 매장 주문을 자기 코드로 가로채지 못하게 막는다.
  const store = await createStoreWithBiz('autobind-taken', '222-22-22222', { erpStoreCode: 'ALREADY-BOUND' })
  const res = await postCart({
    storeCode: 'HIJACK-ATTEMPT',
    referenceId: unique('ERP-AUTO'),
    items: [{ productId: 'P-1', name: 'x', category: '부품', unitPrice: 1000, quantity: 1 }],
    totalAmount: 1000,
    businessNumber: '222-22-22222',
  })
  assert.equal(res.status, 409)
  const after = await prisma.store.findUnique({ where: { id: store.id } })
  assert.equal(after.erpStoreCode, 'ALREADY-BOUND') // 그대로여야 한다
})

testSerial('자동연결: 같은 사업자번호를 쓰는 매장이 둘이면 409로 중단한다', async () => {
  // 어느 쪽인지 우리가 정할 수 없으므로 추측하지 않는다.
  await createStoreWithBiz('dup-a', '333-33-33333')
  await createStoreWithBiz('dup-b', '333-33-33333')
  const res = await postCart({
    storeCode: 'AMBIGUOUS',
    referenceId: unique('ERP-AUTO'),
    items: [{ productId: 'P-1', name: 'x', category: '부품', unitPrice: 1000, quantity: 1 }],
    totalAmount: 1000,
    businessNumber: '333-33-33333',
  })
  assert.equal(res.status, 409)
  const bound = await prisma.store.count({ where: { erpStoreCode: 'AMBIGUOUS' } })
  assert.equal(bound, 0)
})

testSerial('자동연결: 일치하는 사업자번호가 없으면 404', async () => {
  await createStoreWithBiz('nomatch', '444-44-44444')
  const res = await postCart({
    storeCode: 'NO-MATCH',
    referenceId: unique('ERP-AUTO'),
    items: [{ productId: 'P-1', name: 'x', category: '부품', unitPrice: 1000, quantity: 1 }],
    totalAmount: 1000,
    businessNumber: '999-99-99999',
  })
  assert.equal(res.status, 404)
})

testSerial('자동연결: 사업자번호 자릿수가 틀리면 400', async () => {
  const res = await postCart({
    storeCode: 'BAD-BIZ',
    referenceId: unique('ERP-AUTO'),
    items: [{ productId: 'P-1', name: 'x', category: '부품', unitPrice: 1000, quantity: 1 }],
    totalAmount: 1000,
    businessNumber: '12345',
  })
  assert.equal(res.status, 400)
})

testSerial('자동연결: 사업자번호를 안 보내면 예전처럼 404 (동작이 바뀌지 않는다)', async () => {
  const res = await postCart({
    storeCode: 'UNKNOWN-CODE',
    referenceId: unique('ERP-AUTO'),
    items: [{ productId: 'P-1', name: 'x', category: '부품', unitPrice: 1000, quantity: 1 }],
    totalAmount: 1000,
  })
  assert.equal(res.status, 404)
})

// --- 관리자: 사업자번호 저장 ------------------------------------------------

testSerial('관리자 사업자번호: 하이픈 없이 넣어도 하이픈 표기로 정규화해 저장한다', async () => {
  const store = await createStore('biz-save')
  const res = await request(app)
    .post(`/api/admin/stores/${store.id}/business-number`)
    .set('authorization', `Bearer ${await hqToken()}`)
    .send({ businessNumber: '1234567890' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.businessNumber, '123-45-67890')
})

testSerial('관리자 사업자번호: 자릿수가 틀리면 400', async () => {
  const store = await createStore('biz-bad')
  const res = await request(app)
    .post(`/api/admin/stores/${store.id}/business-number`)
    .set('authorization', `Bearer ${await hqToken()}`)
    .send({ businessNumber: '123' })
  assert.equal(res.status, 400)
})

testSerial('관리자 사업자번호: 빈 값이면 해제(null)된다', async () => {
  const store = await createStoreWithBiz('biz-clear', '555-55-55555')
  const res = await request(app)
    .post(`/api/admin/stores/${store.id}/business-number`)
    .set('authorization', `Bearer ${await hqToken()}`)
    .send({ businessNumber: '' })
  assert.equal(res.status, 200)
  const after = await prisma.store.findUnique({ where: { id: store.id } })
  assert.equal(after.businessNumber, null)
})

testSerial('관리자 사업자번호: 본사 관리자가 아니면 거부된다', async () => {
  const store = await createStore('biz-authz')
  const res = await request(app)
    .post(`/api/admin/stores/${store.id}/business-number`)
    .send({ businessNumber: '1234567890' })
  assert.equal(res.status, 401)
})

testSerial('자동연결: 형식에 맞지 않는 storeCode는 저장하지 않고 400', async () => {
  // 자동 연결은 storeCode를 DB에 새로 쓰는 경로다. 관리자 웹과 같은 형식 검사를 하지 않으면
  // 전산이 보낸 아무 문자열이나(공백·한글·수백 자) 매장 코드로 굳어버린다.
  const store = await createStoreWithBiz('badcode', '777-77-77777')
  for (const bad of ['한글코드', 'has space', 'x'.repeat(65)]) {
    const res = await postCart({
      storeCode: bad,
      referenceId: unique('ERP-BADCODE'),
      items: [{ productId: 'P-1', name: 'x', category: '부품', unitPrice: 1000, quantity: 1 }],
      totalAmount: 1000,
      businessNumber: '777-77-77777',
    })
    assert.equal(res.status, 400, `${bad} -> ${res.status}`)
  }
  const after = await prisma.store.findUnique({ where: { id: store.id } })
  assert.equal(after.erpStoreCode, null) // 아무것도 붙지 않아야 한다
})

// --- POS 폴링 부하/한도 (400개 매장 규모 대비) ------------------------------
// 실측으로 드러난 두 가지를 고친 뒤의 회귀 테스트다:
//   1) 정상 폴링 1건마다 RateLimitHit에 2회 쓰던 문제(increment 후 decrement)
//   2) 조회 한도가 IP 기준이라 한 매장이 POS를 3대만 둬도 정상 영업 중 429로 막히던 문제

testSerial('폴링 부하: 인증에 성공한 요청은 RateLimitHit에 쓰지 않는다', async () => {
  const store = await createStore('poll-nowrite')
  await prisma.$executeRawUnsafe('DELETE FROM "RateLimitHit"')

  for (let i = 0; i < 15; i += 1) {
    const res = await getPosCarts(store)
    assert.equal(res.status, 200)
  }

  const rows = await prisma.$queryRawUnsafe('SELECT "key", "count" FROM "RateLimitHit"')
  // 성공만 15번 했으므로 카운터 행 자체가 생기면 안 된다. 예전 구현은 여기서 행이 생기고
  // count가 0으로 남았다(15번 올렸다가 15번 되돌린 흔적).
  assert.deepEqual(rows, [], `성공 요청이 카운터를 건드렸습니다: ${JSON.stringify(rows)}`)
})

testSerial('폴링 한도: 한 매장이 단말기를 여러 대 둬도 조회가 막히지 않는다', async () => {
  // 예전 한도는 IP당 분당 60회였는데 탭앱 한 대가 분당 24회를 쓴다 -> 3대면 72회로 초과.
  // 지금은 매장 토큰 기준이라 한 매장 몫(300회) 안에서 소비된다.
  const store = await createStore('poll-many-terminals')
  const THREE_TERMINALS_PER_MIN = 72
  for (let i = 0; i < THREE_TERMINALS_PER_MIN; i += 1) {
    const res = await getPosCarts(store)
    assert.equal(res.status, 200, `${i + 1}번째 요청에서 ${res.status}`)
  }
})

testSerial('폴링 한도: 매장이 다르면 서로의 한도를 잡아먹지 않는다', async () => {
  const storeA = await createStore('poll-isolate-a')
  const storeB = await createStore('poll-isolate-b')
  for (let i = 0; i < 40; i += 1) {
    assert.equal((await getPosCarts(storeA)).status, 200)
  }
  // A가 많이 썼어도 B는 영향이 없어야 한다(예전 IP 기준이면 같은 키를 공유해 막혔다).
  assert.equal((await getPosCarts(storeB)).status, 200)
})

testSerial('무차별 대입 방어: 틀린 토큰 10회 뒤 429로 차단된다', async () => {
  await prisma.$executeRawUnsafe('DELETE FROM "RateLimitHit"')
  const codes = []
  for (let i = 0; i < 13; i += 1) {
    const res = await request(app).get('/api/pos/erp-carts').set('X-Store-Token', `wrong-token-${i}`)
    codes.push(res.status)
  }
  const first429 = codes.indexOf(429)
  assert.equal(codes.slice(0, 10).every((c) => c === 401), true, `앞 10회가 401이 아님: ${codes}`)
  assert.equal(first429, 10, `11번째부터 429여야 하는데 ${first429 + 1}번째: ${codes}`)

  // 실패는 DB에 기록돼야 한다(인스턴스가 여러 개여도 시도 횟수가 공유되도록).
  const rows = await prisma.$queryRawUnsafe('SELECT "count" FROM "RateLimitHit"')
  assert.equal(rows.length, 1)
  assert.equal(Number(rows[0].count) >= 10, true)
})

testSerial('무차별 대입 방어: 토큰을 아예 안 보내도 실패로 센다', async () => {
  await prisma.$executeRawUnsafe('DELETE FROM "RateLimitHit"')
  const res = await request(app).get('/api/pos/erp-carts')
  assert.equal(res.status, 401)
  const rows = await prisma.$queryRawUnsafe('SELECT "count" FROM "RateLimitHit"')
  assert.equal(rows.length, 1)
})

// --- 폴링 요청 합치기 (매장당 요청 수를 절반으로) -----------------------------
// 탭앱이 /api/pos/queue와 /api/pos/erp-carts를 각각 폴링하던 것을 하나로 합쳤다.
// 400개 매장이 한꺼번에 업데이트되지는 않으므로 옛 경로도 계속 살아 있어야 한다.

testSerial('합친 응답: /api/pos/queue가 대기열과 전산 주문을 함께 내려준다', async () => {
  const store = await createStore('merged-response')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)

  const res = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.equal(res.status, 200)
  assert.equal(Array.isArray(res.body.reservations), true)
  assert.equal(Array.isArray(res.body.erpCarts), true, 'erpCarts 필드가 없습니다')
  assert.equal(res.body.erpCarts.length, 1)
  assert.equal(res.body.erpCarts[0].referenceId, body.referenceId)
  assert.equal(res.body.erpCarts[0].items[0].name, '엔진오일 5W30 (4L)')
})

testSerial('합친 응답: 옛 경로(/api/pos/erp-carts)도 같은 값을 계속 내려준다', async () => {
  // 구버전 탭앱이 남아 있는 동안 이 경로가 죽으면 그 매장은 전산 주문을 못 받는다.
  const store = await createStore('legacy-route')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)

  const merged = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  const legacy = await getPosCarts(store)
  assert.equal(legacy.status, 200)
  assert.deepEqual(legacy.body.carts, merged.body.erpCarts, '두 경로의 전산 주문이 다릅니다')
})

testSerial('합친 응답: 다른 매장의 전산 주문은 섞이지 않는다', async () => {
  const storeA = await createStore('merged-isolate-a')
  const storeB = await createStore('merged-isolate-b')
  assert.equal((await postCart(validBody(storeA))).status, 201)

  const resB = await request(app).get('/api/pos/queue').set('X-Store-Token', storeB.posToken)
  assert.equal(resB.status, 200)
  assert.deepEqual(resB.body.erpCarts, [])
})

testSerial('합친 응답: 전산 주문이 없으면 빈 배열이다(필드 자체는 항상 있다)', async () => {
  // 탭앱은 이 필드의 존재 여부로 "합친 응답을 주는 서버인가"를 판단해 옛 경로 호출을 건너뛴다.
  // 비어 있다고 필드를 빼면 구형 서버로 오인해 요청을 두 번 하게 된다.
  const store = await createStore('merged-empty')
  const res = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.erpCarts, [])
})
