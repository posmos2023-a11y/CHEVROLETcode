require('dotenv').config()
const express = require('express')
const cors = require('cors')
const compression = require('compression')
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
  normalizeBusinessNumber,
  recordWebhookEventOnce,
  findAdminUserByEmail,
  createAdminUser,
  markAdminLogin,
  recordFailedLogin,
  changeAdminPassword,
  getAdminUser,
  createStore,
  listStoresPage,
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
  markErpCartUnloaded,
  markErpCartFailed,
  markErpCartDismissed,
  markErpCartPaid,
  markErpCartFrontPaying,
  releaseErpCartFrontPaying,
  recordErpCartFrontReleasedKey,
  isReleasedToken,
  forceReleaseErpCartFrontPaying,
  forceReleaseErpCartRefunding,
  FORCE_RELEASE_AFTER_MS,
  markErpCartFrontPaid,
  markErpCartFrontPaidAfterRelease,
  recordErpCartFrontOrphan,
  clearErpCartFrontOrphan,
  ackErpCartFrontOrphan,
  recordErpCartFrontOrphanPaid,
  FRONT_ORPHAN_RECORDABLE_STATUSES,
  listClosedFrontOrphanCartsForPos,
  hasUnackedFrontOrphan,
  sendErpCartToFront,
  bumpErpCartFrontSentAt,
  returnErpCartToPos,
  listFrontErpCartsForPos,
  recordTossPayment,
  markBackupPaymentErpLinked,
  linkErpCartsToTossPayment,
  linkFrontCartToRecordedTossPayment,
  markErpCartsRefundedByToss,
  TOSS_CANCEL_REFUND_NOTE,
  restoreErpCartPaidAfterPosCancel,
  requestErpCartRefund,
  withdrawErpCartRefund,
  markErpCartRefunding,
  releaseErpCartRefunding,
  markErpCartRefundAttemptReleased,
  markErpCartRefunded,
  markErpCartRefundedAfterRelease,
  listSettledErpCartsForPos,
  listErpCarts,
  getPosDailySummary,
  findRepairHistoryByCarNumber,
  latestPhonesByCarNumbers,
  findCarNumbersByPhone,
  pingDatabaseReady,
  listRecentRepairHistory,
  findMarketingContactByCarNumber,
  findLastPromoSend,
  PROMO_MIN_INTERVAL_DAYS,
  PROMO_CONSENT_MAX_AGE_DAYS,
  getPromoIntervalDays,
  isPromoDemoActive,
  setPromoDemoUntil,
  assessPromoPhones,
  claimPromoSend,
  finishPromoSend,
  registerMarketingOptOut,
  registerPromoExclusion,
  skipDuePromotion,
  postponeDuePromotion,
  countRecentAutoPromoFailures,
  closeSiblingDuePromotions,
  listPromoCampaignCandidates,
  completeReservationAfterPayment,
  findOpenReservationByCarNumber,
  findReservationForPaymentByCarNumber,
  setErpCartHidden,
  softDeleteErpCart,
  hideHistoryVisit,
  deleteHistoryVisit,
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
if (process.env.NODE_ENV === 'production' && !(process.env.TOSS_WEBHOOK_SECRET || '').trim()) {
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

// 발신번호에 숫자·하이픈 말고 다른 글자(공백·괄호·'+82')가 있으면 솔라피 SDK가 보내기 전에 매 발송을 BadRequestError로 거절한다.
// 그러면 예약·영수증 알림과 홍보가 전부 실패하는데 로그만 보면 원인을 찾기 어렵다 -- 부팅 때 바로 알린다(값은 남기지 않는다).
if (process.env.SOLAPI_SENDER && !/^[0-9-]+$/.test(process.env.SOLAPI_SENDER)) {
  logger.warn('[boot] SOLAPI_SENDER에 숫자와 하이픈(-) 말고 다른 글자가 있습니다. 문자 발송이 모두 거절됩니다. 예) 0212345678 또는 02-1234-5678')
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

// 응답 gzip 압축. 정적 파일과 모든 라우트보다 앞에 둔다. POS 폴링(GET /api/pos/queue)은 한 번에 수십 KB(실측 43KB → gzip 3.4KB)라
// 400개 매장 x 5초면 송신량과 매장 LTE 회선 부담이 크다. 1KB 미만 응답은 압축 이득보다 CPU가 아까워 그대로 보낸다.
// 요청 본문(웹훅 raw body 서명 검증)과는 무관하다 -- 응답 쪽만 바꾼다. 브라우저·웹뷰는 Accept-Encoding을 보내야만 압축본을 받는다.
app.use(compression({ threshold: 1024 }))

// --- CORS 설정 (계약 §8) ---
// 손님/POS 단말기는 토스 결제 단말기 내장 브라우저 등 매번 다른 로컬 오리진에서 접근하므로
// Origin 검증 자체가 불가능하다 — 전체 허용을 유지한다.
// Retry-After는 노출을 허락해야 단말기 스크립트가 읽는다(429 때 얼마나 기다릴지 front-plugin/erp-front-pay.js가 따른다).
const publicCors = cors({ exposedHeaders: ['Retry-After'] })

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
// 프론트 플러그인은 단말기 로컬 서버(예: 172.30.1.54:9900) 오리진에서 부르므로 POS와 같이 전체 허용한다.
app.use('/api/front', publicCors)
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

// 정비 이력처럼 직원만 보는 화면에 전체 번호를 읽기 쉽게 보여줄 때 쓴다(01012345678 -> 010-1234-5678).
function formatPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
  return d || null
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
    res.status(403).json({ ok: false, error: '다른 매장의 접수예요.' })
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
  // 아래 문구는 손님 화면(프론트 접수·웹 접수)에 그대로 뜬다 -- 영문 필드명을 쓰지 않고 할 일을 알려준다.
  if (merchantId === undefined || merchantId === null || merchantId === '') {
    return res.status(400).json({ ok: false, error: '매장 정보를 확인할 수 없어요. 직원에게 문의해주세요.' })
  }
  const store = await findStoreByMerchantId(merchantId)
  if (!store) {
    return res.status(404).json({ ok: false, error: '아직 등록되지 않은 매장이에요. 직원에게 문의해주세요.' })
  }
  if (store.status !== 'active') {
    return res.status(403).json({ ok: false, error: '지금은 이용할 수 없는 매장이에요. 직원에게 문의해주세요.' })
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
    return res.status(403).json({ ok: false, error: '이용이 중지된 매장이에요. 본사에 문의해주세요.' })
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
    return res.status(400).json({ ok: false, error: '토스 가맹점 ID, 이메일, 비밀번호를 모두 입력해주세요.' })
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: '비밀번호는 8자 이상이어야 합니다.' })
  }
  const store = await findStoreByMerchantId(merchantId)
  if (!store) {
    return res.status(404).json({ ok: false, error: '등록되지 않은 토스 가맹점 ID예요.' })
  }
  if (await findAdminUserByEmail(email)) {
    return res.status(409).json({ ok: false, error: '이미 등록된 이메일입니다.' })
  }

  const passwordHash = await hashPassword(password)
  const admin = await createAdminUser({ email, passwordHash, role: 'store_admin', storeId: store.id })
  return res.json({ ok: true, admin: { id: admin.id, email: admin.email, role: admin.role, storeId: admin.storeId } })
}))

// --- 손님 접수(POST /api/reservations) 한도 ---
//
// 예전에는 IP당 10분 5건이었다. 한 매장의 프론트는 공인 IP 하나로 나가므로 붐비는 아침 6번째 손님부터 '요청이 너무 많습니다'가
// 떴고, 본사망·통신사 NAT를 함께 쓰는 매장끼리도 그 5건을 나눠 썼다(2026-10-23 회의). 그래서 매장+IP(requireStore 뒤 req.store.id와
// 요청 IP) 단위로 넉넉히 세고, 같은 번호로 접수 문자를 계속 보내는 스팸은 전화번호(해시) 단위로 따로 막는다(paymentPhoneLimiter와 같은
// 이유로 번호 원문은 저장하지 않는다). IP 한도는 DB를 건드리기 전의 폭주 차단용으로만 메모리에 넉넉히 둔다.
// 매장 한도를 매장 하나로만 세면, merchantId는 공개값이라(웹 접수 링크 쿼리에 그대로 들어간다) IP 하나로 그 매장 몫 60건을 다 써서
// 10분씩 그 매장의 프론트·웹 접수를 전부 429로 막을 수 있었다. 그래서 IP를 키에 넣어 남의 IP 몫은 쓰지 못하게 하고, 본문 검증
// (validateReservationBody)을 통과한 요청만 센다 -- 빈 본문 같은 400 요청은 한도를 쓰지 않는다.
// 429 본문은 { ok:false, code:'RATE_LIMITED', retryAfterSec, error } -- 프론트가 입력을 지우지 않고 그 시간 뒤 다시 시도하게 한다.
// 한도값은 운영 로그를 보고 배포 없이 바꿀 수 있게 환경변수로도 받는다(양수만, 아니면 기본값).
function positiveEnvNumber(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const RESERVATION_WINDOW_MS = 10 * 60 * 1000
// 매장+IP당 10분 60건 -- 실제 접수량(붐빌 때 매장 프론트 하나에서 10분 10~15대)의 몇 배
const RESERVATION_STORE_LIMIT = positiveEnvNumber('RESERVATION_STORE_LIMIT_PER_10MIN', 60)
// 같은 번호 10분 5건 -- 네트워크 오류 뒤 다시 시도(같은 Idempotency-Key)까지 센다
const RESERVATION_PHONE_LIMIT = positiveEnvNumber('RESERVATION_PHONE_LIMIT_PER_10MIN', 5)
const RESERVATION_IP_LIMIT_PER_MIN = positiveEnvNumber('RESERVATION_IP_LIMIT_PER_MIN', 120)

function rateLimitedHandler(error) {
  return (req, res, next, options) => {
    const resetTime = req.rateLimit?.resetTime
    const retryAfterSec = resetTime
      ? Math.max(1, Math.ceil((new Date(resetTime).getTime() - Date.now()) / 1000))
      : Math.ceil(options.windowMs / 1000)
    res.status(options.statusCode).json({ ok: false, code: 'RATE_LIMITED', retryAfterSec, error })
  }
}

function reservationPhoneRateKey(req) {
  const phone = String(req.body?.phone ?? '').replace(/-/g, '').trim()
  if (phone) return `phone:${crypto.createHash('sha256').update(phone).digest('hex').slice(0, 32)}`
  return `ip:${rateLimit.ipKeyGenerator(req.ip)}`
}

const reservationIpFloodLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: RESERVATION_IP_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedHandler('접수가 잠시 몰렸어요. 잠시 후 다시 시도해주세요.'),
})

// 키는 매장+IP다(위 주석). prefix는 예전 그대로라 예전 매장 단위 키(store:<id>)는 창이 지나면 정리된다.
function reservationStoreRateKey(req) {
  return `store:${req.store.id}:ip:${rateLimit.ipKeyGenerator(req.ip)}`
}

const reservationStoreLimiter = rateLimit({
  windowMs: RESERVATION_WINDOW_MS,
  limit: RESERVATION_STORE_LIMIT,
  keyGenerator: reservationStoreRateKey,
  store: new PostgresRateLimitStore(prisma, { prefix: 'reservation-store', windowMs: RESERVATION_WINDOW_MS }),
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedHandler('접수가 잠시 몰렸어요. 잠시 후 다시 시도해주세요.'),
})

const reservationPhoneLimiter = rateLimit({
  windowMs: RESERVATION_WINDOW_MS,
  limit: RESERVATION_PHONE_LIMIT,
  keyGenerator: reservationPhoneRateKey,
  store: new PostgresRateLimitStore(prisma, { prefix: 'reservation-phone', windowMs: RESERVATION_WINDOW_MS }),
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedHandler('같은 번호로 접수가 여러 번 들어왔어요. 잠시 후 다시 시도해주세요.'),
})

