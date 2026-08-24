// Design Ref: docs/02-design/features/multi-store-support.design.md §2.0 (Option C)
// DB 데이터 계층. 예전 인메모리 버전과 export 함수 시그니처를 그대로 유지한 채
// 내부만 Prisma(Client)로 교체했다 — server.js는 await만 붙이면 그대로 동작한다.
// 로컬/프로토타입은 SQLite(.env의 DATABASE_URL=file:./dev.db), 운영 전환 시
// DATABASE_URL을 Postgres로 바꾸고 prisma/schema.prisma의 provider를 postgresql로 바꾼 뒤
// `npx prisma migrate dev`를 다시 실행하면 된다 (docs/multi-store-architecture-review.md 참고).

const { PrismaClient } = require('@prisma/client')
const crypto = require('node:crypto')
const { hashPassword } = require('./auth')

const prisma = new PrismaClient()

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
function listActiveQueueForStore(storeId, serviceDate) {
  return prisma.reservation.findMany({
    where: {
      storeId,
      status: { notIn: CLOSED_RESERVATION_STATUSES },
      OR: [
        { serviceDate },
        { status: { in: ['called', 'notify_failed'] } },
      ],
    },
    orderBy: [{ serviceDate: 'asc' }, { queueNumber: 'asc' }],
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

// 개인정보 보관기간(기본 3년, DATA_RETENTION_DAYS) 경과 건을 물리 삭제 대신 "익명화"한다.
// 레코드 자체를 지우면 매장별 매출/방문 통계가 깨지므로, 개인정보(전화번호/차량번호)만 식별
// 불가능한 값으로 덮어써서 개인정보보호법상 파기 의무를 이행한다. 한 번에 최대 1000건씩, 최대
// 10회(=최대 1만 건) 반복한다 — 대상이 그보다 많으면 다음 스케줄 실행에서 나머지를 처리한다
// (배치 잡 하나가 너무 오래 걸려 Cloud Scheduler의 타임아웃에 걸리는 걸 막기 위함).
async function purgeExpiredPersonalData(retentionDays) {
  const days = Number.isFinite(retentionDays) && retentionDays > 0
    ? retentionDays
    : (Number(process.env.DATA_RETENTION_DAYS) || DEFAULT_DATA_RETENTION_DAYS)
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const reservations = await purgeExpiredReservations(cutoff)
  const payments = await purgeExpiredPayments(cutoff)
  return { reservations, payments }
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
  }
}

module.exports = {
  prisma,
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
}
