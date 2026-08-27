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

// 매장별/IP 한도 -- server.js가 모듈 로드 시점에 읽으므로 require보다 먼저 세팅해야 한다.
// 매장 한도(ERP_STORE_LIMIT_PER_MIN)는 DB 기반(RateLimitHit)이라 beforeEach의 TRUNCATE로
// 테스트마다 리셋되므로 낮게 잡아도 된다. IP 백스톱(ERP_IP_LIMIT_PER_MIN)은 메모리 기반이라
// 이 파일 전체 실행 동안 누적되므로, 낮게 잡으면 이 파일의 다른(무관한) 테스트들이 쌓아온
// 요청 수 때문에 뒤쪽 테스트가 이유 없이 429로 걸린다 -- 그래서 이쪽은 넉넉히 둔다.
process.env.ERP_STORE_LIMIT_PER_MIN = '5'
process.env.ERP_IP_LIMIT_PER_MIN = '100000'

const { hashPassword, signAdminToken } = require('../src/auth')
const { prisma, expireStaleErpCarts, purgeExpiredPersonalData } = require('../src/store')
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

// --- 전산(ERP) 요청 한도: 매장 단위 (400개 매장이 중계 서버 IP 하나를 공유하는 문제 대응) ---
// 이 파일 상단에서 ERP_STORE_LIMIT_PER_MIN을 5로 낮춰뒀다(erpLimiter는 DB 기반이라
// beforeEach의 TRUNCATE로 테스트마다 리셋된다).

testSerial('전산 한도: 한 매장이 한도를 넘겨도 다른 매장은 정상이다', async () => {
  const storeA = await createStore('erp-limit-a')
  const storeB = await createStore('erp-limit-b')

  const codesA = []
  for (let i = 0; i < 8; i += 1) {
    codesA.push((await postCart(validBody(storeA))).status)
  }
  assert.equal(codesA.some((c) => c === 429), true, `storeA가 한도에 걸리지 않았습니다: ${codesA}`)

  // storeA가 자기 몫을 다 썼어도 storeB는 자기 몫이 그대로 남아 있어야 한다 -- 예전처럼
  // IP 기준으로 공유하는 한도였다면 여기서도 429가 났을 것이다. 이게 이 작업의 핵심이다.
  const resB = await postCart(validBody(storeB))
  assert.equal(resB.status, 201, `storeB가 storeA 때문에 막혔습니다: ${resB.status}`)
})

testSerial('전산 한도: 같은 매장이 한도를 넘기면 429가 나온다', async () => {
  const store = await createStore('erp-limit-single')
  const codes = []
  for (let i = 0; i < 8; i += 1) {
    codes.push((await postCart(validBody(store))).status)
  }
  // 테스트 한도가 5이니 앞 5회는 성공(201)하고 6번째부터 429여야 한다.
  assert.equal(codes.slice(0, 5).every((c) => c === 201), true, `앞 5회가 201이 아님: ${codes}`)
  const first429 = codes.indexOf(429)
  assert.equal(first429, 5, `6번째부터 429여야 하는데 ${first429 + 1}번째: ${codes}`)
})

testSerial('전산 한도: 조회/취소도 주문별로 나뉜다 -- 한 건을 두드려도 다른 건은 멀쩡하다', async () => {
  // 이 라우트들은 바디에 storeCode가 없다. IP로 폴백하면 400개 매장이 바구니 하나를 나눠 쓰게
  // 되어 원래 버그가 여기만 그대로 남는다 -- 전산이 상태를 폴링하는 순간 바로 한도를 넘긴다.
  const store = await createStore('erp-limit-ref')
  const a = validBody(store)
  const b = validBody(store)
  assert.equal((await postCart(a)).status, 201)
  assert.equal((await postCart(b)).status, 201)

  const codesA = []
  for (let i = 0; i < 8; i += 1) {
    codesA.push((await getCart(a.referenceId)).status)
  }
  assert.equal(codesA.some((c) => c === 429), true, `a가 한도에 걸리지 않았습니다: ${codesA}`)

  const resB = await getCart(b.referenceId)
  assert.equal(resB.status, 200, `다른 주문(b)이 a 때문에 막혔습니다: ${resB.status}`)
})

testSerial('전산 한도: storeCode가 없는 라우트(IP 폴백)도 정상 동작한다', async () => {
  const store = await createStore('erp-limit-fallback')
  const body = validBody(store)
  const created = await postCart(body)
  assert.equal(created.status, 201)

  // 조회(GET)와 취소(POST cancel)는 바디에 storeCode가 없다 -- 매장 키를 못 만들어 IP로
  // 폴백해도 요청 자체는 정상 처리돼야 한다(폴백 자체가 깨지면 안 된다).
  const got = await getCart(body.referenceId)
  assert.equal(got.status, 200, `IP 폴백 조회가 실패했습니다: ${got.status}`)

  const cancelled = await cancelCart(body.referenceId)
  assert.equal(cancelled.status, 200, `IP 폴백 취소가 실패했습니다: ${cancelled.status}`)
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

// --- 매장이 잘못 온 주문을 치우는 경로 (dismissed) ---------------------------
// 잘못 온 주문(다른 손님 것, 전산 오조작)을 직원이 없앨 방법이 없으면 pending으로 영원히 남아
// POS 화면에 계속 뜬다. 전산이 취소한 cancelled와는 구분해서 남긴다 -- 전산 입장에서
// "우리가 취소"와 "매장이 거부"는 후속 조치가 다르다.

testSerial('지우기: POS가 dismissed로 보고하면 상태가 dismissed가 되고 목록에서 빠진다', async () => {
  const store = await createStore('dismiss-basic')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)

  const before = await getPosCarts(store)
  assert.equal(before.body.carts.length, 1)
  const cartId = before.body.carts[0].id

  const res = await consumeCart(store, cartId, { result: 'dismissed', errorMessage: '매장에서 지움' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.alreadyProcessed, false)

  const stored = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(stored.status, 'dismissed')
  assert.equal(stored.errorMessage, '매장에서 지움')
  assert.equal(stored.loadedAt, null) // 담긴 게 아니므로 loadedAt은 비어 있어야 한다

  const after = await getPosCarts(store)
  assert.deepEqual(after.body.carts, [])
})

testSerial('지우기: 전산이 상태를 조회하면 dismissed로 보인다', async () => {
  const store = await createStore('dismiss-visible')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'dismissed', errorMessage: '매장에서 지움' })

  const res = await getCart(body.referenceId)
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'dismissed')
  assert.equal(res.body.errorMessage, '매장에서 지움')
})