const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  store: new PostgresRateLimitStore(prisma, { prefix: 'payment', windowMs: 10 * 60 * 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

// 위 paymentLimiter는 IP 기준 10회/10분이다 — 공격자가 IP를 바꿔가며(또는 IP가 여러 개인
// 환경에서) 같은 피해자 전화번호로 반복 호출하면 이 한도로는 못 막고, 그 번호로 영수증
// 알림톡만 계속 나간다(표적 스팸/괴롭힘). 그래서 전화번호 기준 한도를 따로 둔다.
// posStoreRateKey(POS 폴링 한도 키)가 토큰을 해시해서 키로 쓰는 것과 같은 이유로, 전화번호 원문을
// 그대로 레이트리밋 스토어에 남기지 않는다 — 평문 전화번호가 별도 테이블에 쌓이는 것 자체가
// 또 다른 개인정보 노출 지점이 된다.
function paymentPhoneRateKey(req) {
  const phone = String(req.body?.phone ?? '').replace(/-/g, '').trim()
  if (phone) return `phone:${crypto.createHash('sha256').update(phone).digest('hex').slice(0, 32)}`
  return `ip:${rateLimit.ipKeyGenerator(req.ip)}`
}

const paymentPhoneLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  keyGenerator: paymentPhoneRateKey,
  store: new PostgresRateLimitStore(prisma, { prefix: 'payment-phone', windowMs: 10 * 60 * 1000 }),
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
    // 발송 실패는 error.message 대신 요약값만 남긴다(solapi.sendFailureLog -- 요청 전체가 담긴 SDK 메시지에 손님 번호가 들어 있다).
    logger.error('순서 알림톡 발송 실패', {
      reservationId: reservation.id,
      storeId: reservation.storeId,
      ...solapi.sendFailureLog(notifyError),
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
// 차량번호 + 전화번호를 등록하고 대기번호를 발급한다(화면에 보이는 이름은 '접수'다 -- 경로·DB 이름은 옛 단말과 전산 연동 때문에 그대로 둔다).
// "앞에 몇 명 있는지"(peopleAhead)는 오늘 접수분 중 아직 호출되지 않은 waiting만 센다(store.countWaitingAhead). 예전에는 이미
// 호출된 손님까지 세어 손님에게 실제보다 긴 대기를 안내했다(2026-10-23 회의 결정으로 바꿈).
// 같은 차·같은 번호가 오늘 이미 대기열에 있으면 새 번호 없이 그 접수를 duplicate:true로 돌려준다(store.createReservation 주석) -- 알림도
// 다시 보내지 않는다. 번호가 다르면 새 접수를 만든다.
// 예약 접수 시에는 앞에 사람이 없더라도 항상 waiting 상태로 두고 접수 알림톡만 보낸다.
// 실제 호출은 직원이 POS/관리자 화면에서 명시적으로 눌렀을 때만 발생한다.
// 한도: IP 폭주 차단(메모리) → 매장 확인 → 본문 검증 → 매장+IP 한도 → 같은 번호 한도(위 reservation*Limiter 주석).

// 접수 본문 검증. 한도보다 앞에 둬서, 검증에 실패한 요청(400)은 매장+IP·번호 한도를 쓰지 않는다. 통과하면 정규화한 값을
// req.reservationInput에 담아 넘긴다(번호 한도 키는 req.body.phone으로 만든다 -- reservationPhoneRateKey).
function validateReservationBody(req, res, next) {
  // '12가 3456'·'12가-3456'처럼 띄어 쓰거나 하이픈을 넣어도 받는다(normalizeCarNumber -- 전산 주문과 같은 정규화). 형식 검사는 그다음이다.
  const carNumber = normalizeCarNumber(req.body?.carNumber) || ''
  const phone = String(req.body?.phone ?? '').replace(/-/g, '').trim()
  const serviceTypeKey = String(req.body?.serviceType ?? '').trim()

  // 아래 문구는 손님 화면(프론트 접수 결과·웹 접수)에 그대로 뜬다.
  if (!CAR_NUMBER_RE.test(carNumber)) {
    return res.status(400).json({ ok: false, error: '차량번호를 다시 확인해주세요. 예) 12가3456' })
  }
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ ok: false, error: '휴대폰 번호를 다시 확인해주세요. 예) 01012345678' })
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
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 처음부터 다시 시도해주세요.' })
  }

  req.reservationInput = { carNumber, phone, serviceType, privacyConsentAt, marketingConsentAt, idempotencyKey }
  return next()
}

app.post('/api/reservations', publicCors, reservationIpFloodLimiter, requireStore, validateReservationBody, reservationStoreLimiter, reservationPhoneLimiter, asyncHandler(async (req, res) => {
  const storeId = req.store.id
  const { carNumber, phone, serviceType, privacyConsentAt, marketingConsentAt, idempotencyKey } = req.reservationInput

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
    return res.status(500).json({ ok: false, error: '접수 중 오류가 발생했어요. 잠시 후 다시 시도하거나 직원에게 문의해주세요.' })
  }

  // 같은 Idempotency-Key의 재시도이거나 같은 차·같은 번호가 오늘 이미 대기열에 있다 -- 기존 접수를 돌려준다(알림 없음).
  // 본문은 손님 화면이 쓰는 값(대기번호·앞 대기 수·상태)만 싣는다. 이 경로는 공개라(merchantId는 공개값) id·정비 항목·날짜 같은
  // 기존 접수의 세부값은 내보내지 않는다.
  if (duplicate) {
    return res.json({
      ok: true,
      duplicate: true,
      queueNumber: reservation.queueNumber,
      peopleAhead,
      status: reservation.status,
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
      ...solapi.sendFailureLog(notifyError),
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
    return res.status(400).json({ ok: false, error: '상단에서 매장을 먼저 선택해주세요.' })
  }
  const reservation = await getNextWaitingReservation(storeId)
  if (!reservation) {
    return res.status(404).json({ ok: false, error: '대기 중인 손님이 없어요.' })
  }

  const outcome = await notifyQueueTurn(reservation)

  // carNumber: 관리자 웹이 "몇 번 어느 차를 호출했는지" 결과를 보여주는 데 쓴다(관리자 전용 라우트라 마스킹하지 않는다).
  return res.json({ ok: true, id: reservation.id, queueNumber: reservation.queueNumber, carNumber: reservation.carNumber, status: reservation.status, alreadyProcessed: !outcome.changed })
}))

// 특정 예약을 대기열 순서와 무관하게 바로 호출한다 (관리자 전용).
// 테스트로 만든 예약을 확인하거나, 예외적으로 순서를 건너뛰어야 할 때 쓴다.
app.post('/api/reservations/:id/call', requireAuth, asyncHandler(async (req, res) => {
  const reservation = await getReservation(req.params.id)
  if (!reservation) {
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  if (!assertOwnsReservation(req, res, reservation)) return
  if (reservation.status !== 'waiting') {
    if (['called', 'notify_failed'].includes(reservation.status)) {
      return res.json({ ok: true, id: reservation.id, queueNumber: reservation.queueNumber, status: reservation.status, alreadyProcessed: true })
    }
    return res.status(400).json({ ok: false, error: '대기 중인 손님만 호출할 수 있어요.' })
  }

  const outcome = await notifyQueueTurn(reservation)

  return res.json({ ok: true, id: reservation.id, queueNumber: reservation.queueNumber, status: reservation.status, alreadyProcessed: !outcome.changed })
}))

// 손님 취소/노쇼 처리 (관리자 전용, 계약 §3.9 신규). waiting|called|notify_failed만 취소 가능.
app.post('/api/reservations/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing) {
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  if (!assertOwnsReservation(req, res, existing)) return
  if (existing.status === 'cancelled') {
    return res.json({ ok: true, id: existing.id, status: 'cancelled', alreadyCancelled: true })
  }
  if (existing.status === 'completed') {
    return res.status(409).json({ ok: false, error: '이미 정비가 끝난 접수라 취소할 수 없어요.' })
  }
  const reservation = await markReservationCancelled(req.params.id)
  if (!reservation) {
    return res.status(409).json({ ok: false, error: '지금은 취소할 수 없는 접수예요.' })
  }
  return res.json({ ok: true, id: reservation.id, status: reservation.status })
}))

// 순서 안내 알림톡 재발송 (관리자 전용, 계약 §3.10 신규). notify_failed 상태만 허용.
// 성공하면 called로 되돌리고, 실패해도(HTTP 200으로) notify_failed를 유지한 채 sent:false로 알린다 —
// 관리자가 "재발송이 요청 자체는 처리됐는데 이번에도 안 갔다"를 구분할 수 있어야 하기 때문이다.
app.post('/api/reservations/:id/retry-notify', requireAuth, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing) {
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  if (!assertOwnsReservation(req, res, existing)) return
  if (existing.status !== 'notify_failed') {
    return res.status(409).json({ ok: false, error: '호출 알림 발송에 실패한 접수만 다시 보낼 수 있어요.' })
  }
  const reservation = await markReservationCalledFromNotifyFailed(existing.id)
  if (!reservation) {
    return res.status(409).json({ ok: false, error: '호출 알림 발송에 실패한 접수만 다시 보낼 수 있어요.' })
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
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  if (!assertOwnsReservation(req, res, existing)) return
  if (existing.intakeNotifyStatus !== 'failed' || ['completed', 'cancelled'].includes(existing.status)) {
    return res.status(409).json({ ok: false, error: '접수 알림 발송에 실패한 건만 다시 보낼 수 있어요.' })
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
      ...solapi.sendFailureLog(notifyError),
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
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
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
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  if (!assertOwnsReservation(req, res, existing)) return
  const reservation = await markReservationCompleted(req.params.id)
  if (!reservation) {
    if (existing.status === 'completed') {
      return res.json({ ok: true, id: existing.id, status: existing.status, alreadyCompleted: true })
    }
    return res.status(409).json({ ok: false, error: '호출한 손님만 정비완료로 처리할 수 있어요.' })
  }
  const notified = await notifyRepairDone(reservation)
  return res.json({ ok: true, id: reservation.id, status: reservation.status, notified })
}))

// 정비 완료(출고) 안내 문자. [완료]가 실제로 상태를 바꾼 때만 보낸다(같은 버튼을 두 번 눌러도 한 번만 간다).
// 결제 뒤 자동 완료(completeReservationAfterPayment)에서는 보내지 않는다 -- 손님이 이미 카운터에서 결제하고
// 있으니 "차를 찾으러 오세요"가 어색하고, 영수증이 따로 간다.
// 실패해도 완료 처리는 그대로 두고 false를 돌려준다 -- 화면이 "직접 연락하세요"라고 알린다.
async function notifyRepairDone(reservation) {
  try {
    await solapi.sendRepairDoneAlimtalk({
      phone: reservation.phone,
      carNumber: reservation.carNumber,
      serviceType: reservation.serviceType,
      storeName: reservation.store?.name,
      storeId: reservation.storeId,
      reservationId: reservation.id,
    })
    return true
  } catch (error) {
    logger.error('[repair-done] 정비 완료 안내 발송 실패', { reservationId: reservation.id, storeId: reservation.storeId, ...solapi.sendFailureLog(error) })
    return false
  }
}

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
// 카운터(rejectPosAuthFailure)가 잡는다. 조회 한도는 인증보다 앞에 둔다: 토큰을 가진 단말이 폭주해도 DB 조회(매장 찾기) 전에 끊긴다.
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

// 호출/완료/취소처럼 상태를 바꾸는 POS·프론트 라우트는 폴링만큼 빈도가 높지 않고, 매장 전체(여러 탭앱
// 인스턴스가 있을 수 있음) 기준의 정확한 한도가 더 의미 있어서 기존처럼 DB 기반 스토어를 유지한다.
// 인증(requireStoreToken) **뒤에** 두고 매장 단위로 센다(2026-10-23). 예전에는 인증 앞에서 IP로 셌다:
//   - 공인 IP를 함께 쓰는 매장들이 결제 보고(/result·/paid)까지 한도 하나를 나눠 썼다.
//   - 토큰이 틀린 요청 1건이 이 카운터와 인증 실패 카운터에 DB를 두 번 썼다(이제 실패 카운터만 쓴다).
// 인증 전에는 req.store가 없으므로 이 키의 ip: 분기는 순서를 잘못 붙였을 때의 안전장치일 뿐이다.
const POS_WRITE_LIMIT_PER_MIN = positiveEnvNumber('POS_WRITE_LIMIT_PER_MIN', 120)

const posLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: POS_WRITE_LIMIT_PER_MIN,
  keyGenerator: (req) => (req.store ? `store:${req.store.id}` : `ip:${rateLimit.ipKeyGenerator(req.ip)}`),
  store: new PostgresRateLimitStore(prisma, { prefix: 'pos', windowMs: 60 * 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

// X-Store-Token 인증 실패 카운터 (validatePosToken 위 주석 참고).
// IP당 15분에 10회를 넘게 틀리면 그 IP의 **틀린** 시도에 401 대신 429를 준다.
//
// ⚠️ 이 카운터는 추측을 막지 못한다(2026-10-23 확인). requireStoreToken은 토큰을 먼저 조회하고 실패했을 때만 여기로 오므로,
// 차단된 IP에서도 맞는 토큰은 그대로 200을 받는다 -- 바뀌는 것은 틀린 시도의 응답 코드뿐이다. 실제 상한은 IP당 분당
// posIpFloodLimiter(600회)이고, 한 번의 추측이 400개 매장 토큰 전부와 비교된다. 그래서 직접 지정 토큰을 12자 이상·영문+숫자로
// 올렸고(POS_TOKEN_MIN_LENGTH), 전체 실패 수가 급증하면 pos_auth_bruteforce 로그를 남긴다(아래 POS_AUTH_GLOBAL_*).
// "차단된 IP는 맞는 토큰도 거절"로 바꾸면 안 된다: POS와 프론트가 같은 공인 IP를 쓰므로 한 단말의 오타가 매장 전체를 멈춘다.
// 근본 대책은 1회용 연결 코드 + 긴 토큰(개선 제안 B1)이다.
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
// 전체(모든 IP) 인증 실패 수. IP를 바꿔 가며 토큰을 맞혀 보는 시도는 IP 카운터에 안 걸리므로 전체 수로 본다. 막지는 않고 로그만
// 남긴다(Cloud Logging에서 jsonPayload.event="pos_auth_bruteforce"로 알림을 건다).
// 주의: 토큰을 재발급한 뒤 다시 연결하지 않은 단말도 폴링마다 틀린다 -- 401에도 3초마다 계속 묻는 옛 프론트 1대가 15분에 약 300회다.
// 그래서 이 알림은 "추측 공격" 또는 "옛 토큰으로 계속 두드리는 단말"을 뜻한다. 로그의 ipFailures(그 IP의 실패 수)가 크면 후자다.
const POS_AUTH_GLOBAL_ALERT_THRESHOLD = 300
const POS_AUTH_GLOBAL_KEY = 'all'
const posAuthGlobalStore = new PostgresRateLimitStore(prisma, {
  prefix: 'pos-auth-global',
  windowMs: POS_AUTH_FAILURE_WINDOW_MS,
})

// 인증 실패를 1회 기록하고, 한도를 넘었으면 429를 보낸 뒤 true를 돌려준다.
// (호출부는 true면 이미 응답이 나갔으므로 그대로 return 하면 된다.)
async function rejectPosAuthFailure(req, res, unauthorizedBody) {
  const key = `ip:${rateLimit.ipKeyGenerator(req.ip)}`
  let totalHits = 1
  const [ipResult, globalResult] = await Promise.allSettled([
    posAuthFailureStore.increment(key),
    posAuthGlobalStore.increment(POS_AUTH_GLOBAL_KEY),
  ])
  if (ipResult.status === 'fulfilled') {
    totalHits = ipResult.value.totalHits
  } else {
    // 카운터를 못 쓰더라도 인증 자체는 이미 실패한 상태다. 여기서 500을 내면 공격자에게
    // DB를 흔드는 수단을 주는 셈이라, 로그만 남기고 평소대로 401로 돌려보낸다.
    logger.error('[pos] 인증 실패 카운터 기록 실패', { error: ipResult.reason?.message })
  }
  if (globalResult.status === 'fulfilled') {
    const globalHits = globalResult.value.totalHits
    // 넘는 순간 한 번, 그 뒤로는 100회마다 남긴다(실패마다 남기면 로그가 공격 규모만큼 불어난다).
    if (globalHits > POS_AUTH_GLOBAL_ALERT_THRESHOLD && (globalHits === POS_AUTH_GLOBAL_ALERT_THRESHOLD + 1 || globalHits % 100 === 0)) {
      logger.error('[pos] 매장 토큰 인증 실패가 전체적으로 급증했습니다(토큰 추측 또는 옛 토큰 단말 의심)', {
        event: 'pos_auth_bruteforce',
        failures: globalHits,
        ipFailures: totalHits,
        windowMinutes: POS_AUTH_FAILURE_WINDOW_MS / 60000,
      })
    }
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

// 오늘(KST) serviceDate 접수분 + 아직 끝나지 않은 이월 건(called/notify_failed)을 함께 보여준다(계약 v3 §4.1~4.2,
// store.listActiveQueueForStore). ?carriedOver=1이면 바로 전날 호출하지 않은 waiting도 싣는다 -- carriedOver를 아는 새 탭앱만 이
// 값을 보낸다. 옛 탭앱은 이 건을 오늘 대기로 세고 [호출]을 켜 두는데 호출은 404이고 [완료]는 waiting에서 눌리지 않는다.
// 응답 최상위 serviceDate(오늘 날짜)는 그대로 유지하고, 각 item에도 serviceDate를 실어보내 POS 화면이 "오늘 최상위 serviceDate와
// 다르면 이월 건"으로 배지를 붙일 수 있게 한다.
// item.carriedOver: 전날의 waiting(호출하지 않은 채 넘어온 건)일 때만 true -- 탭앱이 [호출] 대신 [완료]·[취소]만 보여준다(호출은 오늘
// 접수분만 받는다). item.createdAt·calledAt: 탭앱이 접수 시각과 경과 시간을 그린다.
// 정비 대기열 "최근 결제" 목록이 오늘 말고 며칠 전까지 보여줄지. 6이면 오늘 포함 7일.
const SETTLED_LOOKBACK_DAYS_BEFORE_TODAY = 6

// 매장 단말의 마지막 접속 시각(Store.lastPosSeenAt / lastFrontSeenAt). 폴링마다 쓰면 400개 매장 x 5초라 DB 쓰기가
// 너무 많아서, 인스턴스마다 매장·단말 종류별로 1분에 한 번만 쓴다. 응답을 기다리지 않는다 -- 기록이 실패해도
// 폴링 응답과는 무관하다.
const DEVICE_SEEN_WRITE_MS = 60 * 1000
const deviceSeenWrittenAt = new Map()

function noteDeviceSeen(storeId, kind) {
  const key = `${kind}:${storeId}`
  const now = Date.now()
  if (now - (deviceSeenWrittenAt.get(key) || 0) < DEVICE_SEEN_WRITE_MS) return
  deviceSeenWrittenAt.set(key, now)
  const data = kind === 'front' ? { lastFrontSeenAt: new Date(now) } : { lastPosSeenAt: new Date(now) }
  prisma.store.update({ where: { id: storeId }, data, select: { id: true } }).catch((e) => {
    logger.warn('[device] 마지막 접속 시각 기록 실패', { storeId, kind, error: e.message })
  })
}

app.get('/api/pos/queue', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  noteDeviceSeen(req.store.id, 'pos')
  const serviceDate = kstDateString()
  // 전날 waiting은 새 탭앱이 요청할 때만 싣는다(위 주석). '1' 말고는 모두 예전 응답이다.
  const includePreviousDayWaiting = req.query.carriedOver === '1'
  // 대기열과 전산 장바구니를 한 응답에 함께 담는다. 예전에는 탭앱이 두 경로를 각각 폴링해서
  // 매장당 요청이 두 배였다 -- 400개 매장 기준 초당 160건 중 절반이 이 때문이었다.
  // 두 조회는 서로 무관하므로 병렬로 던진다.
  const [reservations, erpCarts, frontCartRows, settledRows, orphanRows] = await Promise.all([
    listActiveQueueForStore(req.store.id, serviceDate, { includePreviousDayWaiting }),
    loadPendingErpCartsForResponse(req.store.id),
    listFrontErpCartsForPos(req.store.id, 20),
    // 최근 7일(오늘 포함, KST 자정 기준). 정비 후 며칠 지나 환불을 요청하는 손님도 있다.
    listSettledErpCartsForPos(req.store.id, new Date(kstDateRangeUtc(serviceDate).start.getTime() - SETTLED_LOOKBACK_DAYS_BEFORE_TODAY * 24 * 60 * 60 * 1000), 50),
    listClosedFrontOrphanCartsForPos(req.store.id, new Date(Date.now() - FRONT_ORPHAN_ALERT_DAYS * 24 * 60 * 60 * 1000), 20),
  ])
  // 같은 POS 결제로 함께 결제된 주문 수. 그 결제를 취소하면 전부 취소되므로 탭앱이 미리 알려야 한다.
  // 화면에 내려가는 목록(settledRows)만 세면 안 된다: 같이 결제된 다른 주문이 7일 밖이거나 삭제·숨김 상태이거나 50건
  // 한도에 잘려 있으면 1건으로 보이는데, 실제로 /refunded는 같은 tossPaymentId의 주문을 전부 취소한다. 직원이 "1건"이라
  // 믿고 취소했다가 다른 주문까지 취소되는 사고가 된다. 그래서 기간·삭제 여부와 무관하게 DB에서 따로 센다.
  // storeId를 건 이유: /refunded의 형제 주문 조회가 같은 매장으로 한정되어 있어 표시와 실제 취소 범위를 맞춘다.
  // 같은 결제에 묶인 주문들의 금액 합계(sharedPaymentTotal)도 같은 기준으로 센다. 탭앱이 POS 결제 금액과 비교해, 전산 주문 밖의
  // POS 품목까지 함께 결제된 건이면 [결제 취소]가 그 품목까지 전액 취소한다는 것을 미리 알린다(SDK 취소는 결제 한 건 전체를 취소한다).
  const sharedIds = [...new Set(settledRows.map((row) => row.tossPaymentId).filter(Boolean))]
  const sharedCount = new Map()
  const sharedTotal = new Map()
  if (sharedIds.length) {
    const grouped = await prisma.erpCart.groupBy({
      by: ['tossPaymentId'],
      where: { storeId: req.store.id, tossPaymentId: { in: sharedIds } },
      _count: { _all: true },
      _sum: { totalAmount: true },
    })
    for (const g of grouped) {
      sharedCount.set(g.tossPaymentId, g._count._all)
      sharedTotal.set(g.tossPaymentId, g._sum.totalAmount ?? 0)
    }
  }
  return res.json({
    ok: true,
    serviceDate,
    storeName: req.store.name,
    // 구버전 탭앱은 이 필드를 무시하고 /api/pos/erp-carts를 계속 부른다(그 경로도 살아 있다).
    erpCarts,
    // 프론트에서 결제 대기/진행 중인 전산 주문. 담기 버튼이 없는 "보기 전용" 목록이다 --
    // POS가 이 건을 담으면 프론트와 양쪽에서 결제될 수 있다. 구버전 탭앱은 이 필드를 무시한다.
    frontCarts: frontCartRows.map((row) => {
      let items = []
      try { items = JSON.parse(row.itemsJson) } catch { /* 손상된 건은 품목만 빈 배열로 -- 목록 전체를 죽이지 않는다 */ }
      return {
        id: row.id,
        referenceId: row.referenceId,
        carNumber: row.carNumber,
        memo: row.memo,
        items,
        totalAmount: row.totalAmount,
        status: row.status,
        createdAt: row.createdAt,
        // 결제 중(paying)이 10분 넘게 갇혔을 때 탭앱이 [결제 상태 풀기]를 보여주는 기준(force-release)
        frontPayingAt: row.frontPayingAt,
        frontOrphan: frontOrphanOf(row),
      }
    }),
    // 최근 7일 결제된 전산 주문(결제 완료·취소 진행·취소됨). 정비 대기열의 결제 취소는 여기서 한다.
    // 구버전 탭앱은 이 필드를 무시한다.
    settledCarts: settledRows.map((row) => {
      let items = []
      try { items = JSON.parse(row.itemsJson) } catch { /* 손상된 건은 품목만 빈 배열로 */ }
      const front = row.payTarget === 'front' ? parseFrontPayment(row) : null
      return {
        id: row.id,
        referenceId: row.referenceId,
        carNumber: row.carNumber,
        memo: row.memo,
        items,
        totalAmount: row.totalAmount,
        status: row.status,
        payTarget: row.payTarget,
        paidAt: row.paidAt,
        loadedAt: row.loadedAt,
        refundedAt: row.refundedAt,
        refundNote: row.refundNote,
        errorMessage: row.errorMessage,
        // 취소 중(refunding)이 10분 넘게 갇혔을 때 탭앱이 [취소 상태 풀기]를 보여주는 기준(force-release)
        refundRequestedAt: row.refundRequestedAt,
        refundStartedAt: row.refundStartedAt,
        // POS 결제 취소(posPluginSdk.payment.cancel)에 필요한 토스 주문/결제 ID
        tossPaymentId: row.tossPaymentId,
        tossOrderId: row.tossOrderId,
        tossVerified: Boolean(row.tossVerifiedAt),
        sharedPaymentCount: row.tossPaymentId ? sharedCount.get(row.tossPaymentId) || 1 : 1,
        sharedPaymentTotal: row.tossPaymentId && sharedTotal.has(row.tossPaymentId) ? sharedTotal.get(row.tossPaymentId) : row.totalAmount,
        frontOrphan: frontOrphanOf(row),
        paymentMethod: front?.paymentMethod || null,
        cashWithoutReceipt: row.payTarget === 'front' ? isUncancellableCash(row) : false,
        // 탭앱 정리·영수증 다시 보내기용
        hidden: Boolean(row.hiddenAt),
        receiptStatus: row.receiptStatus || null,
      }
    }),
    // 결제 없이 닫힌(매장이 지움·전산 취소·만료) 주문에 남은, 직원이 아직 확인하지 않은 프론트 미반영 승인(최근 7일). 이 주문들은 위
    // 어느 목록에도 실리지 않아 경고가 안 보였다 -- 전산이 새 referenceId로 다시 보내면 같은 정비를 또 결제한다. 탭앱이 따로 띄우고
    // [확인했어요](clear-front-orphan)·[프론트 승인으로 결제 완료 기록](record-front-orphan)을 준다. 구버전 탭앱은 이 필드를 무시한다.
    frontOrphans: orphanRows.map((row) => ({
      id: row.id,
      referenceId: row.referenceId,
      carNumber: row.carNumber,
      totalAmount: row.totalAmount,
      status: row.status,
      payTarget: row.payTarget,
      frontOrphan: frontOrphanOf(row),
    })),
    reservations: reservations.map((r) => ({
      id: r.id,
      queueNumber: r.queueNumber,
      carNumber: r.carNumber,
      serviceType: r.serviceType,
      status: r.status,
      phoneMasked: maskPhone(r.phone),
      createdAt: r.createdAt,
      calledAt: r.calledAt || null,
      serviceDate: r.serviceDate,
      carriedOver: r.status === 'waiting' && r.serviceDate !== serviceDate,
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
async function loadPendingErpCartsForResponse(storeId, payTarget = 'pos') {
  // POS 탭앱 목록은 확인하지 않은 프론트 미반영 승인이 있는 주문을 24시간이 지나도 준다(store.listPendingErpCarts 주석). 프론트 단말은 아니다.
  const rows = await listPendingErpCarts(storeId, 20, payTarget, { includeUnackedOrphans: payTarget === 'pos' })
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
      // 프론트의 "2분 쉬기" 열쇠용(다시 보낸 주문은 바로 뜨게) -- schema.prisma frontSentAt
      frontSentAt: row.frontSentAt || null,
      frontOrphan: frontOrphanOf(row),
    })
  }
  return carts
}

// 프론트에서 승인됐지만 이 주문에 반영하지 못한 결제의 흔적(/result의 PAID_AFTER_RELEASE). 탭앱은 이 값이 있으면 경고를 띄우고
// 같은 주문을 또 결제하기 전에 확인받는다. 없으면 null. ackAt: 직원이 [확인했어요]를 누른 시각(null이면 아직 확인 전) -- 확인해도
// 지우지 않는다(관리자 웹 대사 근거). 탭앱·전산 상태 조회·관리자 웹이 같은 모양을 쓴다.
function frontOrphanOf(row) {
  if (!row?.frontOrphanAt) return null
  return {
    at: row.frontOrphanAt,
    approvalNo: row.frontOrphanApprovalNo ?? null,
    amount: row.frontOrphanAmount ?? null,
    ackAt: row.frontOrphanAckAt ?? null,
  }
}

// 탭앱 경고 목록(/api/pos/queue frontOrphans)이 보여주는 기간. 그보다 오래된 흔적은 관리자 웹 대사로 넘긴다.
const FRONT_ORPHAN_ALERT_DAYS = 7

// ⚠️ 지우지 말 것. 지금 탭앱도 부른다(pos-plugin erpCarts.js refreshErpCarts가 deps.apiGet('/api/pos/erp-carts')): 전산 주문 화면의
// [새로고침] 버튼, 지우기·[POS로 되돌리기] 직후의 목록 갱신, /api/pos/queue 응답에 erpCarts가 없을 때의 폴백. 정기 폴링만
// /api/pos/queue 응답의 erpCarts를 쓴다. 예전 주석은 "구버전 탭앱 호환용"이라고 했는데 사실이 아니었다 -- 믿고 지우면 그 버튼들이 404가 된다.
app.get('/api/pos/erp-carts', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  return res.json({ ok: true, carts: await loadPendingErpCartsForResponse(req.store.id) })
}))

// 클라이언트(탭앱·프론트)가 "한 번의 시도"마다 새로 만들어 요청과 결과 보고에 같이 싣는 구분자. 응답을 못 받아 재시도하거나
// 시간 초과로 포기한 뒤 늦게 도착하는 요청이 자기 시도의 것인지 남의 것인지 서버가 가리는 데 쓴다(consume·refund-start·
// refund-result). 선택 값이라 안 보내는 옛 클라이언트는 예전처럼 동작한다.
// 반환: 값 | null(안 보냄) | false(형식이 틀림 -- 호출부가 400으로 거절)
// 쉼표가 들어갈 수 없어야 한다 -- 접은 취소 시도를 쉼표로 이어 refundReleasedAttemptId 한 컬럼에 목록으로 둔다(store.js 묘비 목록).
const ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

function parseAttemptId(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const value = String(raw).trim()
  return ATTEMPT_ID_RE.test(value) ? value : false
}

// 담기(loaded) 뒤에 이어지는 상태. 이 상태들에서는 담을 때 남긴 consumeAttemptId가 그대로 남는다(결제·취소 전이가 지우지 않는다).
const CONSUMED_CART_STATUSES = ['loaded', 'paid', 'refund_requested', 'refunding', 'refunded']

// 다른 단말기가 담은 주문을 [담기 취소]로 억지로 되돌릴 수 있게 되기까지의 시간. 담은 단말기에는 그 주문의 품목이 POS
// 장바구니와 결제 대기 기록에 그대로 남아 있어, 다른 단말기가 되돌리면 두 곳에서 결제될 수 있다. 그래서 담은 단말기에서
// 취소하는 것이 원칙이고, 그 단말기가 꺼졌거나 사라진 경우만 이 시간이 지난 뒤 직원이 확인하고(force) 되돌린다.
const UNLOAD_FORCE_AFTER_MS = 30 * 60 * 1000

// POS 플러그인이 addLineItem() 결과를 되돌려준다. posLimiter를 쓴다 -- 폴링(조회)이 아니라
// "이 매장 전체 기준으로 한도를 두는 게 의미 있는" 상태 변경 액션이라 posQueueReadLimiter가 아닌
// 기존 posLimiter(DB 기반)와 맞춘다.
app.post('/api/pos/erp-carts/:id/consume', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  // dismissed = 매장 직원이 화면에서 이 주문을 치웠다(잘못 온 건). 전산이 취소한 cancelled와
  // 구분해서 남긴다 -- 전산 입장에서 "우리가 취소"와 "매장이 거부"는 후속 조치가 다르다.
  const result = req.body?.result
  if (result !== 'loaded' && result !== 'failed' && result !== 'dismissed') {
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  }
  const attemptId = parseAttemptId(req.body?.attemptId)
  if (attemptId === false) {
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  }
  // 이미 처리된 건을 돌려줄 때, 그 처리가 이 요청(같은 attemptId)의 첫 시도가 성공한 것인지 알려준다. 재시도한 탭앱이
  // 자기 첫 성공을 "다른 단말기가 먼저 담았다"로 오해해 이미 POS에 담은 주문을 또 담지 않게 한다.
  // 담긴 뒤 이어지는 상태(결제·취소)에서도 consumeAttemptId는 그대로 남으므로 같이 본다 -- 담기 보고와 결제 통보의 응답을
  // 모두 놓친 탭앱이 담기를 다시 보냈을 때, 자기가 담아 결제까지 끝낸 주문을 "다른 단말기가 처리"로 오인하지 않게 한다.
  const alreadyProcessedBody = (row) => ({
    ok: true,
    alreadyProcessed: true,
    status: row?.status,
    ownAttempt: Boolean(attemptId) && CONSUMED_CART_STATUSES.includes(row?.status) && row.consumeAttemptId === attemptId,
  })

  // 다른 매장 소유의 cart를 건드리지 못하게 storeId까지 확인한다 -- id만으로 조회하면 다른 매장
  // POS 토큰으로도 남의 장바구니 상태를 바꿀 수 있게 되어버린다.
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }

  if (cart.payTarget === 'front') {
    // 프론트로 넘긴 건이다. POS가 담으면 프론트와 양쪽에서 결제될 수 있으므로 막는다
    // (넘기기 직전에 출발한 폴링 응답 때문에 탭앱에 카드가 잠깐 남아 있을 수 있다).
    return res.status(409).json({ ok: false, error: '프론트에서 결제하도록 넘긴 주문입니다.', status: cart.status, payTarget: 'front' })
  }

  if (cart.status !== 'pending') {
    // POS가 네트워크 오류 등으로 같은 consume을 재시도해도 안전해야 한다 -- 이미 처리된 건이면
    // 실패로 취급하지 않고 그대로 알려준다.
    return res.json(alreadyProcessedBody(cart))
  }

  // [담기 취소]로 되돌린 담기 시도의 늦은 보고(재전송·응답을 못 받은 첫 요청의 재시도)다. 다시 담김으로 만들면 POS 품목도 탭앱
  // 기록도 없는데 서버만 담김이 된다. 처리된 것으로 답하되 자기 시도가 아니라고 알려(ownAttempt false) 탭앱이 담긴 것으로 보지 않게 한다.
  const releasedAttemptBody = (row) => {
    logger.warn('[pos] 되돌린 담기 시도의 늦은 담기 보고를 받지 않음', { storeId: req.store.id, cartId: cart.id, attemptId, status: row?.status })
    return { ok: true, alreadyProcessed: true, status: row?.status, ownAttempt: false }
  }
  if (result === 'loaded' && isReleasedToken(cart.consumeReleasedAttemptId, attemptId)) {
    return res.json(releasedAttemptBody(cart))
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
    changed = await markErpCartLoaded(cart.id, attemptId)
  } else if (result === 'dismissed') {
    changed = await markErpCartDismissed(cart.id, note, 'pos')
  } else {
    changed = await markErpCartFailed(cart.id, note)
  }

  if (!changed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    if (latest?.payTarget === 'front') {
      // 읽은 직후 다른 단말기가 [프론트로 결제 요청]으로 넘겼다(전이는 payTarget 'pos'에서만 일어나 담기지 않았다). 위의
      // 사전 확인과 같은 409를 돌려 탭앱이 담은 품목을 되돌리고 결제하지 않게 한다.
      return res.status(409).json({ ok: false, error: '프론트에서 결제하도록 넘긴 주문입니다.', status: latest.status, payTarget: 'front' })
    }
    // 읽은 직후 이 시도가 되돌려졌다(markErpCartLoaded가 묘비 목록과 함께 확인해 담지 않았다).
    if (result === 'loaded' && latest?.status === 'pending' && isReleasedToken(latest.consumeReleasedAttemptId, attemptId)) {
      return res.json(releasedAttemptBody(latest))
    }
    return res.json(alreadyProcessedBody(latest))
  }
  return res.json({ ok: true, alreadyProcessed: false, status: result })
}))

// 담김(loaded) 되돌리기. 직원이 잘못 담았거나 POS 장바구니를 비워서 이 주문을 다시 담아야 할 때, 탭앱이 호출한다.
// 결제 통보(paidAt)가 이미 있는 주문과 프론트 결제 건은 되돌리지 않는다(store.markErpCartUnloaded).
// body: { checkDevice?(새 탭앱은 늘 true), attemptId?(담을 때 consume에 실은 값), force?(다른 단말기가 담은 주문을 직원이 확인하고 되돌림) }
// 담은 단말기만 되돌릴 수 있다(consumeAttemptId 비교). 다른 단말기가 되돌리면 담은 단말기의 POS 장바구니와 결제 대기 기록은
// 그대로 남아, 이 주문이 다시 담기거나 프론트로 넘어가 결제된 뒤 담은 단말기에서 또 결제될 수 있다. 담은 단말기가 사라진
// 경우를 위해 담은 지 UNLOAD_FORCE_AFTER_MS가 지났고 force:true면 허용한다. 옛 탭앱이 담은 주문(consumeAttemptId 없음)은 예전처럼.
// 이 확인은 요청이 checkDevice:true나 attemptId를 실었을 때만 한다. 둘 다 없는 요청은 이 확인을 모르는 탭앱(attemptId를 consume에만
// 싣고 /unload는 빈 바디로 보내던 버전)이다 -- 그 탭앱은 force를 보낼 수 없어, 확인하면 자기가 담은 주문도 영영 되돌리지 못한다.
// 그래서 예전처럼 되돌리고 경고 로그만 남긴다. 새 탭앱은 기억하는 attemptId가 없어도 checkDevice:true를 싣는다.
// 담긴 채 24시간이 넘은 주문은 되돌려도 전산 주문 목록에 다시 뜨지 않으므로 pending 대신 dismissed로 닫는다.
app.post('/api/pos/erp-carts/:id/unload', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const attemptId = parseAttemptId(req.body?.attemptId)
  if (attemptId === false) {
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  }
  const force = req.body?.force === true
  const checkDevice = req.body?.checkDevice === true || attemptId !== null
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }

  // 다른 단말기가 담은 주문이면 억지로 되돌릴 수 있게 되기까지 남은 시간(ms). 담은 단말기의 주문이면 null.
  const otherDeviceWaitMs = (row) => {
    if (row?.status !== 'loaded' || !row.consumeAttemptId || row.consumeAttemptId === attemptId) return null
    const loadedAtMs = row.loadedAt ? new Date(row.loadedAt).getTime() : 0
    return Math.max(0, loadedAtMs + UNLOAD_FORCE_AFTER_MS - Date.now())
  }
  const otherDeviceBody = (row, waitMs) => ({
    ok: false,
    code: 'LOADED_ON_OTHER_DEVICE',
    canForceAfterSec: Math.ceil(waitMs / 1000),
    error: '다른 단말기에서 담은 주문입니다. 담은 단말기에서 취소해주세요.',
    status: row.status,
  })

  // 되돌릴 수 있는 상태(loaded)일 때만 담은 단말기를 따진다(그 밖은 아래 전이가 실패해 상태와 함께 409로 답한다).
  const waitMs = otherDeviceWaitMs(cart)
  if (checkDevice && waitMs !== null && (!force || waitMs > 0)) {
    return res.status(409).json(otherDeviceBody(cart, waitMs))
  }
  const forced = checkDevice && waitMs !== null
  // 담은 단말기 확인을 모르는 탭앱의 요청이라 확인 없이 되돌린다(위 주석). 다른 단말기가 담은 주문이었다면 이중 결제를 이 로그로 되짚는다.
  const uncheckedOtherDevice = !checkDevice && waitMs !== null

  // 읽은 담기 시도 그대로일 때만 되돌린다 -- 확인한 뒤 그 사이 다른 단말기가 되돌렸다가 다시 담은 주문을 건드리지 않는다.
  const outcome = await markErpCartUnloaded(cart.id, req.store.id, { consumeAttemptId: cart.consumeAttemptId ?? null })
  if (!outcome) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    const latestWaitMs = otherDeviceWaitMs(latest)
    if (latestWaitMs !== null) {
      // 그 사이 다른 단말기가 다시 담았다.
      return res.status(409).json(otherDeviceBody(latest, latestWaitMs))
    }
    return res.status(409).json({
      ok: false, error: '아직 결제되지 않은, POS에 담긴 주문만 되돌릴 수 있습니다.', status: latest?.status, payTarget: latest?.payTarget,
    })
  }
  if (forced) {
    // 담은 단말기에는 이 주문의 품목과 결제 대기 기록이 남아 있을 수 있다 -- 이중 결제가 나면 이 로그로 되짚는다.
    logger.warn('[pos] 다른 단말기에서 담은 주문을 직원이 확인하고 되돌림', {
      storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId, loadedAt: cart.loadedAt, outcome,
    })
  }
  if (uncheckedOtherDevice) {
    logger.warn('[pos] 담은 단말기 확인 없이 담기 취소(확인을 모르는 옛 탭앱)', {
      storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId, loadedAt: cart.loadedAt, outcome,
    })
  }
  if (outcome === 'dismissed') {
    logger.info('[pos] 담긴 채 24시간이 지난 주문을 되돌려 닫음(dismissed)', { storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId })
    return res.json({ ok: true, status: 'dismissed' })
  }
  logger.info('[pos] 담긴 주문을 담기 전으로 되돌림', { storeId: req.store.id, cartId: cart.id })
  return res.json({ ok: true, status: 'pending' })
}))

// 특정 손님을 호출한다. POS 탭앱 쪽에서 "이 번호를 탭하면 바로 호출"이 되지 않도록
// 반드시 명시적인 확인 동작(예: 2단계 확인 버튼) 뒤에만 이 엔드포인트를 호출해야 한다 —
// 서버는 그 UX를 강제할 수 없으므로 프론트(탭앱) 쪽 책임이다.
// 해당 매장 + 오늘 serviceDate의 예약만 대상으로 한다(계약 §3.14) — 아니면 404.
app.post('/api/pos/queue/:id/call', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const serviceDate = kstDateString()
  const reservation = await getReservation(req.params.id)
  if (!reservation || reservation.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  if (reservation.serviceDate !== serviceDate) {
    // 전날 넘어온 접수(대기열에 carriedOver로 보인다). [호출] 버튼을 그대로 보여주는 옛 탭앱에서 눌러도 무엇을 하면 되는지 알려준다.
    return res.status(404).json({ ok: false, error: '전날 접수한 건이라 호출할 수 없어요. [완료]나 [취소]로 정리해주세요.' })
  }
  if (reservation.status !== 'waiting') {
    if (['called', 'notify_failed'].includes(reservation.status)) {
      return res.json({ ok: true, id: reservation.id, status: reservation.status, alreadyProcessed: true })
    }
    return res.status(400).json({ ok: false, error: '대기 중인 손님만 호출할 수 있어요.' })
  }
  const outcome = await notifyQueueTurn(reservation)
  return res.json({ ok: true, id: reservation.id, status: reservation.status, alreadyProcessed: !outcome.changed })
}))

// 해당 매장만 확인한다(계약 v3 §4.3) — day-scope(오늘 serviceDate만)는 일부러 제거했다. 밤새 맡긴
// 차(어제 called 상태)를 다음날 POS에서 완료 처리할 수 있어야 하기 때문이다. 호출(call)은 여전히
// 오늘 것만 허용하므로(아래 call 라우트), 여기서 day-scope를 빼도 "어제 waiting을 오늘 실수로 새로
// 호출"하는 사고로는 이어지지 않는다.
// 대기(waiting)도 받는다(2026-10-23) -- 호출을 건너뛴 손님을 [호출]("고객님의 순서입니다" 발송) 없이 바로 정비완료로 끝낸다
// (store.markReservationCompleted allowWaiting). 전날 넘어온 waiting(carriedOver)도 여기서 정리한다.
// 본문 { notify: false }면 완료 문자("차량을 찾으러 와주세요") 없이 완료만 하고 notified:false를 준다 -- 어제 정비를 마치고 손님이 이미
// 차를 찾아간 접수를 다음 날 정리할 때 하루 늦은 문자가 가지 않게 한다. 그 밖(본문 없음 포함)은 예전처럼 보낸다.
// 이미 완료된 접수는 200 { ok, alreadyCompleted:true, status:'completed' }다(문자는 다시 보내지 않는다). 처음 읽은 뒤 다른 POS나
// 결제 뒤 자동 완료(completeReservationAfterPayment)가 먼저 완료해 바꾸기가 0건이 된 경우도 다시 읽어 같은 응답을 준다 -- 예전에는
// 처음 읽은 상태(called 등)만 보고 '취소된 접수라…' 409를 줘서, 정비가 끝난 손님을 직원이 취소된 줄 알았다.
app.post('/api/pos/queue/:id/complete', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing || existing.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  const skipNotify = req.body?.notify === false
  const reservation = await markReservationCompleted(req.params.id, { allowWaiting: true })
  if (!reservation) {
    const latest = existing.status === 'completed' ? existing : await getReservation(req.params.id)
    if (!latest) {
      return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
    }
    if (latest.status === 'completed') {
      return res.json({ ok: true, id: latest.id, status: 'completed', alreadyCompleted: true })
    }
    if (latest.status === 'cancelled') {
      return res.status(409).json({ ok: false, error: '취소된 접수라 정비완료로 바꿀 수 없어요.', status: 'cancelled' })
    }
    return res.status(409).json({ ok: false, error: '지금은 정비완료로 바꿀 수 없는 상태예요. 목록을 새로 불러와주세요.', status: latest.status })
  }
  if (skipNotify) {
    logger.info('[pos] 완료 문자 없이 정비완료로 정리', { storeId: req.store.id, reservationId: reservation.id, serviceDate: reservation.serviceDate })
    return res.json({ ok: true, id: reservation.id, status: reservation.status, notified: false })
  }
  const notified = await notifyRepairDone(reservation)
  return res.json({ ok: true, id: reservation.id, status: reservation.status, notified })
}))

