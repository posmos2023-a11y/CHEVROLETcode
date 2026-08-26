require('dotenv').config()
const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const path = require('node:path')
const crypto = require('node:crypto')
const {
  prisma,
  kstDateString,
  kstDateRangeUtc,
  ensureDefaultStore,
  ensureDefaultHqAdmin,
  bulkCreateStores,
  recordWebhookEventOnce,
  findAdminUserByEmail,
  createAdminUser,
  markAdminLogin,
  recordFailedLogin,
  changeAdminPassword,
  getAdminUser,
  createStore,
  listStores,
  getStore,
  findStoreByMerchantId,
  findStoreByPosToken,
  rotatePosToken,
  setPosToken,
  createReservation,
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
  createErpCart,
  findErpCartByReference,
  listPendingErpCarts,
  markErpCartLoaded,
  markErpCartFailed,
  markErpCartDismissed,
  markErpCartPaid,
  listErpCarts,
  findRepairHistoryByCarNumber,
  completeReservationAfterPayment,
  findOpenReservationByCarNumber,
  cancelErpCart,
} = require('./src/store')
const { createTossDraftOrder } = require('./src/tossOrderClient')
const { PostgresRateLimitStore } = require('./src/rateLimitStore')
const logger = require('./src/logger')
const solapi = require('./src/solapi')
const { hashPassword, verifyPassword, signAdminToken, verifyAdminToken } = require('./src/auth')
const { securityHeaders } = require('./src/securityHeaders')

// --- 부팅 가드 (계약 §10) ---
// production에서 없으면 안 되는 값은 throw로 배포 자체를 막는다(서버가 뜨지 않아야 사고를 막는다).
// 없어도 기능 일부만 제한되는 값(SOLAPI/PROMOTION_JOB_TOKEN/ADMIN_ALLOWED_ORIGINS)은 경고만 남긴다.

// JWT_SECRET이 없으면(로컬 개발) 매 부팅마다 랜덤 값을 생성한다 — 서버를 재시작하면
// 이전 로그인 토큰은 전부 무효화되지만(재로그인 필요), 로컬 개발엔 문제없다.
// 운영 배포에서는 반드시 .env에 고정된 JWT_SECRET을 넣어야 한다.
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('운영 환경에서는 JWT_SECRET을 반드시 설정해야 합니다.')
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex')
  logger.warn('[auth] JWT_SECRET이 설정되지 않아 임시 값으로 발급합니다.', { environment: process.env.NODE_ENV || 'development' })
}

// TOSS_WEBHOOK_SECRET 없이 운영에 올라가면 서명 검증 없이 결제 웹훅을 받게 된다 — 누구나 위조된
// "결제 승인" 이벤트를 보내 가짜 결제 기록을 만들 수 있는 심각한 문제라, 아예 부팅을 막는다
// (계약 §3.23-1, §10). 로컬 개발(NODE_ENV != production)에서는 비워둬도 되며, 그 경우
// 웹훅 핸들러가 서명 검증을 건너뛰고 경고 로그만 남긴다.
if (process.env.NODE_ENV === 'production' && !process.env.TOSS_WEBHOOK_SECRET) {
  throw new Error('운영 환경에서는 TOSS_WEBHOOK_SECRET을 반드시 설정해야 합니다.')
}

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SOLAPI_API_KEY || !process.env.SOLAPI_API_SECRET || !process.env.SOLAPI_SENDER) {
    logger.warn('[boot] SOLAPI_API_KEY/SOLAPI_API_SECRET/SOLAPI_SENDER 중 일부가 설정되지 않았습니다. 알림톡 발송이 모두 실패합니다.')
  }
  if (!process.env.PROMOTION_JOB_TOKEN) {
    logger.warn('[boot] PROMOTION_JOB_TOKEN이 설정되지 않았습니다. /internal/jobs/* 엔드포인트가 항상 503을 반환합니다.')
  }
  if (!process.env.ADMIN_ALLOWED_ORIGINS) {
    logger.warn('[boot] ADMIN_ALLOWED_ORIGINS이 설정되지 않아 관리자 API를 모든 오리진에 허용합니다.')
  }
}

const app = express()
app.disable('x-powered-by')

// ETag(조건부 캐싱) 비활성화. Express는 기본적으로 GET 응답에 ETag를 붙이는데, 브라우저/웹뷰가
// 같은 URL을 다시 부를 때 자동으로 If-None-Match 헤더를 실어 보내면 서버가 "안 바뀌었다"며
// 304(본문 없음)로 응답한다. 우리 API는 전부 JSON을 기대하는 클라이언트가 소비하는데(특히 POS
// 탭앱은 GET /api/pos/queue를 5초마다 폴링한다), 304로 빈 본문이 오면 res.json()이 파싱할 게 없어
// 대기열이 갱신되지 않고 화면이 "무반응"으로 멈춘다. 대기열처럼 매번 달라지는 동적 응답에는 조건부
// 캐싱 이점도 없으므로 아예 끈다. (정적 파일은 express.static이 자체 ETag를 쓰므로 이 설정과 무관하다.)
app.set('etag', false)

// Render/GCP(Cloud Run 등) 모두 로드밸런서 뒤에서 X-Forwarded-For를 붙여 전달한다.
// trust proxy를 설정하지 않으면 express-rate-limit이 개별 클라이언트가 아니라
// 매장 전체 트래픽을 하나로 묶어 레이트리밋을 적용해버린다. 홉 수는 배포 플랫폼마다
// 다를 수 있어 하드코딩하지 않고 TRUST_PROXY_HOPS로 뺀다 (기본 1홉: 대부분의 PaaS 로드밸런서).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))
app.use(securityHeaders)

// --- CORS 설정 (계약 §8) ---
// 손님/POS 단말기는 토스 결제 단말기 내장 브라우저 등 매번 다른 로컬 오리진에서 접근하므로
// Origin 검증 자체가 불가능하다 — 전체 허용을 유지한다.
const publicCors = cors()