testSerial('지우기: 두 번 보내도 안전하다(멱등)', async () => {
  const store = await createStore('dismiss-idempotent')
  assert.equal((await postCart(validBody(store))).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id

  assert.equal((await consumeCart(store, cartId, { result: 'dismissed' })).body.alreadyProcessed, false)
  const second = await consumeCart(store, cartId, { result: 'dismissed' })
  assert.equal(second.status, 200)
  assert.equal(second.body.alreadyProcessed, true)
})

testSerial('지우기: 이미 담긴(loaded) 건은 dismissed로 덮어쓰지 않는다', async () => {
  const store = await createStore('dismiss-after-loaded')
  assert.equal((await postCart(validBody(store))).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id

  await consumeCart(store, cartId, { result: 'loaded' })
  const res = await consumeCart(store, cartId, { result: 'dismissed' })
  assert.equal(res.body.alreadyProcessed, true)

  const stored = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(stored.status, 'loaded', '이미 POS에 담긴 건이 지움으로 바뀌면 안 됩니다')
})

testSerial('지우기: 다른 매장 토큰으로는 지울 수 없다', async () => {
  const storeA = await createStore('dismiss-owner')
  const storeB = await createStore('dismiss-other')
  assert.equal((await postCart(validBody(storeA))).status, 201)
  const cartId = (await getPosCarts(storeA)).body.carts[0].id

  const res = await consumeCart(storeB, cartId, { result: 'dismissed' })
  assert.equal(res.status, 404)

  const stored = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(stored.status, 'pending')
})

testSerial('지우기: result 값이 셋 중 하나가 아니면 400', async () => {
  const store = await createStore('dismiss-badresult')
  assert.equal((await postCart(validBody(store))).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  const res = await consumeCart(store, cartId, { result: 'deleted' })
  assert.equal(res.status, 400)
})

// --- 오래 방치된 주문 만료 + 개인정보 파기 ------------------------------------

testSerial('만료: 하루가 지난 pending은 POS 목록에 뜨지 않는다', async () => {
  // 전산이 보냈는데 매장이 그날 처리하지 않으면, 다음 날 아침 POS에 어제 주문이 그대로 뜬다.
  // 직원이 오늘 손님 것으로 착각하고 담아 결제하면 잘못된 금액이 청구된다.
  const store = await createStore('stale-hidden')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)

  // 25시간 전에 들어온 것으로 되돌린다.
  await prisma.erpCart.update({
    where: { referenceId: body.referenceId },
    data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
  })

  const res = await getPosCarts(store)
  assert.deepEqual(res.body.carts, [], '하루 지난 주문이 POS 목록에 남아 있습니다')

  // 합친 응답(/api/pos/queue)에서도 마찬가지여야 한다.
  const merged = await request(app).get('/api/pos/queue').set('X-Store-Token', store.posToken)
  assert.deepEqual(merged.body.erpCarts, [])
})

testSerial('만료: 정리 잡이 돌면 상태가 expired가 되고 전산이 그걸 조회할 수 있다', async () => {
  const store = await createStore('stale-expired')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  await prisma.erpCart.update({
    where: { referenceId: body.referenceId },
    data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
  })

  const count = await expireStaleErpCarts()
  assert.equal(count >= 1, true)

  const res = await getCart(body.referenceId)
  assert.equal(res.body.status, 'expired')
  assert.equal(typeof res.body.errorMessage, 'string')
})

testSerial('만료: 아직 하루가 안 된 주문은 건드리지 않는다', async () => {
  const store = await createStore('stale-fresh')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  await prisma.erpCart.update({
    where: { referenceId: body.referenceId },
    data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
  })

  await expireStaleErpCarts()
  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.status, 'pending')
  assert.equal((await getPosCarts(store)).body.carts.length, 1)
})

testSerial('만료: 이미 담긴(loaded) 건은 만료되지 않는다', async () => {
  const store = await createStore('stale-loaded')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })
  await prisma.erpCart.update({
    where: { id: cartId },
    data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
  })

  await expireStaleErpCarts()
  const stored = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(stored.status, 'loaded')
})

testSerial('개인정보 파기: 보관기간이 지나면 ErpCart.memo가 지워진다', async () => {
  // memo에는 전산이 보낸 "12가3456 김민준님"이 들어간다 -- 차량번호와 고객명은 개인정보다.
  const store = await createStore('purge-memo')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  const old = new Date(Date.now() - 4000 * 24 * 60 * 60 * 1000) // 보관기간(기본 3년)보다 오래됨
  await prisma.erpCart.update({ where: { referenceId: body.referenceId }, data: { createdAt: old } })

  const result = await purgeExpiredPersonalData()
  assert.equal(result.erpCarts >= 1, true, `파기 대상에 ErpCart가 포함되지 않았습니다: ${JSON.stringify(result)}`)

  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.memo, null, 'memo가 남아 있습니다')
  // 레코드 자체와 품목 정보는 남아야 한다(매장별 건수 통계가 깨지지 않게).
  assert.equal(stored.totalAmount, body.totalAmount)
  assert.equal(typeof stored.itemsJson, 'string')
})

testSerial('개인정보 파기: 보관기간 안의 건은 memo를 지우지 않는다', async () => {
  const store = await createStore('purge-keep')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)

  await purgeExpiredPersonalData()
  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.memo, body.memo)
})

testSerial('개인정보 파기: 보관기간이 지나면 ErpCart.carNumber도 지워진다', async () => {
  // carNumber는 memo(사람이 읽는 자유 문자열)보다 식별성이 높은데도 그동안 영구 보존됐다.
  const store = await createStore('purge-carnumber')
  const body = validBody(store, { carNumber: '77허7777' })
  assert.equal((await postCart(body)).status, 201)
  const old = new Date(Date.now() - 4000 * 24 * 60 * 60 * 1000) // 보관기간(기본 3년)보다 오래됨
  await prisma.erpCart.update({ where: { referenceId: body.referenceId }, data: { createdAt: old } })

  const result = await purgeExpiredPersonalData()
  assert.equal(result.erpCarts >= 1, true, `파기 대상에 ErpCart가 포함되지 않았습니다: ${JSON.stringify(result)}`)

  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.carNumber, null, 'carNumber가 남아 있습니다')
  assert.equal(stored.memo, null, 'memo도 함께 지워져야 합니다')
})

testSerial('개인정보 파기: 보관기간 안의 ErpCart는 carNumber를 지우지 않는다', async () => {
  const store = await createStore('purge-carnumber-keep')
  const body = validBody(store, { carNumber: '77허7777' })
  assert.equal((await postCart(body)).status, 201)

  await purgeExpiredPersonalData()
  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.carNumber, '77허7777')
})