// POS [알림 다시 보내기]. 호출 알림(고객님의 순서입니다)이 실패한(notify_failed) 접수만 다시 보낸다. 예전에는 관리자 웹에만 있어
// 매장 직원이 PC에서 로그인해야 했다.
// 두 POS가 동시에 눌러도 한 번만 나간다: notify_failed → called 원자적 전이(markReservationCalledFromNotifyFailed)가 잠금이다 --
// 이긴 요청 하나만 보내고, 진 요청은 409다. 보내기에 실패하면 notify_failed로 되돌린다(sendQueueTurnAndSync).
// 응답: { ok, status, notify: 'sent' | 'failed' | 'unknown', error? }
//   failed  확실히 안 나갔다(번호·발송사 탓) -- 다시 보내도 대개 같으니 직접 연락을 권한다.
//   unknown 결과를 모른다(시간 초과 등) -- 이미 갔을 수 있어 다시 보내기 전에 손님께 먼저 연락해보라고 안내한다. 상태는 notify_failed로
//           되돌려 둔다(502 { ok:false, notify:'unknown', status:'notify_failed' }) -- 탭앱이 다음 다시 보내기 전에 경고한다.
// 보내는 동안에는 상태가 called라 다른 POS의 다시 보내기는 409다(위 잠금). 되돌리기는 called일 때만 하므로(markReservationNotifyFailed),
// 그사이 다른 쪽이 정비완료·취소했으면 그 상태를 다시 읽어 준다.
// 오늘 접수분과 이월 건 모두 받는다(호출 알림을 다시 보내는 것이지 새로 호출하는 것이 아니다).
app.post('/api/pos/queue/:id/retry-notify', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing || existing.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  const notRetryable = (row) => res.status(409).json({
    ok: false,
    status: row?.status ?? null,
    error: row?.status === 'called'
      ? '호출 알림을 이미 보냈어요(다른 단말기에서 먼저 보냈을 수 있어요).'
      : '호출 알림 발송에 실패한 접수만 다시 보낼 수 있어요.',
  })
  if (existing.status !== 'notify_failed') return notRetryable(existing)
  const claimed = await markReservationCalledFromNotifyFailed(existing.id)
  if (!claimed) return notRetryable(await getReservation(existing.id))

  try {
    await solapi.sendQueueTurnAlimtalk({
      phone: claimed.phone,
      carNumber: claimed.carNumber,
      queueNumber: claimed.queueNumber,
      serviceType: claimed.serviceType,
      storeName: claimed.store?.name,
      storeId: claimed.storeId,
      reservationId: claimed.id,
    })
    logger.info('[pos] 호출 알림 다시 보내기 성공', { storeId: req.store.id, reservationId: claimed.id })
    return res.json({ ok: true, status: 'called', notify: 'sent' })
  } catch (notifyError) {
    const notify = solapi.classifySendFailure(notifyError) === 'unknown' ? 'unknown' : 'failed'
    logger.error('[pos] 호출 알림 다시 보내기 실패', {
      storeId: req.store.id, reservationId: claimed.id, notify, ...solapi.sendFailureLog(notifyError),
    })
    const failed = await markReservationNotifyFailed(claimed.id)
    const current = failed || await getReservation(claimed.id)
    return res.status(502).json({
      ok: false,
      status: current?.status || 'notify_failed',
      notify,
      error: notify === 'unknown'
        ? '알림이 나갔는지 확인하지 못했어요. 다시 보내기 전에 손님께 먼저 연락해 주세요.'
        : '호출 알림을 다시 보내지 못했어요. 손님께 직접 연락해 주세요.',
    })
  }
}))

// 노쇼 손님을 대기열에서 빼는 용도 (계약 §3.16 신규). complete와 동일하게(계약 v3 §4.3) 해당
// 매장만 확인하고 day-scope는 두지 않는다 — 이월(called/notify_failed) 건도 취소할 수 있어야 한다.
app.post('/api/pos/queue/:id/cancel', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const existing = await getReservation(req.params.id)
  if (!existing || existing.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  if (existing.status === 'cancelled') {
    return res.json({ ok: true, id: existing.id, status: 'cancelled', alreadyProcessed: true })
  }
  if (existing.status === 'completed') {
    return res.status(409).json({ ok: false, error: '이미 정비가 끝난 접수라 취소할 수 없어요.' })
  }
  const reservation = await markReservationCancelled(req.params.id)
  if (!reservation) {
    return res.status(409).json({ ok: false, error: '지금은 취소할 수 없는 접수예요.' })
  }
  return res.json({ ok: true, id: reservation.id, status: reservation.status })
}))

// --- 결제 (전자영수증 + 3개월 후 프로모션) ---
// paymentKey(토스프론트 sdk.payment.requestPayment 호출 시 발급한 값)를 함께 보내면
// 같은 결제건에 대해 클라이언트가 재시도해도 영수증이 중복 발송되지 않는다.
app.post('/api/payments', publicCors, paymentLimiter, paymentPhoneLimiter, requireStore, asyncHandler(async (req, res) => {
  const storeId = req.store.id
  const paymentKey = String(req.body?.paymentKey ?? '').trim()
  const phone = String(req.body?.phone ?? '').replace(/-/g, '').trim()
  const carNumberRaw = String(req.body?.carNumber ?? '').trim()
  const amountRaw = req.body?.amount

  // 실제로 결제가 있었는지 서버가 확인할 수 있는 유일한 값이다(토스 SDK가 결제 성공 후 발급).
  // 정상 흐름(front-plugin/payment.html)은 항상 이 값을 함께 보내므로 필수로 막아도 정상
  // 결제는 깨지지 않는다 — 없이 들어오는 요청은 "전화번호+동의만 알면 되는" 조회성 악용이다.
  if (!paymentKey) {
    return res.status(400).json({ ok: false, error: '결제 정보를 확인할 수 없어요. 직원에게 문의해주세요.' })
  }
  if (paymentKey.length > 200) {
    return res.status(400).json({ ok: false, error: '결제 정보를 확인할 수 없어요. 직원에게 문의해주세요.' })
  }
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ ok: false, error: '휴대폰 번호를 다시 확인해주세요. 예) 01012345678' })
  }
  if (carNumberRaw && !CAR_NUMBER_RE.test(carNumberRaw)) {
    return res.status(400).json({ ok: false, error: '차량번호를 다시 확인해주세요. 예) 12가3456' })
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
      // 진짜 결제 하나에는 전화번호가 하나뿐이어야 한다. 같은 paymentKey에 다른 전화번호가
      // 오는 건 재시도가 아니라, 그 결제 건을 근거로 남의 번호로 조회/수신을 시도하는
      // 경우이므로 막는다(계약과 무관하게 이번에 새로 추가하는 방어).
      if (existing.phone !== phone) {
        return res.status(409).json({ ok: false, error: '이 결제는 이미 다른 번호로 영수증이 신청되어 있어요. 직원에게 문의해주세요.' })
      }
      return res.json({ ok: true, id: existing.id })
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
      ...solapi.sendFailureLog(notifyError),
    })
    await markPaymentStatus(payment.id, 'receipt_failed')
    // 영수증 발송에 실패해도 결제/DB 적재 자체는 성공으로 처리한다
  }

  // 차량번호/정비항목은 응답에 싣지 않는다 — 이 라우트는 merchantId(공개값)+전화번호+동의만으로도
  // 호출되므로, 응답에 넣으면 남의 전화번호만 알아도 그 사람이 이 매장에 어떤 차를 맡겼는지
  // 알아낼 수 있다(실제 재현된 개인정보 유출). 문자(알림톡)에는 그대로 넣는다 — 그건 전화번호
  // 주인에게만 가므로 자기 차 번호를 보는 것과 같다.
  return res.json({ ok: true, id: payment.id })
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
    logger.error('전자영수증 재발송 실패', { paymentId: claimed.id, storeId: claimed.storeId, ...solapi.sendFailureLog(notifyError) })
    await markPaymentStatus(claimed.id, 'receipt_failed')
    return res.json({ ok: true, id: claimed.id, status: 'receipt_failed', sent: false })
  }
}))

// --- 가맹점(매장) 관리 (본사 관리자 전용) ---
// 토스플레이스 개발자센터에서 발급된 merchant.id를 우리 store 레코드와 매핑해 등록한다.
// 등록해야만 그 매장의 플러그인에서 온 예약/결제 요청이 통과된다 (requireStore 참고).
// 페이지네이션 + 검색(계약 §3.3과 동일 패턴). 400개 매장이면 이전처럼 한 번에 다 내려받고
// 매장마다 입력창 3개(사업자번호/전산코드/POS토큰)짜리 표를 한 번에 그리는 게 감당이 안 됐다.
// ⚠️ POS 토큰은 이 목록 응답에 절대 싣지 않는다 -- listStoresPage가 돌려주는 로우에는 posToken이
// 그대로 있지만(store.js가 어떤 필드를 뺄지는 책임지지 않는다, listErpCarts와 동일한 층 분리),
// 여기서 posToken을 꺼내 hasPosToken(boolean)으로만 바꿔 내보낸다. 관리자는 인증된 사용자지만
// 화면에 필요하지도 않은 400개 매장의 비밀값을 매번 평문으로 전부 내려줄 이유가 없다 -- 실제
// 값은 아래 GET .../pos-token(단건)에서 관리자가 "보기"를 누른 매장 하나만 받는다.
app.get('/api/admin/stores', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const q = req.query.q
  const limit = parseLimit(req.query.limit)
  const offset = parseOffset(req.query.offset)
  const { total, items } = await listStoresPage({ q, limit, offset })
  // weakPosToken: 지금 기준(12자 미만)으로는 직접 지정할 수 없는 짧은 토큰이 이미 들어가 있는 매장. 관리자 웹이 '약한 토큰' 배지를 붙여
  // 재발급을 권한다(값·길이 자체는 내보내지 않는다). 이미 발급된 토큰은 그대로 동작한다.
  const stores = items.map(({ posToken, ...rest }) => ({
    ...rest,
    hasPosToken: Boolean(posToken),
    weakPosToken: Boolean(posToken) && String(posToken).length < POS_TOKEN_MIN_LENGTH,
  }))
  return res.json({ ok: true, count: stores.length, total, hasMore: offset + stores.length < total, stores })
}))

app.post('/api/admin/stores', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const merchantId = String(req.body?.merchantId ?? '').trim()
  const name = String(req.body?.name ?? '').trim()

  if (!merchantId) {
    return res.status(400).json({ ok: false, error: '토스 가맹점 ID를 입력해주세요.' })
  }
  if (!name) {
    return res.status(400).json({ ok: false, error: '매장명이 필요합니다.' })
  }
  if (await findStoreByMerchantId(merchantId)) {
    return res.status(409).json({ ok: false, error: '이미 등록된 토스 가맹점 ID예요.' })
  }

  // 단건 등록은 사람이 직접 입력하는 경로라 수정 라우트(.../business-number)와 똑같이 즉시
  // 거부한다 -- bulkCreateStores(400건 일괄)와 달리 여기서 막아도 다른 매장 등록을 막지 않는다.
  const bnResult = normalizeBusinessNumber(req.body?.businessNumber)
  if (!bnResult.ok) {
    return res.status(400).json({ ok: false, error: bnResult.error })
  }

  // posToken은 createStore 내부에서 crypto.randomBytes(32)로 자동 생성된다(계약 §3.18).
  const store = await createStore({ merchantId, name, businessNumber: bnResult.value })
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
// 다만 이 토큰이 /api/pos/*·/api/front/* 의 유일한 인증 수단이므로 아래 제약을 서버가 강제한다 —
// 이걸 클라이언트 검증에만 맡기면 API를 직접 호출해 "1234" 같은 값을 넣을 수 있고, 그 순간
// 이번에 막은 무인증 취약점으로 그대로 되돌아간다.
//
// 최소 12자, 영문과 숫자를 섞어야 한다(2026-10-23, 예전 최소 4자). 예전 주석은 "인증 실패를 IP당 15분 10회로 막으니
// 4자라도 전수·사전 공격이 불가능하다"고 했는데 사실이 아니었다: 그 카운터는 틀린 시도의 응답 코드만 401에서 429로 바꿀 뿐
// 맞는 토큰은 차단된 IP에서도 통과하고(rejectPosAuthFailure 위 주석), 한 번의 추측이 400개 매장 토큰 전부와 비교된다.
// 짧고 뻔한 값("1234", 매장 약칭)은 흔한 후보 수백 개만 돌려도 맞는다. 12자 영문+숫자(예: gangnam01pos)는 손으로 입력할 수
// 있으면서 후보 사전에 잘 걸리지 않는 선이다. 이미 발급된 토큰(예전 기준으로 지정한 짧은 값 포함)은 그대로 동작한다 --
// 관리자 웹이 '약한 토큰' 배지로 재발급을 권한다(GET /api/admin/stores weakPosToken). 근본 대책은 개선 제안 B1(1회용 연결 코드).
const POS_TOKEN_MIN_LENGTH = 12
const POS_TOKEN_MAX_LENGTH = 128
const POS_TOKEN_RE = /^[A-Za-z0-9_-]+$/

function validatePosToken(raw) {
  const token = String(raw).trim()
  if (token.length < POS_TOKEN_MIN_LENGTH || token.length > POS_TOKEN_MAX_LENGTH) {
    return { error: `POS 토큰은 ${POS_TOKEN_MIN_LENGTH}자 이상 ${POS_TOKEN_MAX_LENGTH}자 이하로 정해주세요.` }
  }
  if (!POS_TOKEN_RE.test(token)) {
    return { error: 'POS 토큰은 영문/숫자/하이픈(-)/밑줄(_)만 쓸 수 있어요.' }
  }
  // 숫자만("123456789012")이거나 영문만인 값은 사전·연번 후보에 잘 걸린다.
  if (!/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) {
    return { error: 'POS 토큰에는 영문과 숫자를 함께 넣어주세요.' }
  }
  // "1111", "0000"처럼 한 글자만 반복하는 값은 후보군이 64개뿐이라 시도 제한이 있어도 위험하다(영문+숫자 규칙 뒤에도 남겨 둔다).
  if (new Set(token).size < 2) {
    return { error: 'POS 토큰이 너무 단순해요. 같은 문자만 반복할 수 없어요.' }
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

// POS 토큰 단건 조회 (본사 전용). GET /api/admin/stores 목록에는 이제 posToken이 실려 오지
// 않으므로, 관리자 화면에서 "보기"/"복사"를 눌렀을 때만 이 라우트로 그 매장 하나의 실제 값을
// 받아온다. requireRole('hq_admin')이라 store_admin은 애초에 이 라우트를 호출할 수 없다 --
// 자기 매장 토큰은 기존처럼 GET /api/admin/me의 store 안에 포함된 값으로 본다(그 라우트는
// role 제한이 없지만 "자기 매장"만 돌려주므로 안전하다).
app.get('/api/admin/stores/:id/pos-token', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  const store = await getStore(req.params.id)
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
// 사업자등록번호 자릿수와 정규화 로직은 store.js에 있다(등록 경로인 createStore/bulkCreateStores와
// 같은 기준을 써야 해서 -- 자세한 사연은 store.js의 normalizeBusinessNumber 주석 참고).
// 이미 등록된 매장의 사업자번호를 채우거나 고친다. 매장 등록 화면에서만 받고 있어서 기존
// 매장은 손댈 방법이 없었는데, 전산 자동 연결(resolveErpStore)이 이 값을 기준으로 동작하므로
// 뒤늦게라도 채울 통로가 필요하다.
// 전산 주문 이력 조회. 매장이 "보냈는데 POS에 안 떴어요" 할 때 본사가 어디서 끊겼는지
// 확인하는 통로다(접수는 됐는지, POS가 가져갔는지, 실패했는지).
// store_admin은 자기 매장만 본다 — 다른 매장의 차량번호·품목이 보이면 안 된다.
// limit/offset + total(hasMore 계산용)을 추가했다. 화면이 offset을 안 보내던 시절엔 최대 200건
// 까지만 보이고 그 이상은 확인할 방법이 없었다 -- pending/failed 건이 200건을 넘으면 오래된
// 문제 건이 조용히 화면에서 사라져 "이 매장엔 문제가 없다"고 오판하게 된다.
app.get('/api/admin/erp-carts', requireAuth, asyncHandler(async (req, res) => {
  const storeId = req.admin.role === 'hq_admin'
    ? (req.query.storeId ? String(req.query.storeId) : null)
    : req.admin.storeId
  const status = req.query.status ? String(req.query.status) : null
  const offset = parseOffset(req.query.offset)

  const { total, items: rows } = await listErpCarts({ storeId, status, limit: req.query.limit, offset })
  return res.json({
    ok: true,
    total,
    hasMore: offset + rows.length < total,
    carts: rows.map((r) => {
      let items = []
      try { items = JSON.parse(r.itemsJson) } catch { /* 손상된 건은 품목만 빈 배열로 */ }
      return {
        id: r.id,
        referenceId: r.referenceId,
        storeName: r.store?.name || null,
        erpStoreCode: r.store?.erpStoreCode || null,
        status: r.status,
        payTarget: r.payTarget,
        tossVerified: Boolean(r.tossVerifiedAt),
        refundedAt: r.refundedAt,
        refundNote: r.refundNote,
        totalAmount: r.totalAmount,
        memo: r.memo,
        carNumber: r.carNumber,
        linkedReservation: Boolean(r.reservationId),
        receiptStatus: r.receiptStatus || null,
        itemCount: items.length,
        errorMessage: r.errorMessage,
        // 프론트에서 승인됐지만 이 주문에 반영하지 못한 결제(PAID_AFTER_RELEASE) -- 대사가 필요하다.
        frontOrphan: frontOrphanOf(r),
        createdAt: r.createdAt,
        loadedAt: r.loadedAt,
        paidAt: r.paidAt,
      }
    }),
  })
}))

app.post('/api/admin/stores/:id/business-number', requireAuth, requireRole('hq_admin'), asyncHandler(async (req, res) => {
  // 표기(하이픈 유무)는 자유롭게 받되 숫자 10자리인지는 확인한다 -- 자릿수가 틀린 값이 들어가면
  // 자동 연결이 조용히 실패하고, 왜 안 되는지 찾기가 어렵다.
  const result = normalizeBusinessNumber(req.body?.businessNumber)
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error })
  }

  const store = await setStoreBusinessNumber(req.params.id, result.value)
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
      return res.status(400).json({ ok: false, error: '전산 코드는 1~64자의 영문·숫자·하이픈(-)·밑줄(_)만 쓸 수 있어요.' })
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

  // 토스 결제내역 매핑. 결제 ID가 있는 결제 웹훅은 전부 TossPayment에 남기고 전산 주문과 잇는다.
  // 전산 주문과 이어진 결제는 아래 Payment 백업 기록을 만들지 않는다 -- 그 테이블은 프론트 영수증
  // (동의 받은 손님) 흐름용이라, 전산 결제를 섞으면 영수증·프로모션 대상 판정이 흐려진다.
  // 문서상 payment.orderId는 토스 주문 ID라 우리 paymentKey와 같다는 아래(기존) 전제는 맞지 않을 수
  // 있다 -- 전산 주문은 승인번호+금액으로 잇는다(linkErpCartsToTossPayment).
  const isPaymentEvent = eventType === 'payment.payment.approved.v1' || eventType === 'payment.payment.cancelled.v1'
  // 아래 백업 기록을 만든 뒤 다시 잇기 위해 남겨 둔다(전산 주문과 잇지 못한 경우에만 쓰인다).
  let tossPaymentForLink = null
  if (isPaymentEvent && payment.id) {
    const mappedStore = await findStoreByMerchantId(merchantId)
    const tossPayment = await recordTossPayment({ ...payment, merchantId }, mappedStore?.id)
    tossPaymentForLink = tossPayment
    const carts = await linkErpCartsToTossPayment(tossPayment)
    if (carts.length) {
      // 늦게 재전송된 '승인' 웹훅이어도 이미 취소된 결제면(recordTossPayment가 CANCELLED를 지킨다) 이은 주문도 취소로 맞춘다.
      // 안 맞추면 취소된 결제에 이어진 주문이 paid로 남는다.
      if (eventType === 'payment.payment.cancelled.v1' || tossPayment.state === 'CANCELLED') {
        const refunded = await markErpCartsRefundedByToss(carts.map((c) => c.id))
        logger.info('[webhook] 전산 주문 결제 취소 확인', { webhookId, tossPaymentId: tossPayment.id, refunded })
      } else {
        logger.info('[webhook] 전산 주문과 토스 결제를 이었습니다', { webhookId, tossPaymentId: tossPayment.id, carts: carts.length })
      }
      // 앞선 웹훅이 못 이은 채 Payment 백업 기록을 만들어 뒀다면, 같은 돈이 전산 주문으로도 집계되니 집계에서 뺀다.
      await markBackupPaymentErpLinked(tossPayment)
      return
    }
    // 잇지 못했다. 전산과 무관한 일반 결제일 수도 있고, 프론트 보고가 아직 안 왔을 수도 있다(그러면
    // 보고 때 이어진다). 끝내 안 이어지면 이 로그로 승인번호·금액·결제수단을 최근 프론트 결제와 비교한다.
    if (mappedStore && eventType === 'payment.payment.approved.v1') {
      const recentFront = await prisma.erpCart.findMany({
        where: { storeId: mappedStore.id, payTarget: 'front', paidAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
        orderBy: { paidAt: 'desc' },
        take: 5,
        select: { id: true, frontApprovalNo: true, totalAmount: true, status: true, tossPaymentId: true, frontPaymentJson: true },
      })
      logger.info('[webhook] 결제 승인을 전산 주문과 잇지 못함', {
        webhookId,
        toss: { id: tossPayment.id, approvedNo: tossPayment.approvedNo, amount: tossPayment.amount, sourceType: tossPayment.sourceType, paymentMethod: payment.paymentMethod },
        recentFront: recentFront.map((c) => ({
          cartId: c.id, approvalNo: c.frontApprovalNo, amount: c.totalAmount, status: c.status, linked: Boolean(c.tossPaymentId),
          method: (() => { try { return JSON.parse(c.frontPaymentJson || '{}').paymentMethod || null } catch { return null } })(),
        })),
      })
    }
  }

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
    // 위에서 잇지 못한 뒤 백업 기록을 만들기 전, 그 사이에 POS 결제 통보(/paid)나 프론트 결과 보고(/result)가 같은 토스 결제를 주문과
    // 이었을 수 있다. 그쪽은 백업 기록이 아직 없어 erp_linked로 바꾸지 못했으므로, 백업을 만든 뒤 한 번 더 잇고 이어졌으면 여기서
    // 바꾼다(늦게 잇는 쪽이 바꾼다 -- 둘 중 하나는 반드시 백업 기록이 생긴 뒤에 확인한다). 안 하면 같은 돈이 Payment와 전산 주문
    // 양쪽에서 집계된다(getDailySummary).
    if (tossPaymentForLink) {
      const relinked = await linkErpCartsToTossPayment(tossPaymentForLink)
      if (relinked.length) {
        if (tossPaymentForLink.state === 'CANCELLED') await markErpCartsRefundedByToss(relinked.map((c) => c.id))
        const marked = await markBackupPaymentErpLinked(tossPaymentForLink)
        logger.info('[webhook] 백업 기록을 만든 사이 전산 주문과 이어져 집계에서 뺐습니다', { webhookId, tossPaymentId: tossPaymentForLink.id, marked })
      }
    }
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

  // 앞뒤 공백·줄바꿈을 지운다. Secret Manager에 값을 넣을 때 끝에 줄바꿈이 붙는 일이 흔한데
  // (echo로 만들면 붙는다), 그러면 개발자센터에 같은 값을 넣어도 서명이 절대 맞지 않는다 --
  // 실제로 운영에서 모든 웹훅이 "서명 검증 실패"(401)로 거절됐다. 비밀키 자체에 공백이 있을 일은 없다.
  const secret = (process.env.TOSS_WEBHOOK_SECRET || '').trim()
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
      // 고정 이벤트 코드로 알림을 건다(문구를 다듬어도 알림이 멈추지 않게) -- jsonPayload.event="webhook_signature_failed"
      logger.error('[webhook] 서명 검증 실패', { event: 'webhook_signature_failed', webhookId })
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
// 매장 단위 한도(erpLimiter)는 이 인증 **뒤에** 둔다(2026-10-23). storeCode(CHV-001 형식)는 비밀값이 아니어서, 앞에 두면 토큰이 없는
// 사람이 {storeCode:'CHV-001'}로 분당 한도만큼 보내기만 해도 그 매장의 진짜 전산 주문이 429를 받았다. IP 폭주 차단(erpIpFloodLimiter)만 앞에 둔다.
function requireErpToken(req, res, next) {
  const expected = process.env.ERP_API_TOKEN
  const supplied = req.get('x-erp-token') || ''
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'ERP 연동이 설정되지 않았습니다.' })
  }
  const expectedBuf = Buffer.from(expected)
  const suppliedBuf = Buffer.from(supplied)
  if (expectedBuf.length !== suppliedBuf.length || !crypto.timingSafeEqual(expectedBuf, suppliedBuf)) {
    // 전산 시뮬레이터·전산 화면 상태줄에 그대로 보인다(영문 'unauthorized' 대신).
    return res.status(401).json({ ok: false, error: 'ERP 토큰이 올바르지 않아요.' })
  }
  return next()
}

// 전산 쪽 시스템이 오작동해 짧은 시간에 대량 요청을 보내도 DB/토스 API를 보호할 수 있도록
// 매장 관리 라우트들과 동일한 DB 기반 레이트리밋을 쓴다. 다만 쉐보레 전산은 중계 서버 하나
// (IP 하나)를 통해 가맹점 400여 곳 요청이 전부 들어온다 -- 예전처럼 키 없이(=IP 기준) 세면
// 그 한도를 400개 매장이 통째로 나눠 쓰는 꼴이 되어, 한 매장이 같은 주문을 실수로 재시도만
// 해도 나머지 399개 매장은 [담기]를 눌러도 POS에 주문이 뜨지 않는다. posStoreRateKey와 같은
// 방식으로 매장 단위로 쪼갠다 -- 다만 여기는 인증 전 토큰이 아니라 요청 바디의 storeCode를
// 키로 쓴다(express.json 미들웨어가 이 라우트들보다 앞서 app.use로 등록돼 있어 keyGenerator에서도
// req.body를 읽을 수 있다). storeCode가 없는 라우트(재조회 GET, 취소 POST)는 referenceId로 쪼갠다(아래).
// 인증(requireErpToken) 뒤에 돌므로, 토큰이 맞는 요청만 이 카운터를 쓴다.
const DEFAULT_ERP_STORE_LIMIT_PER_MIN = 120
const configuredErpStoreLimit = Number(process.env.ERP_STORE_LIMIT_PER_MIN)
const ERP_STORE_LIMIT_PER_MIN = Number.isFinite(configuredErpStoreLimit) && configuredErpStoreLimit > 0
  ? configuredErpStoreLimit
  : DEFAULT_ERP_STORE_LIMIT_PER_MIN

function erpStoreRateKey(req) {
  const storeCode = String(req.body?.storeCode ?? '').trim()
  // POS 쪽(store:/ip:) 관례를 그대로 따른다 -- 매장 키와 폴백 키가 같은 카운터에서 섞이지
  // 않게 접두사를 붙인다. storeCode는 토큰과 달리 비밀값이 아니므로 해시하지 않고, 길이만
  // 방어적으로 잘라 스토리지 키가 과도하게 커지는 것만 막는다.
  if (storeCode) return `store:${storeCode.slice(0, 200)}`

  // 바디에 storeCode가 없는 라우트(재조회 GET, 취소 POST)는 referenceId로 쪼갠다.
  // 여기서 IP로 폴백하면 400개 매장이 다시 바구니 하나를 나눠 쓰게 되어, 지금 고치는 바로 그
  // 버그가 이 라우트들에만 그대로 남는다 -- 전산이 주문 처리 상태를 폴링하는 순간(그러라고
  // 만든 라우트다) 분당 한도를 바로 넘긴다.
  // referenceId 단위로 나누면 매장끼리 간섭하지 않으면서, 재시도 폭주는 그대로 걸린다 --
  // 폭주는 대개 같은 referenceId를 반복해서 두드리기 때문이다.
  const referenceId = String(req.params?.referenceId ?? '').trim()
  if (referenceId) return `ref:${referenceId.slice(0, 200)}`

  return `ip:${rateLimit.ipKeyGenerator(req.ip)}`
}

const erpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: ERP_STORE_LIMIT_PER_MIN,
  keyGenerator: erpStoreRateKey,
  store: new PostgresRateLimitStore(prisma, { prefix: 'erp', windowMs: 60 * 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
})

// storeCode(또는 referenceId)를 계속 바꿔가며 두드리면 위 한도는 새 키가 계속 생겨 우회된다.
// posIpFloodLimiter와 같은 목적의 백스톱을 여기도 둔다.
//
// 값을 정하는 기준: 매장별 한도(120)는 "한 매장이 넘어서면 안 되는 천장"이지 "예상 유량"이
// 아니다. 400 * 120 = 48000 같은 식으로 잡으면 초당 800건이 되어 백스톱이 아무것도 못 막는다
// -- 그러면 우회 경로가 그대로 열려 있는 것과 같다.
// 실제 유량으로 잡는다:
//   정상       하루 8,000건을 영업 10시간에 = 분당 약 13건
//   비관적 피크 몰림 + 전산의 상태 폴링까지 겹쳐도 분당 500건 안쪽
//   백스톱     그 6배인 분당 3,000건(초당 50건)
// 버그로 인한 재시도 폭주는 초당 수백 건이라 몇 초 만에 여기 걸린다. 반대로 이 한도가 걸리면
// 400개 매장이 한꺼번에 막히므로, 오탐이 나지 않게 넉넉히 잡되 폭주는 확실히 끊는 값이다.
// 메모리 기준이라 DB를 전혀 건드리지 않는다.
const DEFAULT_ERP_IP_LIMIT_PER_MIN = 3000
const configuredErpIpLimit = Number(process.env.ERP_IP_LIMIT_PER_MIN)
const ERP_IP_LIMIT_PER_MIN = Number.isFinite(configuredErpIpLimit) && configuredErpIpLimit > 0
  ? configuredErpIpLimit
  : DEFAULT_ERP_IP_LIMIT_PER_MIN

const erpIpFloodLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: ERP_IP_LIMIT_PER_MIN,
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

app.post('/api/erp/draft-orders', erpIpFloodLimiter, requireErpToken, erpLimiter, asyncHandler(async (req, res) => {
  const parsed = validateDraftOrderBody(req.body)
  if (parsed.error) {
    return res.status(400).json({ ok: false, error: parsed.error })
  }
  const { storeCode, referenceId, items, totalAmount, memo } = parsed

  const store = await findStoreByErpCode(storeCode)
  if (!store) {
    return res.status(404).json({ ok: false, error: '등록되지 않은 전산 코드예요.' })
  }
  if (store.status !== 'active') {
    return res.status(403).json({ ok: false, error: '이용이 중지된 매장이에요. 본사에 문의해주세요.' })
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
app.get('/api/erp/draft-orders/:referenceId', erpIpFloodLimiter, requireErpToken, erpLimiter, asyncHandler(async (req, res) => {
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

// 매장이 POS에서 보는 오늘 현황. 관리자 웹에 들어가지 않고도 "오늘 몇 대 봤나"를 확인한다.
// 폴링(대기열)과 달리 화면을 열 때만 부르므로 부하가 없다.
app.get('/api/pos/summary', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const serviceDate = kstDateString()
  const { start, end } = kstDateRangeUtc(serviceDate)
  const summary = await getPosDailySummary(req.store.id, serviceDate, start, end)
  return res.json({ ok: true, serviceDate, ...summary })
}))

// ── 수동 홍보 발송의 차단 조건 ────────────────────────────────────────────────
//
// 광고성 정보 전송은 정보통신망법 제50조의 규제를 받는다. 자동 발송(결제 3개월 뒤)은 조건이
// 코드에 고정돼 있어 안전하지만, 직원이 버튼으로 보내는 건 다르다 — 반복해서 누를 수 있고,
// 동의 여부를 화면에서만 막으면 요청을 직접 만들어 우회할 수 있다. 그래서 **서버에서** 막는다.
//
// 1) 수신 동의 없으면 발송 불가. 가장 최근 방문에서 동의하지 않았다면 그게 지금의 의사다.
// 2) 야간(21시~08시) 발송 금지. 야간 광고는 별도의 동의가 필요한데 우리는 그 동의를 받지 않는다.
// 3) 같은 번호·같은 차에 30일 안에 다시 보낼 수 없다. 스팸이 되면 수신거부와 과태료로 돌아온다.
//    번호 기준은 자동 발송·기간 지정 발송과 공유한다(store.assessPromoPhones).
// 4) 수신거부를 등록한 번호, 동의한 지 2년이 지난 번호에는 보내지 않는다.
const PROMO_NIGHT_START_HOUR = 21 // 이 시각부터
const PROMO_NIGHT_END_HOUR = 8 //   이 시각 전까지 금지

function kstHour(now) {
  // 서버는 UTC로 돌지만 야간 규제는 한국 시각 기준이다.
  return new Date((now || Date.now()) + 9 * 60 * 60 * 1000).getUTCHours()
}

// 판단 결과(store.assessPromoPhones의 status)를 직원에게 보여줄 문구로.
const PROMO_BLOCK_MESSAGES = {
  opted_out: '광고 수신을 거부한 손님입니다. 보낼 수 없습니다.',
  staff_excluded: '홍보 문자 목록에서 삭제한 번호입니다. 보낼 수 없습니다.',
  no_consent: '광고 수신에 동의하지 않은 손님입니다. 보낼 수 없습니다.',
  consent_expired: `광고 수신 동의를 받은 지 ${Math.round(PROMO_CONSENT_MAX_AGE_DAYS / 365)}년이 지났습니다. 다시 동의를 받아야 보낼 수 있습니다.`,
}

// 발송 실패 분류(solapi.classifySendFailure) -> PromoSend.status. 수동·기간·자동 발송이 같은 기준으로 남긴다.
// failed(수신자 탓)·failed_provider(발송사 계정·설정 탓)는 확실히 안 나감 -- 30일 제한에 넣지 않는다(store.PROMO_NOT_SENT_STATUSES).
// unknown은 나갔을 수 있어 30일 제한에 넣는다. 자동 홍보의 "같은 번호 실패 횟수"는 failed만 센다(store.countRecentAutoPromoFailures).
const PROMO_SEND_FAILURE_STATUS = { recipient: 'failed', provider: 'failed_provider', unknown: 'unknown' }
// 발송사 계정·설정 탓 실패의 안내. 매장에서 다시 보내도 똑같이 실패하므로 본사 확인을 요청한다(기간 발송은 멈춘다).
const PROMO_PROVIDER_STOP_MESSAGE = '문자 발송 계정(잔액·발신번호·템플릿) 문제로 멈췄습니다. 본사 확인이 필요합니다.'
const PROMO_PROVIDER_FAILED_MESSAGE = '문자 발송 계정(잔액·발신번호·템플릿) 문제로 보내지 못했습니다. 본사 확인이 필요합니다.'

function recentlySentMessage(lastSentAt) {
  const days = (Date.now() - new Date(lastSentAt).getTime()) / (24 * 60 * 60 * 1000)
  return `${Math.max(1, Math.ceil(PROMO_MIN_INTERVAL_DAYS - days))}일 뒤에 다시 보낼 수 있습니다.`
}

// 보낼 수 있으면 { ok: true, phone }, 아니면 { ok: false, reason, message }.
async function evaluatePromoEligibility(storeId, carNumber) {
  const contact = await findMarketingContactByCarNumber(storeId, carNumber)
  if (!contact) {
    return { ok: false, reason: 'no_record', message: '이 차량의 방문 기록이 없습니다.' }
  }
  if (!contact.phone) {
    return { ok: false, reason: 'no_phone', message: '연락처가 없어 보낼 수 없습니다.' }
  }
  if (!contact.marketingConsentAt) {
    return { ok: false, reason: 'no_consent', message: PROMO_BLOCK_MESSAGES.no_consent }
  }

  // 차의 최근 연락처로 찾은 번호를 번호 기준으로 다시 본다(수신거부·그 번호의 최근 의사·2년·30일).
  const assessed = (await assessPromoPhones(storeId, [contact.phone])).get(contact.phone)
  if (PROMO_BLOCK_MESSAGES[assessed.status]) {
    return { ok: false, reason: assessed.status, message: PROMO_BLOCK_MESSAGES[assessed.status] }
  }

  const hour = kstHour()
  if (hour >= PROMO_NIGHT_START_HOUR || hour < PROMO_NIGHT_END_HOUR) {
    return {
      ok: false,
      reason: 'night',
      message: `야간(${PROMO_NIGHT_START_HOUR}시~${PROMO_NIGHT_END_HOUR}시)에는 광고를 보낼 수 없습니다.`,
    }
  }

  // 30일: 번호 기준(다른 경로 발송 포함)과 차량 기준(번호가 바뀐 같은 차) 중 더 최근 것.
  // 시연 모드인 매장은 기간이 0이라 이 확인을 건너뛴다.
  const intervalDays = await getPromoIntervalDays(storeId)
  const lastCar = intervalDays > 0 ? await findLastPromoSend(storeId, carNumber) : null
  const candidates = [assessed.lastSentAt, lastCar?.sentAt].filter(Boolean).map((d) => new Date(d))
  const lastSentAt = candidates.length ? new Date(Math.max(...candidates)) : null
  if (lastSentAt && Date.now() - lastSentAt.getTime() < intervalDays * 24 * 60 * 60 * 1000) {
    return { ok: false, reason: 'recently_sent', message: recentlySentMessage(lastSentAt), lastSentAt }
  }
  return { ok: true, phone: contact.phone, lastSentAt }
}

// 이 차에 지금 홍보를 보낼 수 있는지 알려준다. 화면에서 버튼을 켤지 끌지 판단하는 데 쓴다
// (실제 차단은 발송 라우트가 다시 확인한다 — 화면만 믿으면 안 된다).
app.get('/api/pos/promo/eligibility', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const carNumber = String(req.query.carNumber || '').trim()
  if (!carNumber) {
    return res.status(400).json({ ok: false, error: '차량번호를 입력해주세요.' })
  }
  const result = await evaluatePromoEligibility(req.store.id, carNumber)
  return res.json({
    ok: true,
    canSend: result.ok === true,
    reason: result.reason || null,
    message: result.message || null,
    lastSentAt: result.lastSentAt || null,
  })
}))

// 직원이 [홍보 보내기]를 눌렀을 때. 위 조건을 **여기서 다시** 확인한다.
app.post('/api/pos/promo/send', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const carNumber = String(req.body?.carNumber || '').trim()
  if (!carNumber) {
    return res.status(400).json({ ok: false, error: '차량번호를 입력해주세요.' })
  }

  const eligible = await evaluatePromoEligibility(req.store.id, carNumber)
  if (!eligible.ok) {
    // 403으로 돌려준다 — 잘못된 요청이 아니라 "보내면 안 되는 상대"다.
    return res.status(403).json({ ok: false, error: eligible.message, reason: eligible.reason })
  }

  // 발송 기록을 **먼저** 남긴다(store.claimPromoSend -- 번호 단위 잠금 안에서 다시 확인하고 기록).
  // 발송이 성공했는데 기록이 실패하면 30일 제한이 풀려서 같은 손님에게 계속 보낼 수 있게 된다.
  const claim = await claimPromoSend({
    storeId: req.store.id,
    carNumber,
    phone: eligible.phone,
    sentBy: null, // POS 탭앱은 매장 단위 인증이라 개인을 특정할 수 없다
    via: 'manual',
  })
  if (!claim.ok) {
    const message = PROMO_BLOCK_MESSAGES[claim.status] || recentlySentMessage(claim.lastSentAt || new Date())
    return res.status(403).json({ ok: false, error: message, reason: claim.status })
  }

  try {
    await solapi.sendPromoAlimtalk({
      phone: eligible.phone,
      carNumber,
      storeName: req.store.name,
      storeId: req.store.id,
      paymentId: null,
    })
  } catch (e) {
    // recipient(이 번호 탓) | provider(발송사 계정·설정 탓 -- 잔액·발신번호·템플릿·키·요청 한도) | unknown(결과 모름)
    const failure = solapi.classifySendFailure(e)
    await finishPromoSend(claim.record.id, PROMO_SEND_FAILURE_STATUS[failure])
    logger.error('[promo] 수동 발송 실패', { storeId: req.store.id, failure, definite: failure !== 'unknown', ...solapi.sendFailureLog(e) })
    const failureBody = {
      recipient: { reason: 'send_failed', error: '발송에 실패했습니다. 잠시 후 다시 시도해주세요.' },
      // 다시 눌러도 똑같이 실패한다 -- 직원이 할 수 있는 일이 없으니 본사 확인으로 안내한다.
      provider: { reason: 'send_failed_provider', error: PROMO_PROVIDER_FAILED_MESSAGE },
      unknown: { reason: 'send_unknown', error: `발송 결과를 확인하지 못했습니다. 이미 나갔을 수 있어 ${PROMO_MIN_INTERVAL_DAYS}일 동안 다시 보내지 않습니다.` },
    }[failure]
    return res.status(502).json({ ok: false, ...failureBody })
  }
  await finishPromoSend(claim.record.id, 'sent')
  return res.json({ ok: true })
}))

// ── 광고 수신거부 등록 ──────────────────────────────────────────────────────────
//
// 홍보 문자 끝의 수신거부 안내를 보고 손님이 매장에 거부를 알려오면 직원이 여기서 등록한다. 등록된
// 번호에는 자동·수동·기간 지정 어떤 광고도 나가지 않는다(store.assessPromoPhones). 거부는 직원이 풀 수
// 없다 -- 손님이 다시 방문해 광고 수신에 새로 동의하면 그 동의가 거부보다 나중이라 다시 받게 된다.
function parseOptOutPhone(raw) {
  const phone = String(raw ?? '').replace(/\D/g, '')
  return PHONE_RE.test(phone) ? phone : null
}

app.post('/api/pos/promo/opt-out', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const phone = parseOptOutPhone(req.body?.phone)
  if (!phone) return res.status(400).json({ ok: false, error: '전화번호를 01012345678 형식으로 입력해주세요.' })
  const row = await registerMarketingOptOut({ storeId: req.store.id, phone, recordedBy: null, via: 'pos' })
  logger.info('[promo] 수신거부 등록', { storeId: req.store.id, via: 'pos' })
  return res.json({ ok: true, phoneMasked: maskPhone(phone), optedOutAt: row.optedOutAt })
}))

// 홍보 문자 목록에서 번호 삭제(탭앱). 리허설·테스트 번호를 치우거나 홍보를 보내지 않기로 한 번호용이다.
// 지운 번호는 목록에서 사라지고 차량별·자동 발송에서도 막힌다. 손님의 수신거부와는 따로 기록한다.
app.post('/api/pos/promo/exclude', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const phone = parseOptOutPhone(req.body?.phone)
  if (!phone) return res.status(400).json({ ok: false, error: '전화번호가 올바르지 않습니다.' })
  await registerPromoExclusion(req.store.id, phone)
  logger.info('[promo] 홍보 목록에서 번호 삭제', { storeId: req.store.id })
  return res.json({ ok: true })
}))