// 관리자 화면은 우리가 배포한 오리진에서만 열려야 한다. ADMIN_ALLOWED_ORIGINS(콤마 구분)가
// 설정돼 있으면 그 목록으로 제한해, 토큰이 유출돼도 다른 사이트에서 관리자 API를 끌어쓰지
// 못하게 막는다. 미설정이면(로컬 개발 등) 기존처럼 전체 허용한다(부팅 경고는 위에서 이미 남김).
const adminAllowedOrigins = (process.env.ADMIN_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const adminCors = cors(
  adminAllowedOrigins.length
    ? {
        origin(origin, callback) {
          // Origin 헤더가 없는 요청(서버-투-서버 호출, curl, 같은-오리진 요청 등)은 브라우저의
          // CORS 검증 대상이 아니므로 통과시킨다 — 여기서 막아도 보안상 의미가 없다(위조 가능).
          if (!origin || adminAllowedOrigins.includes(origin)) return callback(null, true)
          return callback(new Error('CORS로 허용되지 않은 오리진입니다.'))
        },
      }
    : {}
)

// /api/reservations, /api/payments는 같은 경로를 손님용 POST(전체 허용)와 관리자용
// GET(오리진 제한)이 함께 쓴다. 브라우저 preflight(OPTIONS)는 실제 메서드를 담은
// Access-Control-Request-Method 헤더를 보내주므로, 그 값을 보고 어떤 CORS 정책을 적용할지 고른다.
function methodAwarePreflight(policyByMethod, fallbackPolicy) {
  return (req, res, next) => {
    const requestedMethod = (req.get('access-control-request-method') || '').toUpperCase()
    const policy = policyByMethod[requestedMethod] || fallbackPolicy
    return policy(req, res, next)
  }
}

// /api/admin/* 전체(로그인 포함)와 JWT가 필요한 나머지 라우트에 관리자 CORS 정책을 건다.
// app.use는 해당 경로 프리픽스의 모든 HTTP 메서드(OPTIONS 포함)에 매칭되므로 preflight도
// 자동으로 처리된다. /api/reservations/:id/..., /api/payments/:id/...처럼 파라미터가 있는
// 마운트는 그 하위 경로(예: /api/reservations/:id/call, /api/reservations/failed)까지 덮는다 —
// 이 두 베이스 경로 아래에는 손님용 공개 라우트가 없으므로 안전하게 전체를 관리자 정책으로 묶을 수 있다.
app.use('/api/admin', adminCors)
app.use('/api/queue', adminCors)
app.use('/api/reservations/:id', adminCors)
app.use('/api/payments/:id', adminCors)
app.options('/api/reservations', methodAwarePreflight({ GET: adminCors }, publicCors))
app.options('/api/payments', methodAwarePreflight({ GET: adminCors }, publicCors))

// POS 탭앱/웹훅은 항상 전체 허용(§8).
app.use('/api/pos', publicCors)
app.use('/api/webhooks', publicCors)

// 웹훅 서명 검증(HMAC)은 재직렬화한 JSON이 아니라 원본 바이트가 필요해서, verify 훅으로
// req.rawBody에 원본을 남겨둔다 (POST /api/webhooks/toss/payment에서 사용).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }))
app.use(express.static(path.join(__dirname, 'public')))
// 토스프론트 플러그인(../front-plugin)과 토스 POS 탭앱(../pos-plugin)은 각각 독립된 프로젝트 폴더로
// 분리되어 있고, 이 백엔드가 API 서버 역할과 함께 로컬 미리보기용 정적 파일 서빙도 겸한다.
// front-plugin은 빌드가 필요 없는 순수 HTML/JS라 소스 폴더를 그대로 서빙하고,
// pos-plugin은 esbuild 번들이 필요해 dist/ 결과물만 서빙한다(pos-plugin/README.md 참고).
// 실제 배포(토스플레이스 개발자센터 업로드)는 이 서빙 경로와 무관하다 — 로컬 확인 전용.
app.use('/toss-plugin', express.static(path.join(__dirname, '..', 'front-plugin')))
app.use('/pos-plugin', express.static(path.join(__dirname, '..', 'pos-plugin', 'dist')))

// 모든 async 라우트 핸들러/미들웨어를 이걸로 감싼다. 안 감싸면 async 함수 안에서 던진 예외가
// Express 4의 기본 에러 처리 경로를 타지 않고 unhandledRejection으로 새어나가 프로세스가
// 죽을 수 있다(계약 §5) — 실제로 notifyQueueTurn이 명시적으로 throw하는데 이걸 부르는
// 라우트 3곳(POST /api/queue/call-next, /api/reservations/:id/call, /api/pos/queue/:id/call)이
// try/catch 없이 호출하고 있어서 예약이 이미 called인데 알림 실패 처리 중 등 특정 타이밍에
// 서버 전체가 재시작되는 사고로 이어질 수 있었다. asyncHandler + 아래 4-arity 에러 핸들러가
// 이 클래스의 버그 전체를 한 번에 막는다.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

const CAR_NUMBER_RE = /^\d{2,3}[가-힣]\d{4}$/

// 전산이 "12가 3456", "12-가-3456"처럼 보낼 수 있다. 예약 화면에서 손님이 입력한 값과 비교하려면
// 표기를 하나로 맞춰야 한다 — 공백·하이픈만 걷어낸다(그 이상 손대면 다른 차를 같은 차로 볼 수 있다).
function normalizeCarNumber(raw) {
  const v = String(raw ?? '').replace(/[\s-]/g, '').trim()
  return v || null
}
const PHONE_RE = /^01[0-9]{8,9}$/

// 정비 항목 선택지. 토스프론트 플러그인의 reservation.html 선택 화면과 키/순서를 맞춰야 한다.
const SERVICE_TYPES = {
  oil: '엔진오일 교체',
  inspection: '정기점검',
  tire: '타이어 교체·펑크수리',
  battery: '배터리 교체',
  brake: '브레이크 정비',
  etc: '기타 수리·상담',
}

const RESERVATION_STATUSES = new Set(['waiting', 'called', 'notify_failed', 'completed', 'cancelled'])
const PAYMENT_STATUSES = new Set(['requested', 'receipt_sent', 'receipt_failed', 'cancelled'])

// 목록 조회 쿼리파라미터(date/status/limit/offset) 공통 파싱. 잘못된 값은 에러를 내는 대신
// 조용히 기본값/무시로 처리한다 — 관리자 화면 필터 UI가 실수로 이상한 값을 보내도 500이 아니라
// "필터 없이 전체"로 동작하는 편이 운영 중 더 안전하다.
function parseStatusFilter(raw, allowed) {
  if (!raw) return null
  const list = String(raw).split(',').map((s) => s.trim()).filter((s) => allowed.has(s))
  return list.length ? list : null
}
function parseLimit(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 100
  return Math.min(Math.max(Math.trunc(n), 1), 500)
}
function parseOffset(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}
function parseKstDate(raw) {
  const s = String(raw || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

// POS 화면은 순번 호출용이라 손님 전화번호 원본이 필요 없다 — 대기실 화면을 스치듯 보는 다른
// 손님에게 노출될 수 있으므로 마스킹해서 내려준다(계약 §3.13). 표준(010 + 7~8자리)과 자리수가
// 안 맞는 값은 부분적으로 어설프게 노출하느니 전부 가린다.
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 11) return '010-****-****'
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`
}

// Design Ref: docs/02-design/features/multi-store-support.design.md Phase 3
// ADMIN_TOKEN 공유 방식을 대체하는 JWT 인증. 토큰의 role/storeId 클레임을 req.admin에 담아
// 이후 미들웨어(requireRole)와 핸들러가 매장별 접근 범위를 판단하는 데 쓴다.
function requireAuth(req, res, next) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  try {
    const payload = verifyAdminToken(token)
    req.admin = { id: payload.sub, role: payload.role, storeId: payload.storeId, email: payload.email }
    next()
  } catch {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({ ok: false, error: '권한이 없습니다.' })
    }
    next()
  }
}

// store_admin은 쿼리파라미터로 어떤 storeId를 보내든 무시하고 자기 매장으로 강제 고정한다.
// hq_admin은 ?storeId= 쿼리를 그대로 쓰거나(특정 매장), 생략하면 전체 매장을 본다.
function resolveScopedStoreId(req) {
  if (req.admin.role === 'store_admin') return req.admin.storeId
  return String(req.query?.storeId ?? '').trim() || undefined
}

// call/complete/cancel/delete처럼 :id로 특정 예약을 조작하는 라우트에서, store_admin이 다른
// 매장의 예약을 건드리지 못하도록 막는다. hq_admin은 항상 통과.
function assertOwnsReservation(req, res, reservation) {
  if (req.admin.role === 'store_admin' && reservation.storeId !== req.admin.storeId) {
    res.status(403).json({ ok: false, error: '다른 매장의 예약입니다.' })
    return false
  }
  return true
}

function assertOwnsPayment(req, res, payment) {
  if (req.admin.role === 'store_admin' && payment.storeId !== req.admin.storeId) {
    res.status(403).json({ ok: false, error: '다른 매장의 결제입니다.' })
    return false
  }
  return true
}

// 토스 SDK가 단말기에서 넘겨주는 merchant.id를 우리 내부 store(가맹점) 레코드로 변환한다.
// 등록되지 않은 merchantId면(=본사가 아직 이 매장을 승인 안 함) null을 반환한다.
// 요청 바디의 merchantId를 필수로 강제해 여러 매장 데이터가 서로 섞이는 걸 서버단에서 막는다.
// 손님용 공개 API(예약/결제)는 계약 §2.3에 따라 여전히 이 방식을 쓴다 — 키오스크 특성상
// 손님 개인을 인증할 방법이 없어 merchantId가 유일한 신뢰 경계다.
const requireStore = asyncHandler(async (req, res, next) => {
  const merchantId = req.body?.merchantId ?? req.query?.merchantId
  if (merchantId === undefined || merchantId === null || merchantId === '') {
    return res.status(400).json({ ok: false, error: '가맹점 정보(merchantId)가 없습니다.' })
  }
  const store = await findStoreByMerchantId(merchantId)
  if (!store) {
    return res.status(404).json({ ok: false, error: '등록되지 않은 가맹점입니다.' })
  }
  if (store.status !== 'active') {
    return res.status(403).json({ ok: false, error: '비활성화된 가맹점입니다.' })
  }
  req.store = store
  next()
})

// POS 탭앱 인증(계약 §2.2, 가장 중요한 변경). merchantId는 더 이상 POS 라우트의 인증 수단이
// 아니다(보내도 무시) — 매장별로 발급된 X-Store-Token(64자 hex, Store.posToken)만 신뢰한다.
// merchantId 방식은 매장 단말기 안에서 SDK가 자동으로 실어주는 값이라 탈취/위조가 쉬운데,
// POS 탭앱은 대기열의 손님 전화번호(부분 마스킹이라도)와 호출/완료/취소 같은 상태 변경 권한을
// 가지므로 훨씬 강한 인증이 필요하다.
const requireStoreToken = asyncHandler(async (req, res, next) => {
  const token = String(req.get('x-store-token') || '').trim()
  // 인증 실패는 rejectPosAuthFailure가 카운터를 올리고 401(또는 한도 초과 시 429)까지 보낸다.
  // 성공 경로에서는 카운터를 전혀 건드리지 않는다 — 폴링이 DB에 쓰지 않게 하려는 것이 핵심이다.
  if (!token) {
    return rejectPosAuthFailure(req, res, {
      ok: false, error: '매장 인증 토큰이 필요합니다.', code: 'STORE_TOKEN_REQUIRED',
    })
  }
  const store = await findStoreByPosToken(token)
  if (!store) {
    return rejectPosAuthFailure(req, res, {
      ok: false, error: '매장 인증 토큰이 올바르지 않습니다.', code: 'INVALID_STORE_TOKEN',
    })
  }
  if (store.status !== 'active') {
    return res.status(403).json({ ok: false, error: '비활성화된 가맹점입니다.' })
  }
  req.store = store
  next()
})

// --- 관리자 인증 ---
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  store: new PostgresRateLimitStore(prisma, { prefix: 'admin-login', windowMs: 15 * 60 * 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

// 계정 잠금(계약 §3.22): IP 기준 레이트리밋과 별개로, 같은 "계정"에 대한 비밀번호 실패가
// 5회 쌓이면 15분간 그 계정으로는 로그인 자체를 막는다. IP 레이트리밋만으로는 공격자가 여러 IP를
// 돌려가며(혹은 낮은 빈도로) 한 계정을 크리덴셜 스터핑하는 걸 못 막기 때문이다.
app.post('/api/admin/login', adminLoginLimiter, asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  const password = String(req.body?.password ?? '')
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: '이메일/비밀번호를 입력해주세요.' })
  }

  const admin = await findAdminUserByEmail(email)
  if (!admin) {
    // 존재하지 않는 이메일은 계정 존재 여부가 새어나가지 않도록 기존과 동일하게 401만 반환한다.
    return res.status(401).json({ ok: false, error: '이메일 또는 비밀번호가 올바르지 않습니다.' })
  }

  if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
    return res.status(423).json({ ok: false, error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.' })
  }

  if (!(await verifyPassword(password, admin.passwordHash))) {
    await recordFailedLogin(admin.id)
    return res.status(401).json({ ok: false, error: '이메일 또는 비밀번호가 올바르지 않습니다.' })
  }

  await markAdminLogin(admin.id)
  const token = signAdminToken(admin)
  return res.json({ ok: true, token, role: admin.role, storeId: admin.storeId, email: admin.email })
}))

// 로그인한 관리자 본인 정보 (역할/소속 매장). store_admin이 자기 매장의 merchantId/posToken을 알아야
// 테스트 예약 등록이나 POS 탭앱 토큰 입력 같은 매장-스코프 액션을 할 수 있어서, 이 매장 조회는
// role 제한 없이 허용한다(store 안에 posToken이 포함되지만 어차피 "자기 매장"의 값이라 안전하다).
app.get('/api/admin/me', requireAuth, asyncHandler(async (req, res) => {
  let store = null
  if (req.admin.storeId) {
    store = await getStore(req.admin.storeId)
  }
  return res.json({ ok: true, id: req.admin.id, email: req.admin.email, role: req.admin.role, store })
}))

// 로그인한 사람이 자기 비밀번호를 바꾼다.
//
// 지금까지 비밀번호를 바꿀 방법이 아예 없었다. 잊으면 들어갈 길이 없어서 DB의 passwordHash를
// 직접 갈아끼워야 했다(실제로 그렇게 복구했다). ADMIN_BOOTSTRAP_PASSWORD 시크릿을 바꾸고
// 재배포해도 소용없다 — 그 값은 "관리자가 하나도 없을 때 처음 만들 값"이라, 이미 계정이 있으면
// 부팅 코드가 그냥 지나간다.
//
// 잊은 경우까지 셀프로 풀어주려면 이메일 발송이나 마스터 비밀번호가 필요한데, 전자는 인프라가
// 없고 후자는 GCP 콘솔 접근 권한이 곧 관리자 권한이 되는 문제가 있다. 그래서 여기서는
// "기억하고 있을 때 바꿀 수 있게" 하는 것까지만 한다 — 정기 교체와 유출 시 대응은 이걸로 된다.
app.post('/api/admin/password', requireAuth, adminLoginLimiter, asyncHandler(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? '')
  const newPassword = String(req.body?.newPassword ?? '')

  if (newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: '새 비밀번호는 8자 이상이어야 합니다.' })
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ ok: false, error: '지금 쓰는 비밀번호와 다른 값을 입력해주세요.' })
  }

  const admin = await getAdminUser(req.admin.id)
  if (!admin) {
    return res.status(404).json({ ok: false, error: '계정을 찾을 수 없습니다.' })
  }
  // 토큰만으로 바꾸게 하면, 자리를 비운 사이 열린 화면으로 남이 비밀번호를 갈아버릴 수 있다.
  if (!(await verifyPassword(currentPassword, admin.passwordHash))) {
    return res.status(401).json({ ok: false, error: '지금 쓰는 비밀번호가 올바르지 않습니다.' })
  }

  const updated = await changeAdminPassword(admin.id, await hashPassword(newPassword))
  if (!updated) {
    return res.status(500).json({ ok: false, error: '비밀번호를 변경하지 못했습니다.' })
  }
  // 기존 토큰은 그대로 유효하다(만료 12시간). 여기서 전부 무효화하려면 토큰 버전 관리가
  // 필요한데, 자기 비밀번호를 스스로 바꾸는 흐름에서는 그만한 값이 없다.
  return res.json({ ok: true })
}))

// 일별 요약 (관리자 전용, 계약 v3 §5.1 신규). hq_admin은 ?storeId=로 특정 매장 또는 전체(생략),
// store_admin은 항상 자기 매장으로 고정된다(resolveScopedStoreId, 다른 라우트와 동일 패턴).
// date는 KST YYYY-MM-DD, 기본값은 오늘. 예약은 serviceDate 기준으로 필터하고, 결제는 createdAt의
// KST 하루 범위로 필터한다 — 두 모델의 "그 날" 기준이 다르기 때문이다(getDailySummary 주석 참고).
app.get('/api/admin/summary', requireAuth, asyncHandler(async (req, res) => {
  const storeId = resolveScopedStoreId(req)
  const date = parseKstDate(req.query.date) || kstDateString()
  const range = kstDateRangeUtc(date)
  const summary = await getDailySummary({ storeId, date, dateStart: range.start, dateEnd: range.end })
  return res.json({ ok: true, date, storeId: storeId || null, ...summary })
}))

// 매장 관리자 계정 발급 (본사 전용). merchantId로 매장을 찾아 그 매장에 스코프된 계정을 만든다.
app.post('/api/admin/store-admins', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  const password = String(req.body?.password ?? '')
  const merchantId = String(req.body?.merchantId ?? '').trim()

  if (!email || !password || !merchantId) {
    return res.status(400).json({ ok: false, error: 'email/password/merchantId가 모두 필요합니다.' })
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: '비밀번호는 8자 이상이어야 합니다.' })
  }
  const store = await findStoreByMerchantId(merchantId)
  if (!store) {
    return res.status(404).json({ ok: false, error: '등록되지 않은 가맹점입니다.' })
  }
  if (await findAdminUserByEmail(email)) {
    return res.status(409).json({ ok: false, error: '이미 등록된 이메일입니다.' })
  }

  const passwordHash = await hashPassword(password)
  const admin = await createAdminUser({ email, passwordHash, role: 'store_admin', storeId: store.id })
  return res.json({ ok: true, admin: { id: admin.id, email: admin.email, role: admin.role, storeId: admin.storeId } })
}))

const reservationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  store: new PostgresRateLimitStore(prisma, { prefix: 'reservation', windowMs: 10 * 60 * 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  store: new PostgresRateLimitStore(prisma, { prefix: 'payment', windowMs: 10 * 60 * 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

// 대기중인 예약을 호출 처리하고 "순서입니다" 알림톡을 보낸다. status를 'called'로 바꾸는 것과
// 알림 발송은 최초 호출(notifyQueueTurn)과 재발송(retry-notify) 두 지점에서 공유하므로
// sendQueueTurnAndSync로 분리했다 — 발송 실패 시 notify_failed로 되돌리는 로직도 공유한다.
async function sendQueueTurnAndSync(reservation) {
  try {
    await solapi.sendQueueTurnAlimtalk({
      phone: reservation.phone,
      carNumber: reservation.carNumber,
      queueNumber: reservation.queueNumber,
      serviceType: reservation.serviceType,
      storeName: reservation.store?.name,
      storeId: reservation.storeId,
      reservationId: reservation.id,
    })
    return { sent: true, status: 'called' }
  } catch (notifyError) {
    logger.error('순서 알림톡 발송 실패', {
      reservationId: reservation.id,
      storeId: reservation.storeId,
      error: notifyError.message,
    })
    const failed = await markReservationNotifyFailed(reservation.id)
    return { sent: false, status: failed?.status || 'notify_failed' }
  }
}

// 예약 접수 자체는 호출로 취급하지 않으며, 관리자/POS의 수동 호출 API에서만 이 함수를 쓴다.
// DB 업데이트와 별개로, 호출부(server.js)가 응답 본문을 만들 때 쓰는 로컬 reservation 객체의
// status도 함께 갱신해준다 — 인메모리 시절엔 같은 객체를 참조해서 자동으로 반영됐지만
// Prisma는 매번 새 객체를 반환하므로 명시적으로 맞춰줘야 한다.
// ⚠️ 이 함수는 markReservationCalled가 실패하면(=이미 다른 상태) Error를 던진다. 호출부가
// asyncHandler로 감싸져 있지 않으면 이 throw가 unhandledRejection으로 새어나가 프로세스가
// 죽을 수 있었다(계약 §5) — 지금은 이 함수를 부르는 3개 라우트 전부 asyncHandler로 감쌌다.
async function notifyQueueTurn(reservation) {
  const called = await markReservationCalled(reservation.id)
  if (!called) {
    const current = await getReservation(reservation.id)
    if (current && ['called', 'notify_failed', 'completed', 'cancelled'].includes(current.status)) {
      reservation.status = current.status
      return { changed: false, status: current.status }
    }
    throw new Error('대기중인 예약이 아니거나 이미 삭제되었습니다.')
  }
  reservation.status = 'called'
  const outcome = await sendQueueTurnAndSync(reservation)
  reservation.status = outcome.status
  return { changed: true, status: outcome.status }
}

// --- 예약(대기순번) ---
// 차량번호 + 전화번호를 등록하고 대기번호를 발급한다.
// "앞에 몇 명 있는지"는 오늘(serviceDate) 접수분 중 완료/취소가 아닌 예약 수로 센다.
// 단순히 'waiting'만 세면, 이미 호출됐지만 아직 정비 중인 손님을 무시하고 대기인원을 잘못 계산한다
// (정비 베이가 몇 개 비었는지는 모르니, 관리자가 /api/reservations/:id/complete로 "정비완료"를
// 눌러줘야 그 손님이 앞에서 빠진다).
// 예약 접수 시에는 앞에 사람이 없더라도 항상 waiting 상태로 두고 접수 알림톡만 보낸다.
// 실제 호출은 직원이 POS/관리자 화면에서 명시적으로 눌렀을 때만 발생한다.
app.post('/api/reservations', publicCors, reservationLimiter, requireStore, asyncHandler(async (req, res) => {
  const storeId = req.store.id
  const carNumber = String(req.body?.carNumber ?? '').trim()
  const phone = String(req.body?.phone ?? '').replace(/-/g, '').trim()
  const serviceTypeKey = String(req.body?.serviceType ?? '').trim()

  if (!CAR_NUMBER_RE.test(carNumber)) {
    return res.status(400).json({ ok: false, error: '차량번호 형식이 올바르지 않습니다. 예) 12가3456' })
  }
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ ok: false, error: '전화번호 형식이 올바르지 않습니다.' })
  }
  if (!SERVICE_TYPES[serviceTypeKey]) {
    return res.status(400).json({ ok: false, error: '정비 항목을 선택해주세요.' })
  }
  const serviceType = SERVICE_TYPES[serviceTypeKey]

  // 개인정보보호법 제15조: 수집·이용 동의 없이는 접수 자체를 막는다(계약 §3.1). 광고 수신
  // 동의(marketingConsent)는 선택 항목이라 false/누락이어도 접수는 진행하되, 그 손님은 나중에
  // claimDuePromotions가 marketingConsentAt IS NOT NULL만 대상으로 하므로 자동으로 프로모션
  // 발송 대상에서 빠진다(계약 §4).
  if (req.body?.privacyConsent !== true) {
    return res.status(400).json({ ok: false, error: '개인정보 수집·이용에 동의해주세요.' })
  }
  const consentAt = new Date()
  const privacyConsentAt = consentAt
  const marketingConsentAt = req.body?.marketingConsent === true ? consentAt : null

  const idempotencyKey = String(req.get('idempotency-key') || '').trim() || null
  if (idempotencyKey && idempotencyKey.length > 200) {
    return res.status(400).json({ ok: false, error: 'Idempotency-Key가 너무 깁니다.' })
  }

  let reservation, peopleAhead, duplicate
  try {
    ;({ reservation, peopleAhead, duplicate } = await createReservation({
      storeId,
      carNumber,
      phone,
      serviceType,
      idempotencyKey,
      privacyConsentAt,
      marketingConsentAt,
    }))
  } catch (e) {
    logger.error('reservation error', { storeId, error: e.message, code: e.code })
    if (e?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
      return res.status(409).json({ ok: false, error: e.message })
    }
    // 계약 §5: 클라이언트에는 내부 에러 메시지(e.message)를 노출하지 않는다.
    return res.status(500).json({ ok: false, error: '요청 처리 중 오류가 발생했습니다.' })
  }

  if (duplicate) {
    return res.json({
      ok: true,
      id: reservation.id,
      queueNumber: reservation.queueNumber,
      peopleAhead,
      serviceType: reservation.serviceType,
      status: reservation.status,
      serviceDate: reservation.serviceDate,
      duplicate: true,
    })
  }

  reservation.store = req.store // notifyQueueTurn/알림톡에서 #{매장명}으로 쓰기 위해 붙여둔다

  try {
    await solapi.sendReservationAlimtalk({
      phone,
      carNumber,
      queueNumber: reservation.queueNumber,
      peopleAhead,
      serviceType,
      storeName: req.store.name,
      storeId,
      reservationId: reservation.id,
    })
  } catch (notifyError) {
    logger.error('예약 접수 알림 발송 실패', {
      reservationId: reservation.id,
      storeId,
      error: notifyError.message,
    })
    // 접수 안내 알림 발송에 실패해도 손님은 여전히 대기중이므로 status는 바꾸지 않는다.
    // 대신 intakeNotifyStatus='failed'만 기록해 관리자 화면이 재발송 대상을 알 수 있게 한다
    // (계약 v3 §2.1). 중복(idempotency) 경로는 애초에 이 try 블록을 타지 않으므로 여기서
    // 처리할 필요가 없다(기존과 동일).
    await markReservationIntakeFailed(reservation.id)
  }

  return res.json({
    ok: true,
    id: reservation.id,
    queueNumber: reservation.queueNumber,
    peopleAhead,
    serviceType: reservation.serviceType,
    status: reservation.status,
    serviceDate: reservation.serviceDate,
  })
}))

// 매장에서 다음 대기 고객을 호출한다 (관리자 전용). 오늘(serviceDate) 접수분 중 대기중인 첫 건
// (queueNumber 오름차순)에만 알림톡을 발송한다 — 어제 마감 이후 그대로 남아있던 waiting 건이
// 실수로 다시 호출되는 걸 막기 위해 getNextWaitingReservation이 day-scope를 강제한다(계약 §3.6).
// hq_admin은 ?storeId=를 지정해야 하고, store_admin은 자기 매장으로 자동 고정된다.
app.post('/api/queue/call-next', requireAuth, asyncHandler(async (req, res) => {
  const storeId = resolveScopedStoreId(req)
  if (!storeId) {
    return res.status(400).json({ ok: false, error: 'storeId가 필요합니다.' })
  }
  const reservation = await getNextWaitingReservation(storeId)
  if (!reservation) {
    return res.status(404).json({ ok: false, error: '대기중인 예약이 없습니다.' })
  }

  const outcome = await notifyQueueTurn(reservation)

  return res.json({ ok: true, id: reservation.id, queueNumber: reservation.queueNumber, status: reservation.status, alreadyProcessed: !outcome.changed })
}))

// 특정 예약을 대기열 순서와 무관하게 바로 호출한다 (관리자 전용).
// 테스트로 만든 예약을 확인하거나, 예외적으로 순서를 건너뛰어야 할 때 쓴다.
app.post('/api/reservations/:id/call', requireAuth, asyncHandler(async (req, res) => {
  const reservation = await getReservation(req.params.id)
  if (!reservation) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  if (!assertOwnsReservation(req, res, reservation)) return
  if (reservation.status !== 'waiting') {
    if (['called', 'notify_failed'].includes(reservation.status)) {
      return res.json({ ok: true, id: reservation.id, queueNumber: reservation.queueNumber, status: reservation.status, alreadyProcessed: true })
    }
    return res.status(400).json({ ok: false, error: '대기중인 예약만 호출할 수 있습니다.' })
  }

  const outcome = await notifyQueueTurn(reservation)

  return res.json({ ok: true, id: reservation.id, queueNumber: reservation.queueNumber, status: reservation.status, alreadyProcessed: !outcome.changed })
}))

// 손님 취소/노쇼 처리 (관리자 전용, 계약 §3.9 신규). waiting|called|notify_failed만 취소 가능.
app.post('/api/reservations/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  if (!assertOwnsReservation(req, res, existing)) return
  if (existing.status === 'cancelled') {
    return res.json({ ok: true, id: existing.id, status: 'cancelled', alreadyCancelled: true })
  }
  if (existing.status === 'completed') {
    return res.status(409).json({ ok: false, error: '이미 정비완료된 예약입니다.' })
  }
  const reservation = await markReservationCancelled(req.params.id)
  if (!reservation) {
    return res.status(409).json({ ok: false, error: '취소할 수 없는 상태의 예약입니다.' })
  }
  return res.json({ ok: true, id: reservation.id, status: reservation.status })
}))

// 순서 안내 알림톡 재발송 (관리자 전용, 계약 §3.10 신규). notify_failed 상태만 허용.
// 성공하면 called로 되돌리고, 실패해도(HTTP 200으로) notify_failed를 유지한 채 sent:false로 알린다 —
// 관리자가 "재발송이 요청 자체는 처리됐는데 이번에도 안 갔다"를 구분할 수 있어야 하기 때문이다.
app.post('/api/reservations/:id/retry-notify', requireAuth, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  if (!assertOwnsReservation(req, res, existing)) return
  if (existing.status !== 'notify_failed') {
    return res.status(409).json({ ok: false, error: '알림실패 상태의 예약만 재발송할 수 있습니다.' })
  }
  const reservation = await markReservationCalledFromNotifyFailed(existing.id)
  if (!reservation) {
    return res.status(409).json({ ok: false, error: '알림실패 상태의 예약만 재발송할 수 있습니다.' })
  }
  const outcome = await sendQueueTurnAndSync(reservation)
  return res.json({ ok: true, id: reservation.id, status: outcome.status, sent: outcome.sent })
}))

// 접수(대기번호) 알림톡 재발송 (관리자 전용, 계약 v3 §2.3 신규). intakeNotifyStatus='failed'이고
// 아직 completed/cancelled로 끝나지 않은 예약만 허용한다 — retry-notify(순서 재호출)와는 별개로,
// "대기번호 접수됐습니다" 안내가 애초에 안 나간 건을 다시 보내는 용도다.
// status 자체는 바꾸지 않는다(원래도 안 바꿨다) — peopleAhead만 최신값으로 다시 계산해서 보낸다.
app.post('/api/reservations/:id/retry-intake', requireAuth, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  if (!assertOwnsReservation(req, res, existing)) return
  if (existing.intakeNotifyStatus !== 'failed' || ['completed', 'cancelled'].includes(existing.status)) {
    return res.status(409).json({ ok: false, error: '접수 알림 발송 실패 상태의 예약만 재발송할 수 있습니다.' })
  }

  const peopleAhead = await countPeopleAhead(existing.storeId, existing.serviceDate, existing.createdAt)
  try {
    await solapi.sendReservationAlimtalk({
      phone: existing.phone,
      carNumber: existing.carNumber,
      queueNumber: existing.queueNumber,
      peopleAhead,
      serviceType: existing.serviceType,
      storeName: existing.store?.name,
      storeId: existing.storeId,
      reservationId: existing.id,
    })
    await clearReservationIntakeStatus(existing.id)
    return res.json({ ok: true, id: existing.id, sent: true })
  } catch (notifyError) {
    logger.error('접수 알림 재발송 실패', {
      reservationId: existing.id,
      storeId: existing.storeId,
      error: notifyError.message,
    })
    // 다시 실패해도 intakeNotifyStatus는 'failed'로 유지된 채(원래 값 그대로) HTTP 200 + sent:false로
    // 알린다 — retry-notify/retry-receipt와 동일한 패턴(계약 v3 §2.3).
    return res.json({ ok: true, id: existing.id, sent: false })
  }
}))

// 예약을 삭제한다 (관리자 전용). 테스트 데이터 정리나 손님 취소 처리용.
app.delete('/api/reservations/:id', requireAuth, asyncHandler(async (req, res) => {
  const reservation = await getReservation(req.params.id)
  if (!reservation) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  if (!assertOwnsReservation(req, res, reservation)) return
  await deleteReservation(req.params.id)
  return res.json({ ok: true })
}))

// 정비가 끝났음을 표시한다 (관리자 전용). 이걸 눌러야 이 손님이 "앞에 있는 사람" 계산에서 빠져서
// 다음 예약의 대기인원 안내가 한 명 줄어든다.
app.post('/api/reservations/:id/complete', requireAuth, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  if (!assertOwnsReservation(req, res, existing)) return
  const reservation = await markReservationCompleted(req.params.id)
  if (!reservation) {
    if (existing.status === 'completed') {
      return res.json({ ok: true, id: existing.id, status: existing.status, alreadyCompleted: true })
    }
    return res.status(409).json({ ok: false, error: '호출완료 또는 알림실패 상태의 예약만 완료할 수 있습니다.' })
  }
  return res.json({ ok: true, id: reservation.id, status: reservation.status })
}))

// 예약 목록 (관리자 화면용). hq_admin은 ?storeId=로 특정 매장 필터/생략시 전체,
// store_admin은 항상 자기 매장으로 고정된다. 페이지네이션 + 필터를 전부 DB에 위임한다(계약 §3.3) —
// 정렬은 서버가 createdAt desc로 고정해서 내려주므로 클라이언트가 다시 뒤집을 필요가 없다
// (예전엔 여기서 .reverse()를 했는데, 그러려면 매번 전체 로우를 메모리로 가져와야 했다).
app.get('/api/reservations', adminCors, requireAuth, asyncHandler(async (req, res) => {
  const storeId = resolveScopedStoreId(req)
  const date = parseKstDate(req.query.date)
  const statuses = parseStatusFilter(req.query.status, RESERVATION_STATUSES)
  const q = req.query.q
  const limit = parseLimit(req.query.limit)
  const offset = parseOffset(req.query.offset)
  const { total, items } = await listReservationsPage({ storeId, date, statuses, q, limit, offset })
  return res.json({ ok: true, count: items.length, total, hasMore: offset + items.length < total, reservations: items })
}))

// 알림톡 발송 실패 건 확인용(계약 v3 §2.4). 순서 호출 실패(notify_failed)와 접수 알림 실패
// (intakeNotifyStatus='failed')를 함께 반환한다 — 응답 item은 Prisma 모델 그대로라 status/
// intakeNotifyStatus를 모두 포함하므로 프론트가 이걸로 재발송 종류(retry-notify vs retry-intake)를
// 판단한다. /failed 계열은 검색(q) 대상이 아니다(계약 §3.1).
app.get('/api/reservations/failed', requireAuth, asyncHandler(async (req, res) => {
  const storeId = resolveScopedStoreId(req)
  const date = parseKstDate(req.query.date)
  const limit = parseLimit(req.query.limit)
  const offset = parseOffset(req.query.offset)
  const { total, items } = await listFailedReservations({ storeId, date, limit, offset })
  return res.json({ ok: true, count: items.length, total, hasMore: offset + items.length < total, reservations: items })
}))

// --- 토스 POS 탭앱(대기열 관리) 전용 엔드포인트 ---
// 계약 §2.2: merchantId가 아니라 X-Store-Token(requireStoreToken)으로 인증한다.
// GET /api/pos/queue는 5초 폴링 대상이라 DB 기반 PostgresRateLimitStore 대신 express-rate-limit
// 기본 메모리 스토어를 쓴다(계약 §9) — 이미 토큰 인증이 붙어 있어 인스턴스별 한도로 충분하고,
// 폴링마다 DB round-trip을 추가로 만들 이유가 없다.
// 폴링(조회) 라우트의 한도. **IP가 아니라 매장 토큰 기준**으로 센다.
//
// 예전에는 IP당 분당 60회였는데, 탭앱 한 대가 분당 24회(5초마다 queue + erp-carts)를 쓴다.
// 정비소는 한 인터넷 회선에 POS를 여러 대 두므로 **3대만 돼도 72회가 되어 정상 영업 중에
// 429로 막힌다**(실측: 200 응답 60회 뒤 429 = 단말기 2.5대분). 증상이 "가끔 화면이 멈춰요"로
// 나타나서 원인을 찾기도 어렵다.
//
// 매장 토큰으로 키를 잡으면 한 매장이 단말기를 몇 대 두든 그 매장 몫 안에서만 소비된다.
// 토큰은 인증 전 값이지만 이 한도의 목적은 "한 클라이언트가 과하게 두드리는 것"을 막는 것이라
// 문제되지 않는다 — 토큰을 바꿔가며 우회하려는 쪽은 아래 posIpFloodLimiter와 인증 실패
// 카운터(recordPosAuthFailure)가 잡는다.
const POS_READ_LIMIT_PER_MIN = 300

function posStoreRateKey(req) {
  const token = String(req.get('x-store-token') || '').trim()
  // 토큰 원문을 메모리 키로 들고 있지 않도록 해시해서 쓴다.
  if (token) return `store:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)}`
  return `ip:${rateLimit.ipKeyGenerator(req.ip)}`
}

const posQueueReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: POS_READ_LIMIT_PER_MIN,
  keyGenerator: posStoreRateKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

// 토큰을 매번 바꿔가며 두드리면 위 한도는 매번 새 키가 되어 우회된다. 그런 원시적인 폭주는
// IP 기준으로 막는다. 정상 매장(단말기 여러 대 + 상태 변경 요청)이 걸리지 않게 넉넉히 잡되,
// 초당 수십 건짜리 폭주는 확실히 끊는 값이다. 메모리 기준이라 DB를 전혀 건드리지 않는다.
const posIpFloodLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

// 호출/완료/취소처럼 상태를 바꾸는 POS 라우트는 폴링만큼 빈도가 높지 않고, 매장 전체(여러 탭앱
// 인스턴스가 있을 수 있음) 기준의 정확한 한도가 더 의미 있어서 기존처럼 DB 기반 스토어를 유지한다.
const posLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  store: new PostgresRateLimitStore(prisma, { prefix: 'pos', windowMs: 60 * 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

// X-Store-Token 무차별 대입 방어 (validatePosToken 위 주석 참고).
// 관리자가 짧은 토큰(최소 4자)을 지정할 수 있게 하면서도 안전하려면 토큰 추측 시도 자체를
// 막아야 한다. IP당 15분에 10회 실패면 차단한다.
//
// ⚠️ 예전에는 이걸 express-rate-limit의 skipSuccessfulRequests로 구현했다. 그 옵션은
// "일단 세고(increment), 성공하면 되돌리는(decrement)" 방식이라 **정상 요청 1건당 DB 쓰기가
// 2회** 발생했다(실측 확인). 폴링이 5초마다 도는 라우트라 400개 매장이면 초당 320회 —
// 아무 일도 없는데 DB가 그만큼 두들겨 맞는다.
//
// 그래서 미들웨어를 걷어내고 **인증이 실패했을 때만** 카운터를 건드리도록 바꿨다.
// 성공 경로는 DB 쓰기 0회, 방어 성질은 그대로다: 토큰을 틀린 쪽은 항상 실패 경로로 가서
// 세어지고, 맞힌 쪽은 애초에 정당한 매장이다.
//
// 인스턴스별 메모리가 아니라 DB 스토어를 쓰는 이유는 그대로다: Cloud Run이 인스턴스를 여러 개
// 띄우므로 메모리 기준이면 공격자가 인스턴스 수만큼 시도 기회를 더 얻는다.
const POS_AUTH_FAILURE_LIMIT = 10
const POS_AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000
const posAuthFailureStore = new PostgresRateLimitStore(prisma, {
  prefix: 'pos-auth',
  windowMs: POS_AUTH_FAILURE_WINDOW_MS,
})

// 인증 실패를 1회 기록하고, 한도를 넘었으면 429를 보낸 뒤 true를 돌려준다.
// (호출부는 true면 이미 응답이 나갔으므로 그대로 return 하면 된다.)
async function rejectPosAuthFailure(req, res, unauthorizedBody) {
  const key = `ip:${rateLimit.ipKeyGenerator(req.ip)}`
  let totalHits = 1
  try {
    const result = await posAuthFailureStore.increment(key)
    totalHits = result.totalHits
  } catch (e) {
    // 카운터를 못 쓰더라도 인증 자체는 이미 실패한 상태다. 여기서 500을 내면 공격자에게
    // DB를 흔드는 수단을 주는 셈이라, 로그만 남기고 평소대로 401로 돌려보낸다.
    logger.error('[pos] 인증 실패 카운터 기록 실패', { error: e.message })
  }
  if (totalHits > POS_AUTH_FAILURE_LIMIT) {
    res.status(429).json({
      ok: false,
      error: '매장 인증 실패가 반복되어 일시적으로 차단되었습니다. 15분 후 다시 시도해주세요.',
    })
    return true
  }
  res.status(401).json(unauthorizedBody)
  return true
}

// 오늘(KST) serviceDate 접수분 + 아직 끝나지 않은 이월 건(called/notify_failed)을 함께 보여준다
// (계약 v3 §4.1~4.2). 응답 최상위 serviceDate(오늘 날짜)는 그대로 유지하고, 각 item에도
// serviceDate를 실어보내 POS 화면이 "오늘 최상위 serviceDate와 다르면 이월 건"으로 배지를 붙일 수
// 있게 한다.
app.get('/api/pos/queue', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const serviceDate = kstDateString()
  // 대기열과 전산 장바구니를 한 응답에 함께 담는다. 예전에는 탭앱이 두 경로를 각각 폴링해서
  // 매장당 요청이 두 배였다 -- 400개 매장 기준 초당 160건 중 절반이 이 때문이었다.
  // 두 조회는 서로 무관하므로 병렬로 던진다.
  const [reservations, erpCarts] = await Promise.all([
    listActiveQueueForStore(req.store.id, serviceDate),
    loadPendingErpCartsForResponse(req.store.id),
  ])
  return res.json({
    ok: true,
    serviceDate,
    storeName: req.store.name,
    // 구버전 탭앱은 이 필드를 무시하고 /api/pos/erp-carts를 계속 부른다(그 경로도 살아 있다).
    erpCarts,
    reservations: reservations.map((r) => ({
      id: r.id,
      queueNumber: r.queueNumber,
      carNumber: r.carNumber,
      serviceType: r.serviceType,
      status: r.status,
      phoneMasked: maskPhone(r.phone),
      createdAt: r.createdAt,
      serviceDate: r.serviceDate,
    })),
  })
}))

// --- 쉐보레 전산(ERP) "물건 담기" -> POS 플러그인 장바구니 중계 (POS-CART-BRIDGE §1) ---
// POS 플러그인이 5초 폴링으로 가져가 posPluginSdk.draftOrder.addLineItem()에 그대로 넘길 수 있게
// items를 파싱해서 내려준다. queue 폴링과 마찬가지로 인스턴스 기준 메모리 레이트리밋
// (posQueueReadLimiter)으로 충분하다 -- 이미 토큰 인증이 붙어 있고, 폴링마다 DB round-trip을
// 늘릴 이유가 없다.
// 대기 중인 전산 장바구니를 응답 형태로 만든다. /api/pos/queue와 /api/pos/erp-carts가
// 같은 값을 내려주도록 한 곳에 모았다.
async function loadPendingErpCartsForResponse(storeId) {
  const rows = await listPendingErpCarts(storeId, 20)
  const carts = []
  for (const row of rows) {
    let items
    try {
      items = JSON.parse(row.itemsJson)
    } catch (e) {
      // 손상된 itemsJson 한 건 때문에 이 매장의 폴링 응답 전체가 500으로 죽으면 안 된다 --
      // 그 건만 건너뛰고 로그로 남겨서 나중에 원인을 조사할 수 있게 한다.
      logger.error('[pos] ErpCart.itemsJson 파싱 실패 -- 이 건은 건너뜁니다.', { cartId: row.id, error: e.message })
      continue
    }
    carts.push({
      id: row.id,
      referenceId: row.referenceId,
      items,
      totalAmount: row.totalAmount,
      memo: row.memo,
      autoPay: row.autoPay,
      createdAt: row.createdAt,
      // 차량번호는 memo에도 들어 있지만 자유 문자열이라 화면에서 따로 강조할 수 없다.
      // 정비소는 차량번호로 일을 식별하므로 별도 필드로 내려 카드에 크게 띄운다.
      carNumber: row.carNumber,
      // 예약과 이어졌으면 결제 후 정비완료까지 자동으로 된다. 직원이 그 사실을 알아야
      // "왜 대기열에서 안 사라지지?"를 나중에 묻지 않는다.
      linkedReservation: Boolean(row.reservationId),
    })
  }
  return carts
}

// ⚠️ 이 라우트는 **구버전 탭앱 호환용**으로 남겨둔다. 새 탭앱은 /api/pos/queue 응답의
// erpCarts를 쓰므로 이 경로를 부르지 않는다 -- 폴링 요청이 매장당 절반으로 줄어든다.
// 400개 매장이 한꺼번에 업데이트되지는 않으므로 당분간 둘 다 살아 있어야 한다.
app.get('/api/pos/erp-carts', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  return res.json({ ok: true, carts: await loadPendingErpCartsForResponse(req.store.id) })
}))

// POS 플러그인이 addLineItem() 결과를 되돌려준다. posLimiter를 쓴다 -- 폴링(조회)이 아니라
// "이 매장 전체 기준으로 한도를 두는 게 의미 있는" 상태 변경 액션이라 posQueueReadLimiter가 아닌
// 기존 posLimiter(DB 기반)와 맞춘다.
app.post('/api/pos/erp-carts/:id/consume', posIpFloodLimiter, posLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  // dismissed = 매장 직원이 화면에서 이 주문을 치웠다(잘못 온 건). 전산이 취소한 cancelled와
  // 구분해서 남긴다 -- 전산 입장에서 "우리가 취소"와 "매장이 거부"는 후속 조치가 다르다.
  const result = req.body?.result
  if (result !== 'loaded' && result !== 'failed' && result !== 'dismissed') {
    return res.status(400).json({ ok: false, error: "result는 'loaded', 'failed', 'dismissed' 중 하나여야 합니다." })
  }

  // 다른 매장 소유의 cart를 건드리지 못하게 storeId까지 확인한다 -- id만으로 조회하면 다른 매장
  // POS 토큰으로도 남의 장바구니 상태를 바꿀 수 있게 되어버린다.
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '장바구니를 찾을 수 없습니다.' })
  }

  if (cart.status !== 'pending') {
    // POS가 네트워크 오류 등으로 같은 consume을 재시도해도 안전해야 한다 -- 이미 처리된 건이면
    // 실패로 취급하지 않고 그대로 알려준다.
    return res.json({ ok: true, alreadyProcessed: true, status: cart.status })
  }

  // 위에서 pending을 확인했더라도 이 사이에 다른 요청(POS 단말기 2대가 동시에 consume하는 경우)이
  // 먼저 전이시켰을 수 있다 -- markErpCartLoaded/Failed 자체가 원자적 updateMany라 그 경쟁을
  // 최종적으로 판정한다. 반환값(changed)이 false면 내가 아니라 그 사이의 다른 요청이 이겼다는
  // 뜻이므로, 최신 상태를 다시 읽어 alreadyProcessed로 응답한다.
  // errorMessage는 failed의 사유이자 dismissed의 사유(직원이 남긴 메모)로도 쓴다.
  const note = req.body?.errorMessage !== undefined && req.body?.errorMessage !== null
    ? String(req.body.errorMessage).slice(0, 500)
    : null

  let changed
  if (result === 'loaded') {
    changed = await markErpCartLoaded(cart.id)
  } else if (result === 'dismissed') {
    changed = await markErpCartDismissed(cart.id, note)
  } else {
    changed = await markErpCartFailed(cart.id, note)
  }

  if (!changed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    return res.json({ ok: true, alreadyProcessed: true, status: latest?.status })
  }
  return res.json({ ok: true, alreadyProcessed: false, status: result })
}))

// 특정 손님을 호출한다. POS 탭앱 쪽에서 "이 번호를 탭하면 바로 호출"이 되지 않도록
// 반드시 명시적인 확인 동작(예: 2단계 확인 버튼) 뒤에만 이 엔드포인트를 호출해야 한다 —
// 서버는 그 UX를 강제할 수 없으므로 프론트(탭앱) 쪽 책임이다.
// 해당 매장 + 오늘 serviceDate의 예약만 대상으로 한다(계약 §3.14) — 아니면 404.
app.post('/api/pos/queue/:id/call', posIpFloodLimiter, posLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const serviceDate = kstDateString()
  const reservation = await getReservation(req.params.id)
  if (!reservation || reservation.storeId !== req.store.id || reservation.serviceDate !== serviceDate) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  if (reservation.status !== 'waiting') {
    if (['called', 'notify_failed'].includes(reservation.status)) {
      return res.json({ ok: true, id: reservation.id, status: reservation.status, alreadyProcessed: true })
    }
    return res.status(400).json({ ok: false, error: '대기중인 예약만 호출할 수 있습니다.' })
  }
  const outcome = await notifyQueueTurn(reservation)
  return res.json({ ok: true, id: reservation.id, status: reservation.status, alreadyProcessed: !outcome.changed })
}))

// 해당 매장만 확인한다(계약 v3 §4.3) — day-scope(오늘 serviceDate만)는 일부러 제거했다. 밤새 맡긴
// 차(어제 called 상태)를 다음날 POS에서 완료 처리할 수 있어야 하기 때문이다. 호출(call)은 여전히
// 오늘 것만 허용하므로(아래 call 라우트), 여기서 day-scope를 빼도 "어제 waiting을 오늘 실수로 새로
// 호출"하는 사고로는 이어지지 않는다.
app.post('/api/pos/queue/:id/complete', posIpFloodLimiter, posLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing || existing.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  const reservation = await markReservationCompleted(req.params.id)
  if (!reservation) {
    if (existing.status === 'completed') {
      return res.json({ ok: true, id: existing.id, status: existing.status, alreadyCompleted: true })
    }
    return res.status(409).json({ ok: false, error: '호출완료 또는 알림실패 상태의 예약만 완료할 수 있습니다.' })
  }
  return res.json({ ok: true, id: reservation.id, status: reservation.status })
}))

// 노쇼 손님을 대기열에서 빼는 용도 (계약 §3.16 신규). complete와 동일하게(계약 v3 §4.3) 해당
// 매장만 확인하고 day-scope는 두지 않는다 — 이월(called/notify_failed) 건도 취소할 수 있어야 한다.
app.post('/api/pos/queue/:id/cancel', posIpFloodLimiter, posLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing || existing.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' })
  }
  if (existing.status === 'cancelled') {
    return res.json({ ok: true, id: existing.id, status: 'cancelled', alreadyProcessed: true })
  }
  if (existing.status === 'completed') {
    return res.status(409).json({ ok: false, error: '이미 정비완료된 예약입니다.' })
  }
  const reservation = await markReservationCancelled(req.params.id)
  if (!reservation) {
    return res.status(409).json({ ok: false, error: '취소할 수 없는 상태의 예약입니다.' })
  }
  return res.json({ ok: true, id: reservation.id, status: reservation.status })
}))

// --- 결제 (전자영수증 + 3개월 후 프로모션) ---
// paymentKey(토스프론트 sdk.payment.requestPayment 호출 시 발급한 값)를 함께 보내면
// 같은 결제건에 대해 클라이언트가 재시도해도 영수증이 중복 발송되지 않는다.
app.post('/api/payments', publicCors, paymentLimiter, requireStore, asyncHandler(async (req, res) => {
  const storeId = req.store.id
  const paymentKey = String(req.body?.paymentKey ?? '').trim() || null
  const phone = String(req.body?.phone ?? '').replace(/-/g, '').trim()
  const carNumberRaw = String(req.body?.carNumber ?? '').trim()
  const amountRaw = req.body?.amount

  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ ok: false, error: '전화번호 형식이 올바르지 않습니다.' })
  }
  if (carNumberRaw && !CAR_NUMBER_RE.test(carNumberRaw)) {
    return res.status(400).json({ ok: false, error: '차량번호 형식이 올바르지 않습니다. 예) 12가3456' })
  }
  let amount = null
  if (amountRaw !== undefined && amountRaw !== null && amountRaw !== '') {
    amount = Number(amountRaw)
    // amount 컬럼은 Postgres Int(int4)다. 예전엔 Number.isFinite만 확인해서 소수점이 있는 값이나
    // 2^31을 넘는 값이 그대로 통과해 실제 INSERT 시점에야 예외가 났다 — 손님은 이미 결제를 마친
    // 뒤라 이 시점의 500은 매우 곤란하다(계약 §3.2). Number.isSafeInteger + 범위 체크로 미리 막는다.
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000000) {
      return res.status(400).json({ ok: false, error: '결제금액이 올바르지 않습니다.' })
    }
  }

  if (req.body?.privacyConsent !== true) {
    return res.status(400).json({ ok: false, error: '개인정보 수집·이용에 동의해주세요.' })
  }
  const consentAt = new Date()
  const privacyConsentAt = consentAt
  const marketingConsentAt = req.body?.marketingConsent === true ? consentAt : null

  let payment
  try {
    const existing = await findPaymentByKey(paymentKey)
    if (existing) {
      return res.json({ ok: true, id: existing.id, carNumber: existing.carNumber, serviceType: existing.serviceType })
    }

    // 결제 화면에서 차량번호를 다시 입력받는 대신, 전화번호로 이 손님의 예약 기록을 찾아
    // 차량번호/정비항목을 그대로 가져다 쓴다. 같은 매장 안에서만 찾고, 예약 없이 바로 결제하는
    // 손님(연결된 예약이 없는 경우)만 클라이언트가 보낸 carNumber를 fallback으로 쓴다.
    const linkedReservation = await findLatestReservationByPhone(storeId, phone)
    const carNumber = linkedReservation?.carNumber || carNumberRaw || null
    const serviceType = linkedReservation?.serviceType || null

    payment = await createPayment({ storeId, paymentKey, carNumber, serviceType, phone, amount, privacyConsentAt, marketingConsentAt })
  } catch (e) {
    logger.error('payment error', { storeId, error: e.message, code: e.code })
    return res.status(500).json({ ok: false, error: '요청 처리 중 오류가 발생했습니다.' })
  }

  try {
    await solapi.sendReceiptAlimtalk({
      phone,
      carNumber: payment.carNumber,
      serviceType: payment.serviceType,
      amount: payment.amount,
      storeName: req.store.name,
      storeId,
      paymentId: payment.id,
    })
    await markPaymentStatus(payment.id, 'receipt_sent')
  } catch (notifyError) {
    logger.error('전자영수증 발송 실패', {
      paymentId: payment.id,
      storeId,
      error: notifyError.message,
    })
    await markPaymentStatus(payment.id, 'receipt_failed')
    // 영수증 발송에 실패해도 결제/DB 적재 자체는 성공으로 처리한다
  }

  return res.json({ ok: true, id: payment.id, carNumber: payment.carNumber, serviceType: payment.serviceType })
}))

// 결제 목록 (관리자 화면용). date는 createdAt의 KST 날짜 기준(계약 §3.5) — Payment에는 serviceDate가
// 없으므로 kstDateRangeUtc로 하루 범위(UTC)를 계산해 createdAt 인덱스를 그대로 태운다.
app.get('/api/payments', adminCors, requireAuth, asyncHandler(async (req, res) => {
  const storeId = resolveScopedStoreId(req)
  const date = parseKstDate(req.query.date)
  const statuses = parseStatusFilter(req.query.status, PAYMENT_STATUSES)
  const q = req.query.q
  const limit = parseLimit(req.query.limit)
  const offset = parseOffset(req.query.offset)
  const range = date ? kstDateRangeUtc(date) : null
  const { total, items } = await listPaymentsPage({ storeId, dateStart: range?.start, dateEnd: range?.end, statuses, q, limit, offset })
  return res.json({ ok: true, count: items.length, total, hasMore: offset + items.length < total, payments: items })
}))

app.get('/api/payments/failed', requireAuth, asyncHandler(async (req, res) => {
  const storeId = resolveScopedStoreId(req)
  const date = parseKstDate(req.query.date)
  const limit = parseLimit(req.query.limit)
  const offset = parseOffset(req.query.offset)
  const range = date ? kstDateRangeUtc(date) : null
  const { total, items } = await listPaymentsPage({ storeId, dateStart: range?.start, dateEnd: range?.end, statuses: ['receipt_failed'], limit, offset })
  return res.json({ ok: true, count: items.length, total, hasMore: offset + items.length < total, payments: items })
}))

// 전자영수증 재발송 (관리자 전용, 계약 §3.11 신규). receipt_failed 상태만 허용.
app.post('/api/payments/:id/retry-receipt', requireAuth, asyncHandler(async (req, res) => {
  const existing = await getPayment(req.params.id)
  if (!existing) {
    return res.status(404).json({ ok: false, error: '결제를 찾을 수 없습니다.' })
  }
  if (!assertOwnsPayment(req, res, existing)) return
  if (existing.status !== 'receipt_failed') {
    return res.status(409).json({ ok: false, error: '영수증 발송 실패 상태의 결제만 재발송할 수 있습니다.' })
  }
  // markPaymentReceiptRetrying이 receipt_failed -> receipt_sent 전이를 원자적으로 낙관 처리한다
  // (notifyQueueTurn/markReservationCalled와 같은 패턴) — 관리자 두 명이 거의 동시에 재발송
  // 버튼을 눌러도 solapi 호출은 한 번만 나간다. 실패하면 markPaymentStatus로 되돌린다.
  const claimed = await markPaymentReceiptRetrying(existing.id)
  if (!claimed) {
    return res.status(409).json({ ok: false, error: '영수증 발송 실패 상태의 결제만 재발송할 수 있습니다.' })
  }
  try {
    await solapi.sendReceiptAlimtalk({
      phone: claimed.phone,
      carNumber: claimed.carNumber,
      serviceType: claimed.serviceType,
      amount: claimed.amount,
      storeName: claimed.store?.name,
      storeId: claimed.storeId,
      paymentId: claimed.id,
    })
    return res.json({ ok: true, id: claimed.id, status: 'receipt_sent', sent: true })
  } catch (notifyError) {
    logger.error('전자영수증 재발송 실패', { paymentId: claimed.id, storeId: claimed.storeId, error: notifyError.message })
    await markPaymentStatus(claimed.id, 'receipt_failed')
    return res.json({ ok: true, id: claimed.id, status: 'receipt_failed', sent: false })
  }
}))

// --- 가맹점(매장) 관리 (본사 관리자 전용) ---
// 토스플레이스 개발자센터에서 발급된 merchant.id를 우리 store 레코드와 매핑해 등록한다.
// 등록해야만 그 매장의 플러그인에서 온 예약/결제 요청이 통과된다 (requireStore 참고).
app.get('/api/admin/stores', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  return res.json({ ok: true, stores: await listStores() })
}))

app.post('/api/admin/stores', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const merchantId = String(req.body?.merchantId ?? '').trim()
  const name = String(req.body?.name ?? '').trim()
  const businessNumber = String(req.body?.businessNumber ?? '').trim()

  if (!merchantId) {
    return res.status(400).json({ ok: false, error: 'merchantId가 필요합니다.' })
  }
  if (!name) {
    return res.status(400).json({ ok: false, error: '매장명이 필요합니다.' })
  }
  if (await findStoreByMerchantId(merchantId)) {
    return res.status(409).json({ ok: false, error: '이미 등록된 merchantId입니다.' })
  }

  // posToken은 createStore 내부에서 crypto.randomBytes(32)로 자동 생성된다(계약 §3.18).
  const store = await createStore({ merchantId, name, businessNumber })
  return res.json({ ok: true, store })
}))

// Design Ref: Phase 4 대량 온보딩. body: { stores: [{ merchantId, name, businessNumber? }, ...] }
// 항목별로 성공/실패를 나눠서 돌려준다 — 하나가 중복 merchantId라고 전체가 실패하지 않는다.
app.post('/api/admin/stores/bulk', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body?.stores) ? req.body.stores : null
  if (!items || !items.length) {
    return res.status(400).json({ ok: false, error: 'stores 배열이 필요합니다.' })
  }
  if (items.length > 500) {
    return res.status(400).json({ ok: false, error: '한 번에 최대 500건까지 등록할 수 있습니다.' })
  }

  const results = await bulkCreateStores(items)
  const successCount = results.filter((r) => r.ok).length
  return res.json({ ok: true, successCount, failCount: results.length - successCount, results })
}))

// POS 토큰 회전 (본사 전용, 계약 §3.20 신규). 토큰 유출이 의심될 때 예전 토큰을 즉시 무효화하고
// 새 토큰을 발급한다 — 매장 단말기는 새 토큰을 다시 입력받아야 한다(계약 §12).
// POS 토큰 재발급/직접지정 (본사 전용).
// body가 비어 있으면 무작위 64자 hex로 재발급하고, { posToken: "..." }를 주면 그 값으로 지정한다.
// 직접 지정을 허용하는 이유: 무작위 64자는 안전하지만 매장 단말기에서 손으로 입력하기가 사실상
// 불가능하다. 실제 운영에서는 관리자가 매장에 불러주거나 적어서 전달해야 해서, 입력 가능한
// 길이의 값을 정할 수 있어야 한다.
// 다만 이 토큰이 /api/pos/* 의 유일한 인증 수단이므로 아래 제약을 서버가 강제한다 —
// 이걸 클라이언트 검증에만 맡기면 API를 직접 호출해 "1234" 같은 값을 넣을 수 있고, 그 순간
// 이번에 막은 무인증 취약점으로 그대로 되돌아간다.
// 최소 길이를 4자로 둔 이유와, 그래서 반드시 함께 있어야 하는 방어 장치:
//
// 4자(영문/숫자/-/_ 기준 64^4 ≈ 1,670만 가지)는 그 자체로는 절대 안전하지 않다. 게다가 실제로는
// 무작위가 아니라 "1234", "1001", 매장 약칭 같은 값을 쓰게 되므로, 흔한 후보 수백 개만 돌려봐도
// 뚫린다. 그런데도 짧은 값을 허용하는 건 POS 단말기에서 긴 문자열을 손으로 입력하는 게 현실적으로
// 불가능해서다(운영이 불편하면 결국 토큰을 아무 데나 적어두게 되어 더 위험해진다).
//
// 그래서 "짧은 비밀번호 + 시도 횟수 제한"이라는 ATM PIN과 같은 모델을 쓴다. 아래 posAuthLimiter가
// 토큰이 틀린 요청(401)만 세어서 IP당 15분에 10회로 막기 때문에, 4자라도 전수/사전 공격이
// 현실적으로 불가능해진다. 둘 중 하나라도 빠지면 이번에 막은 무인증 취약점으로 되돌아간다 —
// 길이 제한을 더 낮추거나 posAuthLimiter를 제거할 때는 반드시 같이 판단해야 한다.
const POS_TOKEN_MIN_LENGTH = 4
const POS_TOKEN_MAX_LENGTH = 128
const POS_TOKEN_RE = /^[A-Za-z0-9_-]+$/

function validatePosToken(raw) {
  const token = String(raw).trim()
  if (token.length < POS_TOKEN_MIN_LENGTH || token.length > POS_TOKEN_MAX_LENGTH) {
    return { error: `POS 토큰은 ${POS_TOKEN_MIN_LENGTH}자 이상 ${POS_TOKEN_MAX_LENGTH}자 이하여야 합니다.` }
  }
  if (!POS_TOKEN_RE.test(token)) {
    return { error: 'POS 토큰은 영문/숫자/하이픈(-)/밑줄(_)만 사용할 수 있습니다.' }
  }
  // "1111", "0000"처럼 한 글자만 반복하는 값은 후보군이 64개뿐이라 시도 제한이 있어도 위험하다.
  if (new Set(token).size < 2) {
    return { error: 'POS 토큰이 너무 단순합니다. 같은 문자만 반복할 수 없습니다.' }
  }
  return { token }
}

app.post('/api/admin/stores/:id/pos-token', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const raw = req.body?.posToken
  const wantsCustom = raw !== undefined && raw !== null && String(raw).trim() !== ''

  let store
  if (wantsCustom) {
    const { token, error } = validatePosToken(raw)
    if (error) {
      return res.status(400).json({ ok: false, error })
    }
    try {
      store = await setPosToken(req.params.id, token)
    } catch (e) {
      if (e?.code === 'POS_TOKEN_TAKEN') {
        return res.status(409).json({ ok: false, error: e.message })
      }
      throw e
    }
  } else {
    store = await rotatePosToken(req.params.id)
  }

  if (!store) {
    return res.status(404).json({ ok: false, error: '매장을 찾을 수 없습니다.' })
  }
  return res.json({ ok: true, storeId: store.id, posToken: store.posToken })
}))

// 쉐보레 전산(ERP) 측 매장 코드 등록/해제 (본사 전용, ERP_CONTRACT_V1 §4.4). 전산이
// POST /api/erp/draft-orders를 보낼 때 storeCode로 이 값을 지정해 매장을 특정한다.
// posToken과 달리 이 코드는 "비밀"이 아니라 전산 쪽 식별자를 그대로 반영한 값이라(예:
// CHEV-UJB-001) 별도 시도 횟수 제한 없이 형식만 검증한다.
const ERP_STORE_CODE_RE = /^[A-Za-z0-9_-]+$/
// 사업자등록번호 자릿수. 관리자 웹 저장(POST .../business-number)과 전산 자동 연결
// (resolveErpStore)이 같은 기준을 써야 해서 상수로 뺐다.
const BUSINESS_NUMBER_DIGITS = 10
// 이미 등록된 매장의 사업자번호를 채우거나 고친다. 매장 등록 화면에서만 받고 있어서 기존
// 매장은 손댈 방법이 없었는데, 전산 자동 연결(resolveErpStore)이 이 값을 기준으로 동작하므로
// 뒤늦게라도 채울 통로가 필요하다.
// 전산 주문 이력 조회. 매장이 "보냈는데 POS에 안 떴어요" 할 때 본사가 어디서 끊겼는지
// 확인하는 통로다(접수는 됐는지, POS가 가져갔는지, 실패했는지).
// store_admin은 자기 매장만 본다 — 다른 매장의 차량번호·품목이 보이면 안 된다.
app.get('/api/admin/erp-carts', requireAuth, asyncHandler(async (req, res) => {
  const storeId = req.admin.role === 'hq_admin'
    ? (req.query.storeId ? String(req.query.storeId) : null)
    : req.admin.storeId
  const status = req.query.status ? String(req.query.status) : null

  const rows = await listErpCarts({ storeId, status, limit: req.query.limit })
  return res.json({
    ok: true,
    carts: rows.map((r) => {
      let items = []
      try { items = JSON.parse(r.itemsJson) } catch { /* 손상된 건은 품목만 빈 배열로 */ }
      return {
        id: r.id,
        referenceId: r.referenceId,
        storeName: r.store?.name || null,
        erpStoreCode: r.store?.erpStoreCode || null,
        status: r.status,
        totalAmount: r.totalAmount,
        memo: r.memo,
        carNumber: r.carNumber,
        linkedReservation: Boolean(r.reservationId),
        itemCount: items.length,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt,
        loadedAt: r.loadedAt,
        paidAt: r.paidAt,
      }
    }),
  })
}))

app.post('/api/admin/stores/:id/business-number', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const raw = req.body?.businessNumber
  const wantsClear = raw === undefined || raw === null || String(raw).trim() === ''

  let value = null
  if (!wantsClear) {
    // 표기(하이픈 유무)는 자유롭게 받되 숫자 10자리인지는 확인한다 -- 자릿수가 틀린 값이 들어가면
    // 자동 연결이 조용히 실패하고, 왜 안 되는지 찾기가 어렵다.
    const digits = String(raw).replace(/\D/g, '')
    if (digits.length !== BUSINESS_NUMBER_DIGITS) {
      return res.status(400).json({ ok: false, error: '사업자번호는 숫자 10자리여야 합니다.' })
    }
    value = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
  }

  const store = await setStoreBusinessNumber(req.params.id, value)
  if (!store) {
    return res.status(404).json({ ok: false, error: '매장을 찾을 수 없습니다.' })
  }
  return res.json({ ok: true, storeId: store.id, businessNumber: store.businessNumber })
}))

app.post('/api/admin/stores/:id/erp-code', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const raw = req.body?.erpStoreCode
  const wantsClear = raw === undefined || raw === null || String(raw).trim() === ''

  if (!wantsClear) {
    const code = String(raw).trim()
    if (code.length < 1 || code.length > 64 || !ERP_STORE_CODE_RE.test(code)) {
      return res.status(400).json({ ok: false, error: '매장 코드는 1~64자의 영문/숫자/하이픈(-)/밑줄(_)만 사용할 수 있습니다.' })
    }
  }

  let store
  try {
    store = await setStoreErpCode(req.params.id, wantsClear ? null : String(raw).trim())
  } catch (e) {
    if (e?.code === 'ERP_CODE_TAKEN') {
      return res.status(409).json({ ok: false, error: e.message })
    }
    throw e
  }
  if (!store) {
    return res.status(404).json({ ok: false, error: '매장을 찾을 수 없습니다.' })
  }
  return res.json({ ok: true, storeId: store.id, erpStoreCode: store.erpStoreCode })
}))

// --- 토스플레이스 결제 웹훅 (Phase 4, 백업 경로) ---
// payment.html이 결제 성공 후 클라이언트에서 직접 POST /api/payments를 호출하는 게 기본 경로다.
// 이 웹훅은 그 호출이 네트워크 문제 등으로 유실됐을 때를 대비한 보완 장치다.
// ⚠️ TOSS_WEBHOOK_SECRET은 "토스페이먼츠 시크릿 키"(live_sk_.../test_sk_...)가 아니다. 이 프로젝트가
// 연동하는 곳은 토스페이먼츠(PG)가 아니라 토스플레이스(단말기/POS)이고, 이 값은 토스플레이스가 우리
// 서버로 보내는 웹훅의 HMAC 서명 검증에만 쓰인다. 개발자센터 -> 내 애플리케이션 -> OpenAPI -> 웹훅
// 메뉴에서 직접 설정하며, 거기 넣은 값과 이 환경변수 값이 같아야 검증이 통과한다.
// (예전 주석엔 "개발자센터에서 설정 불가, 메일 문의 필요"라고 적혀 있었으나 현재 문서 기준으로는 자체 설정 가능하다.)
//
// 2026-07-30 재검토(https://docs.tossplace.com/reference/open-api/webhook.html,
// https://docs.tossplace.com/reference/open-api/payment.html)로 서명/페이로드 구조를 다음과 같이 확인·수정함:
// - 서명: HMAC-SHA256(key=TOSS_WEBHOOK_SECRET, message=`${x-toss-timestamp}.${원본 raw body}`),
//   hex 인코딩 후 `v1=` 접두사. x-toss-timestamp가 현재 시각과 너무 다르면 거부해야 한다.
// - payload: `{ id, type, createdAt, merchantId, app, data: { payment: {...} } }` 형태
//   (이전엔 `eventType`/`data.paymentKey`로 잘못 파싱하고 있었음). merchantId는 최상위(body.merchantId)에도
//   실릴 수 있어 data.payment.merchantId를 우선하고 없으면 최상위 값을 쓴다(계약 §3.23-2).
// - ⚠️ 미확정 전제: client가 생성해 sdk.payment.requestPayment()에 넘긴 `paymentKey`는
//   웹훅 payment.orderId와 1:1로 대응한다고 간주한다. 실제 결제 1~2건으로 배포 후 검증이 필요하다.
async function processWebhookPayment(body, webhookId) {
  const eventType = body?.type
  const payment = body?.data?.payment || {}
  const merchantId = payment.merchantId ?? body?.merchantId

  if (eventType === 'payment.payment.approved.v1') {
    const paymentKey = String(payment.orderId ?? '').trim() || null
    const existing = await findPaymentByKey(paymentKey)
    if (existing) {
      console.log(`[webhook] 결제 승인 수신: 이미 기록된 결제 paymentKey=${paymentKey}`)
      return
    }
    if (!paymentKey) {
      logger.warn('[webhook] 결제 승인 수신: orderId가 없어 결제 레코드를 만들 수 없습니다.', { webhookId })
      return
    }
    const store = await findStoreByMerchantId(merchantId)
    if (!store) {
      logger.warn('[webhook] 등록되지 않은 merchantId로 결제 반영을 건너뜁니다.', { webhookId, merchantId, paymentKey })
      return
    }
    const amountRaw = payment.amount === undefined || payment.amount === null || payment.amount === '' ? null : Number(payment.amount)
    const amount = Number.isSafeInteger(amountRaw) && amountRaw >= 0 && amountRaw <= 100000000 ? amountRaw : null
    const recorded = await createPayment({
      storeId: store.id,
      paymentKey,
      carNumber: null,
      serviceType: null,
      phone: null,
      amount,
    })
    console.log(`[webhook] 결제 승인 백업 기록 생성: payment id=${recorded.id}, paymentKey=${paymentKey}`)
    return
  }

  if (eventType === 'payment.payment.cancelled.v1') {
    const paymentKey = String(payment.orderId ?? '').trim() || null
    const existing = await findPaymentByKey(paymentKey)
    if (!existing) {
      logger.warn('[webhook] 결제 취소 수신: 매칭되는 결제가 없습니다.', { webhookId, merchantId, paymentKey })
      return
    }
    const cancelled = await markPaymentStatus(existing.id, 'cancelled')
    if (cancelled) {
      logger.warn('[webhook] 결제 취소 반영', { webhookId, paymentId: existing.id, paymentKey })
    } else {
      logger.warn('[webhook] 결제 취소 수신: 상태 반영에 실패했습니다.', { webhookId, paymentId: existing.id, paymentKey })
    }
    return
  }

  console.log('[webhook] 처리 대상 아닌 이벤트:', eventType)
}

app.post('/api/webhooks/toss/payment', asyncHandler(async (req, res) => {
  const webhookId = req.get('x-toss-webhook-id')
  const signature = req.get('x-toss-signature')
  const timestamp = req.get('x-toss-timestamp')

  if (!webhookId) {
    return res.status(400).json({ ok: false, error: 'x-toss-webhook-id 헤더가 없습니다.' })
  }

  const secret = process.env.TOSS_WEBHOOK_SECRET
  if (secret) {
    if (!timestamp || !signature) {
      return res.status(400).json({ ok: false, error: 'x-toss-timestamp/x-toss-signature 헤더가 없습니다.' })
    }
    const FIVE_MIN_MS = 5 * 60 * 1000
    const tsMs = Number(timestamp)
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > FIVE_MIN_MS) {
      logger.error('[webhook] x-toss-timestamp가 허용 범위를 벗어남', { webhookId, timestamp })
      return res.status(400).json({ ok: false, error: 'stale timestamp' })
    }

    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body)
    const message = `${timestamp}.${rawBody}`
    const expected = 'v1=' + crypto.createHmac('sha256', secret).update(message).digest('hex')

    const sigBuf = Buffer.from(signature)
    const expectedBuf = Buffer.from(expected)
    const validSignature =
      sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)
    if (!validSignature) {
      logger.error('[webhook] 서명 검증 실패', { webhookId })
      return res.status(401).json({ ok: false, error: 'invalid signature' })
    }
  } else {
    logger.warn('[webhook] TOSS_WEBHOOK_SECRET 미설정 — 서명 검증 없이 수신 중', { webhookId })
  }

  // 토스 쪽 재전송에도 같은 이벤트를 두 번 처리하지 않도록 먼저 기록한다.
  const isNew = await recordWebhookEventOnce(webhookId, req.body?.type || 'unknown')
  if (!isNew) {
    return res.json({ ok: true, skipped: 'duplicate' })
  }

  // ⚠️ 순서 변경(계약 §3.23-3): 예전엔 여기서 바로 res.json({ok:true})을 보내고 본 처리를 응답
  // 뒤로 미뤘는데, Cloud Run은 응답을 보낸 뒤 그 인스턴스의 CPU를 스로틀링(사실상 정지)한다 —
  // 응답 후 await가 실행 중간에 멈춰버려 결제 반영이 유실될 수 있었다. 그래서 본 처리를 반드시
  // 응답 *이전*에 끝내고, 처리 중 에러가 나면 이미 기록해둔 WebhookEvent를 지워서 토스가
  // 재시도하도록 500을 돌려준다(재시도 없이 200을 주면 그 결제 건은 영영 반영되지 않는다).
  try {
    await processWebhookPayment(req.body, webhookId)
  } catch (e) {
    logger.error('[webhook] 처리 중 오류 — 재시도를 위해 이벤트 기록을 되돌립니다.', {
      webhookId,
      error: e.message,
      eventType: req.body?.type,
    })
    await prisma.webhookEvent.delete({ where: { id: webhookId } }).catch(() => {})
    return res.status(500).json({ ok: false, error: '웹훅 처리 중 오류가 발생했습니다.' })
  }

  return res.json({ ok: true })
}))

// --- 쉐보레 전산(ERP) 연동 (ERP_CONTRACT_V1 §4) ---
// 전산이 우리 서버에 "이 매장에 이런 주문을 미결제 상태로 만들어달라"고 요청하는 창구다.
// 우리는 그 요청을 검증한 뒤 토스 Open API로 넘겨 OPENED 주문을 만들고, 매장은 토스 POS
// [현황] 탭에서 그 주문을 선택해 결제만 하면 된다(§0).
//
// 공유 토큰(X-ERP-Token) 인증. requirePromotionJobAuth와 동일하게 timingSafeEqual로 비교해
// 타이밍 공격으로 토큰 일부를 추측하는 걸 막는다. 미설정이면 503 -- 전산 연동 자체를 켜지
// 않은 환경(로컬 개발 등)에서 이 라우트가 500 대신 명확한 신호를 주기 위함이다.
function requireErpToken(req, res, next) {
  const expected = process.env.ERP_API_TOKEN
  const supplied = req.get('x-erp-token') || ''
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'ERP 연동이 설정되지 않았습니다.' })
  }
  const expectedBuf = Buffer.from(expected)
  const suppliedBuf = Buffer.from(supplied)
  if (expectedBuf.length !== suppliedBuf.length || !crypto.timingSafeEqual(expectedBuf, suppliedBuf)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  return next()
}

// 전산 쪽 시스템이 오작동해 짧은 시간에 대량 요청을 보내도 DB/토스 API를 보호할 수 있도록
// 매장 관리 라우트들과 동일한 DB 기반 레이트리밋을 쓴다(분당 120 -- 전산은 사람이 아니라
// 배치/큐 처리라 사람 조작 API보다 한도를 넉넉히 둔다).
const erpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  store: new PostgresRateLimitStore(prisma, { prefix: 'erp', windowMs: 60 * 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

const ERP_MAX_ITEMS = 100
const ERP_MAX_UNIT_PRICE = 100000000
const ERP_MAX_QUANTITY = 10000
const ERP_MAX_TOTAL_AMOUNT = 1000000000

// 요청 바디를 검증하고, 문제가 있으면 에러 사유 문자열을, 문제가 없으면 정규화된 값을 반환한다.
// 라우트 핸들러 하나에 검증 로직이 전부 몰려있으면 가독성이 떨어져서 별도 함수로 뺐다.
function validateDraftOrderBody(body) {
  const storeCode = String(body?.storeCode ?? '').trim()
  if (!storeCode) return { error: 'storeCode가 필요합니다.' }

  const referenceId = String(body?.referenceId ?? '').trim()
  if (!referenceId || referenceId.length > 200) {
    return { error: 'referenceId는 1~200자여야 합니다.' }
  }

  const itemsRaw = body?.items
  if (!Array.isArray(itemsRaw) || itemsRaw.length < 1 || itemsRaw.length > ERP_MAX_ITEMS) {
    return { error: `items는 1~${ERP_MAX_ITEMS}건의 배열이어야 합니다.` }
  }

  let sum = 0
  const items = []
  for (const raw of itemsRaw) {
    const name = String(raw?.name ?? '').trim()
    if (!name || name.length > 100) {
      return { error: '항목 name은 1~100자여야 합니다.' }
    }
    const unitPrice = raw?.unitPrice
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0 || unitPrice > ERP_MAX_UNIT_PRICE) {
      return { error: '항목 unitPrice가 올바르지 않습니다.' }
    }
    const quantity = raw?.quantity
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > ERP_MAX_QUANTITY) {
      return { error: '항목 quantity가 올바르지 않습니다.' }
    }
    const productId = raw?.productId !== undefined && raw?.productId !== null ? String(raw.productId) : null
    // category는 계약서 §4.2에는 없는 선택 필드다 -- 토스 item.category가 필수라(tossOrderClient.js),
    // 전산이 보내주면 그대로 쓰고 안 보내면 클라이언트 쪽 기본값('정비')을 그대로 둔다.
    const category = raw?.category !== undefined && raw?.category !== null ? String(raw.category) : undefined
    sum += unitPrice * quantity
    items.push({ productId, name, unitPrice, quantity, category })
  }

  const totalAmount = body?.totalAmount
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0 || totalAmount > ERP_MAX_TOTAL_AMOUNT) {
    return { error: 'totalAmount가 올바르지 않습니다.' }
  }
  if (totalAmount !== sum) {
    return { error: 'totalAmount가 항목 합계와 일치하지 않습니다.' }
  }

  const memoRaw = body?.memo
  const memo = memoRaw === undefined || memoRaw === null ? null : String(memoRaw)
  if (memo && memo.length > 200) {
    return { error: 'memo는 200자 이하여야 합니다.' }
  }

  return { storeCode, referenceId, items, totalAmount, memo }
}

// referenceId에서 안정적으로 파생시킨다 -- 재시도해도 항상 같은 값이 나와야 토스 쪽에서도
// 같은 주문으로 취급해 중복이 생기지 않는다(§4.2-3).
function deriveTossOrderKey(referenceId) {
  return `erp-${referenceId}`
}

app.post('/api/erp/draft-orders', erpLimiter, requireErpToken, asyncHandler(async (req, res) => {
  const parsed = validateDraftOrderBody(req.body)
  if (parsed.error) {
    return res.status(400).json({ ok: false, error: parsed.error })
  }
  const { storeCode, referenceId, items, totalAmount, memo } = parsed

  const store = await findStoreByErpCode(storeCode)
  if (!store) {
    return res.status(404).json({ ok: false, error: '등록되지 않은 매장 코드입니다.' })
  }
  if (store.status !== 'active') {
    return res.status(403).json({ ok: false, error: '비활성화된 가맹점입니다.' })
  }

  // 멱등: 이미 처리된(failed가 아닌) 건이면 토스를 다시 호출하지 않고 그대로 돌려준다.
  const existing = await findErpOrderByReference(referenceId)
  if (existing && existing.status !== 'failed') {
    return res.json({ ok: true, referenceId, tossOrderId: existing.tossOrderId, status: 'OPENED', duplicate: true })
  }

  const tossOrderKey = deriveTossOrderKey(referenceId)
  const itemsJson = JSON.stringify(items)

  const result = await createTossDraftOrder({
    merchantId: store.merchantId,
    orderKey: tossOrderKey,
    orderNumber: referenceId,
    memo,
    items,
    totalAmount,
  })

  if (!result.ok) {
    // 토스의 원본 에러 문구는 로그에만 남기고 클라이언트에는 내보내지 않는다(§4.2-4) -- 내부
    // API 키 설정 실수 등 운영 정보가 그대로 노출될 수 있기 때문이다.
    logger.error('[erp] 토스 주문 생성 실패', { referenceId, storeId: store.id, status: result.status, error: result.error })
    await upsertErpOrder({
      referenceId,
      storeId: store.id,
      tossOrderKey,
      tossOrderId: null,
      totalAmount,
      status: 'failed',
      itemsJson,
      memo,
      tossRawJson: result.raw ? JSON.stringify(result.raw) : null,
      errorMessage: result.error,
    })
    return res.status(502).json({ ok: false, error: '토스 주문 생성에 실패했습니다.', referenceId })
  }

  await upsertErpOrder({
    referenceId,
    storeId: store.id,
    tossOrderKey,
    tossOrderId: result.tossOrderId,
    totalAmount,
    status: 'created',
    itemsJson,
    memo,
    tossRawJson: result.raw ? JSON.stringify(result.raw) : null,
    errorMessage: null,
  })

  return res.status(201).json({ ok: true, referenceId, tossOrderId: result.tossOrderId, status: 'OPENED' })
}))

// 전산이 결과를 재조회할 수 있게 한다(§4.3).
app.get('/api/erp/draft-orders/:referenceId', erpLimiter, requireErpToken, asyncHandler(async (req, res) => {
  const order = await findErpOrderByReference(req.params.referenceId)
  if (!order) {
    return res.status(404).json({ ok: false, error: '요청하신 주문을 찾을 수 없습니다.' })
  }
  return res.json({
    ok: true,
    referenceId: order.referenceId,
    tossOrderId: order.tossOrderId,
    status: order.status,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
  })
}))

// 차량번호로 정비 이력을 조회한다. 직원이 "이 차 지난번에 뭐 갈았지?"를 POS에서 바로 본다.
//
// 손님에게 받은 동의의 이용 목적에 "정비 이력 관리"가 들어 있어야 쓸 수 있는 기능이다
// (front-plugin의 동의 문구 참고). 목적 밖 이용이 되지 않도록 돌려주는 항목을 최소로 한다 —
// 전화번호는 포함하지 않는다.
app.get('/api/pos/history', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const carNumber = String(req.query.carNumber || '').trim()
  if (!carNumber) {
    return res.status(400).json({ ok: false, error: '차량번호를 입력해주세요.' })
  }

  const { reservations, carts } = await findRepairHistoryByCarNumber(req.store.id, carNumber, 10)

  // 방문 단위로 묶는다. 전산 주문은 예약에 이어져 있으면 그 예약 밑으로, 아니면 따로 세운다 —
  // 예약 없이 그냥 온 손님도 정비는 받았으므로 이력에서 빠지면 안 된다.
  const cartsByReservation = new Map()
  const standalone = []
  for (const c of carts) {
    let items = []
    try { items = JSON.parse(c.itemsJson) } catch { /* 손상된 건은 품목 없이 금액만 보여준다 */ }
    const view = {
      id: c.id,
      items: items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })),
      totalAmount: c.totalAmount,
      paid: c.status === 'paid',
      at: c.paidAt || c.createdAt,
    }
    if (c.reservationId) {
      const list = cartsByReservation.get(c.reservationId) || []
      list.push(view)
      cartsByReservation.set(c.reservationId, list)
    } else {
      standalone.push(view)
    }
  }

  const visits = reservations.map((r) => ({
    kind: 'reservation',
    date: r.serviceDate,
    serviceType: r.serviceType,
    status: r.status,
    at: r.completedAt || r.createdAt,
    orders: cartsByReservation.get(r.id) || [],
  }))
  for (const c of standalone) {
    visits.push({ kind: 'order', date: null, serviceType: null, status: null, at: c.at, orders: [c] })
  }
  // 최근 방문이 위로.
  visits.sort((a, b) => new Date(b.at) - new Date(a.at))

  return res.json({ ok: true, carNumber, visits: visits.slice(0, 10) })
}))

// POS에서 결제가 실제로 끝났을 때 탭앱이 알려준다(posPluginSdk.payment.on('paid')).
//
// 이게 없으면 전산 주문은 "담김(loaded)"에서 멈춘다 — 전산은 결제가 됐는지 모르고, 우리 쪽
// 집계에도 안 잡힌다. 토스 결제 웹훅으로 뒤늦게 맞추는 방법도 있지만 웹훅은 paymentKey만 주고
// 그게 어느 장바구니 건인지 되짚을 방법이 없다(금액·시각으로 추정해야 한다). 반면 탭앱은
// 자기가 방금 담은 주문이라는 걸 알고 있어서 확실하다.
//
// Payment 테이블에는 넣지 않는다 — 그쪽은 고객 동의를 받은 흐름이고 프로모션 대상 판정에 쓰인다.
// 동의 없이 POS에서 일어난 결제를 섞으면 그 판정이 흐려진다(schema.prisma 주석 참고).
app.post('/api/pos/erp-carts/:id/paid', posIpFloodLimiter, posLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '장바구니를 찾을 수 없습니다.' })
  }
  if (cart.status === 'paid') {
    // 탭앱이 재시도했거나 단말기가 두 대다. 이미 기록된 건이면 그대로 알려준다.
    return res.json({ ok: true, alreadyProcessed: true, status: 'paid' })
  }
  if (cart.status !== 'loaded') {
    // 담기지도 않은 건이 결제됐다고 기록되면 안 된다.
    return res.status(409).json({ ok: false, error: '담긴(loaded) 주문만 결제 완료로 기록할 수 있습니다.', status: cart.status })
  }

  const changed = await markErpCartPaid(cart.id, {
    paymentId: req.body?.paymentId,
    orderId: req.body?.orderId,
  })
  if (!changed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    return res.json({ ok: true, alreadyProcessed: true, status: latest?.status })
  }

  // 예약이 이어져 있으면 정비완료까지 자동으로 처리한다 — 결제가 끝났다는 건 정비가 끝났다는
  // 뜻이라, 직원이 [완료]를 또 누르게 할 이유가 없다. 이미 완료/취소된 예약이면 아무 일도
  // 일어나지 않는다(completeReservationAfterPayment가 상태를 확인한다).
  let reservationCompleted = false
  if (cart.reservationId) {
    try {
      reservationCompleted = await completeReservationAfterPayment(cart.reservationId)
    } catch (e) {
      // 자동완료는 부가 기능이다. 여기서 실패해도 결제 기록 자체는 이미 남았으므로 500을
      // 내지 않는다 — 직원이 대기열에서 직접 완료 처리하면 된다.
      logger.error('[pos] 결제 후 예약 자동완료 실패', { cartId: cart.id, error: e.message })
    }
  }

  return res.json({ ok: true, alreadyProcessed: false, status: 'paid', reservationCompleted })
}))

// --- 쉐보레 전산(ERP) "물건 담기" -> POS 플러그인 장바구니 중계 (POS-CART-BRIDGE §1) ---
// 위 /api/erp/draft-orders(토스 Open API로 주문 자체를 생성)와는 완전히 별개의 새 경로다 -- 그
// 경로로 만든 주문은 POS에서 결제할 수 없다는 게 실증됐다(docs/ERP연동-결제경로-조사결과.md).
// 여기는 토스와 아무것도 통신하지 않는다: 전산이 장바구니를 이 테이블(ErpCart)에 올려두면,
// POS 플러그인이 GET /api/pos/erp-carts로 가져가 posPluginSdk.draftOrder.addLineItem()으로 POS
// 자체 장바구니에 직접 옮겨 담고 startPayment()를 부른다. 인증/레이트리밋은 기존 draft-orders와
// 동일하게 erpLimiter + requireErpToken(X-ERP-Token)을 그대로 재사용한다.

// --- 전산 매장 해석: 코드 우선, 없으면 사업자번호로 자동 연결 ---
//
// 전산은 매장을 자기네 코드(CHV-001)로 부르고 우리는 merchantId로 부른다. 둘이 같은 곳이라는
// 사실은 어느 쪽 시스템에도 없어서 원래는 사람이 관리자 웹에서 한 번 이어줘야 했다.
// 그런데 **사업자등록번호는 양쪽이 이미 아는 유일한 공통 값**이다 -- 전산은 대리점 사업자번호를
// 당연히 알고, 토스 가맹점도 사업자번호로 개설된다. 그래서 전산이 businessNumber를 함께 보내면
// 첫 요청에서 자동으로 코드를 붙여준다(그 뒤로는 코드만 봐도 찾아진다).
//
// 자동 연결은 아래 조건을 모두 만족할 때만 한다. 하나라도 어긋나면 사람이 관리자 웹에서
// 처리하게 두고 명확한 사유를 돌려준다 -- 잘못 이어지면 남의 매장으로 주문이 가고 결제까지
// 이어지므로, 애매하면 자동으로 하지 않는 쪽이 옳다.

// 사업자번호 표기는 "123-45-67890"과 "1234567890"이 섞여 들어온다. 우리 DB에 어느 표기로
// 저장돼 있는지 통제할 수 없으므로 두 형태를 모두 만들어 조회한다.
function businessNumberCandidates(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length !== BUSINESS_NUMBER_DIGITS) return null
  const hyphenated = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
  return [digits, hyphenated]
}

// 반환: { store } | { error: {status, body} }
async function resolveErpStore(storeCode, rawBusinessNumber) {
  const byCode = await findStoreByErpCode(storeCode)
  if (byCode) return { store: byCode }

  if (rawBusinessNumber === undefined || rawBusinessNumber === null || String(rawBusinessNumber).trim() === '') {
    return { error: { status: 404, body: { ok: false, error: '등록되지 않은 매장 코드입니다.' } } }
  }

  // 여기서부터는 storeCode를 **DB에 새로 저장**하는 경로다. 관리자 웹(POST .../erp-code)은 형식을
  // 검사하는데 이 경로만 안 하면, 전산이 보낸 아무 문자열이나 매장 코드로 굳어버린다(공백·한글·
  // 수백 자). 한 번 붙으면 그 매장은 그 값으로만 찾아지므로 나중에 고치기도 번거롭다.
  // 두 경로가 같은 기준을 쓰도록 여기서도 같은 검사를 한다.
  if (storeCode.length > 64 || !ERP_STORE_CODE_RE.test(storeCode)) {
    return { error: { status: 400, body: { ok: false, error: 'storeCode는 64자 이하의 영문/숫자/하이픈(-)/밑줄(_)만 사용할 수 있습니다.' } } }
  }

  const candidates = businessNumberCandidates(rawBusinessNumber)
  if (!candidates) {
    return { error: { status: 400, body: { ok: false, error: 'businessNumber는 숫자 10자리여야 합니다.' } } }
  }

  const matches = await findStoresByBusinessNumbers(candidates)
  if (matches.length === 0) {
    return { error: { status: 404, body: { ok: false, error: '등록되지 않은 매장 코드입니다.' } } }
  }
  if (matches.length > 1) {
    // 같은 사업자번호를 여러 매장이 쓰고 있으면 어느 쪽인지 우리가 정할 수 없다.
    logger.error('[erp] 사업자번호가 여러 매장과 일치해 자동 연결을 중단합니다.', {
      storeCode, matched: matches.map((m) => m.id),
    })
    return { error: { status: 409, body: { ok: false, error: '사업자번호가 여러 매장과 일치합니다. 본사에 매장 코드 등록을 요청해주세요.' } } }
  }

  const store = matches[0]
  if (store.erpStoreCode) {
    // 이미 다른 코드가 붙어 있는 매장이다. 덮어쓰면 기존 매핑이 조용히 바뀌므로 거부한다.
    return { error: { status: 409, body: { ok: false, error: '이 매장에는 이미 다른 매장 코드가 등록되어 있습니다.' } } }
  }

  const bound = await bindErpCodeIfUnset(store.id, storeCode)
  if (!bound) {
    // 그 사이 다른 요청이 먼저 붙였거나 코드를 다른 매장이 선점했다. 다시 읽어 판단한다.
    const recheck = await findStoreByErpCode(storeCode)
    if (recheck && recheck.id === store.id) return { store: recheck }
    return { error: { status: 409, body: { ok: false, error: '매장 코드를 등록하지 못했습니다. 본사에 문의해주세요.' } } }
  }

  logger.info('[erp] 사업자번호로 매장 코드를 자동 연결했습니다.', { storeId: store.id, storeCode })
  return { store: { ...store, erpStoreCode: storeCode } }
}

app.post('/api/erp/carts', erpLimiter, requireErpToken, asyncHandler(async (req, res) => {
  // validateDraftOrderBody를 그대로 재사용한다 -- storeCode/referenceId/items/totalAmount/memo
  // 검증 규칙이 draft-orders와 완전히 동일해야 하고(전산 쪽이 같은 바디 스키마로 두 경로를
  // 오갈 수 있어야 함), 이 검증 로직을 복제하면 나중에 한쪽만 고쳐서 규칙이 어긋날 위험이 있다.
  const parsed = validateDraftOrderBody(req.body)
  if (parsed.error) {
    return res.status(400).json({ ok: false, error: parsed.error })
  }
  const { storeCode, referenceId, items, totalAmount, memo } = parsed
  // autoPay는 draft-orders에는 없는 필드라 validateDraftOrderBody가 모르는 값이다 -- 여기서만
  // 별도로 파싱한다. 안 보내면 true(담자마자 자동 결제 시도)가 기본값이다.
  // Boolean()을 그대로 쓰지 않는 이유: 외부 전산이 JSON 불리언 대신 문자열 "false"를 보내는 일이
  // 흔한데 Boolean('false')는 true라서, "자동결제 끄기"가 조용히 무시된 채 결제창이 떠버린다.
  // 돈이 오가는 분기라 명시적으로 거짓값 목록을 나열한다.
  const autoPayRaw = req.body?.autoPay
  const autoPay = autoPayRaw === undefined || autoPayRaw === null
    ? true
    : !(autoPayRaw === false || autoPayRaw === 'false' || autoPayRaw === 0 || autoPayRaw === '0')

  // 코드로 못 찾으면 사업자번호로 자동 연결을 시도한다(resolveErpStore 주석 참고).
  const resolved = await resolveErpStore(storeCode, req.body?.businessNumber)
  if (resolved.error) {
    return res.status(resolved.error.status).json(resolved.error.body)
  }
  const store = resolved.store
  if (store.status !== 'active') {
    return res.status(403).json({ ok: false, error: '비활성화된 가맹점입니다.' })
  }

  // referenceId는 매장별이 아니라 **전역** 유일이다(@unique). 그래서 다른 매장이 이미 쓴 번호가
  // 들어오면 아래 멱등 분기가 그 매장의 장바구니를 duplicate로 돌려주게 되고, 보낸 쪽은 성공
  // 응답을 받았는데 실제로는 자기 매장에 아무것도 담기지 않는다 -- 조용히 사라지는 게 가장 나쁜
  // 실패라 명시적으로 막는다. cancelled 건도 마찬가지다: 그냥 두면 createErpCart(upsert)가 그 로우의
  // storeId를 다른 매장으로 바꿔치기해버린다.
  const existingAnyStore = await findErpCartByReference(referenceId)
  if (existingAnyStore && existingAnyStore.storeId !== store.id) {
    return res.status(409).json({ ok: false, error: '이미 다른 매장에서 사용한 referenceId입니다.' })
  }

  // 멱등: 같은 referenceId가 이미 있고 cancelled가 아니면(pending/loaded/failed 어느 쪽이든)
  // 그 상태를 그대로 돌려준다 -- 새로 만들면 POS가 같은 장바구니를 두 번 집어갈 수 있다.
  // cancelled였다면 전산이 다시 담는 것이므로 새로 생성한다(취소된 건 재사용하지 않는다).
  const existing = await findErpCartByReference(referenceId)
  if (existing && existing.status !== 'cancelled') {
    return res.json({ ok: true, cartId: existing.id, referenceId, status: existing.status, duplicate: true })
  }

  // 차량번호가 오면 그날 대기 중인 손님과 잇는다. 이어지면 결제가 끝났을 때 정비완료까지
  // 자동으로 처리되고, 직원이 "이 주문이 누구 건지" 헷갈리지 않는다.
  // 형식이 어긋나면(전산 표기가 다를 수 있다) 잇지 않고 저장만 한다 — 400으로 막으면 연동 자체가
  // 끊기는데, 이 필드는 부가 기능이라 그만한 값이 없다.
  const carNumber = normalizeCarNumber(req.body?.carNumber)
  let reservationId = null
  if (carNumber && CAR_NUMBER_RE.test(carNumber)) {
    const reservation = await findOpenReservationByCarNumber(store.id, carNumber, kstDateString())
    reservationId = reservation ? reservation.id : null
    if (!reservation) {
      // 못 이었다고 실패가 아니다(예약 없이 온 손님도 있다). 나중에 "왜 안 이어졌지"를
      // 추적할 수 있게 남겨만 둔다.
      logger.info('[erp] 차량번호와 일치하는 진행 중 예약이 없어 연결하지 않았습니다.', {
        referenceId, storeId: store.id,
      })
    }
  }

  const cart = await createErpCart({
    storeId: store.id,
    referenceId,
    itemsJson: JSON.stringify(items),
    totalAmount,
    memo,
    autoPay,
    carNumber,
    reservationId,
  })
  return res.status(201).json({ ok: true, cartId: cart.id, referenceId, status: cart.status, linkedReservation: Boolean(reservationId) })
}))

// 전산이 담아둔 장바구니의 처리 상태(pending/loaded/failed/cancelled)를 재조회할 수 있게 한다.
app.get('/api/erp/carts/:referenceId', erpLimiter, requireErpToken, asyncHandler(async (req, res) => {
  const cart = await findErpCartByReference(req.params.referenceId)
  if (!cart) {
    return res.status(404).json({ ok: false, error: '요청하신 장바구니를 찾을 수 없습니다.' })
  }
  return res.json({
    ok: true,
    referenceId: cart.referenceId,
    status: cart.status,
    totalAmount: cart.totalAmount,
    autoPay: cart.autoPay,
    createdAt: cart.createdAt,
    loadedAt: cart.loadedAt,
    errorMessage: cart.errorMessage,
  })
}))

// 전산이 주문을 취소할 때 쓴다. POS가 이미 가져간(loaded) 뒤라면 취소해도 POS 장바구니에는 이미
// 반영돼 있으므로 조용히 넘기지 않고 409로 알려준다 -- 전산 쪽이 "취소했는데 실제로는 결제가
// 진행 중일 수 있다"는 걸 알아야 한다.
app.post('/api/erp/carts/:referenceId/cancel', erpLimiter, requireErpToken, asyncHandler(async (req, res) => {
  const cart = await findErpCartByReference(req.params.referenceId)
  if (!cart) {
    return res.status(404).json({ ok: false, error: '요청하신 장바구니를 찾을 수 없습니다.' })
  }
  if (cart.status !== 'pending') {
    return res.status(409).json({ ok: false, error: '대기중인 장바구니만 취소할 수 있습니다.', status: cart.status })
  }
  const changed = await cancelErpCart(req.params.referenceId)
  if (!changed) {
    // 조회와 취소 사이에 다른 요청(POS consume 등)이 먼저 상태를 바꿨을 수 있다 -- 그 사이 값을
    // 다시 읽어 최신 상태를 알려준다.
    const latest = await findErpCartByReference(req.params.referenceId)
    return res.status(409).json({ ok: false, error: '대기중인 장바구니만 취소할 수 있습니다.', status: latest?.status })
  }
  return res.json({ ok: true, status: 'cancelled' })
}))

// --- 내부 배치 작업 (Cloud Scheduler 전용) ---
function requirePromotionJobAuth(req, res, next) {
  const expected = process.env.PROMOTION_JOB_TOKEN
  const supplied = req.get('x-promotion-job-token') || ''
  if (!expected) {
    return res.status(503).json({ ok: false, error: '프로모션 작업 인증이 설정되지 않았습니다.' })
  }
  const expectedBuf = Buffer.from(expected)
  const suppliedBuf = Buffer.from(supplied)
  if (expectedBuf.length !== suppliedBuf.length || !crypto.timingSafeEqual(expectedBuf, suppliedBuf)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  return next()
}

const PROMO_BATCH_SIZE = 100
const PROMO_TIME_BUDGET_MS = 50 * 1000
const DEFAULT_PROMO_MAX_PER_RUN = 2000

// claimDuePromotions(limit=100)을 예전엔 하루 한 번 딱 한 번만 호출해서, 하루 대상자가 100명을
// 넘으면 그 초과분은 영원히 밀렸다(다음 실행도 어차피 앞의 100명만 다시 훑고 지나감 — claim이
// 성공한 애들은 promoSent라 다시 안 걸리지만, 애초에 100건 상한 자체가 하루 최대 발송량을
// 고정해버리는 구조였다). 여기서는 claim이 빈손으로 올 때까지, 또는 PROMO_MAX_PER_RUN(기본 2000건)
// 상한이나 50초 시간 예산에 걸릴 때까지 반복한다(계약 §3.24) — Cloud Scheduler가 무한정 기다려주지
// 않으므로 시간 예산은 꼭 필요하다.
async function sendDuePromotions() {
  const configuredMax = Number(process.env.PROMO_MAX_PER_RUN)
  const maxPerRun = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_PROMO_MAX_PER_RUN
  const startedAt = Date.now()

  let claimed = 0
  let sent = 0
  let failed = 0
  let batches = 0
  let exhausted = false

  while (true) {
    if (claimed >= maxPerRun || Date.now() - startedAt >= PROMO_TIME_BUDGET_MS) {
      exhausted = true
      break
    }

    const batchLimit = Math.min(PROMO_BATCH_SIZE, maxPerRun - claimed)
    const due = await claimDuePromotions(batchLimit)
    batches += 1
    if (!due.length) break // 더 이상 대상이 없다 = 자연 종료(exhausted=false)

    for (const payment of due) {
      try {
        await solapi.sendPromoAlimtalk({
          phone: payment.phone,
          carNumber: payment.carNumber,
          storeName: payment.store?.name,
          storeId: payment.storeId,
          paymentId: payment.id,
        })
        if (await markPromoSent(payment.id)) sent += 1
      } catch (notifyError) {
        failed += 1
        logger.error('프로모션 알림톡 발송 실패', {
          paymentId: payment.id,
          storeId: payment.storeId,
          error: notifyError.message,
        })
        await releasePromoClaim(payment.id)
      }
    }
    claimed += due.length

    // claim 가능한 건이 요청한 batchLimit보다 적게 나왔다 = 지금 시점에 더 밀린 대상이 없다는 뜻.
    if (due.length < batchLimit) break
  }

  return { claimed, sent, failed, batches, exhausted }
}

// Cloud Scheduler가 매일 오전 10시(KST)에 호출한다. Cloud Run 인스턴스마다 cron을 띄우지
// 않고, 공유 claim + promoSent 조건으로 동일 작업의 재전송을 막는다.
app.post('/internal/jobs/send-promotions', requirePromotionJobAuth, asyncHandler(async (req, res) => {
  try {
    const result = await sendDuePromotions()
    return res.json({ ok: true, ...result })
  } catch (error) {
    logger.error('[promotion-job] 처리 실패', { job: 'send-promotions', error: error.message })
    return res.status(500).json({ ok: false, error: '프로모션 작업 처리에 실패했습니다.' })
  }
}))

// 개인정보 보관기간 경과 건 파기(익명화) (계약 §3.25 신규). PROMOTION_JOB_TOKEN을 그대로
// 재사용한다 — 둘 다 "Cloud Scheduler가 부르는 내부 배치 작업"이라는 같은 신뢰 경계이기 때문이다.
app.post('/internal/jobs/purge-expired', requirePromotionJobAuth, asyncHandler(async (req, res) => {
  try {
    const result = await purgeExpiredPersonalData()
    return res.json({ ok: true, ...result })
  } catch (error) {
    logger.error('[purge-job] 처리 실패', { job: 'purge-expired', error: error.message })
    return res.status(500).json({ ok: false, error: '개인정보 파기 작업 처리에 실패했습니다.' })
  }
}))

// Cloud Run 공개 도메인에서는 /healthz가 Google 엣지 경로로 예약되어 있어
// Express까지 도달하지 않을 수 있으므로 별도 경로를 사용한다.
// liveness probe: DB 접근 없이 프로세스가 요청을 받을 수 있는지만 본다(기존 유지).
app.get('/health', (req, res) => res.send('ok'))

// readiness probe(계약 §3.26 신규): DB까지 실제로 붙는지 확인한다. Cloud Run/로드밸런서가 이걸로
// "트래픽을 받을 준비가 됐는지"를 판단하므로, DB 커넥션이 끊긴 인스턴스는 여기서 503을 내서
// 트래픽 라우팅 대상에서 빠지게 한다(liveness만 보면 "떠있지만 DB가 안 붙는" 상태를 못 거른다).
app.get('/health/ready', asyncHandler(async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return res.json({ ok: true })
  } catch (e) {
    logger.error('[health] readiness 체크 실패', { error: e.message })
    return res.status(503).json({ ok: false })
  }
}))

// --- 404 + 에러 핸들러 (계약 §5) ---
// 모든 라우트 등록 뒤에 둬야 Express가 매칭 실패/에러를 이 두 핸들러로 떨어뜨린다.
app.use((req, res) => {
  res.status(404).json({ ok: false, error: '요청하신 경로를 찾을 수 없습니다.' })
})

// 4개 인자(err 포함)를 받는 함수만 Express가 에러 핸들러로 인식한다 — asyncHandler가 next(err)로
// 넘긴 에러가 결국 여기로 모인다. 클라이언트에는 고정 문구만 내려주고 상세(스택 등)는 로그에만 남긴다.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('처리되지 않은 요청 오류', {
    path: req.path,
    method: req.method,
    error: err?.message,
    stack: err?.stack,
  })
  if (err?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
    return res.status(409).json({ ok: false, error: err.message })
  }
  if (res.headersSent) {
    return next(err)
  }
  return res.status(500).json({ ok: false, error: '요청 처리 중 오류가 발생했습니다.' })
})

const PORT = process.env.PORT || 3000
let httpServer = null

function startServer() {
  return Promise.all([ensureDefaultStore(), ensureDefaultHqAdmin()])
    .then(() => {
      httpServer = app.listen(PORT, () => console.log(`쉐보레 토스플러그인 서버 실행 중: http://localhost:${PORT}`))
      return httpServer
    })
    .catch((e) => {
      logger.error('부팅 시드 실패', { phase: 'bootstrap', error: e.message })
      process.exit(1)
    })
}