testSerial('개인정보 파기: 보관기간이 지난 ErpOrder는 memo·itemsJson이 지워지고 anonymizedAt이 찍힌다', async () => {
  // ErpOrder는 그동안 파기 대상에 아예 없었다 -- ErpCart와 같은 이유(memo/items[].name에
  // 차량번호·고객명)로 이제 파기 대상에 넣는다. HTTP 경로(/api/erp/draft-orders)를 타면
  // 토스 목 서버 설정까지 필요해 이 테스트의 관심사가 아니므로, prisma로 직접 로우를 만든다.
  const store = await createStore('purge-erporder')
  const old = new Date(Date.now() - 4000 * 24 * 60 * 60 * 1000) // 보관기간(기본 3년)보다 오래됨
  const order = await prisma.erpOrder.create({
    data: {
      storeId: store.id,
      referenceId: unique('ERP-ORDER-REF'),
      tossOrderKey: unique('toss-order-key'),
      totalAmount: 45000,
      itemsJson: JSON.stringify([{ name: '12가3456 김민준님 엔진오일', unitPrice: 45000, quantity: 1 }]),
      memo: '12가3456 김민준님',
      createdAt: old,
    },
  })

  const result = await purgeExpiredPersonalData()
  assert.equal(result.erpOrders >= 1, true, `파기 대상에 ErpOrder가 포함되지 않았습니다: ${JSON.stringify(result)}`)

  const stored = await prisma.erpOrder.findUnique({ where: { id: order.id } })
  assert.equal(stored.memo, null, 'memo가 남아 있습니다')
  assert.equal(stored.itemsJson, '[]', 'itemsJson이 지워지지 않았습니다')
  assert.notEqual(stored.anonymizedAt, null, 'anonymizedAt이 찍혀야 합니다')
  // 레코드 자체와 집계값(매장별 주문 건수/매출 통계용)은 남아야 한다.
  assert.equal(stored.totalAmount, 45000)
  assert.equal(stored.status, 'created')
})

testSerial('개인정보 파기: 보관기간 안의 ErpOrder는 지우지 않는다', async () => {
  const store = await createStore('purge-erporder-keep')
  const order = await prisma.erpOrder.create({
    data: {
      storeId: store.id,
      referenceId: unique('ERP-ORDER-REF'),
      tossOrderKey: unique('toss-order-key'),
      totalAmount: 10000,
      itemsJson: JSON.stringify([{ name: '와이퍼', unitPrice: 10000, quantity: 1 }]),
      memo: '34나7777',
    },
  })

  await purgeExpiredPersonalData()
  const stored = await prisma.erpOrder.findUnique({ where: { id: order.id } })
  assert.equal(stored.memo, '34나7777')
  assert.equal(stored.anonymizedAt, null)
})

testSerial('개인정보 파기: 보관기간이 지난 WebhookEvent는 행 자체가 삭제된다', async () => {
  // WebhookEvent는 개인정보 필드가 없어 다른 모델처럼 값만 비울 수 없다 -- 무한 증가가
  // 문제이므로 보관기간이 지나면 행 자체를 지운다.
  const old = new Date(Date.now() - 4000 * 24 * 60 * 60 * 1000) // 보관기간(기본 3년)보다 오래됨
  await prisma.webhookEvent.create({
    data: { id: unique('webhook-old'), eventType: 'PAYMENT_STATUS_CHANGED', receivedAt: old },
  })
  const recentId = unique('webhook-recent')
  await prisma.webhookEvent.create({ data: { id: recentId, eventType: 'PAYMENT_STATUS_CHANGED' } })

  const result = await purgeExpiredPersonalData()
  assert.equal(result.webhookEvents >= 1, true, `파기 대상에 WebhookEvent가 포함되지 않았습니다: ${JSON.stringify(result)}`)

  const remaining = await prisma.webhookEvent.findMany()
  assert.equal(remaining.length, 1, '오래된 건은 삭제되어 행 자체가 없어야 합니다')
  assert.equal(remaining[0].id, recentId, '보관기간 안의 최근 건은 남아 있어야 합니다')
})

// --- 결제 완료 기록 + 예약 자동완료 ------------------------------------------
// 이게 없으면 전산 주문은 "담김(loaded)"에서 멈춘다 — 전산은 결제가 됐는지 모르고 우리 집계에도
// 안 잡힌다. POS 탭앱이 posPluginSdk.payment.on('paid')로 받아 서버에 알려준다.

function markPaid(store, cartId, body) {
  return request(app).post(`/api/pos/erp-carts/${cartId}/paid`).set('X-Store-Token', store.posToken).send(body || {})
}

async function loadedCart(label) {
  const store = await createStore(label)
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })
  return { store, cartId, body }
}

testSerial('결제: loaded 건을 paid로 기록하고 결제 식별자를 남긴다', async () => {
  const { store, cartId, body } = await loadedCart('paid-basic')
  const res = await markPaid(store, cartId, { paymentId: 'pay_123', orderId: 'ord_456' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.status, 'paid')

  const stored = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(stored.status, 'paid')
  assert.equal(stored.tossPaymentId, 'pay_123')
  assert.equal(stored.tossOrderId, 'ord_456')
  assert.equal(stored.paidAt instanceof Date, true)

  // 전산이 조회하면 결제됐음을 알 수 있어야 한다.
  const erpView = await getCart(body.referenceId)
  assert.equal(erpView.body.status, 'paid')
})

testSerial('결제: 담기지 않은(pending) 건은 결제로 기록할 수 없다', async () => {
  const store = await createStore('paid-not-loaded')
  assert.equal((await postCart(validBody(store))).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id

  const res = await markPaid(store, cartId, { paymentId: 'p' })
  assert.equal(res.status, 409)
  const stored = await prisma.erpCart.findUnique({ where: { id: cartId } })
  assert.equal(stored.status, 'pending')
})

testSerial('결제: 두 번 보내도 안전하다(멱등)', async () => {
  const { store, cartId } = await loadedCart('paid-idempotent')
  assert.equal((await markPaid(store, cartId, { paymentId: 'p1' })).body.alreadyProcessed, false)
  const second = await markPaid(store, cartId, { paymentId: 'p1' })
  assert.equal(second.status, 200)
  assert.equal(second.body.alreadyProcessed, true)
})

testSerial('결제: 다른 매장 토큰으로는 기록할 수 없다', async () => {
  const { cartId } = await loadedCart('paid-owner')
  const other = await createStore('paid-other')
  const res = await markPaid(other, cartId, { paymentId: 'p' })
  assert.equal(res.status, 404)
})

// --- 차량번호로 예약 연결 -----------------------------------------------------

async function createReservationFor(store, carNumber, status) {
  return prisma.reservation.create({
    data: {
      storeId: store.id,
      carNumber,
      phone: '01012345678',
      serviceType: '엔진오일',
      queueNumber: Math.floor(Math.random() * 9000) + 1000,
      serviceDate: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
      status: status || 'waiting',
    },
  })
}

testSerial('예약 연결: 차량번호가 그날 대기 손님과 정확히 1건 일치하면 이어진다', async () => {
  const store = await createStore('link-one')
  const reservation = await createReservationFor(store, '12가3456')
  const body = validBody(store, { carNumber: '12가3456' })
  const res = await postCart(body)
  assert.equal(res.status, 201)
  assert.equal(res.body.linkedReservation, true)

  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.reservationId, reservation.id)
  assert.equal(stored.carNumber, '12가3456')
})

testSerial('예약 연결: 표기가 달라도(공백) 같은 차로 본다', async () => {
  const store = await createStore('link-spaces')
  const reservation = await createReservationFor(store, '12가3456')
  const body = validBody(store, { carNumber: '12가 3456' })
  assert.equal((await postCart(body)).body.linkedReservation, true)
  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.reservationId, reservation.id)
})