app.post('/api/admin/promo-opt-out', requireAuth, asyncHandler(async (req, res) => {
  const storeId = req.admin.role === 'store_admin' ? req.admin.storeId : String(req.body?.storeId || '').trim()
  if (!storeId) return res.status(400).json({ ok: false, error: '매장을 선택해주세요.' })
  const store = await prisma.store.findUnique({ where: { id: storeId } })
  if (!store) return res.status(404).json({ ok: false, error: '매장을 찾을 수 없습니다.' })
  const phone = parseOptOutPhone(req.body?.phone)
  if (!phone) return res.status(400).json({ ok: false, error: '전화번호를 01012345678 형식으로 입력해주세요.' })
  const row = await registerMarketingOptOut({ storeId, phone, recordedBy: req.admin.id, via: 'admin' })
  logger.info('[promo] 수신거부 등록', { storeId, via: 'admin', adminId: req.admin.id })
  return res.json({ ok: true, storeName: store.name, phoneMasked: maskPhone(phone), optedOutAt: row.optedOutAt })
}))

// ── 홍보 문자 시연 모드 ─────────────────────────────────────────────────────────
//
// 시연할 때 같은 번호로 여러 번 보내 보려고 "30일 내 재발송 금지"만 잠깐 끈다. 켜면 그날 자정(KST)까지로
// 잡혀 저절로 꺼진다 -- 탭앱은 매장 직원 누구나 만질 수 있어서, 켜 둔 채 잊으면 실제 손님에게 광고가 거듭
// 나갈 수 있기 때문이다. 수신 동의·수신거부·야간 금지는 시연 모드에서도 그대로다.
function promoDemoBody(store) {
  return { ok: true, demoMode: isPromoDemoActive(store), demoUntil: isPromoDemoActive(store) ? store.promoDemoUntil : null }
}

async function togglePromoDemo(storeId, enabled, actor) {
  const until = enabled ? kstDateRangeUtc(kstDateString()).end : null
  const store = await setPromoDemoUntil(storeId, until)
  logger.info('[promo] 시연 모드', { storeId, enabled: Boolean(enabled), until, ...actor })
  return store
}

app.get('/api/pos/promo/demo-mode', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.store.id }, select: { promoDemoUntil: true } })
  return res.json(promoDemoBody(store))
}))

app.post('/api/pos/promo/demo-mode', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  // 실매장 운영: 30일 재발송 제한을 푸는 건 본사만 한다(관리자 웹). 매장 단말기에서는 끄기만 된다.
  if (req.body.enabled) return res.status(403).json({ ok: false, error: '시연 모드는 본사 관리자 웹에서만 켤 수 있습니다.' })
  const store = await togglePromoDemo(req.store.id, req.body.enabled, { via: 'pos' })
  return res.json(promoDemoBody(store))
}))

app.post('/api/admin/promo-demo-mode', requireAuth, asyncHandler(async (req, res) => {
  const storeId = req.admin.role === 'store_admin' ? req.admin.storeId : String(req.body?.storeId || '').trim()
  if (!storeId) return res.status(400).json({ ok: false, error: '매장을 선택해주세요.' })
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  if (req.body.enabled && req.admin.role === 'store_admin') {
    return res.status(403).json({ ok: false, error: '시연 모드는 본사 관리자만 켤 수 있습니다.' })
  }
  const exists = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } })
  if (!exists) return res.status(404).json({ ok: false, error: '매장을 찾을 수 없습니다.' })
  const store = await togglePromoDemo(storeId, req.body.enabled, { via: 'admin', adminId: req.admin.id })
  return res.json(promoDemoBody(store))
}))

// ── 기간 지정 홍보 문자 (관리자 웹) ──────────────────────────────────────────────
//
// "○월 ○일 ~ ○월 ○일에 방문한 손님"에게 홍보 문자를 한 번에 보낸다. 광고라서 수동 발송(위)과
// 같은 차단 조건을 그대로 서버에서 건다: 수신 동의자만, 야간 금지, 같은 번호 30일 내 재발송 금지.
// 문구는 기존 홍보 템플릿(solapi.sendPromoAlimtalk -- "(광고)" + 수신거부 문구 포함)을 쓴다.
// 알림톡은 사전 승인된 템플릿만 보낼 수 있어 자유 문구는 받지 않는다.
//
// 누가 보냈는지 남아야 하는 대량 광고라 로그인한 관리자만 쓴다(PromoSend.sentBy = 관리자 id).
// store_admin은 자기 매장으로 고정되고, hq_admin은 매장을 반드시 지정해야 한다(전 매장 일괄 발송 없음).
const PROMO_CAMPAIGN_MAX_DAYS = 366
const PROMO_CAMPAIGN_BATCH_MAX = 200 // 요청 한 번에 보내는 최대 건수(남으면 화면이 이어서 다시 부른다)
const PROMO_CAMPAIGN_TIME_BUDGET_MS = 40 * 1000
const PROMO_CAMPAIGN_CONCURRENCY = 5
const POS_PROMO_CAMPAIGN_LIMITS = { batchMax: 60, timeBudgetMs: 8 * 1000 }
// 묶음 하나는 문자 회사 응답을 기다리느라 최대 SOLAPI_TIMEOUT_MS(기본 10초)쯤 걸린다. 21시 직전에 시작한
// 묶음이 21시를 넘겨 나가지 않도록, 이만큼 여유를 두고 새 묶음을 시작하지 않는다.
const PROMO_NIGHT_MARGIN_MS = 60 * 1000
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
// 같은 매장에 같은 인스턴스에서 발송 요청이 겹치면 바로 돌려보낸다(화면을 두 번 누른 경우 등).
// 여러 인스턴스 사이의 중복 발송은 이걸로 막지 못한다 -- 그건 번호 단위 잠금(store.claimPromoSend)이 막는다.
const promoCampaignBusy = new Set()

// 관리자 웹: store_admin은 자기 매장으로 고정, hq_admin은 매장 필수.
async function resolvePromoCampaignTarget(req, source) {
  const storeId = req.admin.role === 'store_admin'
    ? req.admin.storeId
    : String(source?.storeId || '').trim()
  if (!storeId) return { error: { status: 400, body: { ok: false, error: '매장을 선택해주세요.' } } }
  const store = await prisma.store.findUnique({ where: { id: storeId } })
  if (!store) return { error: { status: 404, body: { ok: false, error: '매장을 찾을 수 없습니다.' } } }
  const period = resolvePromoCampaignPeriod(source)
  if (period.error) return period
  return { store, ...period }
}

// 기간 검증(관리자 웹·POS 탭앱 공통). 반환: { from, to, start, end } | { error }
function resolvePromoCampaignPeriod(source) {
  const from = String(source?.from || '').trim()
  const to = String(source?.to || '').trim()
  if (!DATE_ONLY_RE.test(from) || !DATE_ONLY_RE.test(to)) {
    return { error: { status: 400, body: { ok: false, error: '기간을 YYYY-MM-DD 형식으로 입력해주세요.' } } }
  }
  if (from > to) return { error: { status: 400, body: { ok: false, error: '시작일이 종료일보다 늦습니다.' } } }
  if (to > kstDateString()) return { error: { status: 400, body: { ok: false, error: '종료일은 오늘까지만 고를 수 있어요.' } } }
  const start = kstDateRangeUtc(from).start
  const end = kstDateRangeUtc(to).end
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: { status: 400, body: { ok: false, error: '날짜가 올바르지 않습니다.' } } }
  }
  if ((end - start) / (24 * 60 * 60 * 1000) > PROMO_CAMPAIGN_MAX_DAYS) {
    return { error: { status: 400, body: { ok: false, error: `기간은 최대 ${PROMO_CAMPAIGN_MAX_DAYS}일까지 지정할 수 있습니다.` } } }
  }
  return { from, to, start, end }
}

// 지금 야간이거나, 여유(PROMO_NIGHT_MARGIN_MS) 안에 야간이 시작되면 true. 아침 8시 경계는 지금 시각만 본다.
function isPromoNightNow() {
  const now = Date.now()
  const night = (at) => {
    const hour = kstHour(at)
    return hour >= PROMO_NIGHT_START_HOUR || hour < PROMO_NIGHT_END_HOUR
  }
  return night(now) || night(now + PROMO_NIGHT_MARGIN_MS)
}

// 대상 미리보기 응답(관리자 웹·POS 탭앱 공통). sample은 전화번호를 가린다.
//
// rows: 기간 안 방문자 **전체**를 상태(status)와 함께 filter·offset·limit로 쪼갠 한 쪽. sample(보낼 수 있는
// 50명, 가린 번호)은 관리자 웹이 쓰고 있어 그대로 두고, 이쪽은 직원이 "누가 왜 빠졌는지"를 보고 손님께 연락할
// 수 있도록 전체 번호(010-1234-5678)를 준다. 두 라우트 모두 로그인한 관리자·매장 토큰으로만 열린다.
// filterCounts는 filter와 무관하게 항상 전체 기준이다(탭 숫자용). rowsTotal은 filter를 건 뒤의 수.
// 쿼리스트링이 그대로 들어오므로 여기서 값을 바로잡는다: 알 수 없는 filter는 all, limit은 1~500(숫자가
// 아니면 100), offset은 0 이상의 정수(아니면 0). 한 번에 다 내려주지 않는 이유는 방문자가 최대
// PROMO_CAMPAIGN_MAX_VISITORS(5000)명이라 응답이 수 MB가 되고 POS 탭앱이 느린 망에서 응답을 포기하기 때문이다.
// message: 문자로 나갈 때의 본문(알림톡으로 나가면 카카오에 승인된 템플릿 문구가 쓰인다).
// optOutConfigured: 수신거부 안내 문구(PROMO_OPT_OUT_TEXT)를 운영에서 정했는지. 기본 문구("매장으로 연락")는
// 손님에게 비용이 드는 방법이라, 080 무료수신거부처럼 무료 수단으로 바꾸라고 화면에서 알린다.
const PROMO_PREVIEW_FILTERS = ['all', 'eligible', 'excluded']
const PROMO_PREVIEW_DEFAULT_LIMIT = 100
const PROMO_PREVIEW_MAX_LIMIT = 500

function normalizePromoPreviewPaging({ filter, offset, limit } = {}) {
  const toNumber = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v))
  const limitNum = toNumber(limit)
  const offsetNum = toNumber(offset)
  return {
    filter: PROMO_PREVIEW_FILTERS.includes(filter) ? filter : 'all',
    limit: Number.isFinite(limitNum)
      ? Math.min(PROMO_PREVIEW_MAX_LIMIT, Math.max(1, Math.trunc(limitNum)))
      : PROMO_PREVIEW_DEFAULT_LIMIT,
    offset: Number.isSafeInteger(offsetNum) && offsetNum >= 0 ? offsetNum : 0,
  }
}

async function buildPromoCampaignPreview(target, { filter = 'all', offset = 0, limit = PROMO_PREVIEW_DEFAULT_LIMIT } = {}) {
  const paging = normalizePromoPreviewPaging({ filter, offset, limit })
  const [result, demo] = await Promise.all([
    listPromoCampaignCandidates(target.store.id, target.start, target.end),
    prisma.store.findUnique({ where: { id: target.store.id }, select: { promoDemoUntil: true } }),
  ])
  const { demoMode, demoUntil } = promoDemoBody(demo)
  // 방금(30분 안) 확실히 실패한 번호는 발송이 건너뛰므로(skipRecentFailures) "보낼 수 있음"에 세지 않는다.
  // 세면 [N명에게 보내기]가 남아 눌러도 0건이 나간다. 목록에는 recentFailure로 표시한다.
  const isEligible = (r) => r.status === 'ok' && !r.recentFailure
  const eligibleCount = result.all.filter(isEligible).length
  const eligiblePhones = new Set(result.all.filter(isEligible).map((r) => r.phone))
  const matched = paging.filter === 'eligible'
    ? result.all.filter(isEligible)
    : paging.filter === 'excluded'
      ? result.all.filter((r) => !isEligible(r))
      : result.all
  const pageRows = matched.slice(paging.offset, paging.offset + paging.limit)
  return {
    demoMode,
    demoUntil,
    ok: true,
    storeName: target.store.name,
    from: target.from,
    to: target.to,
    visitors: result.visitors,
    eligible: eligibleCount,
    excluded: result.excluded,
    truncated: result.truncated,
    night: isPromoNightNow(),
    // 기간 발송은 시연 모드여도 30일 제한을 건다(store.assessPromoPhones ignoreDemo).
    minIntervalDays: PROMO_MIN_INTERVAL_DAYS,
    message: solapi.buildPromoText(target.store.name),
    optOutConfigured: Boolean(process.env.PROMO_OPT_OUT_TEXT),
    sample: result.recipients.filter((r) => eligiblePhones.has(r.phone)).slice(0, 50).map((r) => ({
      phoneMasked: maskPhone(r.phone),
      carNumber: r.carNumber,
      lastVisitAt: r.lastVisitAt,
    })),
    filterCounts: { all: result.all.length, eligible: eligibleCount, excluded: result.all.length - eligibleCount },
    rows: pageRows.map((r) => ({
      phone: formatPhone(r.phone),
      carNumber: r.carNumber,
      lastVisitAt: r.lastVisitAt,
      status: r.status,
      lastSentAt: r.lastSentAt,
      recentFailure: Boolean(r.recentFailure),
    })),
    rowsTotal: matched.length,
    hasMore: paging.offset + pageRows.length < matched.length,
  }
}

