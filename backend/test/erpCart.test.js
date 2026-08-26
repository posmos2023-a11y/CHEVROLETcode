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