testSerial('예약 연결: 같은 차량번호가 둘이면 잇지 않는다(애매하면 사람에게)', async () => {
  const store = await createStore('link-ambiguous')
  await createReservationFor(store, '99하9999')
  await createReservationFor(store, '99하9999')
  const body = validBody(store, { carNumber: '99하9999' })
  assert.equal((await postCart(body)).body.linkedReservation, false)
  const stored = await prisma.erpCart.findUnique({ where: { referenceId: body.referenceId } })
  assert.equal(stored.reservationId, null)
})

testSerial('예약 연결: 이미 끝난 예약에는 잇지 않는다', async () => {
  const store = await createStore('link-closed')
  await createReservationFor(store, '11가1111', 'completed')
  const body = validBody(store, { carNumber: '11가1111' })
  assert.equal((await postCart(body)).body.linkedReservation, false)
})

testSerial('예약 연결: 다른 매장 예약에는 잇지 않는다', async () => {
  const storeA = await createStore('link-store-a')
  const storeB = await createStore('link-store-b')
  await createReservationFor(storeA, '22나2222')
  const body = validBody(storeB, { carNumber: '22나2222' })
  assert.equal((await postCart(body)).body.linkedReservation, false)
})

testSerial('예약 연결: 차량번호를 안 보내도 접수는 정상 동작한다', async () => {
  const store = await createStore('link-none')
  const res = await postCart(validBody(store))
  assert.equal(res.status, 201)
  assert.equal(res.body.linkedReservation, false)
})

testSerial('예약 자동완료: 결제되면 이어진 예약이 완료로 바뀐다', async () => {
  const store = await createStore('autocomplete')
  const reservation = await createReservationFor(store, '33다3333', 'called')
  const body = validBody(store, { carNumber: '33다3333' })
  assert.equal((await postCart(body)).body.linkedReservation, true)

  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })
  const res = await markPaid(store, cartId, { paymentId: 'p' })
  assert.equal(res.body.reservationCompleted, true)

  const after = await prisma.reservation.findUnique({ where: { id: reservation.id } })
  assert.equal(after.status, 'completed')
  assert.equal(after.completedAt instanceof Date, true)
})

testSerial('예약 자동완료: 호출 전(waiting)이어도 결제되면 완료된다', async () => {
  // 직원이 [완료]를 누르는 경로는 호출한 건만 완료한다. 하지만 바쁘면 호출 없이 처리하기도 하고,
  // 결제가 끝났다는 건 정비가 끝났다는 뜻이므로 waiting도 완료로 넘긴다.
  const store = await createStore('autocomplete-waiting')
  const reservation = await createReservationFor(store, '44라4444', 'waiting')
  const body = validBody(store, { carNumber: '44라4444' })
  assert.equal((await postCart(body)).body.linkedReservation, true)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })
  assert.equal((await markPaid(store, cartId, {})).body.reservationCompleted, true)

  const after = await prisma.reservation.findUnique({ where: { id: reservation.id } })
  assert.equal(after.status, 'completed')
})

testSerial('예약 자동완료: 이어진 예약이 없으면 결제만 기록된다', async () => {
  const { store, cartId } = await loadedCart('autocomplete-none')
  const res = await markPaid(store, cartId, {})
  assert.equal(res.body.status, 'paid')
  assert.equal(res.body.reservationCompleted, false)
})

// --- 관리자 웹 전산 주문 이력 -------------------------------------------------
// 매장이 "전산에서 보냈는데 POS에 안 떴어요" 할 때 본사가 어디서 끊겼는지 볼 통로가 없었다.

function listAdminCarts(tok, query) {
  const req = request(app).get('/api/admin/erp-carts' + (query || ''))
  if (tok) req.set('authorization', `Bearer ${tok}`)
  return req
}

testSerial('관리자 이력: 본사는 전체 매장의 전산 주문을 본다', async () => {
  const storeA = await createStore('adminlist-a')
  const storeB = await createStore('adminlist-b')
  assert.equal((await postCart(validBody(storeA))).status, 201)
  assert.equal((await postCart(validBody(storeB))).status, 201)

  const res = await listAdminCarts(await hqToken())
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.carts.length >= 2, true)
  const names = res.body.carts.map((c) => c.storeName)
  assert.equal(names.includes(storeA.name) && names.includes(storeB.name), true)
})

testSerial('관리자 이력: 상태로 걸러낼 수 있다', async () => {
  const store = await createStore('adminlist-filter')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })

  const pending = await listAdminCarts(await hqToken(), '?status=pending')
  assert.equal(pending.body.carts.some((c) => c.referenceId === body.referenceId), false)

  const loaded = await listAdminCarts(await hqToken(), '?status=loaded')
  assert.equal(loaded.body.carts.some((c) => c.referenceId === body.referenceId), true)
})

testSerial('관리자 이력: 특정 매장만 골라 볼 수 있다', async () => {
  const storeA = await createStore('adminlist-only-a')
  const storeB = await createStore('adminlist-only-b')
  const bodyA = validBody(storeA)
  assert.equal((await postCart(bodyA)).status, 201)
  assert.equal((await postCart(validBody(storeB))).status, 201)

  const res = await listAdminCarts(await hqToken(), `?storeId=${storeA.id}`)
  assert.equal(res.body.carts.every((c) => c.storeName === storeA.name), true)
  assert.equal(res.body.carts.some((c) => c.referenceId === bodyA.referenceId), true)
})

testSerial('관리자 이력: 로그인하지 않으면 볼 수 없다', async () => {
  const res = await listAdminCarts(null)
  assert.equal(res.status, 401)
})

testSerial('관리자 이력: 응답에 품목 원문은 넣지 않고 개수만 준다', async () => {
  // 목록 화면에 품목 전체를 실어보내면 응답이 커지고, 목록에서는 개수만 보면 충분하다.
  const store = await createStore('adminlist-shape')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)

  const res = await listAdminCarts(await hqToken(), `?storeId=${store.id}`)
  const row = res.body.carts.find((c) => c.referenceId === body.referenceId)
  assert.equal(row.itemCount, body.items.length)
  assert.equal(row.itemsJson, undefined)
  assert.equal(row.totalAmount, body.totalAmount)
})

// --- 일일 요약에 전산 주문 ----------------------------------------------------