// 발송(관리자 웹·POS 탭앱 공통). 반환: { status, body }.
// 대상은 **여기서 다시** 계산한다(미리보기를 믿지 않는다). 한 번에 최대 PROMO_CAMPAIGN_BATCH_MAX건,
// 남은 건은 remaining으로 알려주고 화면이 다시 부른다 -- 이미 보낸 번호는 30일 제한에 걸려 자연히
// 빠지고, 방금 확실히 실패한 번호도 잠시 빠지므로 다시 불러도 같은 번호를 두 번 시도하지 않는다.
// confirmCount: 화면이 본 대상 수에서 이미 처리한 수를 뺀 값. 지금 대상이 그보다 많으면(새 방문 등)
// 보내지 않고 다시 확인하게 한다 -- 화면에서 본 것보다 많이 보내지 않기 위해서다.
// sentBy: 관리자 웹은 관리자 id, POS 탭앱은 매장 단위 인증이라 null(기존 차량별 홍보 발송과 같다).
// limits: 한 요청의 발송 상한. POS 탭앱은 POST를 20초에 포기하므로(pos-plugin/src/app.js POST_TIMEOUT_MS)
// 시간 예산을 짧게 준다 -- 마지막 묶음이 솔라피 타임아웃(기본 10초)만큼 걸려도 20초 안에 응답한다.
//
// 응답: sent(나감) · failed(확실히 안 나감 -- 나중에 다시 보낼 수 있다. failedProvider 포함) · failedProvider(그중 발송사
// 계정·설정 탓 -- 잔액·발신번호·템플릿·요청 한도) · uncertain(결과 모름 -- 나갔을 수 있어 30일 동안 다시 보내지 않는다) ·
// skipped(보내기 직전 확인에서 빠짐 -- 다른 발송이 먼저 보냈거나 그 사이 수신거부 등) · remaining(아직 안 보낸 대상) ·
// stopped(night | time | provider | null) · message(stopped가 provider일 때 화면에 띄울 안내)
// 발송사 탓 실패가 이어지면(PROMO_PROVIDER_FAILURE_STOP_AFTER, 그 사이 성공도 수신자 탓 실패도 없이) 그 묶음(동시 발송 단위) 뒤에
// 멈추고(stopped 'provider') 남은 대상은 시도하지 않는다. 계속 돌면 대상 전원이 같은 이유로 실패하고, 화면은 "30분 뒤 다시"만 안내해
// 직원이 다시 눌러도 또 전원 실패한다. 한 건의 실패로는 멈추지 않는다(목록에 없는 상태 코드 하나가 그 번호만의 사정일 수 있다).
async function runPromoCampaignSend(target, confirmCountRaw, sentBy, via, limits = {}) {
  const batchMax = limits.batchMax || PROMO_CAMPAIGN_BATCH_MAX
  const timeBudgetMs = limits.timeBudgetMs || PROMO_CAMPAIGN_TIME_BUDGET_MS
  if (isPromoNightNow()) {
    return {
      status: 403,
      body: { ok: false, reason: 'night', error: `야간(${PROMO_NIGHT_START_HOUR}시~${PROMO_NIGHT_END_HOUR}시)에는 광고를 보낼 수 없습니다.` },
    }
  }
  const confirmCount = Number(confirmCountRaw)
  if (!Number.isSafeInteger(confirmCount) || confirmCount < 0) {
    return { status: 400, body: { ok: false, error: '보낼 대상을 먼저 확인해주세요.' } }
  }
  if (promoCampaignBusy.has(target.store.id)) {
    return { status: 409, body: { ok: false, reason: 'busy', error: '이 매장에 다른 발송이 진행 중입니다. 잠시 후 다시 시도해주세요.' } }
  }

  promoCampaignBusy.add(target.store.id)
  try {
    const { recipients } = await listPromoCampaignCandidates(target.store.id, target.start, target.end, { skipRecentFailures: true })
    if (recipients.length > confirmCount) {
      return {
        status: 409,
        body: {
          ok: false,
          reason: 'count_changed',
          eligible: recipients.length,
          error: `대상을 확인한 뒤 ${recipients.length}명으로 늘었어요. 대상을 다시 확인한 뒤 보내주세요.`,
        },
      }
    }

    const batch = recipients.slice(0, batchMax)
    const startedAt = Date.now()
    const counts = { sent: 0, failed: 0, failedProvider: 0, uncertain: 0, skipped: 0 }
    let processed = 0
    let stopped = null
    // 이어진 발송사 탓 실패 수. 성공하거나 수신자 탓 실패가 나오면 0으로. 결과 모름·건너뜀은 세지도 끊지도 않는다.
    let providerFailureStreak = 0
    for (let i = 0; i < batch.length; i += PROMO_CAMPAIGN_CONCURRENCY) {
      if (isPromoNightNow()) { stopped = 'night'; break }
      if (Date.now() - startedAt >= timeBudgetMs) { stopped = 'time'; break }
      const chunk = batch.slice(i, i + PROMO_CAMPAIGN_CONCURRENCY)
      // 건마다 결과('sent' | 'skipped' | recipient | provider | unknown)를 받아, 묶음 안 순서대로 연속 실패를 센다.
      const outcomes = await Promise.all(chunk.map(async (r) => {
        const claim = await claimPromoSend({ storeId: target.store.id, carNumber: r.carNumber, phone: r.phone, sentBy, via: `campaign-${via}` })
        if (!claim.ok) { counts.skipped += 1; return 'skipped' }
        try {
          await solapi.sendPromoAlimtalk({
            phone: r.phone,
            carNumber: r.carNumber,
            storeName: target.store.name,
            storeId: target.store.id,
            paymentId: null,
          })
          counts.sent += 1
          await finishPromoSend(claim.record.id, 'sent')
          return 'sent'
        } catch (e) {
          const failure = solapi.classifySendFailure(e)
          if (failure === 'unknown') {
            counts.uncertain += 1
          } else {
            counts.failed += 1
            if (failure === 'provider') counts.failedProvider += 1
          }
          await finishPromoSend(claim.record.id, PROMO_SEND_FAILURE_STATUS[failure])
          logger.error('[promo-campaign] 발송 실패', { storeId: target.store.id, failure, definite: failure !== 'unknown', ...solapi.sendFailureLog(e) })
          return failure
        }
      }))
      processed += chunk.length
      for (const outcome of outcomes) {
        if (outcome === 'provider') providerFailureStreak += 1
        else if (outcome === 'sent' || outcome === 'recipient') providerFailureStreak = 0
      }
      if (providerFailureStreak >= PROMO_PROVIDER_FAILURE_STOP_AFTER) {
        stopped = 'provider'
        logger.error('[promo-campaign] 발송사 계정·설정 탓 실패가 이어져 기간 발송을 멈춥니다. 솔라피 잔액·키·발신번호·템플릿을 확인하세요', {
          storeId: target.store.id, via, streak: providerFailureStreak, remaining: Math.max(0, recipients.length - processed),
        })
        break
      }
    }
    const remaining = Math.max(0, recipients.length - processed)
    logger.info('[promo-campaign] 발송', {
      storeId: target.store.id, via, adminId: sentBy, from: target.from, to: target.to, ...counts, remaining, stopped,
    })
    return {
      status: 200,
      body: { ok: true, ...counts, remaining, stopped, ...(stopped === 'provider' ? { message: PROMO_PROVIDER_STOP_MESSAGE } : {}) },
    }
  } finally {
    promoCampaignBusy.delete(target.store.id)
  }
}

// 관리자 웹
app.get('/api/admin/promo-campaign/preview', requireAuth, asyncHandler(async (req, res) => {
  const target = await resolvePromoCampaignTarget(req, req.query)
  if (target.error) return res.status(target.error.status).json(target.error.body)
  return res.json(await buildPromoCampaignPreview(target, { filter: req.query.filter, offset: req.query.offset, limit: req.query.limit }))
}))

app.post('/api/admin/promo-campaign/send', requireAuth, asyncHandler(async (req, res) => {
  const target = await resolvePromoCampaignTarget(req, req.body)
  if (target.error) return res.status(target.error.status).json(target.error.body)
  const { status, body } = await runPromoCampaignSend(target, req.body?.confirmCount, req.admin.id, 'admin')
  return res.status(status).json(body)
}))

// POS 탭앱 [홍보 문자] 화면. 매장 토큰으로 인증하고 그 매장에만 보낸다(다른 매장 지정 불가).
app.get('/api/pos/promo-campaign/preview', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const period = resolvePromoCampaignPeriod(req.query)
  if (period.error) return res.status(period.error.status).json(period.error.body)
  return res.json(await buildPromoCampaignPreview({ store: req.store, ...period }, { filter: req.query.filter, offset: req.query.offset, limit: req.query.limit }))
}))

app.post('/api/pos/promo-campaign/send', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const period = resolvePromoCampaignPeriod(req.body)
  if (period.error) return res.status(period.error.status).json(period.error.body)
  const { status, body } = await runPromoCampaignSend({ store: req.store, ...period }, req.body?.confirmCount, null, 'pos', POS_PROMO_CAMPAIGN_LIMITS)
  return res.status(status).json(body)
}))

// 매장의 최근 정비 이력. 이력 화면을 열자마자 보여줄 목록이다.
//
// 직원이 "이 차가 누구 차인지" 알아보고 바로 연락할 수 있게 차의 지금 연락처(010-1234-5678)와, 전산
// 주문에는 전산이 보낸 고객명을 함께 준다. 이 화면은 직원용이다 -- 대기실 손님에게 보일 수 있는 정비 대기
// 화면(/api/pos/queue)은 지금처럼 가린 번호만 준다.
app.get('/api/pos/history/recent', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  const { carts, reservations } = await listRecentRepairHistory(req.store.id, 20)
  const phones = await latestPhonesByCarNumbers(req.store.id, [...carts, ...reservations].map((v) => v.carNumber))
  const contactOf = (car) => (phones.get(car) ? formatPhone(phones.get(car)) : null)

  const visits = []
  for (const c of carts) {
    let items = []
    try { items = JSON.parse(c.itemsJson) } catch { /* 손상된 건은 금액만 보여준다 */ }
    visits.push({
      kind: 'order',
      carNumber: c.carNumber,
      contact: contactOf(c.carNumber),
      customerName: customerNameFromMemo(c.memo, c.carNumber),
      at: c.paidAt || c.createdAt,
      paid: c.status === 'paid',
      serviceType: null,
      totalAmount: c.totalAmount,
      items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
    })
  }
  for (const r of reservations) {
    visits.push({
      kind: 'reservation',
      carNumber: r.carNumber,
      contact: contactOf(r.carNumber),
      customerName: null,
      at: r.completedAt,
      paid: false,
      serviceType: r.serviceType,
      totalAmount: 0,
      items: [],
    })
  }
  visits.sort((a, b) => new Date(b.at) - new Date(a.at))

  return res.json({ ok: true, visits: visits.slice(0, 20) })
}))

// 전산 주문 memo에서 고객명만 뽑는다. 전산은 memo에 "12가3456 김민준님"처럼 차량번호와 고객명을 함께
// 넣는다(형식은 자유 문자열). 차량번호 모양의 토큰(이 차의 번호와 같거나 12가3456 형식)을 빼고 남은 것을
// 고객명으로 본다. 파기(익명화)된 건은 memo가 비어 있어 null이다.
function customerNameFromMemo(memo, carNumber) {
  const text = String(memo || '').trim()
  if (!text) return null
  const car = normalizeCarNumber(carNumber)
  const isCarToken = (t) => {
    const v = normalizeCarNumber(t)
    return Boolean(v) && (v === car || CAR_NUMBER_RE.test(v))
  }
  const rest = text.split(/\s+/).filter((t) => !isCarToken(t)).join(' ').trim()
  return rest ? rest.slice(0, 40) : null
}

// 차량번호 또는 전화번호로 정비 이력을 조회한다. 직원이 "이 차 지난번에 뭐 갈았지?"를 POS에서 바로 본다.
//
// 전화번호로 찾으면 그 번호로 방문한 차가 여러 대일 수 있다. 한 대면 바로 그 차의 이력을, 여러 대면
// 차량 목록(cars)만 주고 화면이 고르게 한다. 연락처는 전체 번호(010-1234-5678)로 준다(직원용 화면).
app.get('/api/pos/history', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  let carNumber = String(req.query.carNumber || '').trim()
  const rawPhone = String(req.query.phone || '').replace(/\D/g, '')
  let searchedPhone = null
  if (!carNumber && rawPhone) {
    if (!PHONE_RE.test(rawPhone)) {
      return res.status(400).json({ ok: false, error: '전화번호를 01012345678 형식으로 입력해주세요.' })
    }
    searchedPhone = rawPhone
    const cars = await findCarNumbersByPhone(req.store.id, rawPhone)
    if (cars.length !== 1) {
      return res.json({ ok: true, carNumber: null, phoneSearch: formatPhone(rawPhone), cars, visits: [] })
    }
    carNumber = cars[0]
  }
  if (!carNumber) {
    return res.status(400).json({ ok: false, error: '차량번호나 전화번호를 입력해주세요.' })
  }

  const [{ reservations, carts }, phones] = await Promise.all([
    findRepairHistoryByCarNumber(req.store.id, carNumber, 10),
    latestPhonesByCarNumbers(req.store.id, [normalizeCarNumber(carNumber)]),
  ])
  const currentPhone = phones.get(normalizeCarNumber(carNumber))

  // 방문 단위로 묶는다. 전산 주문은 예약에 이어져 있으면 그 예약 밑으로, 아니면 따로 세운다 —
  // 예약 없이 그냥 온 손님도 정비는 받았으므로 이력에서 빠지면 안 된다.
  const cartsByReservation = new Map()
  const standalone = []
  let customerName = null
  for (const c of carts) {
    let items = []
    try { items = JSON.parse(c.itemsJson) } catch { /* 손상된 건은 품목 없이 금액만 보여준다 */ }
    const name = customerNameFromMemo(c.memo, carNumber)
    if (name && !customerName) customerName = name // carts는 최근 것부터 온다
    const view = {
      id: c.id,
      customerName: name,
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
    reservationId: r.id,
    date: r.serviceDate,
    serviceType: r.serviceType,
    status: r.status,
    at: r.completedAt || r.createdAt,
    contact: r.phone ? formatPhone(r.phone) : null,
    orders: cartsByReservation.get(r.id) || [],
  }))
  // 예약이 이력에 안 보이는 주문(예약이 파기·숨김 처리됐거나 최근 10건 밖이다)은 붙을 방문이 없어 위 visits 어디에도
  // 안 들어간다 -- 그냥 두면 정비를 받은 기록이 이력에서 조용히 사라진다. 주문만 있는 방문으로 돌려 세운다.
  const visibleReservationIds = new Set(reservations.map((r) => r.id))
  for (const [reservationId, orders] of cartsByReservation) {
    if (!visibleReservationIds.has(reservationId)) standalone.push(...orders)
  }
  for (const c of standalone) {
    visits.push({ kind: 'order', date: null, serviceType: null, status: null, at: c.at, contact: null, orders: [c] })
  }
  // 최근 방문이 위로.
  visits.sort((a, b) => new Date(b.at) - new Date(a.at))

  return res.json({
    ok: true,
    carNumber,
    phoneSearch: searchedPhone ? formatPhone(searchedPhone) : null,
    contact: currentPhone ? formatPhone(currentPhone) : null,
    customerName,
    visits: visits.slice(0, 10),
  })
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
//
// body: { paymentId?, orderId?, manual?(직원이 손으로 맞춘 결제) }
// 응답 409 code: ALREADY_PAID_OTHER(이미 다른 결제로 결제된 주문 -- 이중 결제 확인) | ALREADY_CLOSED(이미 끝난 주문에 온 결제)

// 결제 전에 끝난 주문(전산 취소·매장이 지움·담기 실패·만료). 여기에 결제 통보가 오면 받은 돈을 대사해야 한다.
const CLOSED_CART_STATUSES = ['dismissed', 'failed', 'expired', 'cancelled']
// 결제된 뒤의 상태(취소가 끝나기 전)
const PAID_LIKE_CART_STATUSES = ['paid', 'refund_requested', 'refunding']
const CLOSED_CART_PAID_ERROR = '이미 끝난(취소·만료·지움) 주문이라 결제 완료로 기록하지 못했습니다. 받은 결제를 확인해주세요.'

// 이미 결제된 주문(row)에 온 POS 결제 통보가 그 주문을 결제한 바로 그 POS 결제인지(재시도·응답 유실). 결제 ID가 어느 한쪽에
// 없으면 가릴 수 없으므로 예전처럼 같은 결제로 본다(옛 탭앱, ID 없이 기록된 주문). 프론트 결제 건은 늘 다른 결제다.
function isSamePosPayment(row, reportedPaymentId) {
  if (!row || row.payTarget !== 'pos') return false
  return !reportedPaymentId || !row.tossPaymentId || row.tossPaymentId === reportedPaymentId
}

// POS 결제 취소로 환불된 주문의 refundNote. 탭앱 [결제 취소] 기록(/refunded method 'pos')과 토스 취소 웹훅(store.markErpCartsRefundedByToss)이
// 남긴다. "취소 후 재결제" 복원(/paid)이 이 두 문구로 POS 쪽 취소였는지 가린다 -- 프론트 취소·현금 환불은 되살리지 않는다.
const POS_CANCEL_REFUND_NOTE = 'POS에서 결제 취소'
const POS_SIDE_CANCEL_REFUND_NOTES = [TOSS_CANCEL_REFUND_NOTE, POS_CANCEL_REFUND_NOTE]
// 취소 후 재결제로 볼 수 있는 시간. 카드를 바꿔 다시 결제하는 것은 그 자리에서 일어난다. 오래된 환불을 되살리면 남의 결제를 붙인다.
const POS_REPAY_RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000

// 환불된(refunded) 주문에 온 POS 결제 통보가 "취소 후 재결제"인지. 직원이 POS [주문]에서 결제 P를 취소하고(손님이 카드·할부를 바꿈)
// 같은 주문을 P2로 다시 결제하면, 토스 취소 웹훅(또는 탭앱의 취소 기록)이 주문을 refunded로 바꾼 뒤 P2의 통보가 온다. 그대로 거절하면
// P2로 받은 돈이 어디에도 기록되지 않고 전산은 환불로 안다(다시 청구하면 이중 결제). 다음을 모두 만족할 때만 그렇게 본다:
// POS 결제 건, POS 쪽 취소로 환불됨, 환불이 24시간 안, 보고된 결제 ID가 저장된(취소된) 결제 ID와 다름(둘 다 있어야 가릴 수 있다),
// 직원이 손으로 고른 결제(manual)이거나 같은 POS 주문(orderId)의 결제.
function isPosCancelRepay(cart, { reportedPaymentId, reportedOrderId, manual }) {
  if (cart.status !== 'refunded' || cart.payTarget !== 'pos') return false
  if (!POS_SIDE_CANCEL_REFUND_NOTES.includes(cart.refundNote)) return false
  if (!cart.refundedAt || Date.now() - new Date(cart.refundedAt).getTime() > POS_REPAY_RESTORE_WINDOW_MS) return false
  if (!reportedPaymentId || !cart.tossPaymentId || reportedPaymentId === cart.tossPaymentId) return false
  return manual || (Boolean(cart.tossOrderId) && reportedOrderId === cart.tossOrderId)
}

// 직원이 손으로 고른 결제(manual)나 취소 후 재결제 복원이 이 주문 금액을 다 받은 결제인지. 전산 주문에 POS 품목(와이퍼 등)을 더해 한
// 결제로 받은 뒤 POS에서 통째로 취소하고 POS 품목만 다시 결제한 경우, 그 작은 결제를 고르면 환불된 주문이 전액 결제 완료로 되살아난다.
// 토스 결제 기록(웹훅)에 금액이 있고 주문 금액보다 작으면 거절할 근거를 돌려준다. 기록이 없거나 금액을 모르면(웹훅이 아직 안 옴)
// 막지 않는다 -- 대사할 수 있게 경고만 남긴다. 반환: null(통과) | { paymentAmount, cartAmount }
async function shortPosPaymentAmount(cart, reportedPaymentId, meta) {
  const tossPayment = reportedPaymentId
    ? await prisma.tossPayment.findUnique({ where: { id: reportedPaymentId }, select: { amount: true } })
    : null
  if (!tossPayment || tossPayment.amount === null || tossPayment.amount === undefined) {
    logger.warn('[pos] 손으로 고른 결제·취소 후 재결제의 금액을 토스 결제 기록으로 확인하지 못했습니다(웹훅 전). 금액 대사가 필요할 수 있습니다', {
      ...meta, cartAmount: cart.totalAmount,
    })
    return null
  }
  if (tossPayment.amount < cart.totalAmount) return { paymentAmount: tossPayment.amount, cartAmount: cart.totalAmount }
  return null
}

app.post('/api/pos/erp-carts/:id/paid', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  const reportedPaymentId = req.body?.paymentId ? String(req.body.paymentId).slice(0, 200) : null
  const reportedOrderId = req.body?.orderId ? String(req.body.orderId).slice(0, 200) : null
  // manual: 탭앱이 결제를 자동으로 맞추지 못해 직원이 [주문] 탭을 보고 손으로 고른 결제다. 나중에 대사할 때 구분하려고 남긴다.
  const manual = req.body?.manual === true
  const reportMeta = (row) => ({
    storeId: req.store.id,
    cartId: cart.id,
    referenceId: cart.referenceId,
    status: row?.status ?? null,
    payTarget: row?.payTarget ?? null,
    storedPaymentId: row?.tossPaymentId ?? null,
    reportedPaymentId,
    orderId: req.body?.orderId ?? null,
    manual,
  })
  if (manual) logger.info('[pos] 직원이 손으로 확인한 POS 결제 통보', reportMeta(cart))

  // 이미 결제된 주문에 온 통보가 같은 결제의 재시도(응답 유실·탭앱 재시도)인지 다른 결제(같은 주문을 두 번 받음)인지 가른다.
  // 같은 결제면 그대로 처리됨으로 답하고, 다른 결제면 받은 돈이 기록 어디에도 안 남으므로 크게 남기고 409로 알려 탭앱이 직원에게
  // 이중 결제를 확인하게 한다.
  const respondPaidRow = (row) => {
    if (isSamePosPayment(row, reportedPaymentId)) {
      return res.json({ ok: true, alreadyProcessed: true, status: row.status })
    }
    logger.error('[pos] 이미 결제된 주문에 다른 결제 통보가 왔습니다. 대사가 필요합니다', { event: 'recon_needed', ...reportMeta(row) })
    return res.status(409).json({
      ok: false,
      code: 'ALREADY_PAID_OTHER',
      status: row.status,
      error: '이 주문은 이미 다른 결제로 결제 완료됐어요. 이중 결제인지 POS [주문] 탭에서 확인해주세요.',
    })
  }

  // 이 요청이 주문을 결제 완료로 바꾼 뒤의 처리(토스 결제와 잇기·예약 정비완료·영수증). restored: 취소 후 재결제로 되살린 주문 --
  // 첫 결제 때 영수증을 이미 보냈으면 다시 보내지 않는다(같은 정비의 영수증이 두 번 간다).
  const finishPaid = async ({ restored = false } = {}) => {
    // 토스 웹훅이 이 보고보다 먼저 와 있었다면 지금 잇는다(매핑 실패는 결제 기록을 막지 않는다).
    if (reportedPaymentId) {
      try {
        const tossPayment = await prisma.tossPayment.findUnique({ where: { id: reportedPaymentId } })
        if (tossPayment) {
          const linked = await linkErpCartsToTossPayment(tossPayment)
          if (tossPayment.state === 'CANCELLED') await markErpCartsRefundedByToss(linked.map((c) => c.id))
          // 웹훅이 먼저 와서 Payment 백업 기록이 만들어졌다면 이제 같은 돈이 전산 주문으로 집계되므로 빼 둔다.
          if (linked.length) await markBackupPaymentErpLinked(tossPayment)
        }
      } catch (e) {
        logger.error('[pos] 토스 결제 매핑 실패', { cartId: cart.id, error: e.message })
      }
    }

    // 위 매핑이 이미 취소된 토스 결제를 이어 이 주문을 refunded로 바꿨을 수 있다. 취소된 주문의 예약을 완료 처리하고
    // 영수증을 보내면 손님이 환불받은 결제의 영수증을 받게 되므로, 아직 paid일 때만 결제 후 처리를 한다.
    const settled = await prisma.erpCart.findUnique({ where: { id: cart.id }, select: { status: true } })
    const reservationId = await linkPaidCartToReservation(cart)
    const restoredFlag = restored ? { restored: true } : {}
    if (settled?.status !== 'paid') {
      return res.json({ ok: true, alreadyProcessed: false, status: settled?.status ?? 'paid', ...restoredFlag, reservationCompleted: false, receipt: null })
    }

    // 예약이 이어져 있으면 정비완료까지 자동으로 처리한다 — 결제가 끝났다는 건 정비가 끝났다는
    // 뜻이라, 직원이 [완료]를 또 누르게 할 이유가 없다. 이미 완료/취소된 예약이면 아무 일도
    // 일어나지 않는다(completeReservationAfterPayment가 상태를 확인한다).
    let reservationCompleted = false
    if (reservationId) {
      try {
        reservationCompleted = await completeReservationAfterPayment(reservationId)
      } catch (e) {
        // 자동완료는 부가 기능이다. 여기서 실패해도 결제 기록 자체는 이미 남았으므로 500을
        // 내지 않는다 — 직원이 대기열에서 직접 완료 처리하면 된다.
        logger.error('[pos] 결제 후 예약 자동완료 실패', { cartId: cart.id, error: e.message })
      }
    }
    // 프론트 결제와 같이 예약 번호로 전자영수증(품목·금액)을 보낸다. 이 요청이 paid로 바꾼 한 번만.
    const receipt = restored && cart.receiptStatus === 'sent'
      ? 'sent'
      : await sendErpCartReceipt({ ...cart, reservationId }, req.store.name)

    return res.json({ ok: true, alreadyProcessed: false, status: 'paid', ...restoredFlag, reservationCompleted, receipt })
  }

  // 고른 결제 금액이 주문 금액보다 작다(shortPosPaymentAmount 주석) -- 결제 완료로 기록하지 않고 409로 알린다.
  const respondAmountMismatch = (short) => {
    logger.warn('[pos] 결제 금액이 주문 금액보다 작아 결제 완료로 기록하지 않았습니다', { ...reportMeta(cart), ...short })
    return res.status(409).json({
      ok: false,
      code: 'AMOUNT_MISMATCH',
      status: cart.status,
      paymentAmount: short.paymentAmount,
      cartAmount: short.cartAmount,
      error: `고른 결제 금액(${short.paymentAmount.toLocaleString('ko-KR')}원)이 이 주문 금액(${short.cartAmount.toLocaleString('ko-KR')}원)보다 적어요. 이 주문의 결제가 맞는지 POS [주문] 탭에서 확인해주세요.`,
    })
  }

  if (cart.status === 'paid') return respondPaidRow(cart)

  // 취소 후 재결제(isPosCancelRepay 주석). 읽은 그 환불 그대로일 때만 되살린다 -- 그 사이 다른 요청이 바꿨으면 다시 읽어 위 규칙대로 답한다.
  if (isPosCancelRepay(cart, { reportedPaymentId, reportedOrderId, manual })) {
    const short = await shortPosPaymentAmount(cart, reportedPaymentId, reportMeta(cart))
    if (short) return respondAmountMismatch(short)
    const restored = await restoreErpCartPaidAfterPosCancel(cart.id, req.store.id, {
      expectedPaymentId: cart.tossPaymentId,
      paymentId: reportedPaymentId,
      orderId: reportedOrderId,
      refundNotes: POS_SIDE_CANCEL_REFUND_NOTES,
      since: new Date(Date.now() - POS_REPAY_RESTORE_WINDOW_MS),
    })
    if (!restored) {
      const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
      return respondPaidRow(latest || cart)
    }
    // 대사용: 취소된 결제(previousPaymentId)와 새 결제(paymentId)가 같은 주문에 이어졌다는 기록.
    logger.warn('[pos] 취소 후 재결제로 결제 완료 복원', {
      ...reportMeta(cart),
      previousPaymentId: cart.tossPaymentId,
      previousOrderId: cart.tossOrderId,
      refundNote: cart.refundNote,
      refundedAt: cart.refundedAt,
    })
    return finishPaid({ restored: true })
  }

  if (cart.payTarget !== 'pos' || !['pending', 'loaded'].includes(cart.status)) {
    if (CLOSED_CART_STATUSES.includes(cart.status)) {
      // 이미 끝난 주문인데 POS에서는 돈이 나갔다는 통보가 왔다. 조용히 409만 돌려주면 결제된 사실이 우리 기록 어디에도
      // 남지 않으므로 크게 남긴다 -- 매장·토스 결제 ID로 대사해서 주문을 되살리거나 환불해야 한다.
      logger.error('[pos] 결제 통보가 끝난 주문에 왔습니다. 대사가 필요합니다', { event: 'recon_needed', ...reportMeta(cart), paymentId: reportedPaymentId })
      return res.status(409).json({
        ok: false, code: 'ALREADY_CLOSED', error: CLOSED_CART_PAID_ERROR, status: cart.status,
      })
    }
    if (['refund_requested', 'refunding', 'refunded'].includes(cart.status) && !isSamePosPayment(cart, reportedPaymentId)) {
      // 결제된 뒤 취소가 진행 중이거나 끝난 주문에 다른 결제 통보가 왔다(프론트 결제 건 포함) -- 이중 결제다.
      return respondPaidRow(cart)
    }
    if (cart.payTarget !== 'pos') {
      // 프론트 결제 건(대기·결제 중·담김)인데 POS에서 돈이 나갔다는 통보다. 프론트에서도 결제되면 두 번 받는다.
      logger.error('[pos] 프론트 결제 주문에 POS 결제 통보가 왔습니다. 대사가 필요합니다', { event: 'recon_needed', ...reportMeta(cart) })
    }
    // 담기 전(pending)·담김(loaded)이 아니거나 프론트 결제 건은 POS 결제로 기록할 수 없다.
    return res.status(409).json({ ok: false, error: '아직 결제 전인 POS 결제 주문만 결제 완료로 기록할 수 있어요.', status: cart.status })
  }

  // 직원이 손으로 고른 결제도 금액을 본다(자동으로 맞춘 결제는 탭앱이 그 POS 주문에서 찾은 것이라 보지 않는다).
  if (manual) {
    const short = await shortPosPaymentAmount(cart, reportedPaymentId, reportMeta(cart))
    if (short) return respondAmountMismatch(short)
  }

  const changed = await markErpCartPaid(cart.id, {
    paymentId: req.body?.paymentId,
    orderId: req.body?.orderId,
  })
  if (!changed) {
    // 읽은 뒤 다른 요청이 먼저 바꿨다. 다시 읽은 상태로 위와 같은 규칙을 건다.
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    if (latest && PAID_LIKE_CART_STATUSES.includes(latest.status)) return respondPaidRow(latest)
    if (latest && [...CLOSED_CART_STATUSES, 'refunded'].includes(latest.status)) {
      logger.error('[pos] 결제 통보가 끝난 주문에 왔습니다. 대사가 필요합니다', { event: 'recon_needed', ...reportMeta(latest), paymentId: reportedPaymentId })
      return res.status(409).json({
        ok: false, code: 'ALREADY_CLOSED', error: CLOSED_CART_PAID_ERROR, status: latest.status,
      })
    }
    // 그 사이 프론트로 넘어갔다 등. POS에서 받은 돈을 이 주문에 기록하지 못했다.
    logger.error('[pos] POS 결제 통보를 주문에 반영하지 못했습니다. 대사가 필요합니다', { event: 'recon_needed', ...reportMeta(latest) })
    return res.status(409).json({ ok: false, error: '아직 결제 전인 POS 결제 주문만 결제 완료로 기록할 수 있어요.', status: latest?.status, payTarget: latest?.payTarget })
  }
  if (cart.deletedAt) {
    logger.warn('[pos] 삭제했던 주문이 결제 완료로 확정되어 되살립니다', { storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId })
  }
  return finishPaid()
}))

// --- 탭앱 정리: 최근 결제 숨기기·삭제, 프론트 대기 주문 지우기, 정비 이력 숨기기 ---------------------
//
// 리허설·테스트 기록이 실제 화면에 남지 않게 하는 용도다. 결제 기록은 행을 지우지 않는다(store.softDeleteErpCart
// 주석) -- 삭제해도 전산의 상태 조회와 토스 대사에는 그대로 남는다.

async function findOwnCart(req, res) {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id || cart.deletedAt) {
    res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
    return null
  }
  return cart
}

