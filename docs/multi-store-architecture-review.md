# 토스플레이스 플러그인 검토 + 500개 가맹점 확장 아키텍처

> ⚠️ **이미 해결된 과거 검토 — 2026-07-30 시점 스냅샷이다.**
> 아래 §1 "지금 이대로 여러 가맹점에 배포 가능? → **불가능**", "DB 없음(재시작 시 전체 데이터
> 소실)" 등은 이 문서를 작성한 시점의 상태를 가리키는 것이지 현재 상태가 아니다. 여기서 지적된
> 문제들은 이후 Phase 1~4(가맹점 테이블 + `store_id` 스코핑, PostgreSQL 전환, `hq_admin`/
> `store_admin` 2계층 관리자 인증, 매장 대량 등록)로 전부 해결되었다 — 현재 상태는
> [`README.md`](../README.md)의 "알려진 제한사항 & 다음 단계" 섹션과
> [`docs/01-plan/features/multi-store-support.plan.md`](01-plan/features/multi-store-support.plan.md)를
> 참고할 것. 이 문서는 그 결정 과정과 근거를 남긴 기록이라 내용을 지우지 않고 그대로 둔다 — 아래를
> "지금의 미해결 문제 목록"으로 읽지 말 것.
>
> 작성일: 2026-07-30 (최초) / 2026-07-30 재검토 반영
> 대상: `backend/` (Express 서버 + `toss-plugin/` 토스프론트 플러그인)
> 현재 상태: Phase 1~4(DB 전환, 가맹점 식별, 관리자 2계층 인증, 대량 온보딩+웹훅) 구현 완료. 아래 §0은
> 실제 `docs.tossplace.com`을 직접 대조해서 재검토한 결과다.

---

## 0. 2026-07-30 재검토 — 실제 토스 문서 대조 결과

최초 작성 시점(§1~6, 아래)에는 원 개발자가 남긴 코드/주석을 근거로 검토했는데, 실제 `docs.tossplace.com`을
직접 열어서 대조해보니 **두 가지를 잘못 짚고 있었다.**