// --- Graceful shutdown (계약 §6) ---
// SIGTERM/SIGINT 수신 시: 새 연결을 막고(server.close) 기존 요청이 끝나길 기다린 뒤 DB 커넥션을
// 정리하고 종료한다. Cloud Run 등은 컨테이너 교체 시 SIGTERM을 보내고 짧은 유예 시간만 주므로,
// 그 안에 못 끝내면 10초 타이머가 강제로 exit(1)한다(무한 대기로 배포가 멈추는 걸 막기 위함).
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('종료 신호 수신, graceful shutdown 시작', { signal })

  const forceExitTimer = setTimeout(() => {
    logger.error('10초 안에 정상 종료하지 못해 강제 종료합니다.', { signal })
    process.exit(1)
  }, 10000)
  forceExitTimer.unref()

  const closeServer = httpServer
    ? new Promise((resolve) => httpServer.close(() => resolve()))
    : Promise.resolve()

  closeServer
    .then(() => prisma.$disconnect())
    .then(() => {
      clearTimeout(forceExitTimer)
      process.exit(0)
    })
    .catch((e) => {
      logger.error('graceful shutdown 중 오류', { error: e.message })
      process.exit(1)
    })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// --- 프로세스 레벨 안전망 (계약 §5) ---
// asyncHandler가 라우트 안에서 일어난 에러는 다 잡아주지만, 그 바깥(타이머, 라이브러리 내부 콜백 등)
// 에서 놓친 rejection까지 완벽히 막을 순 없다. 여기서 한 번 더 로그만 남기고 프로세스는 죽이지
// 않는다 — 예: notifyQueueTurn류 함수 하나에서 놓친 reject 때문에 매장 전체 서비스가 재시작되는
// 사고가 벌어지면 안 된다.
process.on('unhandledRejection', (reason) => {
  logger.error('처리되지 않은 Promise 거부', { error: reason?.message || String(reason), stack: reason?.stack })
})

// uncaughtException은 Node 공식 문서가 권고하는 대로 다르게 다룬다 — 이 시점엔 프로세스 상태가
// 이미 오염됐을 수 있어(예: 잠긴 리소스, 깨진 클로저 상태) 계속 실행하지 않고 graceful shutdown 후
// 종료한다. unhandledRejection보다 한 단계 더 심각한 신호로 취급한다.
process.on('uncaughtException', (err) => {
  logger.error('처리되지 않은 예외', { error: err.message, stack: err.stack })
  shutdown('uncaughtException')
})

if (require.main === module) {
  startServer()
}

module.exports = { app, sendDuePromotions, purgeExpiredPersonalData }
