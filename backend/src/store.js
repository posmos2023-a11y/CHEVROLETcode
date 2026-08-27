// Design Ref: docs/02-design/features/multi-store-support.design.md §2.0 (Option C)
// DB 데이터 계층. 예전 인메모리 버전과 export 함수 시그니처를 그대로 유지한 채
// 내부만 Prisma(Client)로 교체했다 — server.js는 await만 붙이면 그대로 동작한다.
// 로컬/프로토타입은 SQLite(.env의 DATABASE_URL=file:./dev.db), 운영 전환 시
// DATABASE_URL을 Postgres로 바꾸고 prisma/schema.prisma의 provider를 postgresql로 바꾼 뒤
// `npx prisma migrate dev`를 다시 실행하면 된다 (docs/multi-store-architecture-review.md 참고).

const { PrismaClient } = require('@prisma/client')
const crypto = require('node:crypto')
const { hashPassword } = require('./auth')

// 인스턴스당 커넥션 풀 상한.
//
// Prisma 기본값은 `물리 CPU 수 * 2 + 1`이라 1 vCPU면 3, 2 vCPU면 5, 4 vCPU면 9다. 문제는
// 인스턴스마다 자기 풀을 따로 잡는다는 것 — 실제로 DB가 감당해야 하는 건
// `인스턴스 수 × 풀 크기`다. Cloud SQL max_connections가 100 안팎(.env.example 참고)이므로
// 기본값 그대로 두면 1 vCPU는 33대, 2 vCPU는 20대, 4 vCPU는 11대에서 커넥션이 바닥나고,
// 그 순간 전 매장이 동시에 실패한다.
//
// ⚠️ 이 값만으로는 못 막는다. Cloud Run은 최대 인스턴스 수를 정하지 않으면 100대까지 늘어나므로
// **최대 인스턴스 수를 반드시 콘솔에서 정해야** 이 계산이 성립한다. 정해야 할 값은
//   connection_limit ≤ (Cloud SQL max_connections - 여유분) ÷ Cloud Run 최대 인스턴스 수
// 이고, 여유분은 마이그레이션·관리 접속용으로 20 정도를 빼둔다.
//
// 기본값 5의 근거: docs/gcp-migration-and-scale-plan.md의 배포 계획이 최대 인스턴스 5대이고
// .env.example도 connection_limit=5를 예시로 쓴다. 5대 × 5 = 25로 한도(~100)에 크게 여유가
// 있고, 나중에 16대까지 늘려도 80이라 여유분 안에 들어온다.
// DATABASE_URL에 이미 값이 박혀 있으면(운영자가 직접 조정해둔 경우) 그 값을 존중한다.
// DB_CONNECTION_LIMIT 환경변수로도 조정할 수 있다.
const DEFAULT_DB_CONNECTION_LIMIT = 5

// 쿼리 하나가 DB 쪽에서 응답 없이 멈추면(예: 락 대기, DB 과부하) 그 쿼리를 붙든 커넥션이 영원히
// 반환되지 않아 풀이 마르고, 결국 같은 DB를 보는 모든 인스턴스의 /health/ready가 동시에 죽어
// 우회할 인스턴스가 없어진다. Prisma 5.22에는 "쿼리 타임아웃" 옵션이 PrismaClient 생성자에
// 없다(트랜잭션 timeout/maxWait만 있고 일반 쿼리엔 적용 안 됨 — node_modules/@prisma/client의
// 타입 정의로 확인). 대신 Postgres 연결 문자열의 `options=-c statement_timeout=<ms>` libpq
// 파라미터로 세션 자체에 상한을 걸면 Postgres가 서버 쪽에서 직접 쿼리를 취소한다(클라이언트가
// 기다리다 포기하는 게 아니라 진짜로 취소되어 커넥션이 즉시 반환됨) — pg_sleep(6)에
// statement_timeout=2000을 걸어 실측: 약 2초 뒤 `error 57014 canceling statement due to
// statement timeout`로 취소되고, 같은 커넥션이 바로 다음 쿼리에 재사용 가능함을 확인했다(작업
// 보고 참고). 참고로 Prisma가 인식하는 `socket_timeout` 파라미터도 시도해봤으나, 그건 클라이언트가
// 응답을 기다리다 포기할 뿐 Postgres 쪽 쿼리 자체는 취소되지 않아(pg_stat_activity로 확인)
// 커넥션이 실제로 풀리지 않는다 — 그래서 채택하지 않았다.
const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 10000

// DATABASE_URL은 Secret Manager에서 오므로(운영 환경변수) 코드에서 connection_limit/
// statement_timeout을 붙이는 게 맞다 — 이미 값이 있으면(운영자가 직접 튜닝해둔 경우) 그대로 둔다.
function buildDatabaseUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) return raw // 없으면 Prisma가 자체적으로 명확한 에러를 던지게 둔다.

  let url
  try {
    url = new URL(raw)
  } catch {
    return raw // 파싱 안 되는 값이면 그대로 넘겨 Prisma의 에러 메시지를 보게 한다.
  }

  if (!url.searchParams.has('connection_limit')) {
    const limit = Number(process.env.DB_CONNECTION_LIMIT) || DEFAULT_DB_CONNECTION_LIMIT
    url.searchParams.set('connection_limit', String(limit))
  }
  if (!url.searchParams.has('options')) {
    const timeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS) || DEFAULT_DB_STATEMENT_TIMEOUT_MS
    url.searchParams.set('options', `-c statement_timeout=${timeoutMs}`)
  }
  return url.toString()
}

const prisma = new PrismaClient({ datasources: { db: { url: buildDatabaseUrl() } } })