// [최근 결제] 숨기기/다시 보이기. body: { hidden: true|false }
app.post('/api/pos/erp-carts/:id/hide', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  if (typeof req.body?.hidden !== 'boolean') return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  const cart = await findOwnCart(req, res)
  if (!cart) return
  const changed = await setErpCartHidden(req.store.id, cart.id, req.body.hidden)
  if (!changed) return res.status(409).json({ ok: false, error: '결제가 끝난 주문만 숨길 수 있습니다.' })
  return res.json({ ok: true, hidden: req.body.hidden })
}))

// [최근 결제] 삭제. 결제 완료·취소된 건만(취소 진행 중이면 409).
app.post('/api/pos/erp-carts/:id/delete', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await findOwnCart(req, res)
  if (!cart) return
  const changed = await softDeleteErpCart(req.store.id, cart.id)
  if (!changed) {
    return res.status(409).json({ ok: false, error: '결제 완료 또는 취소된 주문만 삭제할 수 있습니다(결제 취소가 진행 중이면 끝난 뒤 삭제하세요).' })
  }
  logger.info('[pos] 결제 기록 삭제(숨김 처리)', { storeId: req.store.id, cartId: cart.id, status: cart.status })
  return res.json({ ok: true })
}))

// 프론트 결제 대기 주문 지우기. 손님이 아직 결제를 시작하지 않은(pending) 건만 -- 결제 중(paying)이면 409.
app.post('/api/pos/erp-carts/:id/dismiss-front', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await findOwnCart(req, res)
  if (!cart) return
  if (cart.payTarget !== 'front') return res.status(409).json({ ok: false, error: '프론트 결제 대기 주문이 아닙니다.' })
  if (cart.status === 'dismissed') return res.json({ ok: true, alreadyProcessed: true })
  const changed = cart.status === 'pending' ? await markErpCartDismissed(cart.id, '매장이 프론트 대기에서 지움', 'front') : false
  if (!changed) return res.status(409).json({ ok: false, error: '손님이 결제 중이거나 이미 처리된 주문이라 지울 수 없습니다.', status: cart.status })
  return res.json({ ok: true, alreadyProcessed: false })
}))

// 프론트 미반영 승인 경고(frontOrphan) [확인했어요]. 직원이 토스 결제내역에서 그 승인을 확인하고(환불했거나 이 주문의 결제로 맞췄음)
// 누른다. 주문 상태는 바꾸지 않는다. 경고를 지우지 않고 확인 시각(frontOrphanAckAt)만 남긴다 -- 예전에는 지워서 관리자 웹의 '대사 필요'
// 표시까지 사라졌고, 이중 결제였다면 본사가 화면에서 찾을 근거가 없어졌다. 확인한 경고는 관리자 웹에 '매장 확인함'으로 계속 보이고,
// 탭앱은 접어서 보여준다. 확인한 뒤에는 전산 취소·만료가 그 주문을 닫을 수 있다. 확인한 사람·내용은 로그로도 남긴다.
// (경로 이름은 옛 탭앱 호환으로 그대로 둔다.)
app.post('/api/pos/erp-carts/:id/clear-front-orphan', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (!cart.frontOrphanAt || cart.frontOrphanAckAt) {
    return res.json({ ok: true, alreadyProcessed: true, frontOrphan: frontOrphanOf(cart) })
  }
  const acked = await ackErpCartFrontOrphan(cart.id, req.store.id, cart.frontOrphanAt)
  const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
  if (!acked) {
    // 읽은 뒤 다른 단말기가 먼저 확인했거나, 같은 승인이 반영돼 지워졌거나, 새 흔적이 덮었다 -- 지금 값을 돌려준다(새 흔적은 확인 전 그대로).
    return res.json({ ok: true, alreadyProcessed: true, frontOrphan: frontOrphanOf(latest) })
  }
  logger.warn('[pos] 직원이 프론트 미반영 승인 경고를 확인함(지우지 않고 확인 시각만 남김)', {
    storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId, status: cart.status,
    orphanAt: cart.frontOrphanAt, approvalNo: cart.frontOrphanApprovalNo, amount: cart.frontOrphanAmount,
  })
  return res.json({ ok: true, alreadyProcessed: false, frontOrphan: frontOrphanOf(latest) })
}))

// 프론트 미반영 승인을 이 주문의 결제로 기록한다(탭앱 [프론트 승인으로 결제 완료 기록]). 손님이 프론트에서 낸 승인이 주문에 붙지
// 못한 채(PAID_AFTER_RELEASE) 남은 주문을, 다시 결제하지 않고 그 승인으로 결제 완료로 만든다. 안 하면 경고대로 "다시 결제하지 않은"
// 주문이 [지우기]나 만료로 전산에 미결제로 남는다. 조건: 흔적이 있고, 결제 전(대기·담김)이거나 결제 없이 닫힌(지움·만료·전산 취소)
// 주문이고, 흔적의 금액을 알면 주문 금액과 같아야 한다(다르면 409 AMOUNT_MISMATCH -- 다른 주문의 승인이거나 재전송으로 금액이 바뀌었다).
// 결제 중(paying)·결제 완료 이후 상태는 409(다른 결제가 이미 붙어 있거나 붙는 중이다). 바꾼 뒤에는 프론트 결제 보고와 같은 처리를 한다
// (토스 결제 기록과 잇기·웹훅 백업 기록 정리·예약 정비완료·영수증). 응답: { ok, status, wasStatus, reservationCompleted, receipt }
app.post('/api/pos/erp-carts/:id/record-front-orphan', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (!cart.frontOrphanAt) {
    return res.status(409).json({
      ok: false, code: 'NO_FRONT_ORPHAN', status: cart.status,
      error: '기록할 프론트 승인 경고가 없습니다(이미 결제로 기록했거나 같은 승인이 반영됐습니다). 화면을 새로 고쳐 확인해주세요.',
    })
  }
  if (!FRONT_ORPHAN_RECORDABLE_STATUSES.includes(cart.status)) {
    return res.status(409).json({
      ok: false, code: 'NOT_RECORDABLE', status: cart.status, frontOrphan: frontOrphanOf(cart),
      error: '결제 중이거나 이미 결제·취소된 주문이라 이 승인으로 결제 완료를 기록할 수 없어요. 토스 결제내역에서 확인해 한쪽 결제를 취소해주세요.',
    })
  }
  if (cart.frontOrphanAmount !== null && cart.frontOrphanAmount !== cart.totalAmount) {
    logger.warn('[pos] 프론트 미반영 승인의 금액이 주문 금액과 달라 결제로 기록하지 않았습니다', {
      storeId: req.store.id, cartId: cart.id, orphanAmount: cart.frontOrphanAmount, cartAmount: cart.totalAmount,
    })
    return res.status(409).json({
      ok: false, code: 'AMOUNT_MISMATCH', status: cart.status, frontOrphan: frontOrphanOf(cart),
      orphanAmount: cart.frontOrphanAmount, cartAmount: cart.totalAmount,
      error: `승인 금액(${cart.frontOrphanAmount.toLocaleString('ko-KR')}원)이 이 주문 금액(${cart.totalAmount.toLocaleString('ko-KR')}원)과 다릅니다. 토스 결제내역에서 확인해주세요.`,
    })
  }

  const { recorded, withPaymentKey } = await recordErpCartFrontOrphanPaid(cart.id, req.store.id, cart)
  if (!recorded) {
    // 읽은 뒤 주문 상태·흔적이 바뀌었다(다른 단말기가 먼저 기록했거나, 프론트가 결제를 시작했거나, 새 흔적이 덮었다).
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    return res.status(409).json({
      ok: false, code: 'CHANGED', status: latest?.status ?? null, frontOrphan: frontOrphanOf(latest),
      error: '그 사이 주문 상태가 바뀌었습니다. 화면을 새로 고쳐 다시 확인해주세요.',
    })
  }
  const payment = (() => {
    try { return cart.frontOrphanPaymentJson ? JSON.parse(cart.frontOrphanPaymentJson) : {} } catch { return {} }
  })()
  // 대사용: 어떤 승인을 어느 주문의 결제로 기록했는지 남긴다(승인번호·금액은 개인정보가 아니다).
  logger.warn('[pos] 직원이 프론트 미반영 승인을 이 주문의 결제로 기록했습니다', {
    storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId, wasStatus: cart.status, wasPayTarget: cart.payTarget,
    orphanAt: cart.frontOrphanAt, approvalNo: cart.frontOrphanApprovalNo, amount: cart.frontOrphanAmount,
    paymentMethod: payment.paymentMethod ?? null, withPaymentKey,
  })
  if (!withPaymentKey) {
    // 흔적에 paymentKey가 없었다(이 기능 전에 남은 흔적)거나 다른 주문이 같은 키를 쓴다 -- 프론트에서 취소할 때 원결제 키가 없다.
    logger.warn('[pos] 기록한 프론트 결제에 paymentKey가 없어 프론트 취소가 안 될 수 있습니다', { storeId: req.store.id, cartId: cart.id })
  }
  const settled = await settleFrontPaidCart(
    { ...cart, payTarget: 'front', frontApprovalNo: cart.frontOrphanApprovalNo, deletedAt: null },
    { approvalNo: cart.frontOrphanApprovalNo, paymentMethod: payment.paymentMethod },
    req.store.name
  )
  return res.json({ ok: true, wasStatus: cart.status, ...settled })
}))

// 정비 이력에서 한 방문 숨기기. body: { reservationId } 또는 { cartId }
app.post('/api/pos/history/hide', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const reservationId = req.body?.reservationId ? String(req.body.reservationId) : null
  const cartId = req.body?.cartId ? String(req.body.cartId) : null
  if (!reservationId && !cartId) return res.status(400).json({ ok: false, error: '숨길 방문이 없습니다.' })
  const changed = await hideHistoryVisit(req.store.id, { reservationId, cartId })
  if (!changed) return res.status(404).json({ ok: false, error: '방문 기록을 찾을 수 없습니다.' })
  return res.json({ ok: true })
}))

// 정비 이력에서 한 방문 삭제(이어진 결제 기록도 함께). body: { reservationId } 또는 { cartId }
app.post('/api/pos/history/delete', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const reservationId = req.body?.reservationId ? String(req.body.reservationId) : null
  const cartId = req.body?.cartId ? String(req.body.cartId) : null
  if (!reservationId && !cartId) return res.status(400).json({ ok: false, error: '삭제할 방문이 없습니다.' })
  const result = await deleteHistoryVisit(req.store.id, { reservationId, cartId })
  if (result === 'not_found') return res.status(404).json({ ok: false, error: '방문 기록을 찾을 수 없습니다.' })
  if (result === 'refund_in_progress') {
    return res.status(409).json({ ok: false, error: '아직 결제되지 않았거나 결제 중, 결제 취소가 진행 중인 주문이 있어 지금은 삭제할 수 없습니다.' })
  }
  logger.info('[pos] 정비 이력 삭제(숨김 처리)', { storeId: req.store.id, reservationId, cartId })
  return res.json({ ok: true })
}))

// 전자영수증 다시 보내기(탭앱·관리자 웹). 결제 완료 건만. 예약과 이어져 있지 않으면 지금 다시 찾아 잇는다.
async function resendErpCartReceipt(cart, storeName) {
  if (cart.status !== 'paid') return { status: 409, body: { ok: false, error: '결제 완료된 주문만 영수증을 보낼 수 있습니다.' } }
  const reservationId = await linkPaidCartToReservation(cart)
  const receipt = await sendErpCartReceipt({ ...cart, reservationId }, storeName)
  const messages = {
    sent: '영수증을 보냈습니다.',
    failed: '영수증 발송에 실패했습니다. 잠시 후 다시 시도해주세요.',
    no_reservation: '접수 내역과 연결되지 않아 손님 번호를 알 수 없어요. (오늘 같은 차량번호로 접수한 건이 1건일 때만 연결돼요.)',
    no_phone: '접수 내역에 연락처가 없어요.',
  }
  return { status: receipt === 'sent' ? 200 : 409, body: { ok: receipt === 'sent', receipt, error: receipt === 'sent' ? undefined : messages[receipt], message: messages[receipt] } }
}

app.post('/api/pos/erp-carts/:id/resend-receipt', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await findOwnCart(req, res)
  if (!cart) return
  const { status, body } = await resendErpCartReceipt(cart, req.store.name)
  return res.status(status).json(body)
}))

app.post('/api/admin/erp-carts/:id/resend-receipt', requireAuth, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id }, include: { store: true } })
  if (!cart || cart.deletedAt || (req.admin.role === 'store_admin' && cart.storeId !== req.admin.storeId)) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  const { status, body } = await resendErpCartReceipt(cart, cart.store?.name)
  return res.status(status).json(body)
}))

// 정비 완료 안내 다시 보내기(탭앱 정비 이력). 정비완료된 접수만.
app.post('/api/pos/queue/:id/resend-done', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const reservation = await prisma.reservation.findUnique({ where: { id: req.params.id }, include: { store: true } })
  if (!reservation || reservation.storeId !== req.store.id || reservation.anonymizedAt) {
    return res.status(404).json({ ok: false, error: '접수 내역을 찾을 수 없어요.' })
  }
  if (reservation.status !== 'completed') return res.status(409).json({ ok: false, error: '정비가 끝난 접수만 완료 문자를 보낼 수 있어요.' })
  const notified = await notifyRepairDone(reservation)
  if (!notified) return res.status(502).json({ ok: false, notified, error: '완료 문자를 보내지 못했습니다. 잠시 후 다시 시도해주세요.' })
  return res.json({ ok: true, notified })
}))

// --- 전산 주문을 프론트 플러그인에서 직접 결제 (payTarget: 'front') ---
//
// 토스는 프론트 플러그인과 토스 POS 동시 연결을 지원하지 않는다(연동 가이드 FAQ). 플러그인 모드
// 프론트는 POS와 페어링되지 않으므로, POS 플러그인이 프론트에 결제를 보낼 방법이 없다. 그래서
// 전산이 payTarget:'front'로 보낸 주문은 POS를 거치지 않고 프론트 플러그인이 여기서 바로 가져가
// 자기 SDK(sdk.payment.requestPayment)로 결제한다. 서버는 결제를 일으키지 않는다 -- 주문을
// 전달하고, 결과를 받아 전산에 알려줄 뿐이다.
//
// 인증은 POS 탭앱과 같은 매장 토큰(X-Store-Token)이다. 프론트의 다른 API(예약·결제 영수증)는
// merchantId로 매장을 찾지만, 이 경로는 차량번호·고객명이 담긴 주문을 내려주고 "결제됐다"는
// 보고로 전산 주문을 끝내버릴 수 있어서 merchantId만으로는 부족하다(merchantId는 위조가 쉽다).
// 직원이 프론트 [플러그인 설정]에서 매장 토큰을 한 번 넣어두면 된다.
//
// 상태 흐름: pending --(start)--> paying --(result: paid)--> paid
//                                       \--(result: cancelled/failed)--> pending (다시 결제 가능)
// paying에서 결과 보고가 끊기면(프론트 재시작 등) 서버는 자동으로 되돌리지 않는다. 실제로는
// 승인됐을 수 있어서 되돌리면 이중결제가 된다. 프론트가 다시 켜질 때 sdk.payment.getPayment로
// 승인 여부를 확인해 보고를 마저 보낸다(front-plugin/index.html 참고). 그래도 끝내 안 풀리면(프론트가 아예 복구되지 않는 등)
// 10분이 지난 뒤 직원이 탭앱에서 force-release로 풀 수 있다 -- 결제 취소 쪽(refunding)도 같다.

// 쉼표가 들어갈 수 없어야 한다 -- 포기한 키를 쉼표로 이어 frontReleasedKey 한 컬럼에 목록으로 둔다(store.js 묘비 목록).
const FRONT_PAYMENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/

// 프론트 결제가 끝난 뒤의 상태(취소 요청·진행·완료 포함)
const FRONT_PAID_STATUSES = ['paid', 'refund_requested', 'refunding', 'refunded']

// 이 주문을 결제한 바로 그 프론트 결제(paymentKey)의 재보고인지(응답 유실·재시작 후 복구).
function isSameFrontPayment(row, paymentKey) {
  return Boolean(row) && row.payTarget === 'front' && row.frontPaymentKey === paymentKey && FRONT_PAID_STATUSES.includes(row.status)
}

// 부가세는 전산(erp-simulator/cart.py)과 같은 기준(합계 / 11 반올림)으로 나눈다. 금액을 서버가
// 정해 내려주는 이유: 프론트가 자기가 가진 값으로 결제하면 그 사이 바뀐 주문과 금액이 어긋날 수 있다.
function splitVat(totalAmount) {
  const tax = Math.round(totalAmount / 11)
  return { tax, supplyValue: totalAmount - tax }
}

function trimmedString(value, maxLength) {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  return s ? s.slice(0, maxLength) : null
}

// 승인 응답에서 나중에 취소·대사에 쓸 값만 추린다. 카드번호(마스킹본 포함)처럼 필요 없는 값은
// 아예 저장하지 않는다.
function sanitizeFrontPayment(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const method = ['CARD', 'CASH', 'BARCODE'].includes(p.paymentMethod) ? p.paymentMethod : null
  const timestamp = Number(p.timestamp)
  const installment = Number(p.installment)
  return {
    paymentMethod: method,
    approvalNumber: trimmedString(p.approvalNumber, 64),
    timestamp: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null,
    installment: Number.isSafeInteger(installment) && installment >= 0 && installment <= 99 ? installment : null,
    vanTransactionKey: trimmedString(p.vanTransactionKey, 64),
    van: trimmedString(p.van, 20),
    tid: trimmedString(p.tid, 64),
    isCashReceipt: typeof p.isCashReceipt === 'boolean' ? p.isCashReceipt : null,
    isSelfIssuance: typeof p.isSelfIssuance === 'boolean' ? p.isSelfIssuance : null,
    easyPayProvider: trimmedString(p.easyPayProvider, 40),
  }
}

// 프론트가 결과 보고에 실은 결제 금액(payment.amount 또는 amount). 없거나 형식이 틀리면 null -- 호출부가 주문 금액으로 대신한다.
function reportedFrontAmount(body) {
  for (const raw of [body?.payment?.amount, body?.amount]) {
    if (raw === undefined || raw === null || raw === '') continue
    const n = Number(raw)
    if (Number.isSafeInteger(n) && n >= 0 && n <= ERP_MAX_TOTAL_AMOUNT) return n
  }
  return null
}

function parseFrontPayment(cart) {
  try {
    return cart.frontPaymentJson ? JSON.parse(cart.frontPaymentJson) : {}
  } catch {
    return {}
  }
}

// 현금영수증 없이 받은 현금은 토스 쪽에 취소할 대상이 없다(프론트 SDK 문서). 이 건은 현금을 돌려주고
// 기록만 "환불"로 남긴다.
function isUncancellableCash(cart) {
  const p = parseFrontPayment(cart)
  return p.paymentMethod === 'CASH' && p.isCashReceipt !== true
}

// 프론트가 sdk.payment.requestPaymentCancel에 넘길 값. 원거래와 같은 금액·세금으로 취소해야 한다.
function frontRefundParams(cart) {
  const p = parseFrontPayment(cart)
  return {
    paymentKey: cart.frontPaymentKey,
    paymentMethod: p.paymentMethod,
    approvalNumber: p.approvalNumber,
    timestamp: p.timestamp,
    installment: p.installment ?? 0,
    vanTransactionKey: p.vanTransactionKey,
    van: p.van,
    isSelfIssuance: p.isSelfIssuance === true,
    totalAmount: cart.totalAmount,
    ...splitVat(cart.totalAmount),
  }
}

// POS 탭앱 [프론트로 결제 요청]. 전산이 POS로 보낸 주문을, 담기 전에 프론트 결제로 돌린다.
// 손님이 프론트 앞에 왔을 때 직원이 넘기는 흐름이다(전산이 처음부터 payTarget:'front'로 보내는
// 경로와 결과는 같다).
app.post('/api/pos/erp-carts/:id/send-to-front', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (cart.payTarget === 'front' && (cart.status === 'pending' || cart.status === 'paying')) {
    return res.json({ ok: true, alreadyProcessed: true, status: cart.status, payTarget: 'front' })
  }
  const changed = await sendErpCartToFront(cart.id, req.store.id)
  if (!changed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    return res.status(409).json({
      ok: false, error: '아직 담기 전인 주문만 프론트로 넘길 수 있습니다.', status: latest?.status, payTarget: latest?.payTarget,
    })
  }
  return res.json({ ok: true, alreadyProcessed: false, status: 'pending', payTarget: 'front' })
}))

// POS 탭앱 [프론트에 다시 띄우기]. 손님이 결제창을 놓쳐 프론트가 그 주문을 2분 동안 쉬고 있을 때, frontSentAt을 지금으로 바꿔
// 프론트가 바로 다시 띄우게 한다(store.bumpErpCartFrontSentAt). 프론트 결제 대기(pending)인 건만 -- 그 밖은 409와 지금 상태.
app.post('/api/pos/erp-carts/:id/resend-front', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id || cart.deletedAt) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  const frontSentAt = await bumpErpCartFrontSentAt(cart.id, req.store.id)
  if (!frontSentAt) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    const error = latest?.payTarget !== 'front'
      ? '프론트 결제 대기 주문이 아니에요.'
      : latest?.status === 'paying'
        ? '손님이 프론트에서 결제 중이에요.'
        : '이미 결제가 진행됐거나 끝난 주문이에요.'
    return res.status(409).json({ ok: false, error, status: latest?.status ?? null, payTarget: latest?.payTarget ?? null })
  }
  logger.info('[pos] 프론트 결제 대기 주문을 프론트에 다시 띄움', { storeId: req.store.id, cartId: cart.id })
  return res.json({ ok: true, status: 'pending', payTarget: 'front', frontSentAt })
}))

// POS 탭앱 [POS로 되돌리기]. 프론트가 아직 결제를 시작하지 않은 건만 되돌린다.
app.post('/api/pos/erp-carts/:id/return-to-pos', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (cart.payTarget === 'pos' && cart.status === 'pending') {
    return res.json({ ok: true, alreadyProcessed: true, status: 'pending', payTarget: 'pos' })
  }
  const changed = await returnErpCartToPos(cart.id, req.store.id)
  if (!changed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    const error = latest?.status === 'paying'
      ? '손님이 프론트에서 결제 중입니다. 끝나거나 취소된 뒤에 다시 시도해주세요.'
      : '이미 결제가 진행됐거나 끝난 주문이라 POS로 되돌릴 수 없어요.'
    return res.status(409).json({ ok: false, error, status: latest?.status, payTarget: latest?.payTarget })
  }
  return res.json({ ok: true, alreadyProcessed: false, status: 'pending', payTarget: 'pos' })
}))

// --- 정비 대기열(POS 탭앱)에서 결제 취소 ---
//
// 결제한 곳에서만 취소할 수 있다:
//   - POS 결제 건: 탭앱이 POS SDK(posPluginSdk.payment.cancel)로 직접 취소한 뒤 /refunded로 기록한다.
//   - 프론트 결제 건: POS는 프론트와 페어링되지 않으므로 직접 취소할 수 없다. /refund-request로 요청을
//     남기면 프론트 플러그인이 가져가 sdk.payment.requestPaymentCancel로 취소한다(손님 카드 필요).
//   - 현금영수증 없는 현금: 토스 쪽에 취소할 대상이 없다. 현금을 돌려주고 /refunded(method:'cash')로 기록만 한다.
// 어느 경우든 토스 취소 웹훅이 오면 그쪽이 최종 근거로 refunded를 확정한다(markErpCartsRefundedByToss).

app.post('/api/pos/erp-carts/:id/refund-request', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (cart.payTarget !== 'front') {
    return res.status(409).json({ ok: false, error: 'POS에서 결제한 주문은 POS에서 바로 취소합니다.', payTarget: cart.payTarget })
  }
  if (isUncancellableCash(cart)) {
    return res.status(409).json({ ok: false, error: '현금영수증 없이 받은 현금은 프론트에서 취소할 수 없습니다. 현금을 돌려주고 [현금 환불 처리]를 눌러주세요.', code: 'CASH_NO_RECEIPT' })
  }
  if (cart.status === 'refund_requested' || cart.status === 'refunding') {
    return res.json({ ok: true, alreadyProcessed: true, status: cart.status })
  }
  const changed = await requestErpCartRefund(cart.id, req.store.id)
  if (!changed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    return res.status(409).json({ ok: false, error: '결제 완료된 주문만 취소를 요청할 수 있습니다.', status: latest?.status })
  }
  return res.json({ ok: true, alreadyProcessed: false, status: 'refund_requested' })
}))

app.post('/api/pos/erp-carts/:id/refund-withdraw', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (cart.status === 'paid') return res.json({ ok: true, alreadyProcessed: true, status: 'paid' })
  const changed = await withdrawErpCartRefund(cart.id, req.store.id)
  if (!changed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    const error = latest?.status === 'refunding'
      ? '프론트에서 취소가 진행 중입니다. 끝난 뒤에 확인해주세요.'
      : '철회할 수 있는 취소 요청이 없습니다.'
    return res.status(409).json({ ok: false, error, status: latest?.status })
  }
  return res.json({ ok: true, alreadyProcessed: false, status: 'paid' })
}))

// 취소 완료 기록. method: 'pos'(탭앱이 POS SDK로 취소함) | 'cash'(현금영수증 없는 현금을 돌려줌)
// body.paymentId(method 'pos', 선택): 탭앱이 취소한 결제(카드에 보이던 tossPaymentId). 그 사이 이 주문이 다른 결제로 바뀌었으면
// (취소 후 재결제 복원 등) 409 PAYMENT_CHANGED로 거절한다 -- 옛 결제 P의 취소 기록이 새 결제 P2로 받은 주문을 환불로 바꾸면,
// 받은 돈이 전산에 환불로 고정되고 되살릴 길이 없다. 안 보내는 옛 탭앱은 예전처럼 읽은 그 결제 ID로만 취소한다.
const PAYMENT_CHANGED_ERROR = '그 사이 이 주문이 다른 결제로 바뀌었어요. 화면을 새로 고친 뒤 POS [주문] 탭에서 어느 결제를 취소했는지 확인해주세요.'

app.post('/api/pos/erp-carts/:id/refunded', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const method = req.body?.method
  if (method !== 'pos' && method !== 'cash') {
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  }
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  const reportedPaymentId = method === 'pos' && req.body?.paymentId ? String(req.body.paymentId).slice(0, 200) : null
  const paymentChanged = (row) => {
    logger.warn('[pos] 취소 기록의 결제가 주문의 지금 결제와 달라 거절', {
      storeId: req.store.id, cartId: cart.id, status: row?.status ?? null, storedPaymentId: row?.tossPaymentId ?? null, reportedPaymentId,
    })
    return res.status(409).json({ ok: false, code: 'PAYMENT_CHANGED', error: PAYMENT_CHANGED_ERROR, status: row?.status ?? null })
  }
  // 이미 환불된 주문이어도 다른 결제의 취소 기록이면 "처리됨"으로 답하지 않는다(탭앱이 보던 결제가 이 주문의 결제가 아니다).
  if (reportedPaymentId && reportedPaymentId !== cart.tossPaymentId) return paymentChanged(cart)
  if (cart.status === 'refunded') return res.json({ ok: true, alreadyProcessed: true, status: 'refunded', refundedCartIds: [cart.id] })

  if (method === 'pos') {
    if (cart.payTarget !== 'pos') {
      return res.status(409).json({ ok: false, error: '프론트에서 결제한 주문은 프론트에서 취소해야 합니다.', payTarget: cart.payTarget })
    }
    // POS 결제 하나로 여러 주문을 함께 결제했으면 그 결제를 취소하는 순간 전부 취소된 것이다.
    const siblings = cart.tossPaymentId
      ? await prisma.erpCart.findMany({ where: { storeId: req.store.id, tossPaymentId: cart.tossPaymentId }, select: { id: true } })
      : [{ id: cart.id }]
    const ids = siblings.map((s) => s.id)
    // 읽은 결제 ID 그대로일 때만 바꾼다 -- 읽은 뒤 복원(취소 후 재결제)으로 결제가 바뀐 주문을 옛 결제의 취소로 환불하지 않는다.
    const result = await prisma.erpCart.updateMany({
      where: { id: { in: ids }, status: 'paid', tossPaymentId: cart.tossPaymentId },
      data: { status: 'refunded', refundedAt: new Date(), refundNote: POS_CANCEL_REFUND_NOTE },
    })
    if (!result.count) {
      const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
      if (latest && latest.status === 'paid' && latest.tossPaymentId !== cart.tossPaymentId) return paymentChanged(latest)
      return res.status(409).json({ ok: false, error: '결제 완료된 주문만 취소로 기록할 수 있습니다.', status: latest?.status })
    }
    return res.json({ ok: true, alreadyProcessed: false, status: 'refunded', refundedCartIds: ids })
  }

  // method === 'cash'
  if (cart.payTarget !== 'front' || !isUncancellableCash(cart)) {
    return res.status(409).json({ ok: false, error: '현금영수증 없는 현금 결제만 기록으로 환불 처리할 수 있습니다.' })
  }
  const changed = await markErpCartRefunded(cart.id, req.store.id, ['paid', 'refund_requested'], '현금 환불(기록만)')
  if (!changed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    return res.status(409).json({ ok: false, error: '결제 완료된 주문만 환불 처리할 수 있습니다.', status: latest?.status })
  }
  return res.json({ ok: true, alreadyProcessed: false, status: 'refunded', refundedCartIds: [cart.id] })
}))