testSerial('일일 요약: 전산 주문 건수와 결제액이 함께 나온다', async () => {
  const store = await createStore('summary-erp')
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })
  await request(app).post(`/api/pos/erp-carts/${cartId}/paid`).set('X-Store-Token', store.posToken).send({})

  const res = await request(app)
    .get('/api/admin/summary')
    .set('authorization', `Bearer ${await hqToken()}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const erp = res.body.summary ? res.body.summary.erpCarts : res.body.erpCarts
  assert.notEqual(erp, undefined, `요약에 erpCarts가 없습니다: ${JSON.stringify(res.body).slice(0, 300)}`)
  assert.equal(erp.total >= 1, true)
  assert.equal(erp.paid >= 1, true)
  assert.equal(erp.paidAmount >= body.totalAmount, true)
})

// --- 관리자 비밀번호 변경 -----------------------------------------------------
// 지금까지 바꿀 방법이 아예 없었다. 잊으면 DB의 passwordHash를 직접 갈아끼워야 했다.
// (ADMIN_BOOTSTRAP_PASSWORD 시크릿을 바꾸고 재배포해도 소용없다 — 그 값은 "관리자가 하나도
//  없을 때 처음 만들 값"이라 이미 계정이 있으면 부팅 코드가 그냥 지나간다.)

const { hashPassword: hashPw } = require('../src/auth')

async function adminWithPassword(password) {
  const admin = await prisma.adminUser.create({
    data: {
      email: `${unique('pw')}@example.test`,
      passwordHash: await hashPw(password),
      role: 'hq_admin',
      storeId: null,
    },
  })
  return { admin, token: signAdminToken(admin) }
}

function changePw(tok, body) {
  const req = request(app).post('/api/admin/password')
  if (tok) req.set('authorization', `Bearer ${tok}`)
  return req.send(body)
}

testSerial('비밀번호 변경: 현재 비밀번호가 맞으면 바뀌고, 새 값으로 로그인된다', async () => {
  const { admin, token: tok } = await adminWithPassword('old-password-123')
  const res = await changePw(tok, { currentPassword: 'old-password-123', newPassword: 'new-password-456' })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  const login = await request(app).post('/api/admin/login')
    .send({ email: admin.email, password: 'new-password-456' })
  assert.equal(login.status, 200, '새 비밀번호로 로그인되지 않습니다')

  const oldLogin = await request(app).post('/api/admin/login')
    .send({ email: admin.email, password: 'old-password-123' })
  assert.equal(oldLogin.status === 200, false, '옛 비밀번호가 아직 통합니다')
})

testSerial('비밀번호 변경: 현재 비밀번호가 틀리면 거부한다', async () => {
  // 토큰만으로 바꾸게 하면 자리를 비운 사이 열린 화면으로 남이 갈아버릴 수 있다.
  const { admin, token: tok } = await adminWithPassword('old-password-123')
  const res = await changePw(tok, { currentPassword: 'wrong-one', newPassword: 'new-password-456' })
  assert.equal(res.status, 401)

  const login = await request(app).post('/api/admin/login')
    .send({ email: admin.email, password: 'old-password-123' })
  assert.equal(login.status, 200, '비밀번호가 바뀌어버렸습니다')
})

testSerial('비밀번호 변경: 8자 미만은 거부한다', async () => {
  const { token: tok } = await adminWithPassword('old-password-123')
  const res = await changePw(tok, { currentPassword: 'old-password-123', newPassword: 'short' })
  assert.equal(res.status, 400)
})

testSerial('비밀번호 변경: 같은 값으로는 바꿀 수 없다', async () => {
  const { token: tok } = await adminWithPassword('old-password-123')
  const res = await changePw(tok, { currentPassword: 'old-password-123', newPassword: 'old-password-123' })
  assert.equal(res.status, 400)
})

testSerial('비밀번호 변경: 로그인하지 않으면 거부한다', async () => {
  const res = await changePw(null, { currentPassword: 'x', newPassword: 'yyyyyyyy' })
  assert.equal(res.status, 401)
})

testSerial('비밀번호 변경: 잠금 카운터도 함께 풀린다', async () => {
  // 실패가 쌓인 상태로 비밀번호만 바꾸면 새 값으로도 잠금에 막혀 "바꿨는데 왜 안 되지"가 된다.
  const { admin, token: tok } = await adminWithPassword('old-password-123')
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { failedLoginCount: 4, lockedUntil: new Date(Date.now() + 10 * 60 * 1000) },
  })

  assert.equal((await changePw(tok, { currentPassword: 'old-password-123', newPassword: 'new-password-456' })).status, 200)
  const after = await prisma.adminUser.findUnique({ where: { id: admin.id } })
  assert.equal(after.failedLoginCount, 0)
  assert.equal(after.lockedUntil, null)
})

testSerial('POS 응답: 차량번호와 예약 연결 여부가 카드에 실려 온다', async () => {
  // 정비소는 차량번호로 일을 식별한다. memo에도 들어 있지만 자유 문자열이라 화면에서
  // 따로 강조할 수 없어서 별도 필드로 내린다. 연결 표시는 "결제 후 자동완료된다"는 신호다.
  const store = await createStore('poscard-fields')
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const reservation = await prisma.reservation.create({
    data: {
      storeId: store.id, carNumber: '55마5555', phone: '01012345678',
      serviceType: '엔진오일', queueNumber: 11, serviceDate: today, status: 'called',
    },
  })
  const body = validBody(store, { carNumber: '55마5555' })
  assert.equal((await postCart(body)).body.linkedReservation, true)

  const res = await getPosCarts(store)
  const card = res.body.carts[0]
  assert.equal(card.carNumber, '55마5555')
  assert.equal(card.linkedReservation, true)

  // 연결되지 않은 건은 표시가 없어야 한다.
  const store2 = await createStore('poscard-unlinked')
  const body2 = validBody(store2, { carNumber: '66바6666' })
  assert.equal((await postCart(body2)).body.linkedReservation, false)
  const card2 = (await getPosCarts(store2)).body.carts[0]
  assert.equal(card2.carNumber, '66바6666')
  assert.equal(card2.linkedReservation, false)

  assert.equal(reservation.id.length > 0, true)
})

// --- 정비 이력 조회 -----------------------------------------------------------
// 직원이 "이 차 지난번에 뭐 갈았지?"를 POS에서 바로 본다. 손님 동의의 이용 목적에
// "정비 이력 관리"가 들어 있어야 쓸 수 있는 기능이라, 돌려주는 항목을 최소로 유지한다.

function getHistory(store, carNumber) {
  return request(app)
    .get('/api/pos/history?carNumber=' + encodeURIComponent(carNumber))
    .set('X-Store-Token', store.posToken)
}

// 실제 흐름 그대로 한 번의 방문을 만든다: 예약(호출됨) -> 전산 주문 -> 담기 -> 결제.
// 결제 시점에 예약이 자동으로 완료된다. 예약을 미리 'completed'로 만들어두면 주문이 연결되지
// 않는다 — 끝난 정비에 새 주문이 붙으면 안 되므로 그게 올바른 동작이다.
async function visitWithOrder(store, carNumber, serviceType) {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const reservation = await prisma.reservation.create({
    data: {
      storeId: store.id, carNumber, phone: '01012345678',
      serviceType, queueNumber: Math.floor(Math.random() * 9000) + 1000,
      serviceDate: today, status: 'called', calledAt: new Date(),
    },
  })
  const body = validBody(store, { carNumber })
  const created = await postCart(body)
  assert.equal(created.status, 201)
  assert.equal(created.body.linkedReservation, true, '방문 생성 시 예약이 연결되지 않았습니다')

  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })
  await request(app).post(`/api/pos/erp-carts/${cartId}/paid`).set('X-Store-Token', store.posToken).send({})
  return { reservation, cartId }
}

testSerial('이력: 차량번호로 지난 방문과 품목이 나온다', async () => {
  const store = await createStore('hist-basic')
  await visitWithOrder(store, '12가3456', '엔진오일 교환')

  const res = await getHistory(store, '12가3456')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.visits.length >= 1, true)

  const visit = res.body.visits[0]
  assert.equal(visit.serviceType, '엔진오일 교환')
  assert.equal(visit.orders.length, 1)
  assert.equal(visit.orders[0].items[0].name, '엔진오일 5W30 (4L)')
  assert.equal(visit.orders[0].paid, true)
})

testSerial('이력: 전화번호는 돌려주지 않는다', async () => {
  // 이력 확인에 필요 없는 개인정보다. 목적 밖 이용이 되지 않게 응답에서 뺀다.
  const store = await createStore('hist-nophone')
  await visitWithOrder(store, '22나2222', '타이어 교체')

  const res = await getHistory(store, '22나2222')
  const raw = JSON.stringify(res.body)
  assert.equal(raw.includes('01012345678'), false, '전화번호가 응답에 들어 있습니다')
  assert.equal(raw.includes('phone'), false, 'phone 필드가 응답에 있습니다')
})

testSerial('이력: 다른 매장 이력은 보이지 않는다', async () => {
  const storeA = await createStore('hist-owner')
  const storeB = await createStore('hist-other')
  await visitWithOrder(storeA, '33다3333', '배터리 교체')

  const res = await getHistory(storeB, '33다3333')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.visits, [])
})

testSerial('이력: 파기(익명화)된 건은 검색되지 않는다', async () => {
  // 보관기간이 지나면 carNumber가 덮이므로 애초에 조회에 걸리지 않는다.
  // "지웠다고 해놓고 조회에는 남아 있는" 상황이 구조적으로 생기지 않아야 한다.
  const store = await createStore('hist-purged')
  const { reservation } = await visitWithOrder(store, '44라4444', '정기점검')

  const before = await getHistory(store, '44라4444')
  assert.equal(before.body.visits.length >= 1, true)

  await prisma.reservation.update({
    where: { id: reservation.id },
    data: { carNumber: '삭제됨', phone: '0100000000', anonymizedAt: new Date() },
  })
  await prisma.erpCart.updateMany({ where: { storeId: store.id }, data: { carNumber: null, memo: null } })

  const after = await getHistory(store, '44라4444')
  assert.deepEqual(after.body.visits, [], '파기된 기록이 아직 조회됩니다')
})

testSerial('이력: 표기가 달라도(공백) 같은 차로 찾는다', async () => {
  const store = await createStore('hist-spaces')
  await visitWithOrder(store, '55마5555', '브레이크 패드')
  const res = await getHistory(store, '55마 5555')
  assert.equal(res.body.visits.length >= 1, true)
})

testSerial('이력: 예약 없이 온 손님의 전산 주문도 이력에 남는다', async () => {
  // 예약을 안 하고 그냥 온 손님도 정비는 받았다. 예약 기준으로만 묶으면 이 건이 사라진다.
  const store = await createStore('hist-walkin')
  const body = validBody(store, { carNumber: '66바6666' })
  assert.equal((await postCart(body)).body.linkedReservation, false)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })

  const res = await getHistory(store, '66바6666')
  assert.equal(res.body.visits.length, 1)
  assert.equal(res.body.visits[0].kind, 'order')
  assert.equal(res.body.visits[0].orders[0].items.length, 1)
})

testSerial('이력: 담기지 않은(pending) 주문은 이력에 넣지 않는다', async () => {
  // 아직 POS에 담기지도 않은 건은 "정비했다"고 볼 수 없다.
  const store = await createStore('hist-pending')
  assert.equal((await postCart(validBody(store, { carNumber: '77사7777' }))).status, 201)

  const res = await getHistory(store, '77사7777')
  assert.deepEqual(res.body.visits, [])
})

testSerial('이력: 차량번호 없이 부르면 400', async () => {
  const store = await createStore('hist-nocar')
  const res = await request(app).get('/api/pos/history').set('X-Store-Token', store.posToken)
  assert.equal(res.status, 400)
})

testSerial('이력: 매장 토큰 없이는 볼 수 없다', async () => {
  const res = await request(app).get('/api/pos/history?carNumber=12가3456')
  assert.equal(res.status, 401)
})

// --- 홍보 메시지 수동 발송 -----------------------------------------------------
// 광고성 정보 전송은 정보통신망법 제50조의 규제를 받는다. 직원이 버튼으로 보내는 경로는
// 자동 발송과 달리 반복 클릭과 요청 위조가 가능하므로, 차단이 **서버에서** 걸려야 한다.
// 아래 테스트는 화면이 아니라 API를 직접 두드려서 그걸 확인한다.

function promoEligibility(store, carNumber) {
  return request(app)
    .get('/api/pos/promo/eligibility?carNumber=' + encodeURIComponent(carNumber))
    .set('X-Store-Token', store.posToken)
}

function promoSend(store, carNumber) {
  return request(app).post('/api/pos/promo/send')
    .set('X-Store-Token', store.posToken)
    .send({ carNumber })
}

// 야간 차단 때문에 실행 시각에 따라 결과가 달라진다. 낮 시간이 아니면 그 테스트는 건너뛴다.
function isDaytimeKst() {
  const h = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours()
  return h >= 8 && h < 21
}

async function customerWithConsent(store, carNumber, marketing) {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  return prisma.reservation.create({
    data: {
      storeId: store.id, carNumber, phone: '01099998888',
      serviceType: '엔진오일', queueNumber: Math.floor(Math.random() * 9000) + 1000,
      serviceDate: today, status: 'completed', completedAt: new Date(),
      privacyConsentAt: new Date(),
      marketingConsentAt: marketing ? new Date() : null,
    },
  })
}

testSerial('홍보: 광고 수신에 동의하지 않은 손님에게는 보낼 수 없다', async () => {
  // 화면에서만 막으면 요청을 직접 만들어 우회할 수 있다. 서버가 거부해야 한다.
  const store = await createStore('promo-noconsent')
  await customerWithConsent(store, '11가1111', false)

  const el = await promoEligibility(store, '11가1111')
  assert.equal(el.body.canSend, false)
  assert.equal(el.body.reason, 'no_consent')

  const send = await promoSend(store, '11가1111')
  assert.equal(send.status, 403, JSON.stringify(send.body))
  assert.equal(send.body.reason, 'no_consent')

  const sends = await prisma.promoSend.count({ where: { storeId: store.id } })
  assert.equal(sends, 0, '발송 기록이 남았습니다')
})

testSerial('홍보: 방문 기록이 없는 차량에는 보낼 수 없다', async () => {
  const store = await createStore('promo-norecord')
  const send = await promoSend(store, '99하9999')
  assert.equal(send.status, 403)
  assert.equal(send.body.reason, 'no_record')
})

testSerial('홍보: 가장 최근 방문의 의사를 따른다(옛 동의로 보내지 않는다)', async () => {
  // 예전에 동의했더라도 마지막 방문에서 동의하지 않았다면 그게 지금의 의사다.
  const store = await createStore('promo-latest')
  const old = await customerWithConsent(store, '22나2222', true)
  await prisma.reservation.update({
    where: { id: old.id },
    data: { createdAt: new Date(Date.now() - 60 * 86400000) },
  })
  await customerWithConsent(store, '22나2222', false) // 최근 방문에서는 미동의

  const el = await promoEligibility(store, '22나2222')
  assert.equal(el.body.canSend, false)
  assert.equal(el.body.reason, 'no_consent')
})

testSerial('홍보: 30일 안에는 같은 차에 다시 보낼 수 없다', async () => {
  const store = await createStore('promo-throttle')
  await customerWithConsent(store, '33다3333', true)
  await prisma.promoSend.create({
    data: { storeId: store.id, carNumber: '33다3333', phone: '01099998888', sentAt: new Date() },
  })

  const el = await promoEligibility(store, '33다3333')
  assert.equal(el.body.canSend, false)
  assert.equal(el.body.reason, 'recently_sent')

  const send = await promoSend(store, '33다3333')
  assert.equal(send.status, 403)
})

testSerial('홍보: 30일이 지나면 다시 보낼 수 있다', async () => {
  if (!isDaytimeKst()) return // 야간에는 어차피 막힌다
  const store = await createStore('promo-after30')
  await customerWithConsent(store, '44라4444', true)
  await prisma.promoSend.create({
    data: {
      storeId: store.id, carNumber: '44라4444', phone: '01099998888',
      sentAt: new Date(Date.now() - 40 * 86400000),
    },
  })

  const el = await promoEligibility(store, '44라4444')
  assert.equal(el.body.canSend, true, JSON.stringify(el.body))
})

testSerial('홍보: 다른 매장 손님에게는 보낼 수 없다', async () => {
  const storeA = await createStore('promo-owner')
  const storeB = await createStore('promo-other')
  await customerWithConsent(storeA, '55마5555', true)

  const el = await promoEligibility(storeB, '55마5555')
  assert.equal(el.body.canSend, false)
  assert.equal(el.body.reason, 'no_record')
})

testSerial('홍보: 파기(익명화)된 손님에게는 보낼 수 없다', async () => {
  const store = await createStore('promo-purged')
  const r = await customerWithConsent(store, '66바6666', true)
  await prisma.reservation.update({
    where: { id: r.id },
    data: { carNumber: '삭제됨', phone: '0100000000', anonymizedAt: new Date() },
  })

  const el = await promoEligibility(store, '66바6666')
  assert.equal(el.body.canSend, false)
  assert.equal(el.body.reason, 'no_record')
})

testSerial('홍보: 매장 토큰 없이는 부를 수 없다', async () => {
  const el = await request(app).get('/api/pos/promo/eligibility?carNumber=12가3456')
  assert.equal(el.status, 401)
  const send = await request(app).post('/api/pos/promo/send').send({ carNumber: '12가3456' })
  assert.equal(send.status, 401)
})

testSerial('홍보: 차량번호 없이 부르면 400', async () => {
  const store = await createStore('promo-nocar')
  assert.equal((await request(app).get('/api/pos/promo/eligibility').set('X-Store-Token', store.posToken)).status, 400)
  assert.equal((await request(app).post('/api/pos/promo/send').set('X-Store-Token', store.posToken).send({})).status, 400)
})

testSerial('개인정보 파기: 홍보 발송 기록의 전화번호도 지운다', async () => {
  // 발송 기록에도 전화번호·차량번호가 남는다. 레코드는 남기고(발송 통계·감사 근거)
  // 개인을 식별하는 부분만 지운다.
  const store = await createStore('promo-purge-log')
  await prisma.promoSend.create({
    data: {
      storeId: store.id, carNumber: '77사7777', phone: '01099998888',
      sentAt: new Date(Date.now() - 4000 * 86400000),
    },
  })

  const result = await purgeExpiredPersonalData()
  assert.equal(result.promoSends >= 1, true, JSON.stringify(result))

  const row = await prisma.promoSend.findFirst({ where: { storeId: store.id } })
  assert.equal(row.phone, null)
  assert.equal(row.carNumber, null)
  assert.equal(row.anonymizedAt instanceof Date, true)
})

testSerial('POS 오늘 현황: 접수·완료·전산주문·결제액이 나온다', async () => {
  // 매장 직원이 관리자 웹에 들어가지 않고 "오늘 몇 대 봤나"를 확인하는 화면의 데이터.
  const store = await createStore('possummary')
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  for (const [car, st, q] of [['12가3456', 'waiting', 1], ['34나5678', 'completed', 2]]) {
    await prisma.reservation.create({
      data: {
        storeId: store.id, carNumber: car, phone: '01012345678', serviceType: '엔진오일',
        queueNumber: q, serviceDate: today, status: st,
        completedAt: st === 'completed' ? new Date() : null,
      },
    })
  }
  const body = validBody(store)
  assert.equal((await postCart(body)).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })
  await request(app).post(`/api/pos/erp-carts/${cartId}/paid`).set('X-Store-Token', store.posToken).send({})

  const res = await request(app).get('/api/pos/summary').set('X-Store-Token', store.posToken)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.serviceDate, today)
  assert.equal(res.body.received, 2)
  assert.equal(res.body.completed, 1)
  assert.equal(res.body.erpCarts, 1)
  assert.equal(res.body.erpCartsPaid, 1)
  assert.equal(res.body.paidAmount, body.totalAmount)
})

testSerial('POS 오늘 현황: 다른 매장 숫자가 섞이지 않는다', async () => {
  const storeA = await createStore('possummary-a')
  const storeB = await createStore('possummary-b')
  assert.equal((await postCart(validBody(storeA))).status, 201)

  const res = await request(app).get('/api/pos/summary').set('X-Store-Token', storeB.posToken)
  assert.equal(res.body.erpCarts, 0)
  assert.equal(res.body.received, 0)
})

// --- 매장 격리 --------------------------------------------------------------
// 400개 가맹점이 한 서버를 쓴다. 남의 매장 레코드 id를 들고 왔을 때 막지 못하면
// 남의 주문을 처리완료로 만들거나 남의 대기열을 지울 수 있다. id가 UUID라 추측이 어렵다는 것은
// 방어가 아니다 — 로그·화면·전산 연동 어디서든 새어나올 수 있다.

testSerial('격리: 남의 매장 전산 주문을 consume 할 수 없다', async () => {
  const victim = await createStore('iso-victim-1')
  const attacker = await createStore('iso-attacker-1')
  assert.equal((await postCart(validBody(victim))).status, 201)
  const victimCartId = (await getPosCarts(victim)).body.carts[0].id

  const res = await consumeCart(attacker, victimCartId, { result: 'loaded' })
  assert.equal(res.status === 200, false, `남의 주문을 처리했다: ${res.status} ${JSON.stringify(res.body)}`)

  // 피해 매장 쪽은 아무 일도 없어야 한다.
  const after = await getPosCarts(victim)
  assert.equal(after.body.carts.length, 1, '피해 매장의 주문이 사라졌다')
})

testSerial('격리: 남의 매장 전산 주문을 결제완료로 만들 수 없다', async () => {
  const victim = await createStore('iso-victim-2')
  const attacker = await createStore('iso-attacker-2')
  assert.equal((await postCart(validBody(victim))).status, 201)
  const victimCartId = (await getPosCarts(victim)).body.carts[0].id
  await consumeCart(victim, victimCartId, { result: 'loaded' })

  const res = await request(app)
    .post(`/api/pos/erp-carts/${victimCartId}/paid`)
    .set('X-Store-Token', attacker.posToken)
    .send({})
  assert.equal(res.status === 200, false, `남의 주문을 결제완료로 만들었다: ${res.status}`)

  const cart = await prisma.erpCart.findUnique({ where: { id: victimCartId } })
  assert.equal(cart.status, 'loaded', `상태가 바뀌었다: ${cart.status}`)
})

testSerial('격리: 남의 매장 대기 손님을 완료/취소/호출할 수 없다', async () => {
  const victim = await createStore('iso-victim-3')
  const attacker = await createStore('iso-attacker-3')
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const reservation = await prisma.reservation.create({
    data: {
      storeId: victim.id, carNumber: '12가3456', phone: '01012345678',
      serviceType: 'oil', queueNumber: 7, serviceDate: today, status: 'waiting',
      privacyConsentAt: new Date(),
    },
  })

  for (const action of ['call', 'complete', 'cancel']) {
    const res = await request(app)
      .post(`/api/pos/queue/${reservation.id}/${action}`)
      .set('X-Store-Token', attacker.posToken)
      .send({})
    assert.equal(res.status === 200, false, `남의 대기 손님에 ${action}이 통했다: ${res.status}`)
  }

  const after = await prisma.reservation.findUnique({ where: { id: reservation.id } })
  assert.equal(after.status, 'waiting', `상태가 바뀌었다: ${after.status}`)
})

testSerial('격리: 남의 매장 차량 이력을 조회할 수 없다', async () => {
  const victim = await createStore('iso-victim-4')
  const attacker = await createStore('iso-attacker-4')
  assert.equal((await postCart(validBody(victim, { carNumber: '12가3456' }))).status, 201)
  const cartId = (await getPosCarts(victim)).body.carts[0].id
  await consumeCart(victim, cartId, { result: 'loaded' })

  const res = await request(app)
    .get('/api/pos/history?carNumber=' + encodeURIComponent('12가3456'))
    .set('X-Store-Token', attacker.posToken)
  assert.equal(res.status, 200)
  assert.equal(res.body.visits.length, 0, '남의 매장 손님 이력이 보였다')
})

testSerial('격리: 남의 매장 손님에게 홍보문자를 보낼 수 없다', async () => {
  const victim = await createStore('iso-victim-5')
  const attacker = await createStore('iso-attacker-5')
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  await prisma.reservation.create({
    data: {
      storeId: victim.id, carNumber: '12가3456', phone: '01012345678',
      serviceType: 'oil', queueNumber: 8, serviceDate: today, status: 'completed',
      privacyConsentAt: new Date(), marketingConsentAt: new Date(), completedAt: new Date(),
    },
  })

  const res = await request(app)
    .post('/api/pos/promo/send')
    .set('X-Store-Token', attacker.posToken)
    .send({ carNumber: '12가3456' })
  assert.equal(res.status === 200, false, `남의 손님에게 문자를 보냈다: ${res.status} ${JSON.stringify(res.body)}`)
})

// --- 최근 정비 이력 ------------------------------------------------------------
// 이력 화면을 열자마자 보이는 목록. 이게 없으면 차량번호를 이미 아는 직원만 쓸 수 있는
// 검색창이라 "이력이 안 남는다"로 읽힌다.

function getRecent(store) {
  return request(app).get('/api/pos/history/recent').set('X-Store-Token', store.posToken)
}

testSerial('최근 이력: 담긴 전산 주문이 차량번호와 함께 나온다', async () => {
  const store = await createStore('recent-basic')
  const body = validBody(store, { carNumber: '12가3456' })
  assert.equal((await postCart(body)).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })

  const res = await getRecent(store)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.visits.length, 1)
  const v = res.body.visits[0]
  assert.equal(v.carNumber, '12가3456')
  assert.equal(v.paid, false)
  assert.equal(v.totalAmount, body.totalAmount)
  assert.equal(v.items.length > 0, true)
  assert.equal(typeof v.items[0].name, 'string')
})

testSerial('최근 이력: 아직 안 담은(pending) 주문은 나오지 않는다', async () => {
  const store = await createStore('recent-pending')
  assert.equal((await postCart(validBody(store, { carNumber: '12가3456' }))).status, 201)

  const res = await getRecent(store)
  assert.equal(res.body.visits.length, 0)
})

testSerial('최근 이력: 차량번호가 없는 주문은 나오지 않는다', async () => {
  const store = await createStore('recent-nocar')
  const body = validBody(store)
  delete body.carNumber
  assert.equal((await postCart(body)).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })

  const res = await getRecent(store)
  assert.equal(res.body.visits.length, 0, '차를 특정할 수 없는 건은 이력에서 쓸모가 없다')
})

testSerial('최근 이력: 결제까지 끝난 건은 paid로 표시된다', async () => {
  const store = await createStore('recent-paid')
  assert.equal((await postCart(validBody(store, { carNumber: '12가3456' }))).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })
  await request(app).post(`/api/pos/erp-carts/${cartId}/paid`).set('X-Store-Token', store.posToken).send({})

  const res = await getRecent(store)
  assert.equal(res.body.visits.length, 1)
  assert.equal(res.body.visits[0].paid, true)
})

testSerial('최근 이력: 다른 매장 건이 섞이지 않는다', async () => {
  const storeA = await createStore('recent-a')
  const storeB = await createStore('recent-b')
  assert.equal((await postCart(validBody(storeA, { carNumber: '12가3456' }))).status, 201)
  const cartId = (await getPosCarts(storeA)).body.carts[0].id
  await consumeCart(storeA, cartId, { result: 'loaded' })

  const res = await getRecent(storeB)
  assert.equal(res.body.visits.length, 0)
})

testSerial('최근 이력: 전화번호는 절대 실려 나오지 않는다', async () => {
  const store = await createStore('recent-privacy')
  assert.equal((await postCart(validBody(store, { carNumber: '12가3456' }))).status, 201)
  const cartId = (await getPosCarts(store)).body.carts[0].id
  await consumeCart(store, cartId, { result: 'loaded' })

  const res = await getRecent(store)
  // 이용 목적은 "정비 이력 관리"다. 연락처는 그 목적에 필요하지 않으므로 나가면 안 된다.
  assert.equal(JSON.stringify(res.body).includes('01012345678'), false)
  assert.equal(JSON.stringify(res.body).includes('phone'), false)
})

testSerial('최근 이력: 매장 토큰 없이는 볼 수 없다', async () => {
  const res = await request(app).get('/api/pos/history/recent')
  assert.equal(res.status, 401)
})

testSerial('POS 오늘 현황: 매장 토큰 없이는 볼 수 없다', async () => {
  const res = await request(app).get('/api/pos/summary')
  assert.equal(res.status, 401)
})