// /health/ready의 DB 핑 전용. 위 statement_timeout이 이미 모든 쿼리(이 핑 포함)에 상한을
// 걸어두지만, 레디니스 프로브는 그보다 더 짧고 확정적인 상한이 필요하다(그 값까지 기다리면
// 이미 느려진 인스턴스를 트래픽에서 빼는 게 늦어진다). 그래서 JS 쪽에서 한 번 더 Promise.race로
// 감싼다 — 다만 이 race는 클라이언트가 기다리길 포기하는 것뿐이고 언더라잉 쿼리 취소는 여전히
// 위 statement_timeout에 의존한다(SELECT 1 하나라 실질적 위험은 낮음). server.js의
// /health/ready 배선은 이번 작업 범위가 아니라(동시 작업 중) 여기서는 export만 해둔다.
const DEFAULT_HEALTH_PING_TIMEOUT_MS = 3000
async function pingDatabaseReady(timeoutMs) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_HEALTH_PING_TIMEOUT_MS
  let timer
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DB ping이 ${ms}ms 안에 응답하지 않았습니다.`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// 매장 영업일은 한국 시간(KST, UTC+9) 자정 기준으로 리셋되어야 한다. `new Date().toISOString()`을
// 그대로 쓰면 UTC 자정(=KST 오전 9시) 기준이 되어 새벽 시간대 예약의 날짜 경계가 어긋난다.
function kstDateString(d = new Date()) {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function kstDayStartUtc(dateStr) {
  return new Date(`${dateStr}T00:00:00+09:00`)
}

// Payment에는 serviceDate 컬럼이 없어서(결제는 예약과 달리 "당일 접수" 개념이 없음) 날짜로
// 필터링하려면 createdAt을 KST 기준 하루 범위(UTC 두 시점)로 변환해야 한다. Prisma의 `gte`/`lt`
// 범위 비교로 넘기면 DB 인덱스를 그대로 탈 수 있어(함수 변환 없이) storeId+createdAt 인덱스가 먹는다.
function kstDateRangeUtc(dateStr) {
  const start = kstDayStartUtc(dateStr)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

// 정비가 끝났거나(completed) 취소된(cancelled) 예약은 "지금 대기열에 남아있는 손님" 계산에서
// 항상 제외한다. peopleAhead 계산과 POS 대기열 조회가 이 규칙을 공유한다.
const CLOSED_RESERVATION_STATUSES = ['completed', 'cancelled']

// Plan SC: FR-07 — 최초 부팅 시 본사(hq_admin) 계정이 하나도 없으면 자동 생성한다.
// 비밀번호는 ADMIN_BOOTSTRAP_PASSWORD가 있으면 그 값을, 없으면 무작위로 생성해 콘솔에 한 번만 출력한다.
async function ensureDefaultHqAdmin() {
  const existing = await prisma.adminUser.findFirst({ where: { role: 'hq_admin' } })
  if (existing) return

  if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_BOOTSTRAP_EMAIL || !process.env.ADMIN_BOOTSTRAP_PASSWORD)) {
    throw new Error('운영 환경에서 첫 본사 관리자 계정을 만들려면 ADMIN_BOOTSTRAP_EMAIL/PASSWORD가 필요합니다.')
  }

  const email = process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@local'
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || crypto.randomBytes(9).toString('base64url')
  const passwordHash = await hashPassword(password)

  await prisma.adminUser.create({
    data: { email, passwordHash, role: 'hq_admin', storeId: null },
  })

  console.log('='.repeat(60))
  console.log('[bootstrap] 본사 관리자 계정이 생성되었습니다. 최초 1회만 출력됩니다.')
  console.log(`  이메일: ${email}`)
  if (!process.env.ADMIN_BOOTSTRAP_PASSWORD) {
    console.log(`  비밀번호(무작위 생성): ${password}`)
    console.log('  -> .env에 ADMIN_BOOTSTRAP_PASSWORD로 고정값을 지정하면 재생성 시에도 동일 비밀번호를 씁니다.')
  } else {
    console.log('  비밀번호: .env의 ADMIN_BOOTSTRAP_PASSWORD 값 사용')
  }
  console.log('='.repeat(60))
}

function findAdminUserByEmail(email) {
  return prisma.adminUser.findUnique({ where: { email } })
}

function getAdminUser(id) {
  return prisma.adminUser.findUnique({ where: { id } })
}

function createAdminUser({ email, passwordHash, role, storeId }) {
  return prisma.adminUser.create({ data: { email, passwordHash, role, storeId: storeId || null } })
}

// 로그인 성공 시 lastLoginAt을 갱신하는 김에 계정 잠금 카운터도 함께 초기화한다(§3.22).
// 실패가 몇 번 쌓여 있었더라도 결국 올바른 비밀번호로 들어오면 그 이력은 더 이상 의미가 없다.
async function markAdminLogin(id) {
  try {
    return await prisma.adminUser.update({
      where: { id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    })
  } catch {
    return null
  }
}

const MAX_FAILED_LOGIN_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000

// 로그인 비밀번호가 틀렸을 때 호출한다. 5회가 누적되면 15분 잠금을 건다.
// 존재하지 않는 이메일은 이 함수를 아예 타지 않는다(server.js가 findAdminUserByEmail로 계정을
// 먼저 찾은 뒤에만 호출) — 그래야 "계정이 있는데 잠겼다(423)"와 "계정이 없다(401)"를 구분하지 않고
// 없는 계정은 항상 기존과 동일한 401만 돌려줘서 계정 존재 여부가 새어나가지 않는다.
// 로그인한 사람이 자기 비밀번호를 바꾼다. 잠금 카운터도 함께 푼다 — 실패가 쌓인 상태로
// 비밀번호만 바꾸면 새 비밀번호로도 423에 막혀서 "바꿨는데 왜 안 되지"가 된다.
async function changeAdminPassword(id, passwordHash) {
  try {
    return await prisma.adminUser.update({
      where: { id },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    })
  } catch {
    return null
  }
}

async function recordFailedLogin(id) {
  try {
    const current = await prisma.adminUser.findUnique({ where: { id } })
    if (!current) return

    // 잠금이 이미 풀린 뒤의 실패는 카운터를 0부터 다시 센다.
    // 단순 increment만 하면 failedLoginCount가 5에 머물러 있어서, 15분 잠금이 풀린 직후
    // 비밀번호를 한 번만 잘못 쳐도 곧바로 6이 되어 또 15분간 잠기는 문제가 생긴다
    // (정상 사용자가 오타 한 번에 계속 묶이는 상황). 잠금은 "짧은 시간에 5회"를 막기 위한
    // 것이지 "한 번 잠긴 계정을 계속 잠가두기" 위한 게 아니다.
    const lockExpired = current.lockedUntil ? current.lockedUntil.getTime() <= Date.now() : false
    const nextCount = (lockExpired ? 0 : current.failedLoginCount) + 1
    const locking = nextCount >= MAX_FAILED_LOGIN_ATTEMPTS

    await prisma.adminUser.update({
      where: { id },
      data: {
        failedLoginCount: nextCount,
        lockedUntil: locking ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
      },
    })
  } catch {
    // 잠금 카운터 갱신이 실패해도 로그인 실패 응답 자체(401)는 정상적으로 나가야 하므로 삼킨다.
  }
}

// 로컬 개발/토스프론트 미리보기용 기본 가맹점.
// sdk.js의 overrides({ merchant: { id: 0, ... } })와 짝을 맞춘 값이라, 서버를 새로 띄워도
// 로컬 브라우저 미리보기(merchantId=0)가 바로 동작한다. upsert라 여러 번 불려도 안전하다.
// Plan SC: FR-06 — 서버 재시작 후에도 매장이 남아있는지 확인하는 시드 데이터(§8.5).
async function ensureDefaultStore() {
  // 테스트 merchantId=0은 로컬 미리보기 전용이다. Cloud Run 운영 컨테이너에서
  // 자동 시드되면 실제 매장 등록 정책을 우회하므로 production에서는 만들지 않는다.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_STORE !== 'true') return
  await prisma.store.upsert({
    where: { merchantId: '0' },
    update: {},
    create: { merchantId: '0', name: '쉐보레 대리점 (테스트)', businessNumber: '0000000000', posToken: generatePosToken() },
  })
}

// POS 탭앱 인증 토큰(64자 hex). crypto.randomBytes(32)는 브라우저가 아닌 서버(Node)에서만
// 돌기 때문에 예측 불가능성이 필요한 이 토큰 발급에 적합하다(Math.random 금지).
function generatePosToken() {
  return crypto.randomBytes(32).toString('hex')
}

function createStore({ merchantId, name, businessNumber, posToken }) {
  return prisma.store.create({
    data: {
      merchantId: String(merchantId),
      name,
      businessNumber: businessNumber || null,
      posToken: posToken || generatePosToken(),
    },
  })
}

function listStores() {
  return prisma.store.findMany()
}

// Design Ref: Phase 4 대량 온보딩. 각 항목을 개별 트랜잭션으로 처리해서 하나가 실패(중복 merchantId 등)해도
// 나머지는 계속 등록되고, 항목별 성공/실패를 그대로 돌려준다.
async function bulkCreateStores(items) {
  const results = []
  for (const item of items) {
    const merchantId = String(item.merchantId ?? '').trim()
    const name = String(item.name ?? '').trim()
    const businessNumber = String(item.businessNumber ?? '').trim()
    if (!merchantId || !name) {
      results.push({ merchantId, ok: false, error: 'merchantId/name이 필요합니다.' })
      continue
    }
    try {
      const store = await createStore({ merchantId, name, businessNumber })
      results.push({ merchantId, ok: true, store })
    } catch (e) {
      results.push({ merchantId, ok: false, error: '이미 등록된 merchantId이거나 저장에 실패했습니다.' })
    }
  }
  return results
}

function getStore(id) {
  return prisma.store.findUnique({ where: { id } })
}

function findStoreByMerchantId(merchantId) {
  if (merchantId === undefined || merchantId === null || merchantId === '') return null
  return prisma.store.findUnique({ where: { merchantId: String(merchantId) } })
}

// POS 탭앱 인증(§2.2). X-Store-Token 헤더 값으로 매장을 찾는다 — merchantId와 달리 이 토큰은
// 추측이 사실상 불가능해야 하므로(64자 hex, crypto.randomBytes(32)) 그 자체가 인증 수단이 된다.
function findStoreByPosToken(posToken) {
  if (!posToken) return null
  return prisma.store.findUnique({ where: { posToken } })
}

// hq_admin이 "토큰이 유출된 것 같다" 등의 이유로 특정 매장의 POS 토큰을 회전(재발급)할 때 쓴다.
// 예전 토큰은 즉시 무효화된다 — 매장 단말기는 새 토큰을 다시 입력받아야 한다(§3.20, §12).
async function rotatePosToken(storeId) {
  try {
    return await prisma.store.update({
      where: { id: storeId },
      data: { posToken: generatePosToken() },
    })
  } catch {
    return null
  }
}

// 본사 관리자가 토큰 값을 직접 지정할 때 쓴다. 무작위 64자 hex는 안전하지만 POS 단말기에서
// 손으로 입력하기가 사실상 불가능해서, 매장에 전달·입력하기 쉬운 값을 관리자가 정할 수 있게 한다.
// 다만 이 토큰 자체가 /api/pos/* 의 유일한 인증 수단이라 짧거나 뻔한 값을 쓰면 원래 취약점으로
// 되돌아간다 — 그래서 길이/문자 제약은 서버(validatePosToken)에서 강제한다.
// 다른 매장이 이미 쓰는 값이면 unique 제약(P2002)에 걸리므로 호출부가 409로 변환할 수 있게
// 코드를 붙여 던진다(조용히 null을 반환하면 "매장 없음"과 구분이 안 된다).
async function setPosToken(storeId, posToken) {
  try {
    return await prisma.store.update({ where: { id: storeId }, data: { posToken } })
  } catch (e) {
    if (e?.code === 'P2002') {
      const conflict = new Error('다른 매장이 이미 사용 중인 토큰입니다.')
      conflict.code = 'POS_TOKEN_TAKEN'
      throw conflict
    }
    return null
  }
}

// 매장·날짜별 대기번호 채번을 원자적 UPSERT(INSERT ... ON CONFLICT ... DO UPDATE) 한 문장으로 처리한다.
// ⚠️ 예전 comment는 "이 함수 전체가 하나의 Prisma $transaction 안에 있으니 채번도 안전하게
// 직렬화된다"고 적혀 있었는데, 이는 틀린 설명이다 — Postgres의 기본 격리수준인 READ COMMITTED에서는
// 트랜잭션 내부의 일반 SELECT/count()가 다른 트랜잭션의 동시 실행을 막지 않는다(아무것도 잠그지 않는다).
// 실제로 오늘 첫 두 손님이 거의 동시에 접수하면, 두 트랜잭션 모두 "이 매장·오늘 날짜의 카운터가 아직
// 없음"을 보고 각자 counter=1로 새로 만들려다 하나가 QueueCounter의 unique(storeId,date) 제약(P2002)에
// 걸려 그대로 500을 손님에게 돌려주는 버그가 있었다(예전 findUnique -> create/update 2단계 방식).
// 그래서 카운터 증가는 "먼저 읽고 나중에 쓰는" 방식 대신, DB가 보장하는 단일 원자적 문장으로 바꿨다 —
// INSERT ... ON CONFLICT DO UPDATE는 실행되는 동안 해당 (storeId,date) 행에 row-level lock을 잡기
// 때문에, 동시에 들어온 두 요청이 진짜로 순서대로(하나가 커밋된 뒤 다른 하나가 그 값을 보고 +1) 처리되어
// 서로 다른 queueNumber를 받는다. 반면 peopleAhead(대기인원 안내)는 이런 정확한 직렬화가 필요 없는
// "손님에게 보여주는 대략적인 안내"일 뿐이라 count()를 그대로 둬도 문제없다 — 최악의 경우 대기인원
// 안내가 한두 명 오차 나는 정도이고, 실제 대기 순서(queueNumber)는 항상 정확하다.
async function createReservation({ storeId, carNumber, phone, serviceType, idempotencyKey, privacyConsentAt, marketingConsentAt }) {
  const today = kstDateString()
  try {
    return await prisma.$transaction(async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.reservation.findUnique({ where: { idempotencyKey } })
        if (existing) {
          if (existing.storeId !== storeId) {
            const conflict = new Error('Idempotency-Key가 다른 매장에서 이미 사용되었습니다.')
            conflict.code = 'IDEMPOTENCY_KEY_CONFLICT'
            throw conflict
          }
          const peopleAhead = await tx.reservation.count({
            where: {
              storeId,
              serviceDate: existing.serviceDate,
              status: { notIn: CLOSED_RESERVATION_STATUSES },
              createdAt: { lt: existing.createdAt },
            },
          })
          return { reservation: existing, peopleAhead, duplicate: true }
        }
      }

      const counterRows = await tx.$queryRaw`
        INSERT INTO "QueueCounter" ("id", "storeId", "date", "counter")
        VALUES (${crypto.randomUUID()}, ${storeId}, ${today}, 1)
        ON CONFLICT ("storeId", "date") DO UPDATE
        SET "counter" = "QueueCounter"."counter" + 1
        RETURNING "counter"
      `
      const queueNumber = Number(counterRows[0].counter)

      // 오늘(serviceDate) + 아직 끝나지 않은(완료/취소 제외) 예약 수 = 이 손님 앞에 몇 명이 있는지.
      const peopleAhead = await tx.reservation.count({
        where: { storeId, serviceDate: today, status: { notIn: CLOSED_RESERVATION_STATUSES } },
      })

      const reservation = await tx.reservation.create({
        data: {
          storeId,
          carNumber,
          phone,
          serviceType,
          queueNumber,
          serviceDate: today,
          idempotencyKey: idempotencyKey || null,
          status: 'waiting',
          privacyConsentAt: privacyConsentAt || null,
          marketingConsentAt: marketingConsentAt || null,
        },
      })

      return { reservation, peopleAhead, duplicate: false }
    })
  } catch (error) {
    // 두 요청이 같은 idempotency key로 동시에 들어오면 둘 다 사전 조회를 통과할 수 있다.
    // unique 제약에서 진 요청은 이미 생성된 예약을 반환해 재시도도 안전하게 만든다.
    if (error?.code === 'P2002' && idempotencyKey) {
      const existing = await prisma.reservation.findUnique({ where: { idempotencyKey } })
      if (existing?.storeId === storeId) {
        const peopleAhead = await prisma.reservation.count({
          where: {
            storeId,
            serviceDate: existing.serviceDate,
            status: { notIn: CLOSED_RESERVATION_STATUSES },
            createdAt: { lt: existing.createdAt },
          },
        })
        return { reservation: existing, peopleAhead, duplicate: true }
      }
    }
    throw error
  }
}

// storeId를 안 넘기면(관리자 "전체 매장 보기") 전체를 반환한다.
// ⚠️ 관리자 목록 화면(GET /api/reservations 등)은 더 이상 이 함수를 쓰지 않는다 — 전체를 메모리로
// 가져와 JS에서 필터링/역순 처리하면 매장·기간이 늘어날수록 응답이 느려지고 메모리를 낭비하기 때문에
// listReservationsPage로 교체했다(§6 페이지네이션). 이 함수는 기존 export 시그니처 보존을 위해 남겨둔다.
function listReservations(storeId) {
  return prisma.reservation.findMany({
    where: storeId ? { storeId } : undefined,
    orderBy: { createdAt: 'asc' },
  })
}

// 손님 검색(계약 v3 §3.1) OR절 공통 빌더. qRaw가 빈 문자열이면 필터를 아예 적용하지 않도록
// 호출부(listReservationsPage/listPaymentsPage)가 undefined를 받아 where에서 생략한다.
// ⚠️ contains는 앞뒤 와일드카드(부분일치)라 btree 인덱스를 타지 못한다 — 예: "%1234%" 검색은
// 인덱스 스캔이 아니라 시퀀셜 스캔이 된다. 매장당 데이터량이 크지 않고(단일 매장 관리자가 가끔
// 쓰는 조회) 빈도도 낮아 여기서는 허용하지만, 데이터가 크게 늘면 pg_trgm GIN 인덱스 등을
// 고려해야 한다.
function buildSearchOr(q) {
  const qRaw = String(q ?? '').trim()
  if (!qRaw) return null
  const qDigits = qRaw.replace(/\D/g, '')
  return {
    OR: [
      { carNumber: { contains: qRaw } },
      ...(qDigits ? [{ phone: { contains: qDigits } }] : []),
    ],
  }
}

// 예약 목록(관리자 화면) 페이지네이션 + 필터. count/필터/정렬을 전부 DB(Prisma)에 위임해서
// 매장이 많아지거나 기간이 길어져도 매 요청마다 전체 로우를 애플리케이션 메모리로 끌어오지 않는다.
async function listReservationsPage({ storeId, date, statuses, q, limit, offset }) {
  const where = {
    ...(storeId ? { storeId } : {}),
    ...(date ? { serviceDate: date } : {}),
    ...(statuses && statuses.length ? { status: { in: statuses } } : {}),
    ...(buildSearchOr(q) || {}),
  }
  const [total, items] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
  ])
  return { total, items }
}

// 결제 목록(관리자 화면) 페이지네이션 + 필터. Payment는 serviceDate가 없어서 date 필터는
// createdAt을 KST 하루 범위(dateStart~dateEnd, kstDateRangeUtc)로 변환해 넘겨받는다.
async function listPaymentsPage({ storeId, dateStart, dateEnd, statuses, q, limit, offset }) {
  const where = {
    ...(storeId ? { storeId } : {}),
    ...(dateStart && dateEnd ? { createdAt: { gte: dateStart, lt: dateEnd } } : {}),
    ...(statuses && statuses.length ? { status: { in: statuses } } : {}),
    ...(buildSearchOr(q) || {}),
  }
  const [total, items] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
  ])
  return { total, items }
}

// POS 탭앱 대기열 조회 전용(계약 v3 §4.1). 오늘(KST) serviceDate 접수분 전부 + 날짜와 무관하게
// 아직 끝나지 않은(called/notify_failed) 이월 건을 함께 돌려준다. 대기열을 "오늘 것만"으로
// 완전히 막으면 밤새 맡긴 차(어제 called 상태)를 다음날 POS에서 완료 처리할 수 없어지므로,
// 이미 호출까지 끝난(더 이상 "새로 호출"할 대상이 아닌) 이월 건만 예외로 섞는다 — 어제 waiting
// (노쇼로 추정되는 건)은 여전히 여기 뜨지 않는다. serviceDate 오름차순을 앞세워 이월 건이
// 위쪽에 보이게 하고, 그 안에서는 queueNumber 오름차순을 유지한다.
//
// 원래는 이 조건을 `(serviceDate=오늘 OR status IN(called,notify_failed))` 하나의 OR로 걸어
// 한 번의 findMany로 받았다. 문제: OR로 묶이면 `@@index([storeId, serviceDate, status])`를
// 안정적으로 타지 못한다 — 3년치(21,920행)를 시드해 통계(ANALYZE)가 없는 상태로 EXPLAIN
// ANALYZE를 떠보면 "Rows Removed by Filter: 21898"까지 나온다(20건 받으려고 그 매장 예약을
// 거의 다 훑음). 예약은 절대 삭제되지 않으므로(purgeExpiredReservations는 익명화만 함) 매장이
// 오래될수록 이 스캔량은 계속 커진다. OR을 없애 두 번의 findMany로 나누면 각각 인덱스의
// (storeId, serviceDate) / (storeId, status) 접두어를 그대로 태울 수 있다. 결과는 20~40건
// 수준이라 JS에서 합쳐 정렬하는 비용은 무시할 만하다(구체적 EXPLAIN ANALYZE 전/후 수치는
// 작업 보고 참고).
async function listActiveQueueForStore(storeId, serviceDate) {
  const [todayItems, carriedOverItems] = await Promise.all([
    // 오늘(serviceDate) 접수분 중 아직 끝나지 않은 것 전부.
    prisma.reservation.findMany({
      where: { storeId, serviceDate, status: { notIn: CLOSED_RESERVATION_STATUSES } },
    }),
    // 다른 날짜에서 넘어온 이월 건(called/notify_failed만). serviceDate로 좁히지 않는다 —
    // 이월 건은 원래 접수일과 무관하게 걸러야 하는 게 계약이라(위 주석 참고), 오늘 것과
    // 겹치지 않게 serviceDate != 오늘만 뺀다(중복 방지, 위 todayItems 쪽에서 이미 잡힘).
    prisma.reservation.findMany({
      where: { storeId, status: { in: ['called', 'notify_failed'] }, serviceDate: { not: serviceDate } },
    }),
  ])

  // 원래 쿼리의 정렬(serviceDate asc, 그 안에서 queueNumber asc)을 그대로 유지한다.
  return [...todayItems, ...carriedOverItems].sort((a, b) => {
    if (a.serviceDate !== b.serviceDate) return a.serviceDate < b.serviceDate ? -1 : 1
    return a.queueNumber - b.queueNumber
  })
}

// store를 함께 로드해 알림톡 발송 시 #{매장명}을 채울 수 있게 한다 (Phase 4).
// call-next(§3.6)는 오늘 접수분만 호출해야 한다 — 어제 마감 시간을 넘겨 그대로 남아있던 waiting
// 건이 실수로(혹은 자정 넘어 재시작 후) 다시 호출되는 걸 막기 위해 serviceDate로 day-scope한다.
function getNextWaitingReservation(storeId) {
  return prisma.reservation.findFirst({
    where: { storeId, status: 'waiting', serviceDate: kstDateString() },
    orderBy: { queueNumber: 'asc' },
    include: { store: true },
  })
}

function getReservation(id) {
  return prisma.reservation.findUnique({ where: { id }, include: { store: true } })
}

async function deleteReservation(id) {
  try {
    await prisma.reservation.delete({ where: { id } })
    return true
  } catch {
    return false
  }
}

async function markReservationCalled(id) {
  try {
    const result = await prisma.reservation.updateMany({
      where: { id, status: 'waiting' },
      data: { status: 'called', calledAt: new Date() },
    })
    if (!result.count) return null
    return prisma.reservation.findUnique({ where: { id }, include: { store: true } })
  } catch {
    return null
  }
}

// 알림톡 재발송(§3.10)에서만 쓰인다. notify_failed 상태에서만 called로 되돌릴 수 있다 — 이 원자적
// updateMany 자체가 "재발송 시도를 시작했다"는 낙관적 잠금 역할을 한다: 관리자 두 명이 거의 동시에
// 재발송 버튼을 눌러도 where절의 status='notify_failed' 조건을 통과하는 건 하나뿐이라 알림톡이
// 중복 발송되지 않는다(발송이 실패하면 markReservationNotifyFailed로 다시 되돌린다).
async function markReservationCalledFromNotifyFailed(id) {
  try {
    const result = await prisma.reservation.updateMany({
      where: { id, status: 'notify_failed' },
      data: { status: 'called', calledAt: new Date() },
    })
    if (!result.count) return null
    return prisma.reservation.findUnique({ where: { id }, include: { store: true } })
  } catch {
    return null
  }
}

// 정비가 끝나 정비 베이(자리)가 비었다는 뜻. 관리자가 직접 처리해야 한다 — 알림톡 발송 성공/실패와는
// 별개로, 이걸 눌러야 다음 예약의 앞사람 계산에서 빠져 대기인원이 줄어든다.
async function markReservationCompleted(id) {
  try {
    const result = await prisma.reservation.updateMany({
      where: { id, status: { in: ['called', 'notify_failed'] } },
      data: { status: 'completed', completedAt: new Date() },
    })
    if (!result.count) return null
    return prisma.reservation.findUnique({ where: { id }, include: { store: true } })
  } catch {
    return null
  }
}

async function markReservationNotifyFailed(id) {
  try {
    const result = await prisma.reservation.updateMany({
      where: { id, status: 'called' },
      data: { status: 'notify_failed' },
    })
    return result.count ? prisma.reservation.findUnique({ where: { id }, include: { store: true } }) : null
  } catch {
    return null
  }
}

// 접수(대기번호) 알림톡 발송 실패 기록(계약 v3 §2.2). status는 건드리지 않는다 — 손님은 여전히
// waiting 상태로 정상 대기 중이고, 이건 "안내 문자가 못 나갔다"만 별도로 추적하는 값이다.
// updateMany라 대상이 이미 지워졌거나 없어도 조용히 넘어간다(발송 실패 처리 중 또 에러를
// 던지면 안 되므로 실패해도 삼킨다).
async function markReservationIntakeFailed(id) {
  try {
    await prisma.reservation.updateMany({ where: { id }, data: { intakeNotifyStatus: 'failed' } })
  } catch {
    // 기록 실패는 삼킨다 — 접수 자체는 이미 끝난 뒤라 손님에게 영향이 없어야 한다.
  }
}

// 접수 알림 재발송(retry-intake) 성공 시 'failed' 표식을 지운다.
async function clearReservationIntakeStatus(id) {
  try {
    await prisma.reservation.updateMany({ where: { id }, data: { intakeNotifyStatus: null } })
  } catch {
    // 표식 해제 실패는 삼킨다 — 재발송 자체(sent:true)는 이미 성공했으므로 응답에 영향을 주지 않는다.
  }
}

// 재발송 메시지의 "앞으로 N명"을 최신값으로 다시 계산한다. createReservation의 peopleAhead와
// 동일 규칙(오늘 접수분 중 완료/취소가 아닌 예약 수, beforeCreatedAt 이전 접수분만) — 접수 시점과
// 재발송 시점 사이에 다른 손님이 왔다 갔다 했을 수 있어 그 시점 값을 그대로 재사용하면 안 된다.
function countPeopleAhead(storeId, serviceDate, beforeCreatedAt) {
  return prisma.reservation.count({
    where: {
      storeId,
      serviceDate,
      status: { notIn: CLOSED_RESERVATION_STATUSES },
      createdAt: { lt: beforeCreatedAt },
    },
  })
}

// 발송실패 목록(계약 v3 §2.4): 순서 호출 실패(status='notify_failed')와 접수 알림 실패
// (intakeNotifyStatus='failed', 아직 completed/cancelled로 끝나지 않은 건)를 함께 반환한다.
// 한 건이 두 조건을 동시에 만족해도(예: 접수는 실패했는데 그 뒤 호출까지 실패) OR라 중복 없이 한 번만 잡힌다.
async function listFailedReservations({ storeId, date, limit, offset }) {
  const where = {
    ...(storeId ? { storeId } : {}),
    ...(date ? { serviceDate: date } : {}),
    OR: [
      { status: 'notify_failed' },
      { intakeNotifyStatus: 'failed', status: { notIn: CLOSED_RESERVATION_STATUSES } },
    ],
  }
  const [total, items] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
  ])
  return { total, items }
}

// 손님 취소/노쇼 처리(§3.9, §3.16 공용). waiting|called|notify_failed 상태에서만 cancelled로
// 전이할 수 있다 — completed는 이미 정비가 끝난 건이라 취소 대상이 아니다(호출부에서 별도 409 처리).
async function markReservationCancelled(id) {
  try {
    const result = await prisma.reservation.updateMany({
      where: { id, status: { in: ['waiting', 'called', 'notify_failed'] } },
      data: { status: 'cancelled' },
    })
    if (!result.count) return null
    return prisma.reservation.findUnique({ where: { id }, include: { store: true } })
  } catch {
    return null
  }
}

async function markPaymentStatus(id, status) {
  try {
    return await prisma.payment.update({ where: { id }, data: { status } })
  } catch {
    return null
  }
}

function getPayment(id) {
  return prisma.payment.findUnique({ where: { id }, include: { store: true } })
}

// 전자영수증 재발송(§3.11). receipt_failed 상태에서만 낙관적으로 receipt_sent로 먼저 바꾼다 —
// markReservationCalledFromNotifyFailed와 같은 이유로, 이 원자적 updateMany가 곧 "재발송 시도
// 시작"의 낙관적 잠금이다. solapi 호출이 실패하면 호출부(server.js)가 다시 receipt_failed로
// 되돌린다(markPaymentStatus 재사용).
async function markPaymentReceiptRetrying(id) {
  try {
    const result = await prisma.payment.updateMany({
      where: { id, status: 'receipt_failed' },
      data: { status: 'receipt_sent' },
    })
    if (!result.count) return null
    return prisma.payment.findUnique({ where: { id }, include: { store: true } })
  } catch {
    return null
  }
}

// 결제 화면에서 차량번호를 다시 입력받는 대신, 전화번호로 이 손님의 예약 기록을 찾아
// 차량번호/정비항목을 그대로 가져다 쓴다. 같은 매장(storeId) 안에서만 찾는다 — 다른 매장에
// 등록된 동일 전화번호 예약을 잘못 가져오면 안 되기 때문이다.
// 오늘 등록한 예약을 우선하고(같은 날 재방문 등으로 여러 건이 있어도 최신 것 사용),
// 오늘 것이 없으면 그 번호로 등록된 가장 최근 예약을 쓴다.
async function findLatestReservationByPhone(storeId, phone) {
  const todayStart = kstDayStartUtc(kstDateString())
  const todayMatch = await prisma.reservation.findFirst({
    where: { storeId, phone, createdAt: { gte: todayStart } },
    orderBy: { createdAt: 'desc' },
  })
  if (todayMatch) return todayMatch
  return prisma.reservation.findFirst({
    where: { storeId, phone },
    orderBy: { createdAt: 'desc' },
  })
}

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000

function findPaymentByKey(paymentKey) {
  if (!paymentKey) return null
  return prisma.payment.findUnique({ where: { paymentKey } })
}

function createPayment({ storeId, paymentKey, carNumber, serviceType, phone, amount, privacyConsentAt, marketingConsentAt }) {
  return prisma.payment.create({
    data: {
      storeId,
      paymentKey: paymentKey || null,
      carNumber: carNumber || null,
      serviceType: serviceType || null,
      phone,
      amount: amount ?? null,
      status: 'requested',
      promoAt: new Date(Date.now() + THREE_MONTHS_MS),
      privacyConsentAt: privacyConsentAt || null,
      marketingConsentAt: marketingConsentAt || null,
    },
  })
}

// storeId를 안 넘기면(관리자 "전체 매장 보기") 전체를 반환한다.
// ⚠️ listReservations와 같은 이유로 관리자 목록 화면은 더 이상 이 함수를 쓰지 않는다(listPaymentsPage
// 사용). 기존 export 시그니처 보존을 위해 남겨둔다.
function listPayments(storeId) {
  return prisma.payment.findMany({
    where: storeId ? { storeId } : undefined,
    orderBy: { createdAt: 'asc' },
  })
}

// Cloud Scheduler는 최소 한 번 전달하고, 동일한 작업이 동시에 들어올 수 있다.
// 외부 알림 API를 호출하기 전에 짧은 claim을 원자적으로 잡아 같은 결제건을 다른
// 인스턴스가 동시에 처리하지 않게 한다. 프로세스가 죽어 claim만 남은 건은 10분 후
// 다시 claim할 수 있다(외부 API 호출 직후 프로세스가 죽는 경우의 완전한 exactly-once는
// 알림 제공자 idempotency 키가 없으면 보장할 수 없으므로, 성공 후 promoSent를 최종 기준으로 둔다).
// §4: 광고성 정보 수신에 동의(marketingConsentAt IS NOT NULL)한 결제만 대상으로 한다 — 동의 없이
// 광고 알림톡을 보내면 정보통신망법 위반이다.
async function claimDuePromotions(limit = 100) {
  const now = new Date()
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1000)
  const candidates = await prisma.payment.findMany({
    where: {
      promoSent: false,
      promoAt: { lte: now },
      phone: { not: null, notIn: [''] },
      marketingConsentAt: { not: null },
      OR: [{ promoClaimedAt: null }, { promoClaimedAt: { lt: staleBefore } }],
    },
    orderBy: { promoAt: 'asc' },
    take: limit,
    include: { store: true },
  })

  const claimed = []
  for (const candidate of candidates) {
    const result = await prisma.payment.updateMany({
      where: {
        id: candidate.id,
        promoSent: false,
        OR: candidate.promoClaimedAt
          ? [{ promoClaimedAt: candidate.promoClaimedAt }]
          : [{ promoClaimedAt: null }],
      },
      data: { promoClaimedAt: now },
    })
    if (result.count) {
      const payment = await prisma.payment.findUnique({ where: { id: candidate.id }, include: { store: true } })
      if (payment) claimed.push(payment)
    }
  }
  return claimed
}

async function markPromoSent(id) {
  try {
    const result = await prisma.payment.updateMany({
      where: { id, promoSent: false, promoClaimedAt: { not: null } },
      data: { promoSent: true, promoSentAt: new Date(), promoClaimedAt: null },
    })
    if (!result.count) return null
    return prisma.payment.findUnique({ where: { id } })
  } catch {
    return null
  }
}

async function releasePromoClaim(id) {
  try {
    await prisma.payment.updateMany({
      where: { id, promoSent: false },
      data: { promoClaimedAt: null },
    })
  } catch {
    // 다음 Scheduler 실행에서 stale claim으로 회수할 수 있으므로 release 실패는 삼킨다.
  }
}

// --- 쉐보레 전산(ERP) 연동 (ERP_CONTRACT_V1 §5) ---

// 전산이 보낸 storeCode로 매장을 찾는다. 등록되지 않은 코드(빈 값 포함)는 null-safe하게 null을
// 반환한다 -- findStoreByMerchantId와 동일한 패턴.
function findStoreByErpCode(erpStoreCode) {
  if (erpStoreCode === undefined || erpStoreCode === null || erpStoreCode === '') return null
  return prisma.store.findUnique({ where: { erpStoreCode: String(erpStoreCode) } })
}

// 본사 관리자가 매장에 전산 코드를 등록/해제할 때 쓴다. 빈 문자열/null을 보내면 코드 해제(null 저장)로
// 취급한다(server.js가 형식 검증을 먼저 하므로 여기서는 unique 충돌만 신경 쓴다). 다른 매장이 이미
// 쓰는 코드면 P2002가 나므로, setPosToken과 동일하게 호출부가 409로 변환할 수 있도록 코드를 붙여 던진다.
// 전산이 사업자번호를 함께 보내오면 그걸로 매장을 찾는다(자동 연결). 사업자번호는 전산도
// 우리도 이미 아는 유일한 공통 값이라, 이게 있으면 사람이 매핑표를 손으로 만들지 않아도 된다.
// 표기가 "123-45-67890"일 수도 "1234567890"일 수도 있어 호출부가 두 형태를 다 만들어 넘긴다 --
// 여기서 정규화하지 않는 이유는 DB에 저장된 값의 표기를 우리가 통제하지 못하기 때문이다.
function findStoresByBusinessNumbers(candidates) {
  if (!candidates || candidates.length === 0) return []
  return prisma.store.findMany({ where: { businessNumber: { in: candidates } } })
}

// 아직 전산 코드가 없는 매장에만 붙인다. 이미 다른 코드가 붙어 있으면 건드리지 않는다 --
// 자동 연결이 기존 매핑을 덮어쓰면, 사업자번호만 아는 쪽이 남의 매장 주문을 자기 코드로
// 가로챌 수 있다. 반환값은 실제로 붙였는지 여부(경쟁 조건 방지를 위해 updateMany의 count로 판정).
async function bindErpCodeIfUnset(storeId, erpStoreCode) {
  try {
    const result = await prisma.store.updateMany({
      where: { id: storeId, erpStoreCode: null },
      data: { erpStoreCode: String(erpStoreCode) },
    })
    return result.count > 0
  } catch (e) {
    // 그 사이 다른 매장이 같은 코드를 선점했으면 unique 제약에 걸린다. 자동 연결은 실패해도
    // 치명적이지 않으므로(관리자 웹에서 수동으로 지정하면 된다) 예외를 밖으로 던지지 않는다.
    if (e?.code === 'P2002') return false
    throw e
  }
}

// 관리자 웹에서 기존 매장의 사업자번호를 채워 넣을 때 쓴다. 자동 연결이 동작하려면 이 값이
// 먼저 들어가 있어야 하는데, 매장 등록 화면에서만 받고 있어서 이미 등록된 매장은 고칠 방법이
// 없었다.
async function setStoreBusinessNumber(storeId, businessNumber) {
  try {
    return await prisma.store.update({
      where: { id: storeId },
      data: { businessNumber: businessNumber ? String(businessNumber) : null },
    })
  } catch {
    return null
  }
}

async function setStoreErpCode(storeId, erpStoreCode) {
  const value = erpStoreCode ? String(erpStoreCode) : null
  try {
    return await prisma.store.update({ where: { id: storeId }, data: { erpStoreCode: value } })
  } catch (e) {
    if (e?.code === 'P2002') {
      const conflict = new Error('다른 매장이 이미 사용 중인 코드입니다.')
      conflict.code = 'ERP_CODE_TAKEN'
      throw conflict
    }
    return null
  }
}

// referenceId(전산 측 주문 참조번호)는 ErpOrder의 멱등키다. 같은 값으로 재조회/재시도할 때 쓴다.
function findErpOrderByReference(referenceId) {
  if (!referenceId) return null
  return prisma.erpOrder.findUnique({ where: { referenceId } })
}

// ErpOrder 생성/갱신을 한 함수로 묶는다 -- 최초 생성(created/failed)과 실패 후 재시도(같은
// referenceId/tossOrderKey로 다시 생성 시도) 모두 이 함수를 거친다. referenceId가 unique라
// upsert가 자연스럽다(재시도 시 update 경로를 탄다).
function upsertErpOrder({ referenceId, storeId, tossOrderKey, tossOrderId, totalAmount, status, itemsJson, memo, tossRawJson, errorMessage }) {
  const data = {
    storeId,
    tossOrderKey,
    tossOrderId: tossOrderId ?? null,
    totalAmount,
    status,
    itemsJson,
    memo: memo ?? null,
    tossRawJson: tossRawJson ?? null,
    errorMessage: errorMessage ?? null,
  }
  return prisma.erpOrder.upsert({
    where: { referenceId },
    create: { referenceId, ...data },
    update: data,
  })
}

// --- 쉐보레 전산(ERP) "물건 담기" -> POS 플러그인 장바구니 중계 (POS-CART-BRIDGE §1) ---
// ErpOrder(토스 Open API로 주문을 직접 생성하는 기존 경로)와는 완전히 별개다. 이쪽은 전산이
// 올려둔 장바구니를 POS 플러그인이 폴링해 가져가서 자기 장바구니에 옮겨 담는 중계용이라,
// 토스와는 아무것도 통신하지 않는다.

// referenceId(전산 측 참조번호)가 멱등키이자 unique 컬럼이다 -- 그래서 순수 create만으로는
// "cancelled 상태였던 건을 같은 referenceId로 재생성"을 표현할 수 없다(옛 cancelled 로우가 이미
// 그 referenceId를 쥐고 있어 새 로우를 또 만들면 unique 제약(P2002)에 걸린다). 그래서
// upsertErpOrder와 동일하게 upsert를 쓴다: referenceId가 처음이면 새 로우를, cancelled 로우가
// 이미 있으면 그 로우를 pending으로 되돌려 재사용한다(errorMessage/loadedAt도 새 장바구니처럼
// 초기화). 멱등 판단(cancelled가 아닌 기존 건은 손대지 않고 duplicate로 응답) 자체는
// server.js가 findErpCartByReference로 먼저 조회해서 처리하고, 이 함수는 "없거나 cancelled일
// 때만" 호출된다.
function createErpCart({ storeId, referenceId, itemsJson, totalAmount, memo, autoPay, carNumber, reservationId }) {
  const data = {
    storeId,
    itemsJson,
    totalAmount,
    memo: memo ?? null,
    autoPay: autoPay !== false,
    status: 'pending',
    errorMessage: null,
    loadedAt: null,
    carNumber: carNumber ?? null,
    reservationId: reservationId ?? null,
    // 재전송(cancelled 뒤 같은 referenceId)일 때 이전 결제 흔적이 남지 않게 초기화한다.
    paidAt: null,
    tossPaymentId: null,
    tossOrderId: null,
  }
  return prisma.erpCart.upsert({
    where: { referenceId },
    create: { referenceId, ...data },
    update: data,
  })
}

function findErpCartByReference(referenceId) {
  if (!referenceId) return null
  return prisma.erpCart.findUnique({ where: { referenceId } })
}

// POS 플러그인 폴링(GET /api/pos/erp-carts) 전용. 오래 기다린 것부터 순서대로 최대 limit건.
function listPendingErpCarts(storeId, limit) {
  // 만료 잡은 하루 한 번 돌므로, 그 사이에 하루가 지난 건이 화면에 남을 수 있다. 조회에서도
  // 같은 기준으로 걸러서 "어제 주문이 오늘 아침 POS에 떠 있는" 상황 자체를 막는다.
  const staleBefore = new Date(Date.now() - ERP_CART_STALE_HOURS * 60 * 60 * 1000)
  return prisma.erpCart.findMany({
    where: { storeId, status: 'pending', createdAt: { gte: staleBefore } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
}

// POS가 addLineItem()까지 성공적으로 마쳤다는 통보(consume). updateMany + count로 pending ->
// loaded 전이가 실제로 일어났는지 판별한다 -- POS 단말기가 여러 대면 같은 cart를 두 대가 거의
// 동시에 consume할 수 있어서, findUnique 후 update 2단계로 짜면 경쟁 조건이 생긴다(둘 다 pending을
// 보고 둘 다 "내가 처리했다"고 응답할 수 있음). 이 원자적 updateMany 자체가 낙관적 잠금 역할을 해서
// 딱 한쪽만 count:1을 받는다.
async function markErpCartLoaded(id) {
  const result = await prisma.erpCart.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'loaded', loadedAt: new Date() },
  })
  return result.count > 0
}

// markErpCartLoaded와 동일한 이유로 원자적 updateMany를 쓴다. errorMessage는 호출부(server.js)가
// 이미 500자로 잘라 넘긴다고 가정한다(여기서 다시 자르지 않음 -- 책임을 한 곳에 둔다).
async function markErpCartFailed(id, errorMessage) {
  const result = await prisma.erpCart.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'failed', errorMessage: errorMessage ?? null },
  })
  return result.count > 0
}

// 전산이 보낸 차량번호로 "그날 아직 진행 중인" 예약을 찾는다.
//
// 잘못 이으면 남의 정비 이력에 부품이 붙고, 결제 후 자동완료로 엉뚱한 손님이 대기열에서
// 사라진다. 그래서 **정확히 1건일 때만** 잇고 애매하면 잇지 않는다(사람이 POS에서 확인하게 둔다).
//
// 범위를 좁히는 조건들:
//   - 같은 매장 (다른 매장에 같은 차가 있어도 무관하다)
//   - 오늘 접수분 (serviceDate) — 같은 차가 며칠 뒤 또 와도 옛 예약에 붙지 않는다
//   - 아직 끝나지 않은 건 (completed/cancelled 제외) — 이미 끝난 정비에 새 주문이 붙으면 안 된다
// 표기 흔들림(공백·하이픈)은 호출부가 정규화해서 넘긴다.
async function findOpenReservationByCarNumber(storeId, carNumber, serviceDate) {
  if (!carNumber) return null
  const matches = await prisma.reservation.findMany({
    where: {
      storeId,
      carNumber,
      serviceDate,
      status: { notIn: CLOSED_RESERVATION_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
    take: 2, // 2건만 가져오면 "정확히 1건인가"를 판정하기에 충분하다
  })
  return matches.length === 1 ? matches[0] : null
}

// 결제가 끝났을 때의 예약 완료 처리.
//
// 직원이 누르는 [완료](markReservationCompleted)는 called/notify_failed에서만 동작한다 —
// "호출한 손님을 완료한다"는 뜻이라 그게 맞다. 하지만 결제는 호출을 안 눌러도 일어난다
// (바쁘면 부르지 않고 그냥 처리한다). 결제가 끝났다는 건 정비가 끝났다는 뜻이므로 waiting도
// 완료로 넘긴다. 이미 끝난(completed/cancelled) 건은 건드리지 않는다.
async function completeReservationAfterPayment(id) {
  const result = await prisma.reservation.updateMany({
    where: { id, status: { in: ['waiting', 'called', 'notify_failed'] } },
    data: { status: 'completed', completedAt: new Date() },
  })
  return result.count > 0
}

// POS에서 결제가 끝났다는 통보. loaded인 건만 paid로 넘긴다 — 담기지도 않은 건이 결제됐다고
// 기록되면 안 된다. 다른 전이와 같은 이유로 원자적 updateMany를 쓴다.
async function markErpCartPaid(id, { paymentId, orderId }) {
  const result = await prisma.erpCart.updateMany({
    where: { id, status: 'loaded' },
    data: {
      status: 'paid',
      paidAt: new Date(),
      tossPaymentId: paymentId ? String(paymentId).slice(0, 200) : null,
      tossOrderId: orderId ? String(orderId).slice(0, 200) : null,
    },
  })
  return result.count > 0
}

// 이 차의 "지금 연락처와 광고 수신 의사"를 찾는다. 수동 홍보 발송의 전제다.
//
// 가장 최근 기록 하나만 본다. 예전에 동의했더라도 마지막 방문에서 동의하지 않았다면 그게
// 지금의 의사다 — 옛 동의를 근거로 보내면 안 된다.
// 예약(Reservation)과 결제(Payment) 양쪽에 동의 기록이 남으므로 둘 중 더 최근 것을 쓴다.
// 익명화된 건은 제외한다(전화번호가 이미 지워져 있고, 파기한 정보로 광고를 보낼 수는 없다).
async function findMarketingContactByCarNumber(storeId, carNumber) {
  const value = String(carNumber || '').replace(/[\s-]/g, '').trim()
  if (!value) return null

  const [reservation, payment] = await Promise.all([
    prisma.reservation.findFirst({
      where: { storeId, carNumber: value, anonymizedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { phone: true, marketingConsentAt: true, createdAt: true },
    }),
    prisma.payment.findFirst({
      where: { storeId, carNumber: value, anonymizedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { phone: true, marketingConsentAt: true, createdAt: true },
    }),
  ])

  const candidates = [reservation, payment].filter(Boolean)
  if (!candidates.length) return null
  candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const latest = candidates[0]
  return {
    phone: latest.phone || null,
    marketingConsentAt: latest.marketingConsentAt || null,
    at: latest.createdAt,
  }
}

// 이 차에 마지막으로 홍보를 보낸 시각. 반복 발송을 막는 데 쓴다.
async function findLastPromoSend(storeId, carNumber) {
  const value = String(carNumber || '').replace(/[\s-]/g, '').trim()
  if (!value) return null
  return prisma.promoSend.findFirst({
    where: { storeId, carNumber: value },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  })
}

function recordPromoSend({ storeId, carNumber, phone, sentBy }) {
  return prisma.promoSend.create({
    data: {
      storeId,
      carNumber: carNumber ? String(carNumber).replace(/[\s-]/g, '').trim() : null,
      phone: phone || null,
      sentBy: sentBy || null,
    },
  })
}

// 매장이 POS에서 보는 오늘 현황. 관리자 웹의 getDailySummary와 목적이 다르다 —
// 저쪽은 본사가 여러 매장을 비교하는 용도라 상태별로 잘게 쪼개져 있고, 여기는 매장 직원이
// "오늘 몇 대 봤나"를 한눈에 보는 용도라 숫자 네 개면 충분하다.
//
// 예약은 serviceDate(접수일) 기준, 전산 주문은 createdAt 기준이다 — 두 모델의 "그 날" 기준이
// 원래 다르다(getDailySummary도 같은 이유로 인자를 나눠 받는다).
async function getPosDailySummary(storeId, serviceDate, dateStart, dateEnd) {
  const reservationWhere = { storeId, serviceDate }
  const cartWhere = { storeId, createdAt: { gte: dateStart, lt: dateEnd } }

  const [received, completed, cartTotal, cartPaid, paidAmount] = await Promise.all([
    prisma.reservation.count({ where: reservationWhere }),
    prisma.reservation.count({ where: { ...reservationWhere, status: 'completed' } }),
    prisma.erpCart.count({ where: cartWhere }),
    prisma.erpCart.count({ where: { ...cartWhere, status: 'paid' } }),
    prisma.erpCart.aggregate({ where: { ...cartWhere, status: 'paid' }, _sum: { totalAmount: true } }),
  ])

  return {
    received,
    completed,
    erpCarts: cartTotal,
    erpCartsPaid: cartPaid,
    paidAmount: paidAmount._sum.totalAmount || 0,
  }
}

// 차량번호로 그 차의 정비 이력을 찾는다. POS 탭앱에서 직원이 "이 차 지난번에 뭐 갈았지?"를
// 확인하는 용도다.
//
// 개인정보 관점에서 짚어둘 것:
//   - 같은 매장(storeId) 것만 본다. 다른 매장 손님 이력은 보이지 않는다.
//   - 보관기간이 지나 익명화된 건은 carNumber가 '삭제됨'으로 덮여 있어 애초에 검색되지 않는다.
//     즉 파기 정책이 조회에도 그대로 적용된다 — 따로 거를 필요가 없다.
//   - 전화번호는 돌려주지 않는다. 이력 확인에 필요 없고, 화면에 띄울 이유도 없다.
//
// 전산 주문(ErpCart)을 함께 붙여야 "무엇을 갈았는지"가 나온다. 예약만으로는 정비 항목
// (serviceType) 한 줄뿐이라 실제로 어떤 부품이 들어갔는지 알 수 없다.
// 매장의 최근 정비 이력. 정비 이력 화면을 열었을 때 빈 화면 대신 보여준다 —
// 차량번호를 이미 알고 있을 때만 쓸 수 있는 화면은 이력 화면이 아니라 검색창이다.
//
// 차량번호가 없는 건은 뺀다. 이력에서 차를 특정할 수 없으면 직원에게 아무 쓸모가 없고,
// 목록만 길어진다.
async function listRecentRepairHistory(storeId, limit = 20) {
  const take = Math.min(Math.max(Number(limit) || 20, 1), 50)
  // 보관기간(3년)과 별개로, 화면에 필요한 건 최근 것뿐이다. 범위를 좁혀 인덱스를 타게 한다.
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)

  const carts = await prisma.erpCart.findMany({
    where: {
      storeId,
      status: { in: ['loaded', 'paid'] },
      carNumber: { not: null },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true, carNumber: true, itemsJson: true, totalAmount: true,
      status: true, createdAt: true, paidAt: true, reservationId: true,
    },
  })

  // 전산 주문 없이 정비만 끝난 건도 이력이다(부품 없이 점검만 한 경우).
  const reservations = await prisma.reservation.findMany({
    where: {
      storeId,
      status: 'completed',
      anonymizedAt: null,
      completedAt: { gte: since },
      id: { notIn: carts.map((c) => c.reservationId).filter(Boolean) },
    },
    orderBy: { completedAt: 'desc' },
    take,
    select: { id: true, carNumber: true, serviceType: true, serviceDate: true, completedAt: true },
  })

  return { carts, reservations }
}

async function findRepairHistoryByCarNumber(storeId, carNumber, limit = 10) {
  const value = String(carNumber || '').replace(/[\s-]/g, '').trim()
  if (!value) return []

  const reservations = await prisma.reservation.findMany({
    where: { storeId, carNumber: value, anonymizedAt: null },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 10, 1), 50),
    select: {
      id: true, serviceType: true, serviceDate: true, status: true,
      createdAt: true, completedAt: true,
    },
  })

  // 같은 차의 전산 주문도 함께 본다(예약 없이 방문한 건도 잡힌다).
  const carts = await prisma.erpCart.findMany({
    where: { storeId, carNumber: value, status: { in: ['loaded', 'paid'] } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, reservationId: true, itemsJson: true, totalAmount: true,
      status: true, createdAt: true, paidAt: true,
    },
  })

  return { reservations, carts }
}

// 관리자 웹에서 전산 주문 이력을 보는 용도. 매장이 "전산에서 보냈는데 POS에 안 떴어요" 할 때
// 본사가 확인할 방법이 지금까지 없었다 — 접수는 됐는지, POS가 가져갔는지, 실패했는지.
// storeId가 없으면 전체(본사 관리자), 있으면 그 매장만 본다.
async function listErpCarts({ storeId, status, limit = 50 }) {
  return prisma.erpCart.findMany({
    where: {
      ...(storeId ? { storeId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 50, 1), 200),
    include: { store: { select: { name: true, erpStoreCode: true } } },
  })
}

// 매장 직원이 POS 화면에서 이 주문을 치웠을 때. 잘못 온 주문(다른 손님 것, 전산 오조작)을
// 직원이 없앨 방법이 없으면 pending으로 영원히 남아 화면에 계속 뜬다.
//
// 전산이 취소한 것(cancelled)과 구분해서 dismissed로 남긴다 -- 전산 입장에서 "우리가 취소했다"와
// "매장이 거부했다"는 후속 조치가 다르다(후자는 왜 거부했는지 확인해야 한다).
// 다른 전이와 같은 이유로 원자적 updateMany를 쓴다.
async function markErpCartDismissed(id, reason) {
  const result = await prisma.erpCart.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'dismissed', errorMessage: reason ?? null },
  })
  return result.count > 0
}

// 전산 쪽에서 주문을 취소했을 때(POST /api/erp/carts/:referenceId/cancel). pending일 때만
// cancelled로 전이한다 -- 이미 POS가 가져간(loaded) 뒤라면 취소해도 POS 장바구니에는 이미
// 반영되어 있으므로 여기서 조용히 상태만 바꾸면 안 되고(호출부가 409로 알려야 함), 그 판단을
// 위해 전이 성공 여부(boolean)를 그대로 반환한다.
async function cancelErpCart(referenceId) {
  const result = await prisma.erpCart.updateMany({
    where: { referenceId, status: 'pending' },
    data: { status: 'cancelled' },
  })
  return result.count > 0
}

// 향후 결제 웹훅 연동용(계약 §5) -- 지금은 함수만 만들어 둔다. 아직 호출부가 없다.
async function markErpOrderPaid(referenceId, paidAt) {
  try {
    return await prisma.erpOrder.update({
      where: { referenceId },
      data: { status: 'paid', paidAt: paidAt || new Date() },
    })
  } catch {
    return null
  }
}

// 웹훅 중복 수신 방지. 이미 처리한 x-toss-webhook-id면 false(스킵), 처음 보는 id면 기록하고 true.
async function recordWebhookEventOnce(webhookId, eventType) {
  try {
    await prisma.webhookEvent.create({ data: { id: webhookId, eventType } })
    return true
  } catch {
    return false // unique 제약 위반 = 이미 처리된 이벤트
  }
}

const DEFAULT_DATA_RETENTION_DAYS = 1095
const PURGE_BATCH_SIZE = 1000
const PURGE_MAX_ITERATIONS = 10
// Reservation.phone은 NOT NULL 컬럼이라(예약 화면은 항상 전화번호를 받는다) null로 지울 수 없다 —
// 식별 불가능한 더미값으로 대체한다. Payment.phone은 nullable이라 그냥 null로 지운다.
const ANONYMIZED_RESERVATION_PHONE = '0100000000'
const ANONYMIZED_CAR_NUMBER = '삭제됨'

async function purgeExpiredReservations(cutoff) {
  let total = 0
  for (let i = 0; i < PURGE_MAX_ITERATIONS; i += 1) {
    const targets = await prisma.reservation.findMany({
      where: { createdAt: { lt: cutoff }, anonymizedAt: null },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    })
    if (!targets.length) break
    const result = await prisma.reservation.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { phone: ANONYMIZED_RESERVATION_PHONE, carNumber: ANONYMIZED_CAR_NUMBER, anonymizedAt: new Date() },
    })
    total += result.count
    if (targets.length < PURGE_BATCH_SIZE) break
  }
  return total
}

async function purgeExpiredPayments(cutoff) {
  let total = 0
  for (let i = 0; i < PURGE_MAX_ITERATIONS; i += 1) {
    const targets = await prisma.payment.findMany({
      where: { createdAt: { lt: cutoff }, anonymizedAt: null },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    })
    if (!targets.length) break
    const result = await prisma.payment.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { phone: null, carNumber: ANONYMIZED_CAR_NUMBER, anonymizedAt: new Date() },
    })
    total += result.count
    if (targets.length < PURGE_BATCH_SIZE) break
  }
  return total
}

// ErpCart.memo에는 전산이 보낸 "12가3456 김민준님"이 그대로 들어간다 — 차량번호와 고객명은
// 개인정보다. Reservation/Payment만 파기 대상에 넣어두면 이 테이블만 보관기간을 넘겨 남는다.
// 여기서도 레코드는 남기고(매장별 전산 주문 건수 통계가 깨지지 않게) memo·carNumber만 지운다.
// carNumber는 findRepairHistoryByCarNumber/listRecentRepairHistory가 조회에 쓰는 필드라
// memo(사람이 읽는 자유 문자열)보다 식별성이 높은데도 그동안 영구 보존됐다 — 이제 memo와
// 같은 기준으로 지운다(지우고 나면 그 정비 이력 조회가 이 건을 못 찾게 되는데, 3년이 지난
// 건이므로 그게 맞는 동작이다). itemsJson은 품목명·가격이라 개인정보가 아니므로 그대로 둔다.
async function purgeExpiredErpCarts(cutoff) {
  let total = 0
  for (let i = 0; i < PURGE_MAX_ITERATIONS; i += 1) {
    const targets = await prisma.erpCart.findMany({
      where: { createdAt: { lt: cutoff }, OR: [{ memo: { not: null } }, { carNumber: { not: null } }] },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    })
    if (!targets.length) break
    const result = await prisma.erpCart.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { memo: null, carNumber: null },
    })
    total += result.count
    if (targets.length < PURGE_BATCH_SIZE) break
  }
  return total
}

// 전산 주문(ErpOrder)은 그동안 파기 대상에 아예 없었다 — memo에 ErpCart와 같은 방식으로
// 차량번호·고객명이 들어가고, items[].name도 전산이 형식 제약 없이 보내는 자유 텍스트라
// (server.js validateDraftOrderBody — 1~100자 문자열이면 통과) 개인정보가 섞여 들어올 수 있다.
// 레코드와 집계값(totalAmount, status)은 남기고 memo·itemsJson만 지운다 — itemsJson은
// NOT NULL 컬럼이라 null 대신 빈 배열 JSON으로 대체한다(형식은 유지하되 내용만 비움).
async function purgeExpiredErpOrders(cutoff) {
  let total = 0
  for (let i = 0; i < PURGE_MAX_ITERATIONS; i += 1) {
    const targets = await prisma.erpOrder.findMany({
      where: { createdAt: { lt: cutoff }, anonymizedAt: null },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    })
    if (!targets.length) break
    const result = await prisma.erpOrder.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { memo: null, itemsJson: '[]', anonymizedAt: new Date() },
    })
    total += result.count
    if (targets.length < PURGE_BATCH_SIZE) break
  }
  return total
}

// 웹훅 이벤트(WebhookEvent)는 개인정보라기보다 무한 증가가 문제다 — id가 토스 웹훅 id일 뿐이고
// 익명화할 전화번호/차량번호 같은 필드 자체가 없다. 다른 모델처럼 필드만 비우는 게 아니라
// 보관기간이 지난 행 자체를 지운다(중복 수신 방지라는 목적이 그 기간이 지나면 의미가 없어짐).
async function purgeExpiredWebhookEvents(cutoff) {
  let total = 0
  for (let i = 0; i < PURGE_MAX_ITERATIONS; i += 1) {
    const targets = await prisma.webhookEvent.findMany({
      where: { receivedAt: { lt: cutoff } },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    })
    if (!targets.length) break
    const result = await prisma.webhookEvent.deleteMany({
      where: { id: { in: targets.map((t) => t.id) } },
    })
    total += result.count
    if (targets.length < PURGE_BATCH_SIZE) break
  }
  return total
}

// 홍보 발송 기록의 개인정보(전화번호·차량번호)를 지운다. 레코드 자체는 남긴다 —
// "언제 몇 건 보냈는지"는 통계이자 감사 근거라 지우면 안 되고, 개인을 식별하는 부분만 없앤다.
async function purgeExpiredPromoSends(cutoff) {
  let total = 0
  for (let i = 0; i < PURGE_MAX_ITERATIONS; i += 1) {
    const targets = await prisma.promoSend.findMany({
      where: { sentAt: { lt: cutoff }, anonymizedAt: null },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    })
    if (!targets.length) break
    const result = await prisma.promoSend.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { phone: null, carNumber: null, anonymizedAt: new Date() },
    })
    total += result.count
    if (targets.length < PURGE_BATCH_SIZE) break
  }
  return total
}

// 매장이 가져가지 않은 채 오래 남은 전산 주문을 끝난 상태로 정리한다.
//
// 왜 필요한가: 전산이 보냈는데 매장이 그날 처리하지 않으면 pending으로 계속 남아, 다음 날
// 아침에 POS 화면에 어제 주문이 그대로 뜬다. 직원이 오늘 손님 것으로 착각하고 담아 결제하면
// 잘못된 금액이 청구된다. 정비 주문은 당일 처리가 원칙이라 하루를 넘기면 유효하지 않다고 본다.
//
// cancelled(전산이 취소)나 dismissed(매장이 지움)와 구분해 expired로 남긴다 — 전산 입장에서
// "아무도 손대지 않아 만료됨"은 원인 파악이 다르다(매장에 안 떴을 수도, 직원이 못 봤을 수도).
const ERP_CART_STALE_HOURS = 24

async function expireStaleErpCarts(now) {
  const cutoff = new Date((now ? now.getTime() : Date.now()) - ERP_CART_STALE_HOURS * 60 * 60 * 1000)
  const result = await prisma.erpCart.updateMany({
    where: { status: 'pending', createdAt: { lt: cutoff } },
    data: { status: 'expired', errorMessage: `${ERP_CART_STALE_HOURS}시간 동안 처리되지 않아 만료됨` },
  })
  return result.count
}

// 개인정보 보관기간(기본 3년, DATA_RETENTION_DAYS) 경과 건을 물리 삭제 대신 "익명화"한다.
// 레코드 자체를 지우면 매장별 매출/방문 통계가 깨지므로, 개인정보(전화번호/차량번호)만 식별
// 불가능한 값으로 덮어써서 개인정보보호법상 파기 의무를 이행한다. 한 번에 최대 1000건씩, 최대
// 10회(=최대 1만 건) 반복한다 — 대상이 그보다 많으면 다음 스케줄 실행에서 나머지를 처리한다
// (배치 잡 하나가 너무 오래 걸려 Cloud Scheduler의 타임아웃에 걸리는 걸 막기 위함).
// 예외적으로 WebhookEvent는 익명화할 개인정보 필드가 없어 행 자체를 지운다(무한 증가 방지).
async function purgeExpiredPersonalData(retentionDays) {
  const days = Number.isFinite(retentionDays) && retentionDays > 0
    ? retentionDays
    : (Number(process.env.DATA_RETENTION_DAYS) || DEFAULT_DATA_RETENTION_DAYS)
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const reservations = await purgeExpiredReservations(cutoff)
  const payments = await purgeExpiredPayments(cutoff)
  const erpCarts = await purgeExpiredErpCarts(cutoff)
  // 전산 주문(ErpOrder)도 ErpCart와 같은 이유(memo/items[].name에 차량번호·고객명)로 파기 대상이다.
  const erpOrders = await purgeExpiredErpOrders(cutoff)
  // 홍보 발송 기록에도 전화번호·차량번호가 남는다. 같은 기준으로 지운다.
  const promoSends = await purgeExpiredPromoSends(cutoff)
  // 웹훅 이벤트는 개인정보가 아니라 무한 증가가 문제라 별도로 지운다(보관기간은 같은 값을 재사용).
  const webhookEvents = await purgeExpiredWebhookEvents(cutoff)
  // 만료 처리는 보관기간(3년)과 무관하게 매일 돌아야 하는 짧은 주기의 정리라 같은 잡에 얹는다.
  const expiredErpCarts = await expireStaleErpCarts()
  return { reservations, payments, erpCarts, erpOrders, promoSends, webhookEvents, expiredErpCarts }
}

// 일별 요약(계약 v3 §5.1). 예약은 serviceDate 기준(접수일), 결제는 createdAt의 KST 하루 범위
// (dateStart~dateEnd, 호출부가 kstDateRangeUtc로 변환해 넘김) 기준이다 — 두 모델의 "그 날" 기준이
// 서로 다르기 때문에 인자를 분리해서 받는다. groupBy 대신 상태별 개별 count를 쓴 이유: 상태
// 목록이 고정된 5/4가지뿐이라 groupBy 결과를 다시 매핑하는 것보다 Promise.all로 병렬 count하는
// 쪽이 더 읽기 쉽고, 존재하지 않는 상태(count 0)도 굳이 채워 넣을 필요가 없다.
async function getDailySummary({ storeId, date, dateStart, dateEnd }) {
  const reservationWhere = { ...(storeId ? { storeId } : {}), serviceDate: date }
  const paymentWhere = {
    ...(storeId ? { storeId } : {}),
    ...(dateStart && dateEnd ? { createdAt: { gte: dateStart, lt: dateEnd } } : {}),
  }

  // 전산 주문은 접수 시각(createdAt) 기준으로 그날 것을 센다 — Payment와 같은 기준이다.
  const erpCartWhere = {
    ...(storeId ? { storeId } : {}),
    ...(dateStart && dateEnd ? { createdAt: { gte: dateStart, lt: dateEnd } } : {}),
  }

  const [
    reservationTotal,
    waiting,
    called,
    notifyFailed,
    completed,
    cancelled,
    paymentTotal,
    amountAgg,
    receiptFailed,
    intakeFailed,
    erpCartTotal,
    erpCartPaid,
    erpCartPaidAmount,
    erpCartUnhandled,
  ] = await Promise.all([
    prisma.reservation.count({ where: reservationWhere }),
    prisma.reservation.count({ where: { ...reservationWhere, status: 'waiting' } }),
    prisma.reservation.count({ where: { ...reservationWhere, status: 'called' } }),
    prisma.reservation.count({ where: { ...reservationWhere, status: 'notify_failed' } }),
    prisma.reservation.count({ where: { ...reservationWhere, status: 'completed' } }),
    prisma.reservation.count({ where: { ...reservationWhere, status: 'cancelled' } }),
    prisma.payment.count({ where: paymentWhere }),
    prisma.payment.aggregate({ where: paymentWhere, _sum: { amount: true } }),
    prisma.payment.count({ where: { ...paymentWhere, status: 'receipt_failed' } }),
    prisma.reservation.count({
      where: { ...reservationWhere, intakeNotifyStatus: 'failed', status: { notIn: CLOSED_RESERVATION_STATUSES } },
    }),
    // 전산 주문은 Payment와 별개 채널이라(POS에서 동의 없이 결제된다) 따로 센다.
    // 합쳐서 보여주면 "결제 몇 건"이 어느 경로인지 알 수 없어 대사가 안 된다.
    prisma.erpCart.count({ where: erpCartWhere }),
    prisma.erpCart.count({ where: { ...erpCartWhere, status: 'paid' } }),
    prisma.erpCart.aggregate({ where: { ...erpCartWhere, status: 'paid' }, _sum: { totalAmount: true } }),
    prisma.erpCart.count({ where: { ...erpCartWhere, status: { in: ['failed', 'expired', 'dismissed'] } } }),
  ])

  return {
    reservations: {
      total: reservationTotal,
      waiting,
      called,
      notify_failed: notifyFailed,
      completed,
      cancelled,
    },
    payments: {
      total: paymentTotal,
      amountSum: amountAgg._sum.amount || 0,
      receiptFailed,
    },
    intakeFailed,
    // 전산에서 온 주문. total 대비 paid가 낮으면 매장이 POS에서 처리하지 않고 있다는 뜻이라
    // 운영에서 먼저 봐야 할 신호다.
    erpCarts: {
      total: erpCartTotal,
      paid: erpCartPaid,
      paidAmount: erpCartPaidAmount._sum.totalAmount || 0,
      unhandled: erpCartUnhandled, // failed + expired + dismissed
    },
  }
}

module.exports = {
  prisma,
  pingDatabaseReady,
  kstDateString,
  kstDateRangeUtc,
  ensureDefaultStore,
  ensureDefaultHqAdmin,
  bulkCreateStores,
  recordWebhookEventOnce,
  findAdminUserByEmail,
  getAdminUser,
  createAdminUser,
  markAdminLogin,
  recordFailedLogin,
  changeAdminPassword,
  createStore,
  listStores,
  getStore,
  findStoreByMerchantId,
  findStoreByPosToken,
  rotatePosToken,
  setPosToken,
  createReservation,
  listReservations,
  listReservationsPage,
  listActiveQueueForStore,
  getNextWaitingReservation,
  getReservation,
  deleteReservation,
  markReservationCalled,
  markReservationCalledFromNotifyFailed,
  markReservationCompleted,
  markReservationNotifyFailed,
  markReservationCancelled,
  markReservationIntakeFailed,
  clearReservationIntakeStatus,
  countPeopleAhead,
  listFailedReservations,
  findLatestReservationByPhone,
  createPayment,
  findPaymentByKey,
  getPayment,
  markPaymentStatus,
  markPaymentReceiptRetrying,
  listPayments,
  listPaymentsPage,
  claimDuePromotions,
  markPromoSent,
  releasePromoClaim,
  purgeExpiredPersonalData,
  getDailySummary,
  findStoreByErpCode,
  findStoresByBusinessNumbers,
  bindErpCodeIfUnset,
  setStoreBusinessNumber,
  setStoreErpCode,
  findErpOrderByReference,
  upsertErpOrder,
  markErpOrderPaid,
  createErpCart,
  findErpCartByReference,
  listPendingErpCarts,
  markErpCartLoaded,
  markErpCartFailed,
  markErpCartDismissed,
  markErpCartPaid,
  listErpCarts,
  getPosDailySummary,
  findRepairHistoryByCarNumber,
  listRecentRepairHistory,
  findMarketingContactByCarNumber,
  findLastPromoSend,
  recordPromoSend,
  completeReservationAfterPayment,
  findOpenReservationByCarNumber,
  expireStaleErpCarts,
  cancelErpCart,
}