// 갇힌 프론트 결제 중(paying)·취소 중(refunding)을 직원이 푸는 비상구. 프론트가 결과 보고를 못 한 채 꺼지면 서버는 자동으로
// 되돌리지 않으므로(실제로는 승인됐을 수 있어서 되돌리면 이중결제) 사람이 풀어야 한다. 그래서 정상 결제·취소가 끝나고도
// 남을 시간(10분)이 지난 건만 푼다 -- 지금 손님이 결제하는 주문을 풀면 같은 주문이 두 번 결제될 수 있다.
//   - 결제 중: pending으로 풀고 옛 paymentKey를 묘비 목록(frontReleasedKey)에 더한다. 그 키의 늦은 /start는 거절된다. 그 키의
//     늦은 'paid' 보고는 아직 아무도 주문을 다시 잡지 않았으면(프론트 대기 pending) 결제 완료로 받고, 그 밖(POS로 되돌림·다시
//     결제됨·지움 등)이면 logger.error(대사 필요)와 409 PAID_AFTER_RELEASE로 남긴다(/result 참고).
//   - 취소 중: paid로 풀고 그 시도를 묘비 목록(refundReleasedAttemptId)에 더한다. 카드 취소가 실제로 끝났다면 토스 취소 웹훅이 refunded로 맞춘다.
app.post('/api/pos/erp-carts/:id/force-release', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (cart.status !== 'paying' && cart.status !== 'refunding') {
    return res.status(409).json({ ok: false, error: '프론트에서 결제 중이거나 취소 중인 주문만 풀 수 있습니다.', status: cart.status, retryAfterSec: 0 })
  }

  const heldSince = cart.status === 'paying' ? cart.frontPayingAt : (cart.refundStartedAt || cart.refundRequestedAt)
  const waitMs = heldSince ? new Date(heldSince).getTime() + FORCE_RELEASE_AFTER_MS - Date.now() : 0
  if (waitMs > 0) {
    return res.status(409).json({
      ok: false,
      error: `손님이 아직 ${cart.status === 'paying' ? '결제' : '취소'} 중일 수 있습니다. ${Math.ceil(FORCE_RELEASE_AFTER_MS / 60000)}분이 지난 뒤에 풀 수 있습니다.`,
      status: cart.status,
      retryAfterSec: Math.ceil(waitMs / 1000),
    })
  }

  const released = cart.status === 'paying'
    ? await forceReleaseErpCartFrontPaying(cart.id, req.store.id, cart.frontPaymentKey, '프론트 결제 중 상태를 직원이 풀었어요')
    : await forceReleaseErpCartRefunding(cart.id, req.store.id, cart.refundAttemptId, '프론트 결제 취소 중 상태를 직원이 풀었어요')
  if (!released) {
    // 읽은 뒤 프론트가 결과를 보고했거나 다른 시도로 바뀌었다 -- 푸는 대신 최신 상태를 알려준다.
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    return res.status(409).json({ ok: false, error: '그 사이 주문 상태가 바뀌었습니다. 다시 확인해주세요.', status: latest?.status, retryAfterSec: 0 })
  }
  // 결제 중을 풀면 'pending', 24시간이 지난 주문이면 'dismissed'(forceReleaseErpCartFrontPaying). 취소 중을 풀면 true(paid로 복귀).
  const status = cart.status === 'paying' ? released : 'paid'
  logger.warn('[pos] 직원이 갇힌 프론트 주문을 풀었습니다', {
    storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId, previousStatus: cart.status, status,
  })
  return res.json({ ok: true, previousStatus: cart.status, status })
}))

// 프론트 대기화면이 몇 초마다 부른다. POS 폴링과 같은 한도(매장 토큰 기준)를 쓴다.
// pollMs: 프론트가 다음 조회까지 기다릴 간격(ms). 400대에 ZIP을 다시 배포하지 않고 서버 배포만으로 간격을 바꿀 수 있게 미리 심어 둔다
// (프론트는 2초~30초로 잘라 쓰고, 이 필드가 없으면 3초). 지금은 예전과 같은 3초라 동작이 바뀌지 않는다.
const FRONT_POLL_MS = 3000

app.get('/api/front/erp-carts', posIpFloodLimiter, posQueueReadLimiter, requireStoreToken, asyncHandler(async (req, res) => {
  noteDeviceSeen(req.store.id, 'front')
  const [carts, refundRows] = await Promise.all([
    loadPendingErpCartsForResponse(req.store.id, 'front'),
    // 정비 대기열에서 [프론트에서 취소]를 누른 결제. 프론트가 가져가 취소창을 띄운다.
    prisma.erpCart.findMany({
      where: { storeId: req.store.id, payTarget: 'front', status: 'refund_requested' },
      orderBy: { refundRequestedAt: 'asc' },
      take: 10,
    }),
  ])
  const refunds = refundRows.map((row) => ({
    id: row.id,
    referenceId: row.referenceId,
    carNumber: row.carNumber,
    memo: row.memo,
    totalAmount: row.totalAmount,
    requestedAt: row.refundRequestedAt || null, // 다시 요청한 취소는 프론트가 쉬는 중이어도 바로 띄운다
    refund: frontRefundParams(row),
  }))
  return res.json({ ok: true, storeName: req.store.name, carts, refunds, pollMs: FRONT_POLL_MS })
}))

// 프론트가 결제 취소창을 띄우기 직전에 부른다(두 대가 같은 건을 동시에 취소하지 않게 잡는다).
// body.attemptId(선택): 프론트가 취소창을 띄울 때마다 새로 만든 시도 구분자. refund-result에 같은 값을 돌려보낸다.
app.post('/api/front/erp-carts/:id/refund-start', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const attemptId = parseAttemptId(req.body?.attemptId)
  if (attemptId === false) {
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  }
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id || cart.payTarget !== 'front') {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (isReleasedToken(cart.refundReleasedAttemptId, attemptId)) {
    // 프론트가 이 시도는 포기했다고 이미 알렸는데(시간 초과 뒤 refund-result) 이 start가 늦게 도착했다. 받아주면 프론트는
    // 취소창을 접었는데 서버만 refunding으로 잡혀 직원이 풀 때까지 갇힌다. (읽은 뒤 끼어든 포기 보고는 markErpCartRefunding이
    // 전이와 함께 다시 확인해 거절한다.)
    return res.status(409).json({ ok: false, error: '중단된 결제 취소예요. 처음부터 다시 시도해주세요.', stale: true, status: cart.status })
  }
  if (cart.status === 'refunding') {
    if (attemptId && cart.refundAttemptId && cart.refundAttemptId !== attemptId) {
      // 다른 시도가 취소를 쥐고 있다. 그 정보를 나눠주면 두 곳에서 같은 결제를 취소하려 든다.
      return res.status(409).json({ ok: false, error: '다른 단말기에서 결제 취소가 진행 중이에요.', status: 'refunding' })
    }
    // 같은 프론트가 재시도했다. 취소 정보를 다시 돌려준다.
    return res.json({ ok: true, alreadyProcessed: true, id: cart.id, refund: frontRefundParams(cart) })
  }
  const claimed = await markErpCartRefunding(cart.id, req.store.id, attemptId)
  if (!claimed) {
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    if (isReleasedToken(latest?.refundReleasedAttemptId, attemptId)) {
      // 읽은 직후 같은 시도의 포기 보고가 먼저 처리됐다.
      return res.status(409).json({ ok: false, error: '중단된 결제 취소예요. 처음부터 다시 시도해주세요.', stale: true, status: latest.status })
    }
    return res.status(409).json({ ok: false, error: '이미 취소됐거나 결제 전인 주문이라 결제 취소를 할 수 없어요.', status: latest?.status })
  }
  return res.json({ ok: true, alreadyProcessed: false, id: cart.id, refund: frontRefundParams(cart) })
}))

// 풀린 취소 시도의 늦은 완료 보고를 환불로 받을 때 남기는 refundNote(관리자 웹·탭앱에 보인다). 화면 표시용 문구일 뿐 조회 조건으로
// 쓰지 않는다(2026-10-23 문구를 바꿨다 -- 그 전 행에는 '프론트에서 결제 취소(풀린 뒤 보고)'가 남아 있다).
const FRONT_REFUND_AFTER_RELEASE_NOTE = '프론트에서 결제 취소(늦게 확인됨)'

// 프론트 결제 취소 결과. result: 'refunded' | 'failed' | 'cancelled'(손님이 취소창을 닫음)
app.post('/api/front/erp-carts/:id/refund-result', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const result = req.body?.result
  if (result !== 'refunded' && result !== 'failed' && result !== 'cancelled') {
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  }
  const attemptId = parseAttemptId(req.body?.attemptId)
  if (attemptId === false) {
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  }
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id || cart.payTarget !== 'front') {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }

  if (result === 'refunded' && cart.status === 'refunded') return res.json({ ok: true, alreadyProcessed: true, status: 'refunded' })

  // 지금 취소를 쥐고 있는 시도가 아닌 시도의 보고는 받지 않는다(예: 포기한 시도의 늦은 보고가 새 시도의 취소를 풀거나 끝낸다).
  // refunding일 때만 본다: 그 밖의 상태에서 refundAttemptId는 지난 시도의 기록일 뿐이라, 새 시도(refund-start가 아직
  // 도착 전)의 "포기" 보고를 지난 시도와 다르다는 이유로 거절하면 늦은 start를 막을 기록을 남길 수 없다.
  if (cart.status === 'refunding' && attemptId && cart.refundAttemptId && cart.refundAttemptId !== attemptId) {
    if (result === 'refunded') {
      // 다른 시도의 취소가 실제로 성공했을 수 있다(카드는 이미 취소). 상태는 토스 취소 웹훅이 맞추지만 사람이 볼 수 있게 남긴다.
      logger.error('[front] 다른 시도의 결제 취소 완료 보고가 와서 거절했습니다. 토스 취소 내역과 대사가 필요합니다.', {
        event: 'recon_needed',
        cartId: cart.id, status: cart.status, attemptId, currentAttemptId: cart.refundAttemptId,
      })
    } else {
      // 접은 시도는 지금 상태와 관계없이 묘비 목록에 남긴다 -- 지금 시도가 끝난 뒤 같은 주문의 취소가 다시 요청됐을 때 이 시도의
      // 늦은 refund-start가 그 취소를 가로채지 못하게 한다(지금 쥐고 있는 시도는 목록을 보지 않으므로 막지 않는다).
      await markErpCartRefundAttemptReleased(cart.id, attemptId)
    }
    return res.status(409).json({ ok: false, error: '이미 다른 결제 취소 처리로 바뀌었어요. 직원에게 확인해주세요.', stale: true, status: cart.status })
  }

  if (result === 'refunded') {
    const changed = await markErpCartRefunded(cart.id, req.store.id, ['refunding'], '프론트에서 결제 취소')
    // 풀린 취소 시도의 늦은 완료 보고(직원이 [취소 중 풀기]로 paid로 돌렸거나 다시 취소를 요청한 뒤). 카드는 이미 취소됐으므로
    // 그 시도가 묘비 목록에 있으면 환불로 받는다(store.markErpCartRefundedAfterRelease). 목록에 없는 시도는 아래처럼 거절한다.
    if (!changed && attemptId) {
      const afterRelease = await markErpCartRefundedAfterRelease(cart.id, req.store.id, attemptId, FRONT_REFUND_AFTER_RELEASE_NOTE)
      if (afterRelease) {
        logger.warn('[front] 풀린 취소 시도의 완료 보고를 받아 환불로 기록', {
          storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId, attemptId, previousStatus: cart.status,
        })
        return res.json({ ok: true, alreadyProcessed: false, status: 'refunded' })
      }
    }
    if (!changed) {
      // 손님 돈은 돌려줬는데 상태가 맞지 않는다 -- 대사가 필요하므로 크게 남긴다.
      logger.error('[front] 결제 취소 완료 보고를 반영하지 못했습니다. 확인이 필요합니다.', { event: 'recon_needed', cartId: cart.id, status: cart.status })
      return res.status(409).json({ ok: false, error: '주문 상태가 바뀌어 결제 취소를 기록하지 못했어요. 직원에게 알려주세요.', status: cart.status })
    }
    return res.json({ ok: true, alreadyProcessed: false, status: 'refunded' })
  }

  // cancelled/failed: 취소가 안 됐으므로 결제 완료(paid) 상태로 돌린다. 프론트가 같은 취소를 계속 다시 가져가지 않게
  // refund_requested로 되돌리지 않는다(store.releaseErpCartRefunding 주석).
  const note = result === 'failed' ? (trimmedString(req.body?.errorMessage, 500) || '프론트 결제 취소 실패') : null
  const released = await releaseErpCartRefunding(cart.id, note, attemptId)
  if (released) return res.json({ ok: true, alreadyProcessed: false, status: 'paid' })

  // 풀 게 없다: refund-start보다 먼저 도착했거나(시간 초과 뒤 프론트가 먼저 포기를 알림) 이미 풀린 뒤의 재시도다. 시도를 묘비
  // 목록에 남겨 늦게 도착하는 같은 시도의 refund-start를 거절한다(markErpCartRefunding이 전이와 함께 확인한다).
  if (attemptId) {
    const marked = await markErpCartRefundAttemptReleased(cart.id, attemptId)
    // 기록하기 직전에 그 refund-start가 먼저 처리돼 refunding이 됐을 수 있다(같은 시도) -- 이제는 정상적으로 푼다.
    const retried = await releaseErpCartRefunding(cart.id, note, attemptId)
    if (retried) return res.json({ ok: true, alreadyProcessed: false, status: 'paid' })
    if (!marked) {
      // 기록하지 못한 채 200을 주면 프론트가 기록을 지우고, 늦은 refund-start가 취소 중으로 가둘 수 있다. 다시 보내게 한다.
      logger.warn('[front] 취소 시도 중단을 기록하지 못했습니다(다시 보내도록 503)', { cartId: cart.id, attemptId })
      return res.status(503).json({ ok: false, error: '잠시 후 다시 시도해주세요.' })
    }
  }
  const latest = await prisma.erpCart.findUnique({ where: { id: cart.id }, select: { status: true } })
  if (latest?.status === 'refund_requested' || latest?.status === 'paid') {
    return res.json({ ok: true, alreadyProcessed: true, status: latest.status })
  }
  return res.status(409).json({ ok: false, error: '주문 상태가 바뀌었어요. 직원에게 확인해주세요.', status: latest?.status })
}))

// 결제창을 띄우기 직전에 부른다. 이 주문을 이 프론트가 잡았다는 표시(paying)와 paymentKey를 남기고,
// 결제할 금액을 서버 기준으로 돌려준다.
app.post('/api/front/erp-carts/:id/start', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const paymentKey = String(req.body?.paymentKey ?? '').trim()
  if (!FRONT_PAYMENT_KEY_RE.test(paymentKey)) {
    return res.status(400).json({ ok: false, error: '결제 요청 정보가 올바르지 않아요. 직원에게 문의해주세요.' })
  }

  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id || cart.payTarget !== 'front') {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  if (cart.status !== 'pending') {
    return res.status(409).json({ ok: false, error: '이미 결제 중이거나 결제가 끝난 주문이에요.', status: cart.status })
  }
  // 이미 승인됐는데 반영하지 못한 결제가 있는 주문(확인 전)은 결제창을 띄우지 않는다(markErpCartFrontPaying 주석).
  const orphanBlock = (row) => (row?.frontOrphanAt && !row.frontOrphanAckAt
    ? res.status(409).json({ ok: false, code: 'FRONT_ORPHAN', error: '이미 승인된 결제가 있는 주문입니다. 직원 확인이 필요합니다.', status: row.status, frontOrphan: frontOrphanOf(row) })
    : null)
  if (orphanBlock(cart)) return

  let claimed
  try {
    claimed = await markErpCartFrontPaying(cart.id, req.store.id, paymentKey)
  } catch (e) {
    // paymentKey unique 충돌 -- 프론트가 같은 키를 다른 주문에 재사용했다.
    if (e?.code === 'P2002') {
      return res.status(409).json({ ok: false, error: '이미 처리된 결제 요청이에요. 처음 화면으로 돌아가 다시 시도해주세요.' })
    }
    throw e
  }
  if (!claimed) {
    // 조회와 전이 사이에 다른 프론트가 먼저 잡았거나 전산이 취소했다. 또는 프론트가 이 paymentKey를 이미 포기한다고
    // 알려(묘비 목록 frontReleasedKey) 늦게 도착한 start가 거절된 경우다.
    const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
    if (isReleasedToken(latest?.frontReleasedKey, paymentKey)) {
      return res.status(409).json({ ok: false, error: '중단된 결제예요. 처음 화면으로 돌아가 다시 시도해주세요.', stale: true, status: latest.status })
    }
    if (orphanBlock(latest)) return
    return res.status(409).json({ ok: false, error: '이미 결제 중이거나 결제가 끝난 주문이에요.', status: latest?.status })
  }

  return res.json({
    ok: true,
    id: cart.id,
    referenceId: cart.referenceId,
    paymentKey,
    totalAmount: cart.totalAmount,
    ...splitVat(cart.totalAmount),
  })
}))

// 프론트에서 결제가 끝난 전산 주문의 전자영수증 알림톡. 예약과 이어진 주문만 보낸다 -- 손님이 그 예약에서
// 직접 넣은 번호라 확실하다. 차량번호로 연락처를 짐작해 보내면 차를 판 이전 주인처럼 엉뚱한 사람에게 갈 수
// 있다. 실패해도 결제 기록에는 영향이 없다(로그만 남긴다).
// 반환: sent | failed | no_reservation | no_phone (ErpCart.receiptStatus에도 남겨 관리자 웹에 보인다)
async function sendErpCartReceipt(cart, storeName) {
  const status = await sendErpCartReceiptInner(cart, storeName)
  // 결과 기록이 실패해도 발송 결과(응답)는 그대로 돌려준다. 다만 조용히 버리면 관리자 웹에 영수증 상태가 비어 "안 보냈나?"를 되짚을 수 없다.
  await prisma.erpCart.update({ where: { id: cart.id }, data: { receiptStatus: status } }).catch((e) => {
    logger.warn('[erp-cart] 영수증 발송 결과를 주문에 기록하지 못함', { cartId: cart.id, receipt: status, error: e.message })
  })
  return status
}

async function sendErpCartReceiptInner(cart, storeName) {
  if (!cart.reservationId) return 'no_reservation'
  const reservation = await prisma.reservation.findUnique({
    where: { id: cart.reservationId },
    select: { phone: true, carNumber: true, serviceType: true, anonymizedAt: true },
  })
  if (!reservation || reservation.anonymizedAt || !reservation.phone) return 'no_phone'
  let names = []
  try { names = JSON.parse(cart.itemsJson).map((i) => i?.name).filter(Boolean) } catch { /* 품목을 못 읽으면 정비 항목으로 */ }
  const summary = names.length > 1 ? `${names[0]} 외 ${names.length - 1}건` : (names[0] || reservation.serviceType)
  try {
    await solapi.sendReceiptAlimtalk({
      phone: reservation.phone,
      carNumber: cart.carNumber || reservation.carNumber,
      serviceType: summary,
      amount: cart.totalAmount,
      storeName,
      storeId: cart.storeId,
      paymentId: cart.id,
    })
    return 'sent'
  } catch (e) {
    logger.error('[front] 결제 영수증 발송 실패', { cartId: cart.id, storeId: cart.storeId, ...solapi.sendFailureLog(e) })
    return 'failed'
  }
}

// 결제가 끝났는데 주문이 예약과 이어져 있지 않으면 지금 다시 찾아 잇는다. 전산 주문을 먼저 넣고 손님이
// 나중에 예약했거나, 직원이 [완료]를 누른 뒤에 전산 주문을 넣은 경우다(접수 때는 이을 안 끝난 예약이 없었다).
// 같은 매장·오늘·그 차량번호로 애매하지 않게 1건일 때만 잇는다(store.findReservationForPaymentByCarNumber).
// 이어지면 정비완료 자동 처리(안 끝난 예약일 때)와 영수증이 따라온다.
// 반환: 이어진(또는 원래 이어져 있던) reservationId 또는 null
async function linkPaidCartToReservation(cart) {
  try {
    // 접수 때 이어진 예약이 그 뒤 취소됐거나 개인정보 파기로 익명화됐으면 그 예약으로는 정비완료 처리도 영수증(전화번호가
    // 없다)도 안 된다. 같은 차의 다른 예약이 정확히 1건이면 그쪽으로 옮겨 잇는다. 못 찾으면 예전처럼 원래 값을 그대로 둔다.
    if (cart.reservationId) {
      const linked = await prisma.reservation.findUnique({ where: { id: cart.reservationId }, select: { status: true, anonymizedAt: true } })
      if (linked && linked.status !== 'cancelled' && !linked.anonymizedAt) return cart.reservationId
      const carNumber = normalizeCarNumber(cart.carNumber)
      if (!carNumber) return cart.reservationId
      const replacement = await findReservationForPaymentByCarNumber(cart.storeId, carNumber, kstDateString())
      if (!replacement || replacement.id === cart.reservationId) return cart.reservationId
      // 옛 값이 그대로일 때만 바꾼다 -- 그 사이 다른 요청이 먼저 이었다면 덮어쓰지 않는다.
      const moved = await prisma.erpCart.updateMany({ where: { id: cart.id, reservationId: cart.reservationId }, data: { reservationId: replacement.id } })
      return moved.count ? replacement.id : cart.reservationId
    }
    const carNumber = normalizeCarNumber(cart.carNumber)
    if (!carNumber) return null
    const reservation = await findReservationForPaymentByCarNumber(cart.storeId, carNumber, kstDateString())
    if (!reservation) return null
    const result = await prisma.erpCart.updateMany({ where: { id: cart.id, reservationId: null }, data: { reservationId: reservation.id } })
    return result.count ? reservation.id : null
  } catch (e) {
    logger.error('[erp-cart] 결제 후 예약 연결 실패', { cartId: cart.id, error: e.message })
    return cart.reservationId || null
  }
}

// 프론트 결제가 이 주문의 결제로 기록된 뒤의 처리. 프론트 결제 보고(/result paid)와 직원의 미반영 승인 기록(record-front-orphan)이
// 같이 쓴다. cart: 기록 전에 읽은 행(id·storeId·totalAmount·reservationId·carNumber·itemsJson을 쓴다).
// approvalNo·paymentMethod: 이 결제의 승인번호·결제수단(토스 결제 기록과 잇는 열쇠). 반환: { status, reservationCompleted, receipt }
async function settleFrontPaidCart(cart, { approvalNo, paymentMethod }, storeName) {
  // 토스 웹훅이 이 보고보다 먼저 와 있었다면 지금 잇는다. 매핑 실패는 결제 기록을 막지 않는다.
  try {
    const linked = await linkFrontCartToRecordedTossPayment({ ...cart, frontApprovalNo: approvalNo ?? null }, paymentMethod)
    // 웹훅이 먼저 와서 Payment 백업 기록이 만들어졌다면 이제 같은 돈이 전산 주문으로 집계되므로 빼 둔다.
    if (linked) await markBackupPaymentErpLinked(linked)
    if (!linked) {
      // 웹훅이 아직 안 왔을 수도 있다(그러면 웹훅이 올 때 이어진다). 끝내 안 이어지면 이 로그와
      // 웹훅 쪽 로그의 승인번호·금액·결제수단을 비교해 원인을 찾는다. 승인번호·금액은 개인정보가 아니다.
      logger.info('[front] 결제 보고 시점에 토스 결제와 잇지 못함(웹훅 대기)', {
        cartId: cart.id, approvalNo: approvalNo ?? null, amount: cart.totalAmount, paymentMethod: paymentMethod ?? null,
      })
    }
  } catch (e) {
    logger.error('[front] 토스 결제 매핑 실패', { cartId: cart.id, error: e.message })
  }

  // 매핑에서 토스 쪽이 이미 취소된 결제로 확인되면 주문이 refunded로 바뀐다(POS /paid와 같은 이유). 그때는 정비완료
  // 문자와 영수증을 보내지 않는다 -- 취소된 결제의 영수증이 손님께 가면 안 된다.
  const afterLink = await prisma.erpCart.findUnique({ where: { id: cart.id }, select: { status: true } })
  if (afterLink?.status !== 'paid') {
    return { status: afterLink?.status ?? 'paid', reservationCompleted: false, receipt: null }
  }

  // POS 결제 경로와 같이, 예약이 이어져 있으면 정비완료까지 자동으로 처리한다.
  const reservationId = await linkPaidCartToReservation(cart)
  let reservationCompleted = false
  if (reservationId) {
    try {
      reservationCompleted = await completeReservationAfterPayment(reservationId)
    } catch (e) {
      logger.error('[front] 결제 후 예약 자동완료 실패', { cartId: cart.id, error: e.message })
    }
  }
  const receipt = await sendErpCartReceipt({ ...cart, reservationId }, storeName)
  return { status: 'paid', reservationCompleted, receipt }
}