| 항목 | 최초 검토 결과 | 실제 문서 확인 결과 | 조치 |
| --- | --- | --- | --- |
| 가맹점 식별 API | `sdk.merchant.id`/`sdk.serialNumber`를 "안 읽고 버리는 게 문제"라고 지적 | 애초에 **그런 프로퍼티가 문서에 없음.** 진짜 API는 App API의 비동기 함수 `await sdk.app.getMerchant()` / `await sdk.app.getSerialNumber()` ([문서](https://docs.tossplace.com/reference/plugin-sdk/front/app.html)) | `reservation.html`/`payment.html`/`sdk.js`를 실제 API로 재작성 완료 |
| 웹훅 서명 검증 | "구조만 잡아둔 자리표시자"라고 명시하고 `JSON.stringify(req.body)` 기반으로 임시 구현 | 실제 스펙은 `HMAC-SHA256(secret, "{x-toss-timestamp}.{원본 raw body}")` → hex → `v1=` 접두사, `x-toss-timestamp` 신선도 검사 필요 ([문서](https://docs.tossplace.com/reference/open-api/webhook.html)) | `server.js` 웹훅 핸들러를 실제 스펙으로 재작성, `express.json({ verify })`로 raw body 확보 완료 |
| Template API (`renderIdlePage` 등) | 확인 안 함(원 개발자 코드를 신뢰) | 실제 문서와 **파라미터까지 정확히 일치** ([문서](https://docs.tossplace.com/reference/plugin-sdk/front/template.html)) | 수정 불필요 |
| 결제 웹훅 payload의 `paymentKey` | (당시엔 언급 없음) | 실제 payload(`data.payment` 객체)에 **`paymentKey` 필드가 없음** ([문서](https://docs.tossplace.com/reference/open-api/payment.html)). 우리 쪽 `paymentKey`(클라이언트가 생성해 `sdk.payment.requestPayment()`에 넘기는 값)가 이 객체의 어떤 필드와 대응되는지 공개 문서로는 미확인 | 여전히 미해결 — 지금은 웹훅 수신 시 로그만 남기고 자동으로 결제 레코드를 만들지 않도록 보수적으로 구현(잘못된 매칭 방지). `developer-support@tossplace.com` 문의 필요 |

**교훈**: 원 개발자의 코드 주석("~라고 안내되어 있어서", "~에 나와 있음")을 사실 확인 없이 그대로 믿으면 안
된다는 걸 이번에 확인했다. `sdk.overrides()`(로컬 개발용 오버라이드 함수)도 실제 문서 어디에도 없는
함수였다 — 있어도 그만 없어도 그만인 방어적 코드(`sdk.js`가 이제 `sdk.app.getMerchant`가 없을 때만
채워 넣는 방식)로 바꿔서, 실제 API가 있으면 그대로 쓰고 없으면(로컬 미리보기) 안전하게 대체하도록 했다.

---

## 1. 결론 요약

| 구분 | 내용 |
| --- | --- |
| 지금 이대로 여러 가맹점에 배포 가능? | **불가능.** 모든 예약/결제가 하나의 전역 배열에 섞여서 어느 매장 손님인지 구분이 안 됨 |
| 가장 시급한 문제 | 플러그인이 토스 SDK가 주는 `merchant.id`(가맹점 식별자)를 아예 안 읽고 버림 |
| 두 번째 시급한 문제 | DB 없음(재시작 시 전체 데이터 소실) + 관리자 인증이 토큰 1개 공유 |
| 500개 가맹점을 다루려면 | ① 가맹점 테이블 + 모든 데이터에 `store_id` 부여 ② 실제 DB ③ 매장별 관리자 로그인 ④ 무료 호스팅 탈피 |

아래 순서로 설명합니다: **(2) 토스 SDK 문서 대비 플러그인 코드 문제점 → (3) 500개 가맹점용 서버 아키텍처 → (4) 관리자 페이지 설계 → (5) 단계별 마이그레이션 로드맵**

---

## 2. 토스 Front SDK 플러그인 코드 검토

`docs.tossplace.com` 연동 가이드 기준으로 실제 파일을 대조한 결과입니다.

### 2.1 Critical — 멀티 가맹점 확장을 막는 문제

**① `merchant.id`/`serialNumber`를 읽지도, 서버로 보내지도 않음**

- `backend/public/toss-plugin/sdk.js`는 로컬 개발용 오버라이드만 정의하고,
  `reservation.html`(`backend/public/toss-plugin/reservation.html:99-105`)과
  `payment.html`(`backend/public/toss-plugin/payment.html:121` 부근)의 `fetch()` 바디에는
  `carNumber`/`phone`/`serviceType`/`amount`만 담깁니다. `sdk.merchant.id`나 `sdk.serialNumber`는
  어디서도 읽어서 요청에 실어 보내지 않습니다.
- 토스 SDK는 단말기에 온보딩된 실제 가맹점 정보(`merchant.id`, `merchant.name`, `merchant.businessNumber`,
  `serialNumber`)를 제공하도록 설계되어 있는데(문서: "실제 토스프론트 단말기에서는... 단말기에 온보딩된
  실제 가맹점 정보가 사용된다" — `sdk.js` 주석에도 명시), 지금 코드는 이 값을 그냥 버립니다.
- 결과: 매장이 2곳 이상이 되는 순간 A매장 예약과 B매장 예약이 서버에서 구분 불가능해집니다.

**② 서버(`server.js`)와 저장소(`src/store.js`)에 가맹점 개념 자체가 없음**

- `reservations`/`payments` 배열이 프로세스 전역 변수 하나씩입니다 (`src/store.js:8-9`).
  `getNextWaitingReservation()`, `listReservations()` 전부 매장 필터링 없이 전체를 대상으로 동작합니다.
- 즉 지금 코드에 매장 A의 `merchant.id`를 넘겨받는 기능을 추가해도, `store.js`가 그 값을 저장/필터링하는
  구조가 아니라서 반쪽짜리 수정이 됩니다. **API·DB 계층을 함께 고쳐야 합니다.**

**③ `onboarding.html`이 이미 이 문제를 알고 있음**

- `backend/public/toss-plugin/onboarding.html:14-21`의 주석: *"단일 매장 전용 플러그인이라 자체 로그인이
  필요하지 않다... 나중에 매장이 여러 곳으로 늘어나면 `sdk.storage` 기반 토큰 저장 패턴을 참고해서
  구현하면 된다"* — 정확히 지금 하려는 작업을 가리키고 있습니다. 즉 원 개발자도 단일 매장 임시 구조임을
  인지하고 있었습니다.

### 2.2 Important — 지금 구조로도 문제, 확장 시 반드시 고쳐야 함

| 문제 | 위치 | 설명 |
| --- | --- | --- |
| DB 없음 (인메모리) | `src/store.js:1` | README에 이미 알려진 제한사항으로 명시됨. 재배포/재시작마다 예약·결제·3개월 프로모션 예약 전부 소실. 500개 매장이면 매일 상당한 트래픽이 생기는데 이 상태로는 서비스 불가 |
| 관리자 인증이 토큰 1개 | `server.js:47-53` (`requireAdmin`) | `ADMIN_TOKEN` 하나를 모든 관리자가 공유. 매장별 접근 제어 불가능(A매장 직원이 B매장 데이터도 다 봄), 토큰 유출 시 전체 매장 노출, 감사 로그(누가 삭제/호출했는지) 없음 |
| CORS 전면 허용 | `server.js:30` (`app.use(cors())`) | origin 제한 없이 전체 허용. 결제·예약 API가 공개 상태이므로 최소한 등록된 ACL 도메인/토스프론트 오리진으로 제한 권장 |
| 정비 항목이 3곳에 하드코딩 | README 자체 언급 (`server.js` `SERVICE_TYPES`, `reservation.html`, `admin.html`) | 매장마다 취급 품목/가격이 다를 수 있는데 지금은 코드 수정 없이는 매장별 커스터마이즈 불가 |
| 결제 승인 웹훅 미수신 | README "다음 단계" | 클라이언트가 결제 성공 후 직접 `/api/payments`를 호출하는 방식이라, 네트워크 실패 시 결제는 됐는데 서버 기록이 안 남는 case 발생 가능. 매장 수가 늘수록 이 갭의 총량도 커짐 |
| Render 무료 플랜 슬립 | README 명시 | 매일 10시 프로모션 크론이 슬립 중이면 안 돌아감. 매장 500개 트래픽이면 유료 플랜 필수가 되므로 사실상 해소되지만, 그 전엔 외부 헬스체크 핑으로 임시 완화 필요 |
| Rate limit이 IP 단위 | `server.js:55-69` | 매장 여러 곳이 같은 NAT/프록시 뒤에 있으면(예: 프랜차이즈 본사 공용 회선) 서로 영향을 줄 수 있음. 매장(store_id) 단위 제한으로 전환 필요 |

### 2.3 Minor / 참고

- `payment.html`, `reservation.html`의 `API_BASE` 하드코딩(`chevroletcode.onrender.com`)은 단일 서버 전제라 문제없지만, 멀티 리전/스케일아웃 시 ACL 도메인 관리 정책과 맞물려 재검토 필요.
- Solapi 발신번호(`SOLAPI_SENDER`)와 카카오 채널(`SOLAPI_KAKAO_PFID`)이 전역 1개뿐입니다. 브랜드 공용 채널로 계속 갈지, 가맹점별 발신을 분리할지는 사업적 결정이 필요합니다(3.4절 참고).
- 웹훅(§ README "결제 완료를 서버에서 더 확실하게 받으려면")은 토스플레이스 담당자에게 별도 문의해야 등록 가능 — 500개 매장 규모라면 이 시점에 반드시 진행 권장.

---

## 3. 500개 가맹점을 관리하는 서버 아키텍처

### 3.1 핵심 원칙: Multi-tenant, `store_id`가 모든 테이블의 1급 시민

```
stores (가맹점)
  id (PK), store_code(고유코드), name, business_number,
  toss_merchant_id(=SDK merchant.id, unique), toss_serial_number,
  phone_sender(발신번호), kakao_pf_id(nullable→브랜드 공용값 상속),
  service_types(JSONB, 매장별 정비항목 커스터마이즈),
  status(pending/active/suspended), created_at

store_admins (매장 관리자 계정)
  id, store_id(FK, nullable=본사 슈퍼관리자), email/phone, password_hash,
  role(hq_admin | store_admin | store_staff), created_at, last_login_at

reservations
  id, store_id(FK, NOT NULL, 인덱스), car_number, phone, service_type,
  queue_number(매장별로 매일 리셋), status, created_at, called_at, completed_at

payments
  id, store_id(FK, NOT NULL, 인덱스), payment_key(unique), car_number,
  service_type, phone, amount, status, promo_at, promo_sent, created_at

audit_logs (감사 로그)
  id, store_id, actor(admin id), action, target_id, created_at
```

- **모든 조회/쓰기 쿼리에 `WHERE store_id = ?`가 강제되도록** 데이터 접근 계층(리포지토리)을 만들어서,
  실수로 매장 간 데이터가 섞이는 걸 코드 레벨에서 방지합니다 (예: `store_id`를 요구하는 함수 시그니처로
  `src/store.js`를 다시 설계).
- `queue_number`(대기번호)는 매장별·날짜별로 리셋되어야 하므로 `(store_id, date)` 기준 시퀀스로 관리합니다
  (지금 `store.js`의 전역 `dailyQueueCounter`를 매장별 컬럼/카운터로 분리).

### 3.2 가맹점 식별 플로우 (Critical 이슈 ①의 해결책)

1. **온보딩 시점**: 본사가 `stores` 테이블에 매장을 먼저 등록(§4 관리자 페이지에서) → `store_code` 발급.
2. **토스플레이스 개발자센터**에서 해당 매장의 "테스트/실 가맹점"을 만들 때 발급되는 `merchant.id`를
   `stores.toss_merchant_id`에 매핑해서 저장 (1회성 등록 작업, 매장 오픈 시마다 반복).
3. **플러그인 코드 수정**: `toss-plugin/*.html`에서 `sdk.merchant.id`(또는 `sdk.serialNumber`)를 읽어
   모든 API 요청 바디/헤더에 포함시킵니다.
   ```js
   // 예시 — reservation.html, payment.html 공통
   const merchant = sdk.merchant // { id, name, businessNumber }
   fetch(`${API_BASE}/api/reservations`, {
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ carNumber, phone, serviceType, merchantId: merchant.id }),
   })
   ```
4. **서버**: `merchantId`를 받아 `stores.toss_merchant_id`로 조회해 내부 `store_id`로 변환 후 저장.
   등록 안 된 `merchantId`가 오면 400 응답(= 아직 본사가 승인 안 한 매장).
5. `sdk.js`의 로컬 오버라이드 패턴(`merchant.id: 0`)은 그대로 두되, 서버에도 `merchant.id === 0`을
   "개발용 테스트 매장"으로 시드해두면 로컬 개발 흐름이 안 끊깁니다.

### 3.3 DB / 인프라

| 항목 | 권장 | 이유 |
| --- | --- | --- |
| DB | PostgreSQL (Supabase 관리형 또는 RDS) | README에서도 이미 Supabase를 최우선 TODO로 언급. 관계형 데이터(매장-예약-결제)에 적합, 트랜잭션/인덱스 지원 |
| 접근 계층 | Prisma 또는 Knex 같은 쿼리 빌더 + 마이그레이션 도구 | `src/store.js`의 함수 시그니처를 유지한 채 내부만 교체하는 기존 설계 원칙과 맞음. raw SQL 문자열 조립 금지(인젝션 방지) |
| 커넥션 풀 | DB 프록시(Supabase pgbouncer 등) 또는 앱 레벨 풀 | 500개 매장이면 관리자 페이지 + 플러그인 동시 접속이 늘어남 → 커넥션 고갈 방지 |
| 앱 서버 | Node 인스턴스 stateless화 + 오토스케일(Render 유료 플랜 / Fly.io / AWS ECS 등 택1) | 인메모리 상태(`store.js`처럼)를 DB로 옮기면 여러 인스턴스로 수평 확장 가능해짐 |
| 스케줄러 | 3개월 프로모션 `cron`을 **웹 프로세스와 분리된 워커**로 (예: 별도 Render Cron Job / AWS EventBridge + Lambda) | 지금처럼 웹 프로세스에 `node-cron`을 얹으면 무료 플랜 슬립·오토스케일 시 중복 실행/미실행 위험. 매장 수가 늘수록 이 잡의 신뢰성이 매출에 직결됨(프로모션 문자) |
| 모니터링 | 구조화 로그(JSON, `store_id` 포함) + 에러 트래킹(Sentry 등) + 알림톡 발송 성공률 대시보드 | 500개 매장 규모에서 특정 매장만 발송 실패하는 케이스를 빠르게 찾아야 함 |
| 결제 웹훅 수신 | `payment.payment.approved.v1`/`cancelled.v1` 엔드포인트 추가 + `x-toss-signature` 검증 + `x-toss-webhook-id` 중복 방지 | 클라이언트 콜백 유실을 서버가 보완. 500개 매장 규모에서는 필수급으로 격상 권장 (토스플레이스 담당자에게 웹훅 등록 요청 필요) |

### 3.4 알림톡/문자 발신 정책 (사업적 결정 필요)

- **옵션 A — 브랜드 공용 발신**: 모든 매장이 "쉐보레 서비스센터" 명의 카카오 채널(`pfId`) 1개 + 발신번호 1개 공유,
  메시지 안의 `#{매장명}` 변수로만 구분. 구현이 가장 단순하고 지금 `solapi.js` 구조를 거의 그대로 재사용 가능.
- **옵션 B — 매장별 발신번호**: 프랜차이즈 각 지점이 별도 사업자라면, 통신망법상 발신자 실명 확인 요건 때문에
  매장별 발신번호 등록이 필요할 수 있음. 이 경우 `stores.phone_sender`를 매장마다 채워 `solapi.js`가
  `store_id` 기준으로 발신번호를 선택하도록 확장.
- 카카오 알림톡 템플릿은 브랜드 단위로 1세트만 승인받고 변수(`#{매장명}`, `#{매장연락처}` 등)로 매장을 구분하는 게
  현실적입니다(매장마다 템플릿을 따로 심사받으면 500번 심사해야 함).
- **권장**: 우선 옵션 A로 시작하고, 실제 가맹 계약 구조(직영 vs 프랜차이즈 개별 사업자)에 따라 발신번호만
  옵션 B로 전환할 수 있게 `solapi.js`를 `store_id` 파라미터 받는 구조로 미리 설계.

### 3.5 API 변경 요약 (기존 엔드포인트에 `store_id` 스코프 추가)

| 엔드포인트 | 변경 |
| --- | --- |
| `POST /api/reservations`, `POST /api/payments` | 바디에 `merchantId`(SDK 값) 필수 → 서버가 `store_id`로 변환 |
| `GET /api/reservations`, `GET /api/payments`, `.../failed` | 관리자 토큰의 role에 따라 자동 필터: `store_admin`은 자기 `store_id`만, `hq_admin`은 쿼리파라미터 `?storeId=`로 특정 매장 조회 또는 전체 |
| `POST /api/queue/call-next`, `/:id/call`, `/:id/complete`, `DELETE /:id` | 대상 리소스의 `store_id`가 요청자의 권한 범위 안인지 검증 후 처리 (다른 매장 예약을 조작 못 하게) |
| 신규: `POST /api/admin/stores`, `GET /api/admin/stores`, `PATCH /api/admin/stores/:id` | 본사 전용, 가맹점 등록/조회/활성화·비활성화 |

---

## 4. 관리자 페이지 설계

현재 `admin.html`은 토큰 1개로 로그인하는 **단일 화면**입니다. 500개 매장 운영에는 **2계층 관리자 구조**가 필요합니다.

### 4.1 본사(HQ) 관리자

- **가맹점 관리**: 매장 등록(상호/사업자번호/`toss_merchant_id` 매핑)/승인/비활성화, 매장별 정비항목·발신번호 설정
- **전체 현황판**: 매장별 오늘 예약 수/대기 인원/결제 건수/알림톡 발송 실패율을 매장 목록에서 한눈에
- **매장 드릴다운**: 특정 매장을 선택하면 그 매장 전용 화면(4.2와 동일 UI)을 그대로 조회 가능 (읽기 우선, 필요 시 대리 조작)
- **감사 로그 열람**: 어떤 관리자가 어느 매장에서 무엇을 했는지 (`audit_logs`)
- **알림톡 발송 통계**: 브랜드 전체 발송 성공/실패 추이, 실패 사유 Top N

### 4.2 가맹점(Store) 관리자

- 로그인 시 자신의 `store_id`로 자동 스코프 — 지금 `admin.html`의 예약/결제 조회·호출·완료·삭제 기능을
  거의 그대로 재사용하되, API가 자기 매장 데이터만 반환하도록 서버에서 강제
- 대기열 호출/완료 처리, 테스트 예약 생성(기존 기능 유지)
- 자기 매장 알림톡 발송 실패 건 확인

### 4.3 인증 방식 변경

- 현재: `x-admin-token` 헤더 1개 값 비교 (`server.js:47-53`)
- 변경: 이메일/비밀번호(또는 매장별 관리자 초대 링크) 로그인 → 서버가 JWT 발급(role: `hq_admin`/`store_admin`,
  `store_id` 클레임 포함) → 이후 요청은 `Authorization: Bearer <jwt>`
- 미들웨어를 `requireAdmin` 하나에서 `requireAuth` + `requireRole(role)` + `scopeToStore` 조합으로 분리
- 비밀번호는 bcrypt 해시 저장, 세션/토큰 만료 시간 설정, (선택) 2단계 인증은 나중 단계에서 고려

### 4.4 화면 우선순위 (구현 순서 제안)

1. 매장 등록/조회 (HQ) — 이게 없으면 3.2절의 가맹점 식별 자체가 불가능
2. 매장 관리자 로그인 + 자기 매장 스코프 예약/결제 화면 (기존 `admin.html` 리팩터링)
3. HQ 전체 현황판 (매장별 요약 통계)
4. 감사 로그 / 알림톡 발송 통계 (운영 안정화 단계)

---

## 5. 단계별 마이그레이션 로드맵

기존 코드를 한 번에 갈아엎지 않고, **지금 단일 매장 운영을 막지 않으면서** 단계적으로 확장하는 순서입니다.

| 단계 | 내용 | 산출물 |
| --- | --- | --- |
| **0단계 (선행)** | 솔라피 알림톡 키/템플릿 발급, `ADMIN_TOKEN` 발급 — README에 이미 있는 TODO. 이건 몇 개 매장이든 필요 | `.env` 값 채움 |
| **1단계 — DB 전환** | `src/store.js`를 Postgres(Prisma) 기반으로 교체하되, **아직은 단일 매장 그대로**(스키마에 `store_id` 컬럼만 미리 넣고 고정값 사용). README에서 이미 최우선으로 지목한 작업 | 재배포해도 데이터 안 사라짐, 3개월 프로모션 유실 문제 해결 |
| **2단계 — 가맹점 식별 도입** | `stores` 테이블 추가, 플러그인이 `sdk.merchant.id`를 API에 실어 보내도록 3개 HTML 수정, 서버가 `merchantId → store_id` 변환 | 매장 2곳부터 데이터가 안 섞임 |
| **3단계 — 관리자 2계층화** | JWT 로그인 도입, `store_admin`/`hq_admin` role 분리, 기존 `admin.html`을 매장 스코프로 리팩터링 + HQ 현황판 신규 | §4 화면 완성 |
| **4단계 — 500개 온보딩 준비** | 매장 등록 API/화면으로 대량 등록 지원(CSV 업로드 등), 발신번호 정책(§3.4) 확정, 웹훅 수신 엔드포인트 추가 | 실제 가맹점 순차 온보딩 시작 가능 |
| **5단계 — 스케일 검증** | 유료 호스팅 전환(무료 플랜 슬립 제거), 커넥션 풀/인덱스 점검, 부하 테스트(동시 예약/결제 시뮬레이션), 감사 로그·모니터링 대시보드 | 500개 매장 동시 운영 가능한 상태 |

**중요**: 2단계(가맹점 식별)를 건너뛰고 바로 매장을 늘리면, 지금 구조에서는 A매장 손님이 B매장 대기열에
섞여서 호출되는 등 실서비스 사고로 직결됩니다. 반드시 1→2단계 순서를 지켜야 합니다.

---

## 6. 우선순위 한눈에 보기

1. 🔴 **DB 전환** (README 기존 TODO, 500개 매장이 아니어도 필수)
2. 🔴 **가맹점 식별 흐름 구현** (`merchant.id` 캡처 → `store_id` 매핑) — 500개 매장 확장의 전제조건
3. 🟠 **관리자 인증을 매장 단위 계정으로 전환** (지금의 토큰 1개 공유 구조는 매장이 2곳만 돼도 위험)
4. 🟠 **결제 웹훅 수신 등록** (토스플레이스 담당자 문의 필요 — 지금 시작해도 됨)
5. 🟡 발신번호/알림톡 채널 정책 결정 (사업 구조에 따라 A/B 택 1)
6. 🟡 유료 호스팅/스케일 아웃 전환 (트래픽 늘어나는 시점에 맞춰 진행)