// 결제 결과 보고. result: 'paid' | 'cancelled' | 'failed'.
app.post('/api/front/erp-carts/:id/result', posIpFloodLimiter, requireStoreToken, posLimiter, asyncHandler(async (req, res) => {
  const result = req.body?.result
  if (result !== 'paid' && result !== 'cancelled' && result !== 'failed') {
    return res.status(400).json({ ok: false, error: '요청 정보가 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해주세요.' })
  }
  const paymentKey = String(req.body?.paymentKey ?? '').trim()
  if (!FRONT_PAYMENT_KEY_RE.test(paymentKey)) {
    return res.status(400).json({ ok: false, error: '결제 요청 정보가 올바르지 않아요. 직원에게 문의해주세요.' })
  }

  // 다른 매장 주문·없는 주문은 404. 프론트 결제 건이 아니게 된 주문(POS로 되돌림)도 예전에는 404였는데, 'paid' 보고라면
  // 받은 돈이 아무 흔적 없이 사라지므로 아래에서 대사 필요 409로 남긴다.
  const cart = await prisma.erpCart.findUnique({ where: { id: req.params.id } })
  if (!cart || cart.storeId !== req.store.id) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }

  if (result === 'paid') {
    // 프론트가 재시도했다(응답을 못 받았거나 재시작 후 복구). 같은 키로 이미 끝난 건이면 성공으로 돌려준다. 그 뒤 취소가
    // 요청·진행·완료된 주문도 같은 결제의 재보고라 성공으로 본다(대사할 결제가 아니다).
    if (isSameFrontPayment(cart, paymentKey)) {
      return res.json({ ok: true, alreadyProcessed: true, status: cart.status })
    }
    const payment = sanitizeFrontPayment(req.body?.payment)
    const paymentJson = JSON.stringify(payment)
    let changed = false
    let afterRelease = false
    if (cart.payTarget === 'front') {
      changed = await markErpCartFrontPaid(cart.id, paymentKey, paymentJson, payment.approvalNumber)
      if (!changed) {
        // 풀린 시도(포기·시간 초과·직원의 [결제 중 풀기])의 승인 보고일 수 있다. 아무도 주문을 다시 잡지 않았으면(pending)
        // 결제 완료로 받는다 -- 손님 돈은 이미 나갔고, 안 받으면 같은 주문의 결제창이 다시 떠 한 번 더 결제된다.
        changed = await markErpCartFrontPaidAfterRelease(cart.id, req.store.id, paymentKey, paymentJson, payment.approvalNumber)
        afterRelease = changed
      }
    }
    if (!changed) {
      const latest = await prisma.erpCart.findUnique({ where: { id: cart.id } })
      // 읽은 뒤 같은 보고의 재시도가 먼저 반영했다.
      if (isSameFrontPayment(latest, paymentKey)) {
        return res.json({ ok: true, alreadyProcessed: true, status: latest.status })
      }
      // 돈은 나갔는데 주문에 붙일 수 없다(POS로 되돌림·다른 키로 결제 중이거나 결제됨·지움·만료·전산 취소 등). 조용히 넘기면
      // 아무도 모르는 결제가 생기므로 오류로 크게 남긴다 -- 관리자가 승인번호로 대사해야 한다. 전용 code로 프론트가 "완료 알림"
      // 대신 "직원 확인 필요"를 띄우고 같은 주문의 결제를 다시 시작하지 않게 한다.
      const orphanAmount = reportedFrontAmount(req.body) ?? cart.totalAmount
      logger.error('[front] 결제가 승인됐지만 주문에 반영하지 못함. 대사 필요', {
        event: 'recon_needed',
        cartId: cart.id,
        status: latest?.status ?? null,
        payTarget: latest?.payTarget ?? null,
        paymentKey,
        approvalNumber: payment.approvalNumber,
        amount: orphanAmount,
      })
      // 주문 행에도 흔적을 남긴다(schema.prisma frontOrphan*). 로그만 남기면 POS 화면에는 평범한 주문으로 보여 직원이 같은 주문을
      // 또 결제한다. 남기지 못해도 409는 그대로 준다(로그가 대사 근거다).
      // 결제 정보(승인번호·승인시각·결제수단 등)와 paymentKey도 함께 남긴다 -- 직원이 이 승인으로 결제 완료를 기록하면(record-front-orphan)
      // 그 값이 frontPaymentJson·frontPaymentKey가 되어 프론트 취소·토스 대사에 쓰인다.
      try {
        await recordErpCartFrontOrphan(cart.id, req.store.id, { approvalNo: payment.approvalNumber, amount: orphanAmount, paymentJson, paymentKey })
      } catch (e) {
        logger.error('[front] 미반영 승인 흔적을 주문에 남기지 못함', { cartId: cart.id, error: e.message })
      }
      return res.status(409).json({
        ok: false,
        code: 'PAID_AFTER_RELEASE',
        status: latest?.status ?? null,
        error: '결제는 승인됐지만 주문에 반영하지 못했어요. 직원에게 알려주세요.',
      })
    }
    if (afterRelease) {
      logger.warn('[front] 풀린 결제 시도의 승인 보고를 결제 완료로 반영했습니다', {
        storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId, approvalNumber: payment.approvalNumber,
      })
    }
    // 앞서 반영하지 못했던 그 승인(같은 승인번호)이 이제 이 주문의 결제로 기록됐다 -- 미반영 흔적을 지운다. 다른 승인번호면 지우지
    // 않는다: 같은 주문을 두 번 받은 것이라 직원이 확인해야 한다.
    if (cart.frontOrphanAt && payment.approvalNumber) {
      try {
        if (await clearErpCartFrontOrphan(cart.id, req.store.id, { approvalNo: payment.approvalNumber })) {
          logger.warn('[front] 미반영이던 승인이 결제 완료로 반영되어 흔적을 지움', { storeId: req.store.id, cartId: cart.id, approvalNumber: payment.approvalNumber })
        }
      } catch (e) {
        logger.error('[front] 미반영 승인 흔적 정리 실패', { cartId: cart.id, error: e.message })
      }
    }
    if (cart.deletedAt) {
      logger.warn('[front] 삭제했던 주문이 결제 완료로 확정되어 되살립니다', { storeId: req.store.id, cartId: cart.id, referenceId: cart.referenceId })
    }

    // 결제 기록이 끝난 뒤의 처리(이 요청이 paid로 바꾼 한 번만 -- 재시도 보고는 위에서 이미 돌려보냈다).
    const settled = await settleFrontPaidCart(cart, { approvalNo: payment.approvalNumber, paymentMethod: payment.paymentMethod }, req.store.name)
    return res.json({ ok: true, alreadyProcessed: false, ...settled })
  }

  // cancelled/failed: 돈이 나가지 않았으므로 다시 결제할 수 있게 되돌린다(되돌리면서 그 키를 묘비 목록에 남긴다).
  const note = result === 'failed'
    ? (trimmedString(req.body?.errorMessage, 500) || '프론트 결제 실패')
    : null
  if (cart.payTarget !== 'front') {
    // POS로 되돌린 주문이다(예전처럼 404). 포기한 키는 남겨 둔다 -- 다시 프론트로 넘어왔을 때 그 키의 늦은 /start가 잡지 못하게.
    await recordErpCartFrontReleasedKey(cart.id, paymentKey)
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  const released = await releaseErpCartFrontPaying(cart.id, paymentKey, note)
  if (released) return res.json({ ok: true, alreadyProcessed: false, status: 'pending' })

  // 되돌릴 게 없다: 같은 보고의 재시도로 이미 되돌려졌거나, 프론트가 /start 시간 초과로 포기를 먼저 알렸는데 그 /start가 아직
  // 서버에 도착하지 않았거나, 다른 키가 결제 중인 경우다. 그냥 끝내면 늦게 처리된 /start가 이 주문을 paying으로 잡아 프론트는
  // 포기했는데 서버만 결제 중으로 갇힌다. 그래서 주문 상태와 관계없이 이 키를 묘비 목록에 남겨 그 키의 /start를 거절한다
  // (지금 다른 키로 결제 중인 시도는 목록을 보지 않으므로 그대로 끝까지 결제된다).
  const marked = await recordErpCartFrontReleasedKey(cart.id, paymentKey)
  // 기록하기 직전에 그 /start가 먼저 처리돼 paying이 됐을 수 있다(같은 키) -- 이제는 정상적으로 되돌린다.
  const retried = await releaseErpCartFrontPaying(cart.id, paymentKey, note)
  if (retried) return res.json({ ok: true, alreadyProcessed: false, status: 'pending' })
  if (!marked) {
    // 기록하지 못한 채 200을 주면 프론트가 기록을 지우고, 늦은 /start가 결제 중으로 가둘 수 있다. 다시 보내게 한다.
    logger.warn('[front] 결제 시도 중단을 기록하지 못했습니다(다시 보내도록 503)', { cartId: cart.id })
    return res.status(503).json({ ok: false, error: '잠시 후 다시 시도해주세요.' })
  }
  const latest = await prisma.erpCart.findUnique({ where: { id: cart.id }, select: { status: true } })
  if (latest?.status === 'pending') return res.json({ ok: true, alreadyProcessed: true, status: 'pending' })
  return res.status(409).json({ ok: false, error: '주문 상태가 바뀌었어요. 직원에게 확인해주세요.', status: latest?.status })
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
  // normalizeBusinessNumber는 등록/수정 경로가 저장 시 쓰는 바로 그 정규화다 -- 여기서 후보를
  // 따로 계산하면 두 로직이 갈라져 다시 같은 버그(형식 불일치로 자동 연결 실패)가 날 수 있다.
  const result = normalizeBusinessNumber(raw)
  if (!result.ok || !result.value) return null
  return [result.value.replace(/-/g, ''), result.value]
}

// 반환: { store } | { error: {status, body} }
// 코드로 찾은 매장의 사업자번호와 전산이 함께 보낸 사업자번호가 다르면 erp_store_mismatch 경고만 남긴다(아직 거절하지 않는다) --
// 전산 쪽 코드 매핑이 틀려 남의 매장으로 주문이 가고 있을 수 있다. 양쪽에 값이 다 있을 때만 비교한다.
async function resolveErpStore(storeCode, rawBusinessNumber) {
  const byCode = await findStoreByErpCode(storeCode)
  if (byCode) {
    const sent = businessNumberCandidates(rawBusinessNumber)
    const stored = String(byCode.businessNumber || '').replace(/\D/g, '')
    if (sent && stored && sent[0] !== stored) {
      logger.warn('[erp] 전산 코드로 찾은 매장과 사업자번호가 다릅니다(주문은 그대로 받음)', {
        event: 'erp_store_mismatch', storeCode, storeId: byCode.id,
      })
    }
    return { store: byCode }
  }

  if (rawBusinessNumber === undefined || rawBusinessNumber === null || String(rawBusinessNumber).trim() === '') {
    return { error: { status: 404, body: { ok: false, error: '등록되지 않은 전산 코드예요.' } } }
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
    return { error: { status: 404, body: { ok: false, error: '등록되지 않은 전산 코드예요.' } } }
  }
  if (matches.length > 1) {
    // 같은 사업자번호를 여러 매장이 쓰고 있으면 어느 쪽인지 우리가 정할 수 없다.
    logger.error('[erp] 사업자번호가 여러 매장과 일치해 자동 연결을 중단합니다.', {
      storeCode, matched: matches.map((m) => m.id),
    })
    return { error: { status: 409, body: { ok: false, error: '사업자번호가 여러 매장과 일치해요. 본사에 전산 코드 등록을 요청해주세요.' } } }
  }

  const store = matches[0]
  if (store.erpStoreCode) {
    // 이미 다른 코드가 붙어 있는 매장이다. 덮어쓰면 기존 매핑이 조용히 바뀌므로 거부한다.
    return { error: { status: 409, body: { ok: false, error: '이 매장에는 이미 다른 전산 코드가 등록되어 있어요.' } } }
  }

  const bound = await bindErpCodeIfUnset(store.id, storeCode)
  if (!bound) {
    // 그 사이 다른 요청이 먼저 붙였거나 코드를 다른 매장이 선점했다. 다시 읽어 판단한다.
    const recheck = await findStoreByErpCode(storeCode)
    if (recheck && recheck.id === store.id) return { store: recheck }
    return { error: { status: 409, body: { ok: false, error: '전산 코드를 등록하지 못했어요. 본사에 문의해주세요.' } } }
  }

  logger.info('[erp] 사업자번호로 매장 코드를 자동 연결했습니다.', { storeId: store.id, storeCode })
  return { store: { ...store, erpStoreCode: storeCode } }
}

// 인증 뒤의 거절(400/403/404/409)을 고정 이벤트 코드로 남긴다(jsonPayload.event="erp_rejected"). "전산에서 보냈는데 POS에 안 떠요"의
// 가장 흔한 원인(등록되지 않은 전산 코드 404)이 예전에는 흔적을 남기지 않았다. 개인정보(차량번호·memo)는 넣지 않는다.
function rejectErpCart(req, res, status, body) {
  logger.warn('[erp] 전산 주문을 거절했습니다', {
    event: 'erp_rejected',
    status,
    storeCode: String(req.body?.storeCode ?? '').trim().slice(0, 64) || null,
    referenceId: String(req.body?.referenceId ?? req.params?.referenceId ?? '').trim().slice(0, 200) || null,
    reason: body.code || body.error,
  })
  return res.status(status).json(body)
}

app.post('/api/erp/carts', erpIpFloodLimiter, requireErpToken, erpLimiter, asyncHandler(async (req, res) => {
  // validateDraftOrderBody를 그대로 재사용한다 -- storeCode/referenceId/items/totalAmount/memo
  // 검증 규칙이 draft-orders와 완전히 동일해야 하고(전산 쪽이 같은 바디 스키마로 두 경로를
  // 오갈 수 있어야 함), 이 검증 로직을 복제하면 나중에 한쪽만 고쳐서 규칙이 어긋날 위험이 있다.
  const parsed = validateDraftOrderBody(req.body)
  if (parsed.error) {
    return rejectErpCart(req, res, 400, { ok: false, error: parsed.error })
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

  // 어디서 결제할지. 안 보내면 기존과 같이 'pos'다 -- 이 필드를 모르는 전산은 동작이 바뀌지 않는다.
  // 오타를 'pos'로 조용히 바꾸면 전산은 프론트로 보냈다고 믿는데 POS에 뜨므로 400으로 막는다.
  const payTargetRaw = req.body?.payTarget
  const payTarget = payTargetRaw === undefined || payTargetRaw === null || payTargetRaw === '' ? 'pos' : payTargetRaw
  if (payTarget !== 'pos' && payTarget !== 'front') {
    return rejectErpCart(req, res, 400, { ok: false, error: "payTarget은 'pos' 또는 'front'여야 합니다." })
  }

  // 코드로 못 찾으면 사업자번호로 자동 연결을 시도한다(resolveErpStore 주석 참고).
  const resolved = await resolveErpStore(storeCode, req.body?.businessNumber)
  if (resolved.error) {
    return rejectErpCart(req, res, resolved.error.status, resolved.error.body)
  }
  const store = resolved.store
  if (store.status !== 'active') {
    return rejectErpCart(req, res, 403, { ok: false, error: '이용이 중지된 매장이에요. 본사에 문의해주세요.' })
  }

  // referenceId는 매장별이 아니라 **전역** 유일이다(@unique). 그래서 다른 매장이 이미 쓴 번호가
  // 들어오면 아래 멱등 분기가 그 매장의 장바구니를 duplicate로 돌려주게 되고, 보낸 쪽은 성공
  // 응답을 받았는데 실제로는 자기 매장에 아무것도 담기지 않는다 -- 조용히 사라지는 게 가장 나쁜
  // 실패라 명시적으로 막는다. cancelled 건도 마찬가지다: 그냥 두면 createErpCart(upsert)가 그 로우의
  // storeId를 다른 매장으로 바꿔치기해버린다.
  const existingAnyStore = await findErpCartByReference(referenceId)
  if (existingAnyStore && existingAnyStore.storeId !== store.id) {
    return rejectErpCart(req, res, 409, { ok: false, error: '이미 다른 매장에서 사용한 referenceId입니다.' })
  }

  // 멱등: 같은 referenceId가 이미 있고 cancelled가 아니면(pending/loaded/failed 어느 쪽이든)
  // 그 상태를 그대로 돌려준다 -- 새로 만들면 POS가 같은 장바구니를 두 번 집어갈 수 있다.
  // cancelled였다면 전산이 다시 담는 것이므로 새로 생성한다(취소된 건 재사용하지 않는다).
  const existing = await findErpCartByReference(referenceId)
  if (existing && existing.status !== 'cancelled') {
    return res.json({ ok: true, cartId: existing.id, referenceId, status: existing.status, payTarget: existing.payTarget, storeName: store.name, duplicate: true })
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
    payTarget,
  })
  // storeName: 전산(시뮬레이터)이 "어느 매장으로 갔는지" 사람에게 보여줄 수 있게 함께 돌려준다 -- 코드 매핑이 틀려 남의 매장으로 간
  // 주문을 보낸 쪽에서 바로 알아챌 수 있다.
  return res.status(201).json({
    ok: true, cartId: cart.id, referenceId, status: cart.status, payTarget: cart.payTarget, storeName: store.name, linkedReservation: Boolean(reservationId),
  })
}))

// 전산이 담아둔 장바구니의 처리 상태(pending/loaded/failed/cancelled)를 재조회할 수 있게 한다.
app.get('/api/erp/carts/:referenceId', erpIpFloodLimiter, requireErpToken, erpLimiter, asyncHandler(async (req, res) => {
  const cart = await findErpCartByReference(req.params.referenceId)
  if (!cart) {
    return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  return res.json({
    ok: true,
    referenceId: cart.referenceId,
    status: cart.status,
    totalAmount: cart.totalAmount,
    autoPay: cart.autoPay,
    payTarget: cart.payTarget,
    createdAt: cart.createdAt,
    loadedAt: cart.loadedAt,
    paidAt: cart.paidAt,
    refundedAt: cart.refundedAt,
    tossVerified: Boolean(cart.tossVerifiedAt),
    errorMessage: cart.errorMessage,
    // 프론트에서 승인됐지만 이 주문에 반영하지 못한 결제(없으면 null). 이 값이 있으면 손님이 이미 낸 주문일 수 있다 -- 전산이 같은 정비를
    // 새 referenceId로 다시 보내 청구하기 전에 매장과 확인해야 한다. ackAt은 매장이 확인한 시각.
    frontOrphan: frontOrphanOf(cart),
  })
}))

// 전산이 주문을 취소할 때 쓴다. POS가 이미 가져간(loaded) 뒤라면 취소해도 POS 장바구니에는 이미
// 반영돼 있으므로 조용히 넘기지 않고 409로 알려준다 -- 전산 쪽이 "취소했는데 실제로는 결제가
// 진행 중일 수 있다"는 걸 알아야 한다.
// 매장이 아직 확인하지 않은 프론트 미반영 승인(frontOrphan)이 있는 대기 주문도 409 FRONT_ORPHAN으로 막는다 -- 손님이 이미 낸 주문이라,
// 취소되면 POS 목록에서 빠지고 전산이 새 referenceId로 다시 보내면 같은 정비를 또 결제한다. 매장이 확인(탭앱 [확인했어요])하거나 그
// 승인으로 결제 완료를 기록하면 풀린다. 응답에는 늘 frontOrphan을 싣는다.
const ERP_CANCEL_FRONT_ORPHAN_ERROR = '프론트에서 이미 승인된 결제가 있는 주문이라 취소할 수 없습니다. 매장에서 결제 내역을 확인한 뒤 다시 시도해주세요.'
// 대기(pending)가 아닌 주문의 전산 취소. 정확한 상태는 응답 status에 함께 실린다.
const ERP_CANCEL_NOT_PENDING_ERROR = '아직 매장에서 처리하기 전인 주문만 취소할 수 있어요. 이미 POS에 담겼거나 처리된 주문이라 매장에 확인해주세요.'

app.post('/api/erp/carts/:referenceId/cancel', erpIpFloodLimiter, requireErpToken, erpLimiter, asyncHandler(async (req, res) => {
  const cart = await findErpCartByReference(req.params.referenceId)
  if (!cart) {
    return rejectErpCart(req, res, 404, { ok: false, error: '주문을 찾을 수 없습니다.' })
  }
  const frontOrphanBlocked = (row) => {
    logger.warn('[erp] 확인하지 않은 프론트 미반영 승인이 있어 전산 취소를 거절', {
      storeId: row.storeId, cartId: row.id, referenceId: row.referenceId, approvalNo: row.frontOrphanApprovalNo, amount: row.frontOrphanAmount,
    })
    return rejectErpCart(req, res, 409, { ok: false, code: 'FRONT_ORPHAN', error: ERP_CANCEL_FRONT_ORPHAN_ERROR, status: row.status, frontOrphan: frontOrphanOf(row) })
  }
  if (cart.status !== 'pending') {
    return rejectErpCart(req, res, 409, { ok: false, error: ERP_CANCEL_NOT_PENDING_ERROR, status: cart.status, frontOrphan: frontOrphanOf(cart) })
  }
  if (hasUnackedFrontOrphan(cart)) return frontOrphanBlocked(cart)
  const changed = await cancelErpCart(req.params.referenceId)
  if (!changed) {
    // 조회와 취소 사이에 다른 요청(POS consume 등)이 먼저 상태를 바꿨거나 늦은 프론트 승인이 흔적을 남겼을 수 있다 -- 그 사이 값을
    // 다시 읽어 최신 상태를 알려준다.
    const latest = await findErpCartByReference(req.params.referenceId)
    if (latest?.status === 'pending' && hasUnackedFrontOrphan(latest)) return frontOrphanBlocked(latest)
    return rejectErpCart(req, res, 409, { ok: false, error: ERP_CANCEL_NOT_PENDING_ERROR, status: latest?.status, frontOrphan: frontOrphanOf(latest) })
  }
  return res.json({ ok: true, status: 'cancelled', frontOrphan: frontOrphanOf(cart) })
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
// 확실히 안 나간 자동 홍보(발송사 접수 거부 등)는 이만큼 뒤로 미뤄 다시 보낸다. 예전에는 claim만 풀어, promoAt이 그대로라
// 같은 실행의 다음 묶음에서 또 맨 앞에 잡혔다 -- 거부되는 번호가 묶음 크기(100) 이상이면 매 묶음이 그 번호들로 꽉 차, 뒤의
// 정상 대상은 실행 상한(건수·시간)이 끝날 때까지 한 번도 시도되지 않았다(매일 똑같이).
const PROMO_DEFINITE_FAILURE_RETRY_MS = 24 * 60 * 60 * 1000
// 이 기간에 같은 매장·번호로 자동 홍보가 이만큼 확실히 실패했으면 그 결제의 자동 홍보를 "보내지 않음"으로 닫는다.
const PROMO_DEFINITE_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const PROMO_DEFINITE_FAILURE_MAX = 3
// 발송사 계정·설정 탓의 실패(solapi.classifySendFailure 'provider')나 결과를 모르는 실패가 한 실행에서 이만큼 이어지면(그 사이 성공도
// 수신자 탓 실패도 없이) 발송사 쪽 장애로 보고 실행을 멈춘다(stopped:'provider'). 남은 대상은 claim만 풀어 다음 실행에 그대로 보낸다
// -- 계속 돌면 차례가 온 결제마다 실패를 쌓거나(결과 모름은 보낸 것으로 닫는다) 쓸데없이 하루씩 밀린다. 한 건의 실패로는 멈추지 않는다:
// 목록에 없는 상태 코드 하나(그 번호만의 사정일 수 있다) 때문에 전 매장의 발송이 날마다 멈추면 안 된다.
const PROMO_PROVIDER_FAILURE_STOP_AFTER = 3

// 자동 홍보가 확실히 실패했다(지금 실패도 PromoSend 'failed'로 이미 남아 있다). 최근 실패가 상한에 이르렀으면 닫고, 아니면 하루 뒤로 미룬다.
// 수신자 탓의 실패만 이 함수로 온다 -- 발송사 계정·설정 탓은 세지 않고 미루기만 한다(sendDuePromotions).
async function settleDefinitePromoFailure(payment) {
  let failures = 0
  try {
    failures = await countRecentAutoPromoFailures(payment.storeId, payment.phone, new Date(Date.now() - PROMO_DEFINITE_FAILURE_WINDOW_MS))
  } catch (e) {
    // 세지 못하면 미루기만 한다(닫는 쪽은 되돌릴 수 없다).
    logger.error('[promotion-job] 자동 홍보 실패 횟수 조회 실패', { paymentId: payment.id, error: e.message })
  }
  if (failures >= PROMO_DEFINITE_FAILURE_MAX) {
    logger.warn('[promotion-job] 같은 번호로 자동 홍보가 계속 실패해 보내지 않음으로 닫습니다', {
      paymentId: payment.id, storeId: payment.storeId, failures,
    })
    await skipDuePromotion(payment.id, payment.promoClaimedAt)
    return
  }
  await postponeDuePromotion(payment.id, new Date(Date.now() + PROMO_DEFINITE_FAILURE_RETRY_MS), payment.promoClaimedAt)
}

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
  let skipped = 0
  let batches = 0
  let exhausted = false
  let stopped = null
  // 이 실행에서 이어진 발송사 탓·결과 모름 실패 수(PROMO_PROVIDER_FAILURE_STOP_AFTER). 성공하거나 수신자 탓 실패가 나오면 0으로.
  let providerFailureStreak = 0

  // 광고는 야간(21~8시)에 보내지 않는다. 스케줄러 시각이 바뀌거나 사람이 늦게 수동 실행해도 서버가 막는다.
  if (isPromoNightNow()) return { claimed, sent, failed, skipped, batches, exhausted, stopped: 'night' }

  while (true) {
    if (claimed >= maxPerRun || Date.now() - startedAt >= PROMO_TIME_BUDGET_MS) {
      exhausted = true
      break
    }

    const batchLimit = Math.min(PROMO_BATCH_SIZE, maxPerRun - claimed)
    const due = await claimDuePromotions(batchLimit)
    batches += 1
    if (!due.length) break // 더 이상 대상이 없다 = 자연 종료(exhausted=false)

    for (let index = 0; index < due.length; index += 1) {
      const payment = due[index]
      // 묶음 안에서도 시간 예산과 야간을 본다. 넘기면 남은 건의 claim을 풀고 끝낸다 -- 안 풀면 10분 동안
      // 아무도 못 잡고, 그 사이 이 실행이 계속 돌면 다른 실행이 다시 잡은 건과 겹친다.
      const overTime = Date.now() - startedAt >= PROMO_TIME_BUDGET_MS
      const providerDown = providerFailureStreak >= PROMO_PROVIDER_FAILURE_STOP_AFTER
      if (overTime || providerDown || isPromoNightNow()) {
        stopped = overTime ? 'time' : providerDown ? 'provider' : 'night'
        if (providerDown) {
          logger.error('[promotion-job] 발송사 계정·설정 탓 실패가 이어져 자동 홍보 실행을 멈춥니다. 솔라피 잔액·키·발신번호·템플릿을 확인하세요', {
            streak: providerFailureStreak, released: due.length - index,
          })
        }
        for (const rest of due.slice(index)) await releasePromoClaim(rest.id, rest.promoClaimedAt)
        break
      }
      // 수동·기간 지정 발송과 같은 기준으로 다시 본다(store.assessPromoPhones): 수신거부, 그 번호의 최근
      // 의사, 동의 2년, 30일 안의 다른 광고. 발송 기록(PromoSend)도 같이 남겨 다른 경로가 이 발송을 본다.
      const claim = await claimPromoSend({
        storeId: payment.storeId,
        phone: payment.phone,
        carNumber: payment.carNumber,
        sentBy: null,
        via: 'auto',
      })
      if (!claim.ok) {
        skipped += 1
        if (claim.status === 'recently_sent' && claim.lastSentAt) {
          // 다른 경로로 최근에 받았다 -- 30일이 끝날 때까지 미룬다.
          const until = new Date(new Date(claim.lastSentAt).getTime() + PROMO_MIN_INTERVAL_DAYS * 24 * 60 * 60 * 1000)
          await postponeDuePromotion(payment.id, until, payment.promoClaimedAt)
        } else {
          await skipDuePromotion(payment.id, payment.promoClaimedAt)
        }
        continue
      }
      try {
        await solapi.sendPromoAlimtalk({
          phone: payment.phone,
          carNumber: payment.carNumber,
          storeName: payment.store?.name,
          storeId: payment.storeId,
          paymentId: payment.id,
        })
        await finishPromoSend(claim.record.id, 'sent')
        if (await markPromoSent(payment.id)) sent += 1
        providerFailureStreak = 0
        // 같은 방문의 다른 결제(분할·재결제)가 30일 뒤 같은 광고를 또 보내지 않게 닫는다.
        await closeSiblingDuePromotions(payment.storeId, payment.phone, payment.id, PROMO_MIN_INTERVAL_DAYS)
      } catch (notifyError) {
        failed += 1
        // recipient(이 번호 탓) | provider(발송사 계정·설정 탓) | unknown(결과 모름) -- solapi.classifySendFailure
        const failure = solapi.classifySendFailure(notifyError)
        logger.error('프로모션 알림톡 발송 실패', {
          paymentId: payment.id,
          storeId: payment.storeId,
          failure,
          definite: failure !== 'unknown',
          // tag·httpStatus·statusCode·error(요약) -- error.message를 그대로 남기지 않는다(solapi.sendFailureLog)
          ...solapi.sendFailureLog(notifyError),
        })
        if (failure === 'recipient') {
          providerFailureStreak = 0
          await finishPromoSend(claim.record.id, 'failed')
          await settleDefinitePromoFailure(payment)
        } else if (failure === 'provider') {
          // 번호와 무관한 실패라 실패 횟수에 넣지 않고(PromoSend 'failed_provider') 하루 뒤로 미루기만 한다.
          providerFailureStreak += 1
          await finishPromoSend(claim.record.id, 'failed_provider')
          await postponeDuePromotion(payment.id, new Date(Date.now() + PROMO_DEFINITE_FAILURE_RETRY_MS), payment.promoClaimedAt)
        } else {
          // 결과를 모르면(시간 초과 등) 나갔을 수 있으므로 보낸 것으로 닫는다 -- 같은 광고가 두 번 가는 쪽이 더 나쁘다.
          // 나갔다고 보는 것이므로 성공과 같이 같은 방문의 다른 결제도 닫는다(안 닫으면 30일 뒤 같은 광고가 또 나간다).
          providerFailureStreak += 1
          await finishPromoSend(claim.record.id, 'unknown')
          await markPromoSent(payment.id)
          await closeSiblingDuePromotions(payment.storeId, payment.phone, payment.id, PROMO_MIN_INTERVAL_DAYS)
        }
      }
    }
    claimed += due.length
    // 묶음의 마지막 건들에서 연속 실패가 상한에 닿았다 -- 다음 묶음을 잡았다가 바로 풀지 않도록 여기서 멈춘다.
    if (!stopped && providerFailureStreak >= PROMO_PROVIDER_FAILURE_STOP_AFTER) {
      stopped = 'provider'
      logger.error('[promotion-job] 발송사 계정·설정 탓 실패가 이어져 자동 홍보 실행을 멈춥니다. 솔라피 잔액·키·발신번호·템플릿을 확인하세요', {
        streak: providerFailureStreak, released: 0,
      })
    }
    if (stopped) {
      exhausted = stopped === 'time'
      break
    }

    // claim 가능한 건이 요청한 batchLimit보다 적게 나왔다 = 지금 시점에 더 밀린 대상이 없다는 뜻.
    if (due.length < batchLimit) break
  }

  return { claimed, sent, failed, skipped, batches, exhausted, stopped }
}

// Cloud Scheduler가 매일 오전 10시(KST)에 호출한다. Cloud Run 인스턴스마다 cron을 띄우지
// 않고, 공유 claim + promoSent 조건으로 동일 작업의 재전송을 막는다.
// 잡이 돌았는지 알 수 있게 끝날 때마다 고정 이벤트로 남긴다(jsonPayload.event="job_finished" / "job_failed"). 예전에는 성공하면 아무
// 기록이 없어 스케줄러 등록 여부조차 확인할 수 없었다.
app.post('/internal/jobs/send-promotions', requirePromotionJobAuth, asyncHandler(async (req, res) => {
  try {
    const result = await sendDuePromotions()
    logger.info('[promotion-job] 완료', { event: 'job_finished', job: 'send-promotions', ...result })
    return res.json({ ok: true, ...result })
  } catch (error) {
    logger.error('[promotion-job] 처리 실패', { event: 'job_failed', job: 'send-promotions', error: error.message })
    return res.status(500).json({ ok: false, error: '프로모션 작업 처리에 실패했습니다.' })
  }
}))

// 개인정보 보관기간 경과 건 파기(익명화) (계약 §3.25 신규). PROMOTION_JOB_TOKEN을 그대로
// 재사용한다 — 둘 다 "Cloud Scheduler가 부르는 내부 배치 작업"이라는 같은 신뢰 경계이기 때문이다.
// 단계별로 따로 돈다(store.purgeExpiredPersonalData 주석) -- 한 단계가 실패해도 나머지는 끝까지 하고, 실패한 단계가 있으면 500을 돌려
// 스케줄러가 재시도하게 한다(다시 돌려도 결과가 같다). 응답에는 단계별 건수와 errors가 실린다.
app.post('/internal/jobs/purge-expired', requirePromotionJobAuth, asyncHandler(async (req, res) => {
  try {
    const result = await purgeExpiredPersonalData()
    if (result.errors) {
      logger.error('[purge-job] 일부 단계 실패', { event: 'job_failed', job: 'purge-expired', ...result })
      return res.status(500).json({ ok: false, error: '개인정보 파기 작업 일부가 실패했습니다.', ...result })
    }
    logger.info('[purge-job] 완료', { event: 'job_finished', job: 'purge-expired', ...result })
    return res.json({ ok: true, ...result })
  } catch (error) {
    logger.error('[purge-job] 처리 실패', { event: 'job_failed', job: 'purge-expired', error: error.message })
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
    // 상한을 두고 묻는다. 그냥 SELECT 1을 기다리면 DB가 느려졌을 때 레디니스 프로브 자체가
    // 같이 매달려서, 정작 "이 인스턴스를 트래픽에서 빼야 한다"는 판단이 늦어진다.
    // 쿼리 전체에 걸린 statement_timeout(기본 10초)보다 짧아야 의미가 있다.
    await pingDatabaseReady()
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
