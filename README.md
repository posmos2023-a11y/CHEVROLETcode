# 🚗 쉐보레 포스모스 — 토스플레이스 예약·결제 플러그인

![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/express-4.x-000000?logo=express&logoColor=white)
![Deploy](https://img.shields.io/badge/deploy-Render-46E3B7?logo=render&logoColor=white)
![Status](https://img.shields.io/badge/status-active-brightgreen)
![License](https://img.shields.io/badge/license-Private-lightgrey)

캐치테이블 스타일의 차량 정비 예약 · 대기열 호출 · 결제 전자영수증 알림톡 플러그인입니다.
매장에 설치된 **토스프론트 결제 단말기**에서 실제로 동작하는 Front Plugin과, 브라우저 어디서나 접속 가능한
**독립 웹페이지** 두 가지 형태로 제공됩니다.

- 🔗 저장소: https://github.com/one030728-cloud/CHEVROLETcode
<!-- TODO(운영): 정본 확정 필요 — 아래 표시는 잠정 값이다. Dockerfile/Cloud Run 인프라가 최신이고
     TODO.md의 GCP 이전 작업이 Cloud Run을 대상으로 진행 중이라 정본 후보로 표시해뒀지만, 실제로 손님이
     접속하는 운영 트래픽이 지금 Render/Cloud Run 중 어느 쪽인지는 운영 담당자만 확정할 수 있다.
     결정되면 이 주석을 지우고 레거시 쪽 항목은 "폐기됨" 또는 삭제로 정리할 것. -->
- ☁️ **정본(source of truth, 잠정) — GCP Cloud Run**: https://chevrolet-api-813801981857.asia-northeast3.run.app
- 🌐 **레거시/롤백 대상 — Render**: https://chevroletcode.onrender.com
  (GCP 전환 이전의 운영 배포. Cloud Run 장애 시 롤백처로 당분간 유지하고, 정본이 확정되면
  [`TODO.md`](TODO.md)에 폐기 시점을 기록할 것)

## 목차

- [개요](#개요)
- [주요 기능](#주요-기능)
- [빠른 시작](#빠른-시작)
- [프로젝트 구조](#프로젝트-구조)
- [API](#api)
- [토스프론트 플러그인 연동](#토스프론트-플러그인-연동)
- [환경 변수 / 알림톡 설정](#환경-변수--알림톡-설정)
- [개인정보·광고성 정보 처리](#개인정보광고성-정보-처리)
- [Render 배포](#render-배포)
- [GCP 이전 및 트래픽 확장 계획](docs/gcp-migration-and-scale-plan.md)
- [TODO](TODO.md)
- [알려진 제한사항 & 다음 단계](#알려진-제한사항--다음-단계)

## 개요

백엔드(Express) 하나가 두 프론트를 함께 서빙합니다.

| 버전 | 경로 | 설명 |
| --- | --- | --- |
| 독립 웹페이지 | `backend/public/index.html` (`?mode=payment`) | 브라우저 어디서나 접속 가능한 범용 버전. 플러그인이 탭앱으로 띄울 땐 `?merchantId=`를 함께 넘겨야 함 |
| 토스프론트 플러그인 | `front-plugin/` (백엔드가 `/toss-plugin` 경로로 정적 서빙) | 매장 단말기(토스프론트)에서 실행되는 실제 플러그인. [토스플레이스 Front SDK](https://docs.tossplace.com/)의 Template API(`sdk.template.renderXxxPage`)와 결제 API(`sdk.payment.requestPayment`) 사용 |
| 토스 POS 탭앱 | [`pos-plugin/`](pos-plugin/README.md) | POS 화면에 탭으로 추가되는 정비 대기열 관리 플러그인(호출/완료). `@tossplace/pos-plugin-sdk` 기반, 별도 빌드 필요 |

자세한 내용은 [토스프론트 플러그인 연동](#토스프론트-플러그인-연동) 섹션과 [`pos-plugin/README.md`](pos-plugin/README.md) 참고.

## 주요 기능

- **예약 접수 + 실시간 대기 안내** — 차량번호 → 정비 항목(엔진오일 교체/정기점검/타이어 교체·펑크수리/배터리 교체/브레이크 정비/기타 수리·상담) → 전화번호 입력만으로 대기번호 발급
- **수동 순서 호출** — 예약 접수만으로는 호출하지 않고, 직원이 POS/관리자 화면에서 호출 버튼을 눌렀을 때만 "고객님의 순서입니다" 알림톡 발송
- **정비완료 기반 대기열** — 알림톡 발송 여부가 아니라 관리자가 직접 처리하는 "정비완료" 상태로 대기인원을 계산해 실제 매장 상황을 반영
- **결제 즉시 전자영수증** — 결제 화면에서 차량번호를 다시 입력받지 않고, 전화번호로 예약 기록을 조회해 차량번호·정비항목을 자동으로 매칭
- **3개월 후 자동 프로모션 알림톡** — 매일 오전 10시 스케줄러가 결제일 기준 대상자 확인 후 발송
- **관리자 대시보드** (`/admin.html`) — 예약/결제 전체 조회, 특정 예약 즉시 호출·정비완료·삭제, 테스트 예약 생성
- **카카오 알림톡 → SMS 자동 폴백** — 채널/템플릿 승인 전에도 일반 문자로 즉시 테스트 가능

## 빠른 시작

```bash
git clone https://github.com/one030728-cloud/CHEVROLETcode.git
cd CHEVROLETcode/backend
npm install
cp .env.example .env   # 값은 비워둬도 서버는 뜹니다 (알림톡 발송만 실패, 예약/결제 접수는 정상 처리됨)
npx prisma migrate deploy   # 로컬 SQLite DB(backend/prisma/dev.db) 생성 (계정 발급 불필요)
npm start
```

필요한 것은 **Node.js 18 이상**뿐입니다. DB는 로컬 SQLite 파일(`prisma/dev.db`)을 그대로 쓰므로 외부 서비스 계정 없이도
로컬에서 예약·결제 접수 흐름을 바로 테스트할 수 있고, 이제 서버를 재시작해도 데이터가 남아있습니다
(알림톡 발송만 솔라피 키가 있어야 실제로 나갑니다). 운영 배포 시 Postgres로 전환하는 방법은
[`docs/multi-store-architecture-review.md`](docs/multi-store-architecture-review.md) 참고.

| 접속 주소 | 내용 |
| --- | --- |
| `http://localhost:3000` | 독립 웹페이지 — 차량번호 → 전화번호 예약 폼 |
| `http://localhost:3000/?mode=payment` | 독립 웹페이지 — 결제(영수증) 모드 |
| `http://localhost:3000/toss-plugin/index.html` | 토스프론트 플러그인 화면을 브라우저에서 미리보기 |
| `http://localhost:3000/admin.html` | 관리자 대시보드 (이메일/비밀번호 로그인) |

## 프로젝트 구조

```
backend/                    # 공유 서버 + DB — 아래 두 플러그인이 전부 이 서버 하나의 API를 호출한다
  server.js                 # Express 서버 (예약/결제 API + /api/pos/* + 대기순번 호출 + 3개월 프로모션 스케줄러)
                             # front-plugin/, pos-plugin/dist/ 정적 서빙도 겸함(로컬 미리보기용)
  src/
    solapi.js              # 알림톡 발송 함수 (예약안내/순서호출/영수증/프로모션 템플릿별로 분리)
    store.js                # DB 데이터 계층 (Prisma, SQLite 로컬/Postgres 운영)
    auth.js                 # 관리자 비밀번호 해시/JWT 발급·검증
  prisma/
    schema.prisma            # Store/Reservation/Payment/QueueCounter/AdminUser 모델
  public/
    index.html, reservation.js, styles.css   # 독립 웹페이지 버전 (?mode=payment로 결제 모드, ?merchantId= 필요)
    admin.html                                # 관리자 대시보드

front-plugin/                # 토스프론트 플러그인 (독립 프로젝트 폴더, 빌드 불필요)
  index.html                # 대기화면 (예약하기/결제하기 2버튼)
  reservation.html           # 차량번호 → 정비항목 → 전화번호 → 대기번호 (Template API)
  payment.html                # 금액입력 → 실제 결제(sdk.payment) → 전화번호 → 영수증
  onboarding.html, settings.html, sdk.js   # 템플릿 요구 파일 (자세한 설명은 파일 내 주석)
  api-config.js                            # window.CHEVROLET_API_BASE_URL 설정(빌드 시 placeholder 치환)
  package.ps1, package.sh                  # 공식 업로드용 ZIP 생성 스크립트 (npm run zip은 package.ps1 호출,
                                            # PowerShell 없는 환경은 package.sh 직접 실행)

pos-plugin/                  # 토스 POS 탭앱 (독립 프로젝트 폴더, esbuild 빌드 필요 — pos-plugin/README.md 참고)
  src/app.js                # 대기열 조회/호출/완료. 매장 식별은 X-Store-Token 헤더로 하고,
                             # posPluginSdk.merchant.getMerchant()는 화면에 보여줄 매장명 표시용 보조 정보로만 사용
  public/, build.js          # 탭 매니페스트/빌드 스크립트 (manifest의 tab.href 포함)
  package.ps1, package.sh    # dist 빌드 + 공식 업로드용 ZIP 생성 (npm run zip은 package.ps1 호출,
                             # PowerShell 없는 환경은 package.sh 직접 실행)
```

## API

용도별로 인증 방식이 다릅니다 — 손님용 API는 `merchantId`로 매장만 식별(사실상 무인증), POS 탭앱은
매장별 발급 토큰(`X-Store-Token`), 관리자 화면은 로그인 후 JWT, 배치 작업은 별도 공유 토큰을 씁니다.

### 손님용 (무인증, `merchantId`로 매장 식별)

| 메서드/경로 | 설명 | 인증 |
| --- | --- | --- |
| `POST /api/reservations` | 차량번호+정비항목(`serviceType`)+전화번호로 대기번호(매장·날짜별 독립 채번) 발급. `privacyConsent: true`가 없으면 400(개인정보 수집·이용 동의 필수), `marketingConsent: true`면 광고 수신동의 시각 기록. 응답에 `serviceDate`(접수일 KST) 포함, `peopleAhead`는 오늘 서비스 날짜 기준으로 계산. `Idempotency-Key` 헤더로 중복 접수 방지 | 없음 (10분당 5회 IP 레이트리밋) |
| `POST /api/payments` | 전화번호(+금액/`paymentKey`) 등록, 차량번호/정비항목은 같은 매장·전화번호의 예약 기록에서 자동 매칭. `privacyConsent: true` 필수(없으면 400), `amount`는 0~1억 사이 정수만 허용(그 외 400). 전자영수증 즉시 발송, 3개월 후 프로모션 예약(동의한 경우만) | 없음 (10분당 10회 IP 레이트리밋) |
| `POST /api/webhooks/toss/payment` | 결제 승인/취소 웹훅(백업 경로). `x-toss-webhook-id` 중복 방지 → 서명 검증(`x-toss-signature`) → 본 처리 순서로 실행하고, 본 처리가 실패하면 웹훅 기록을 지우고 500을 반환해 토스가 재시도하게 함. **`NODE_ENV=production`에서 `TOSS_WEBHOOK_SECRET` 미설정 시 서버가 부팅하지 않음**(§환경 변수) | 없음(웹훅 전용, 토스가 호출) |
| `GET /health` | 헬스체크(liveness). DB 접근 없이 즉시 `200 'ok'` | 없음 |
| `GET /health/ready` | 헬스체크(readiness). `SELECT 1` 성공 시 `200 {ok:true}`, 실패 시 `503 {ok:false}` — Cloud Run 등에서 새 리비전으로 트래픽을 넘기기 전 DB 연결 확인용 | 없음 |

### 관리자 화면용 (JWT)

목록 조회 3종(`GET /api/reservations`, `/api/reservations/failed`, `/api/payments`, `/api/payments/failed`)은
공통으로 아래 쿼리 파라미터와 응답 형태를 씁니다.

| 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `storeId` | — | `hq_admin`만 유효(전체 매장 중 필터). `store_admin`이 보내면 무시하고 자기 매장으로 고정 |
| `date` | 없음(전체 기간) | KST 날짜 `YYYY-MM-DD`. 예약은 `serviceDate`, 결제는 `createdAt`의 KST 날짜 기준 |
| `status` | 없음 | 콤마로 구분한 상태값(예: `waiting,called`). `/failed` 계열은 이 값을 무시하고 각각 `notify_failed`/`receipt_failed`로 고정 |
| `limit` | `100` | 1~500으로 클램프 |
| `offset` | `0` | 0 이상 |

응답은 `{ ok, count, total, hasMore, reservations }`(또는 `payments`) 형태입니다 — `count`는 이번 페이지
건수, `total`은 필터 적용 후 전체 건수, `hasMore`는 `offset + count < total`. **서버가 이미
`createdAt desc`로 정렬해서 내려주므로 관리자 화면에서 다시 정렬/역순 처리하지 않습니다.**

| 메서드/경로 | 설명 | 인증 |
| --- | --- | --- |
| `GET /api/reservations` | 예약 목록 조회(위 공통 파라미터/응답) | JWT (Bearer) |
| `GET /api/reservations/failed` | 순서/접수 알림톡 발송 실패 건(`notify_failed`) 조회 | JWT (Bearer) |
| `GET /api/payments` | 결제 목록 조회(위 공통 파라미터/응답) | JWT (Bearer) |
| `GET /api/payments/failed` | 전자영수증 발송 실패 건(`receipt_failed`) 조회 | JWT (Bearer) |
| `POST /api/queue/call-next?storeId=` | 지정한 매장의 **오늘(KST) 서비스 날짜** `waiting` 중 대기번호가 가장 앞선 손님만 호출(어제 이월분은 호출 안 함), "순서입니다" 알림톡 발송 | JWT (Bearer) |
| `POST /api/reservations/:id/call` | 특정 예약을 순서와 무관하게 즉시 호출 (`waiting` 상태만 가능) | JWT (Bearer) |
| `POST /api/reservations/:id/complete` | 정비완료 처리. 이후 예약들의 "앞사람" 계산에서 빠짐 | JWT (Bearer) |
| `POST /api/reservations/:id/cancel` | **신규.** `waiting`/`called`/`notify_failed` → `cancelled`. 이미 취소된 건이면 `alreadyCancelled: true`로 200 응답, 이미 완료된 건이면 409 | JWT (Bearer) |
| `POST /api/reservations/:id/retry-notify` | **신규.** `notify_failed` 상태만 허용(아니면 409). 순서 안내 알림톡을 재발송하고 성공하면 `called`로, 실패해도 `notify_failed`를 유지한 채 200으로 응답(재시도 자체가 실패라는 신호는 응답의 `sent: false`로 전달) | JWT (Bearer) |
| `DELETE /api/reservations/:id` | 예약 삭제 (테스트 데이터 정리) | JWT (Bearer) |
| `POST /api/payments/:id/retry-receipt` | **신규.** `receipt_failed` 상태만 허용(아니면 409). 전자영수증 알림톡 재발송, 응답 형태는 `retry-notify`와 동일한 패턴(`sent` 플래그) | JWT (Bearer) |
| `GET /api/admin/stores` | 등록된 가맹점(매장) 목록 조회. 각 매장 객체에 `posToken`(POS 탭앱 인증용) 포함 | JWT (Bearer), `hq_admin` 전용 |
| `POST /api/admin/stores` | 가맹점 등록. `merchantId`+매장명(+사업자번호)을 받아 내부 `store_id`와 **POS 토큰을 함께 자동 발급** | JWT (Bearer), `hq_admin` 전용 |
| `POST /api/admin/stores/bulk` | 매장 대량 등록(최대 500건), 항목별 성공/실패를 나눠서 반환. 성공 항목마다 `posToken` 포함 | JWT (Bearer), `hq_admin` 전용 |
| `POST /api/admin/stores/:id/pos-token` | **신규.** 해당 매장의 POS 토큰을 재발급(회전) — 기존 토큰은 즉시 무효화됨. 없는 매장이면 404 | JWT (Bearer), `hq_admin` 전용 |
| `POST /api/admin/store-admins` | 매장 관리자 계정 발급. `merchantId`로 매장을 찾아 그 매장에 스코프된 `store_admin` 계정 생성 | JWT (Bearer), `hq_admin` 전용 |
| `POST /api/admin/login` | 이메일/비밀번호로 로그인, JWT 발급(`role`: `hq_admin`\|`store_admin`, `storeId` 포함). 기존 IP 레이트리밋에 더해 **같은 계정 비밀번호 5회 연속 실패 시 15분 계정 잠금**(423 응답) 추가 | 없음 |
| `GET /api/admin/me` | 로그인한 관리자 본인 정보(역할, 소속 매장) 조회. `store` 객체에 `posToken` 포함(자기 매장이므로 `store_admin`도 조회 가능) | JWT (Bearer) |

### POS 탭앱용 (`X-Store-Token`, ⚠️ 인증 방식이 바뀜)

`merchantId`는 더 이상 POS API의 인증 수단이 아닙니다(요청에 실려도 무시됩니다) — 매장별로 발급된
64자리 hex 토큰을 `X-Store-Token` 헤더로 보내야 합니다. 토큰이 없거나 틀리면 401
(`STORE_TOKEN_REQUIRED`/`INVALID_STORE_TOKEN`), 매장이 비활성 상태면 403을 반환합니다. 발급/재발급
절차는 바로 아래 [POS 토큰 발급·재발급 운영 절차](#pos-토큰-발급재발급-운영-절차) 참고.

| 메서드/경로 | 설명 | 인증 |
| --- | --- | --- |
| `GET /api/pos/queue` | 오늘(KST) 서비스 날짜의 대기열(정비완료·취소 제외)을 대기번호순으로 조회. **전화번호는 마스킹**(`010-****-5678`)해서 내려줌(POS 화면에 원본이 필요 없음) | `X-Store-Token` |
| `POST /api/pos/queue/:id/call` | 오늘 등록된 해당 매장 예약만 호출 가능(아니면 404) | `X-Store-Token` |
| `POST /api/pos/queue/:id/complete` | 오늘 등록된 해당 매장 예약만 정비완료 처리 | `X-Store-Token` |
| `POST /api/pos/queue/:id/cancel` | **신규.** 노쇼 등으로 대기열에서 제외. `waiting`/`called`/`notify_failed` → `cancelled` | `X-Store-Token` |

### 내부 배치 작업용 (`X-Promotion-Job-Token`, Cloud Scheduler가 호출)

| 메서드/경로 | 설명 | 인증 |
| --- | --- | --- |
| `POST /internal/jobs/send-promotions` | 결제 3개월 경과 + 광고성 정보 수신에 동의(`marketingConsentAt` not null)한 손님에게 프로모션 알림톡 발송. 100건씩 배치로 claim해 **1회 실행 최대 `PROMO_MAX_PER_RUN`건(기본 2000) 또는 50초 예산**까지 처리하고, 상한에 걸려 남은 대상이 있으면 `exhausted: true` | `X-Promotion-Job-Token` |
| `POST /internal/jobs/purge-expired` | **신규.** `DATA_RETENTION_DAYS`(기본 1095일)보다 오래된 예약/결제 중 아직 파기 안 된 건의 전화번호·차량번호를 익명화(`anonymizedAt` 기록). 한 번에 최대 1000건씩 최대 10회 반복 | `X-Promotion-Job-Token` |

### POS 토큰 발급·재발급 운영 절차

POS 탭앱은 이제 매장마다 다른 64자리 hex 토큰(`Store.posToken`)이 있어야 대기열 API를 호출할 수
있습니다(§API POS 탭앱용). 운영 절차는 다음과 같습니다.

1. **발급 (매장 등록 시 자동)** — 본사(`hq_admin`)가 관리자 화면(`/admin.html`)에서 `POST /api/admin/stores`로
   매장을 등록하면 `posToken`이 자동으로 함께 발급됩니다. 대량 등록(`/bulk`)도 동일합니다.
2. **직원 입력 (최초 1회)** — 매장 직원이 POS 탭앱을 처음 열면 토큰 입력 화면이 뜹니다. 본사 또는
   매장관리자가 관리자 화면의 **POS 토큰 관리** 표에서 해당 매장 토큰을 "보기"/"복사"해 전달하면, 직원이
   그 값을 한 번 입력합니다. 입력한 토큰은 POS 단말기의 `localStorage`에 저장되어 이후에는 다시
   묻지 않습니다.
3. **재발급(회전)** — 토큰이 유출됐거나(직원 퇴사, 단말기 분실 등) 정기 로테이션이 필요하면 `hq_admin`이
   관리자 화면에서 **재발급** 버튼(`POST /api/admin/stores/:id/pos-token`)을 누릅니다. **재발급 즉시 기존
   토큰은 무효화되며, 그 토큰을 쓰던 모든 POS 단말기는 다음 요청부터 401(`INVALID_STORE_TOKEN`)을 받고
   자동으로 토큰 재입력 화면으로 돌아갑니다** — 그러므로 재발급 직후 매장에 새 토큰을 다시 전달해야
   대기열 화면이 끊기지 않습니다. `store_admin`은 조회/복사만 가능하고 재발급 권한은 없습니다(`hq_admin` 전용).
4. **로컬 개발** — 자동 시드되는 테스트 매장(`merchantId '0'`)은 최초 생성 시 토큰이 비어 있을 수 있으므로,
   관리자 화면에서 한 번 재발급을 눌러 값을 채워야 합니다. 자세한 절차는
   [`pos-plugin/README.md`의 "로컬 미리보기"](pos-plugin/README.md#로컬-미리보기) 참고.

<details>
<summary>멀티 가맹점(매장) 구조 — merchantId ↔ store_id, 2계층 관리자</summary>

- 예약/결제 API는 `merchantId`(토스 SDK가 단말기에서 넘겨주는 `sdk.merchant.id`)를 필수로 받습니다.
  등록되지 않은 `merchantId`면 404를 반환합니다 — 본사가 `/api/admin/stores`로 먼저 매장을 등록해야
  그 매장의 플러그인 요청이 통과됩니다.
- 모든 예약/결제 레코드는 내부 `storeId`로 스코프됩니다(Postgres/SQLite, Prisma). 대기번호(`queueNumber`)도
  매장별·날짜별로 원자적으로 독립 채번되고, 결제 화면의 전화번호→예약 매칭(`findLatestReservationByPhone`)도
  같은 매장 안에서만 찾습니다.
- 로컬 개발/미리보기는 `front-plugin/sdk.js`의 `merchant.id: 0` 오버라이드와 짝을 맞춰 서버가 부팅 시
  `merchantId: '0'` 테스트 매장을 자동으로 시드해둡니다.
- **관리자 인증은 이메일/비밀번호 + JWT 2계층 구조**입니다. `hq_admin`(본사)은 전체 매장을 보고 매장/매장관리자를
  등록할 수 있고, `store_admin`(가맹점)은 로그인하는 순간 자기 `storeId`로 강제 스코프되어 다른 매장의
  예약/결제는 조회·조작(`/complete`, `/call`, `DELETE`)이 전부 403으로 막힙니다. 최초 부팅 시 `hq_admin` 계정이
  없으면 자동 생성됩니다(§환경 변수 참고).
- `admin.html` 상단에 매장 선택 드롭다운("전체 매장" 포함, `hq_admin`만 보임)과 "매장 등록"/"매장 관리자 계정 발급"
  폼이 있습니다. `store_admin`으로 로그인하면 이 드롭다운/폼은 숨겨지고 자기 매장 화면만 보입니다.
- 자세한 아키텍처와 남은 로드맵(Phase 4 대량 온보딩, Phase 5 스케일 검증)은
  [`docs/multi-store-architecture-review.md`](docs/multi-store-architecture-review.md)와
  [`docs/01-plan/features/multi-store-support.plan.md`](docs/01-plan/features/multi-store-support.plan.md) 참고.

</details>

<details>
<summary>세부 동작 참고</summary>

- `serviceType`은 `엔진오일 교체`/`정기점검`/`타이어 교체·펑크수리`/`배터리 교체`/`브레이크 정비`/`기타 수리·상담` 중 하나를 가리키는 키
  (`oil`/`inspection`/`tire`/`battery`/`brake`/`etc`)입니다. 서버([server.js](backend/server.js)의 `SERVICE_TYPES`), 토스프론트 예약 화면
  ([front-plugin/reservation.html](front-plugin/reservation.html)), 관리자 페이지([admin.html](backend/public/admin.html)) 세 군데에
  같은 목록이 하드코딩돼 있어서, 항목을 추가/변경할 땐 세 파일을 함께 고쳐야 합니다.
- 관리자 페이지(`/admin.html`)에는 실제 손님 없이 예약을 넣어볼 수 있는 "테스트 예약 생성" 폼이 있습니다 — 대기인원 안내와
  수동 호출 동작을 확인할 때 씁니다.
- `POST /api/payments`에 `paymentKey`(토스프론트에서 `sdk.payment.requestPayment()` 호출 시 발급한 값)를 같이 보내면,
  같은 `paymentKey`로 재요청해도 기존 레코드를 그대로 반환합니다 (영수증 중복 발송 방지, 결제 화면 네트워크 재시도 대비).
- 알림톡을 보냈다고 자동으로 대기열 "앞사람"에서 빠지는 게 아닙니다 — 정비가 실제로 끝나면 관리자 페이지에서 그 예약의
  "완료" 버튼을 눌러야(`POST /api/reservations/:id/complete`) 다음 예약이 "앞에 아무도 없음"으로 계산됩니다.
- 결제 화면에서 차량번호를 다시 입력받지 않는 대신, 전화번호로 `findLatestReservationByPhone`가 그 손님의 예약 기록을 찾습니다
  (같은 날 예약을 우선하고, 없으면 그 번호로 등록된 가장 최근 예약을 사용). 예약 없이 바로 결제하러 온 손님은 매칭되는 기록이 없어
  차량번호/정비항목 없이 영수증이 나갑니다.
- 예약 상태값은 `waiting`(대기중)/`called`(호출완료)/`notify_failed`(알림실패)/`completed`(정비완료)/`cancelled`(취소됨) 5가지,
  결제 상태값은 `requested`/`receipt_sent`/`receipt_failed`/`cancelled` 4가지입니다. 관리자 화면에서 예약/결제를 취소하면
  알림톡 발송 실패(`notify_failed`/`receipt_failed`) 건도 "재시도" 버튼으로 즉시 재발송을 시도할 수 있습니다(§API).
- 관리자 로그인은 IP 기준 레이트리밋 외에 **같은 계정이 비밀번호를 5회 연속 틀리면 15분 잠금**됩니다(계정 존재 여부는
  여전히 노출하지 않도록, 존재하지 않는 이메일은 이전과 동일하게 401만 돌려줍니다).

</details>

## 토스프론트 플러그인 연동

`front-plugin/`이 실제 토스 결제 단말기(토스프론트)에서 돌아가는 플러그인입니다(백엔드가 `/toss-plugin` 경로로 정적 서빙).
[토스플레이스 연동 가이드](https://docs.tossplace.com/)를 확인해서 아래 구조로 만들었습니다.

- CDN에서 `https://cdn.tossplace.com/toss-front-sdk/v0/index.js`를 불러오면 전역 `window.TossFrontSDK`가 생깁니다.
- 화면은 반드시 SDK가 제공하는 **Template API**(`sdk.template.renderIdlePage`, `renderInputPage`, `renderSelectPage`, `renderResultPage` 등)로만
  구성해야 합니다. 심사 때 이 부분을 확인한다고 안내되어 있어서, 이 플러그인의 자유 형식 HTML/CSS(`public/index.html` 쪽)는
  토스프론트 안에서는 그대로 못 쓰고 Template API로 다시 짰습니다.
- 실제 결제는 `sdk.payment.requestPayment({ paymentKey, tax, supplyValue, tip })`로 단말기가 직접 처리합니다.
  이 저장소의 Express 백엔드는 결제 자체를 처리하지 않고, 결제 성공 후 수집한 전화번호로 영수증 알림톡을 보내고
  DB에 적재하는 역할만 합니다.
- 파일별 역할은 `sdk.js`(로컬 개발용 가맹점 정보 오버라이드), `index.html`(대기화면), `reservation.html`(예약),
  `payment.html`(결제+영수증), `onboarding.html`/`settings.html`(템플릿이 요구하는 표준 파일, 이 매장은 단일 매장이라
  실질적인 로그인/설정 로직은 없고 파일 안 주석에 이유를 적어뒀습니다)로 나뉩니다.

### 로컬 미리보기

`npm start` 후 `http://localhost:3000/toss-plugin/index.html`으로 접속하면 단말기 없이 브라우저에서 확인할 수 있습니다
(토스 문서에도 "기본 개발은 단말기 없이 브라우저로 가능"하다고 나와 있음). 예약 흐름(차량번호→정비항목→전화번호→대기번호)과
결제 흐름(금액입력→결제수단선택→전화번호→영수증)을 브라우저로 직접 클릭해서 끝까지 확인했고, 실제로 백엔드에
`POST /api/reservations`, `POST /api/payments`가 정상 호출되어 대기번호/영수증 상태까지 저장되는 것을 확인했습니다.

### 실제 단말기에 배포하려면 (사업자 계정 필요)

토스플레이스 개발자센터는 사업자 계정으로 로그인해야 해서 대신 진행할 수 없는 단계입니다. 문서 기준 절차는 다음과 같습니다.

1. [토스플레이스 개발자센터](https://developers.tossplace.com/login)에 로그인 → **내 플러그인 → 플러그인 등록**,
   타입은 "토스프론트"로 선택 (플러그인 이름/ID/회사명 입력). ACL에는 `https://chevroletcode.onrender.com`을 등록
   (이 문서 상단의 배포 주소 정본이 Cloud Run으로 확정되면 이 ACL도 함께 옮겨야 합니다 — `TODO(운영)` 참고)
2. 등록하면 예제 기반 기본 플러그인이 자동 생성됨 (이 저장소의 `front-plugin/` 코드로 교체할 부분)
3. **테스트 가맹점 관리**에서 기존 테스트 가맹점 선택 또는 신규 생성 → 매장고유번호/사업자번호/휴대폰번호 발급
4. 테스트 가맹점 상세화면에서 이 플러그인 사용 여부를 켬
5. 실제 토스프론트 단말기(또는 테스트 단말기)에서 사업자번호/매장고유번호/휴대폰번호로 온보딩
6. 코드 수정 후 `cd front-plugin && npm run zip`으로 `chevrolet-front-plugin.zip`을 생성하고
   개발자센터 **내 플러그인 → 개발 배포 → 개발용 파일 추가** → **배포** 클릭
   (개발 배포는 검수 없이 최대 5개 단말기까지 즉시 반영, 전체 단말기 반영은 검수 후 **라이브 배포**)
7. 프론트 설정 → `7055` → 플러그인 업데이트 또는 토스 프론트 재시작
8. 문의사항은 developer-support@tossplace.com

> ⚠️ 프로젝트 전체(`server.js`, `.env`, `public/index.html` 등)를 통째로 압축하면 안 됩니다 — 단말기가 진짜 플러그인
> 화면(Template API) 대신 독립 웹페이지를 잘못 로드해 키보드 겹침 등 예상치 못한 문제가 생깁니다.

### 토스 POS 탭앱 배포

`pos-plugin/`은 토스 POS **탭 화면(iframe 패키지)** 방식으로 구현되어 있습니다. `main.js`가 필수인
POS 스크립트 직접 로드(UMD/웹 워커) 방식과 다르므로, 현재 ZIP에는 `main.js` 대신 다음 파일이 들어갑니다.

```text
index.html
iframe-manifest.json   # tab.title / tab.description / tab.href: "index.html"
bundle.js              # src/app.js 번들
```

```bash
cd pos-plugin
npm install
npm run zip             # build 후 chevrolet-pos-plugin.zip 생성
```

생성된 ZIP을 개발자센터의 **내 플러그인 → 개발 배포 → 개발용 파일 추가**에 업로드하고, 테스트 POS를
테스트 단말기로 등록한 뒤 POS를 재시작합니다. 개발 배포는 최대 5개 단말기에서 검수 없이 확인할 수
있으며, 라이브 배포는 검수와 VAN 대리점의 플러그인 활성화가 필요합니다.

공식 방식은 [POS iframe 패키지 가이드](https://docs.tossplace.com/guide/pos-integration/plugin/develop/iframe-package.html),
[POS UMD(main.js) 가이드](https://docs.tossplace.com/guide/pos-integration/plugin/develop/umd.html),
[프론트 개발 배포 가이드](https://docs.tossplace.com/guide/front-integration/plugin/develop/develop-environment.html)를
기준으로 정리했습니다. 자세한 명령과 체크리스트는 각 폴더의 README를 참고하세요.

<details>
<summary>결제 완료를 서버에서 더 확실하게 받으려면 (선택, 계정/문의 필요)</summary>

토스플레이스는 결제 승인/취소 시 **웹훅**(`payment.payment.approved.v1`, `payment.payment.cancelled.v1`)을 지원합니다
([Open API 문서](https://docs.tossplace.com/reference/open-api/webhook.html)). 지금 구현은 `payment.html`이 결제 성공 후
클라이언트에서 직접 `/api/payments`를 호출하는 방식인데, 만약 이 호출이 네트워크 문제로 실패하면 결제는 됐는데 영수증/DB
적재가 안 되는 경우가 생길 수 있습니다. 웹훅을 받으면 이런 누락을 서버 쪽에서 보완할 수 있는데, **웹훅 등록은 개발자센터에서
자체적으로 설정할 수 없고 토스플레이스 담당자에게 별도로 문의해서 설정해야 한다**고 문서에 나와 있습니다
(수신 주소/이벤트 범위를 담당자가 등록, `x-toss-signature`로 위변조 검증, `x-toss-webhook-id`로 중복 수신 방지 필요).
지금 당장은 클라이언트 호출 방식만으로도 동작하니, 필요할 때 담당자 문의 후 웹훅 수신 엔드포인트를 추가하면 됩니다.

</details>

## 환경 변수 / 알림톡 설정

```env
PORT=3000

# DB. 로컬은 SQLite 파일 그대로, 운영은 Postgres 연결 문자열로 교체.
DATABASE_URL="file:./dev.db"

# 관리자 로그인(JWT) 서명 키. 운영에서는 반드시 긴 랜덤 문자열로 고정. 비워두면 로컬 개발용 임시값 자동 생성.
JWT_SECRET=

# 최초 부팅 시 자동 생성되는 본사(hq_admin) 계정. 비워두면 admin@local + 무작위 비밀번호(콘솔 1회 출력).
ADMIN_BOOTSTRAP_EMAIL=
ADMIN_BOOTSTRAP_PASSWORD=

# 솔라피 (알림톡)
SOLAPI_API_KEY=
SOLAPI_API_SECRET=
SOLAPI_SENDER=                       # 발신번호 (사전등록 필요)
SOLAPI_KAKAO_PFID=                   # 카카오 채널 pfId
SOLAPI_KAKAO_TEMPLATE_RESERVATION=   # 예약 접수 안내 (모든 예약)
SOLAPI_KAKAO_TEMPLATE_QUEUE_TURN=    # "고객님의 순서입니다" 순서 호출
SOLAPI_KAKAO_TEMPLATE_RECEIPT=       # 결제 전자영수증
SOLAPI_KAKAO_TEMPLATE_PROMO=         # 결제 3개월 후 홍보
```

카카오 알림톡은 채널 개설 + 템플릿 승인이 필요해서 보통 1~3영업일이 걸립니다. `SOLAPI_KAKAO_PFID`와 각 템플릿 ID가
비어 있으면 자동으로 **일반 문자(SMS)**로 대신 보내도록 되어 있어서, 승인을 기다리지 않고도 바로 전체 흐름을 테스트할 수 있습니다.

<details>
<summary>카카오 알림톡 승인 전, 일반 문자로 먼저 테스트하기</summary>

1. [솔라피](https://solapi.com) 가입
2. 콘솔 → API Key 관리에서 `SOLAPI_API_KEY`/`SOLAPI_API_SECRET` 발급
3. 콘솔 → 발신번호 관리에서 본인 번호를 발신번호로 등록(본인인증) → `SOLAPI_SENDER`에 입력
4. 계정에 소액 충전 (문자는 건당 과금)
5. `.env`에 위 세 값만 채우고(카카오 관련 값은 비워둠) 서버 재시작 → 예약/결제 시 일반 문자로 발송됨

나중에 카카오 채널/템플릿이 승인되면 `SOLAPI_KAKAO_PFID`와 템플릿 ID들을 채우기만 하면 코드 변경 없이
자동으로 알림톡 발송으로 전환됩니다.

</details>

<details>
<summary>알림톡 템플릿 변수</summary>

| 변수 | 설명 |
| --- | --- |
| `#{차량번호}` | 예) 12가3456 |
| `#{전화번호}` | 하이픈 없는 숫자만 |
| `#{대기번호}` | 예약 순번 (예약/순서호출 템플릿) |
| `#{대기인원}` | 내 앞에 대기중인 인원수 (예약 접수 템플릿 전용) |
| `#{정비항목}` | 예약 시 선택한 정비 종류 (예: 엔진오일 교체). 예약 접수/순서호출/영수증 템플릿에서 사용. 영수증에서는 전화번호로 찾은 예약 기록에서 가져오며, 매칭되는 예약이 없으면 빈 값 |
| `#{결제금액}` | 예) "15,000원" (영수증 템플릿) |
| `#{수신거부}` | 무료수신거부 안내 문구(`PROMO_OPT_OUT_TEXT`, 기본값은 §개인정보·광고성 정보 처리 참고). 프로모션(광고) 템플릿 전용 |

</details>

## 개인정보·광고성 정보 처리

> ⚠️ **이 섹션의 동의/수신거부 문구와 보관기간(`DATA_RETENTION_DAYS`)은 아직 법무 검토를 거치지 않았습니다.**
> 실제 서비스에 적용하기 전에 반드시 법무 검토(개인정보보호법, 정보통신망법 제50조 등)를 받아야 합니다 —
> 아래 내용은 "기능적으로 동의 수집·광고 구분·파기 로직이 만들어져 있다"는 것이지, 문구 자체가 법적으로
> 완결됐다는 뜻이 아닙니다.

- **수집 동의.** 예약(`POST /api/reservations`)과 결제(`POST /api/payments`) 화면 모두 `privacyConsent: true`를
  실제 사용자 동의 UI(체크박스 등)를 통해 받아야 요청이 통과합니다 — 동의 없이 하드코딩으로 `true`를
  보내면 안 됩니다(front-plugin/backend 공용 화면 모두 동일). 동의 시각은 `privacyConsentAt`에 저장됩니다.
- **광고 수신동의.** `marketingConsent: true`를 함께 보낸 손님만 `marketingConsentAt`이 기록되고,
  결제 3개월 후 프로모션 알림톡(`POST /internal/jobs/send-promotions`) 대상에 포함됩니다. 동의하지 않은
  손님에게는 광고성 알림톡이 발송되지 않습니다 — 예약/접수/순서호출/영수증 같은 정보성 알림톡은 동의
  여부와 무관하게 그대로 발송됩니다(광고가 아니므로).
- **광고 문구 표시 의무(정보통신망법 제50조 대응).** 프로모션 알림톡은 맨 앞에 `(광고) ` 접두사가 붙고,
  맨 끝에 무료수신거부 안내(`PROMO_OPT_OUT_TEXT` 환경변수, 미설정 시 기본값
  "무료수신거부: 매장으로 연락 주시면 즉시 처리해 드립니다.")가 따라붙습니다. 지금 기본값은 "매장으로
  연락"하는 방식뿐이라 실제로 정보통신망법이 요구하는 수준(예: 무료 전화/URL 등 구체적 수신거부 수단)을
  충족하는지는 검토가 필요합니다.
- **보관기간 및 파기.** `POST /internal/jobs/purge-expired`(Cloud Scheduler가 주기 호출, `X-Promotion-Job-Token`
  인증)가 `DATA_RETENTION_DAYS`(기본 1095일 = 3년)보다 오래된 예약/결제 기록의 전화번호·차량번호를
  익명화합니다(`anonymizedAt` 기록). 결제 기록은 전화번호를 `null`로, 예약 기록은 `phone` 컬럼이
  `NOT NULL`이라 `'0100000000'`(더미값)으로 바꿉니다. 보관기간 3년이 업종·기록 성격에 맞는 값인지도
  법무 검토 대상입니다.
- **관리자 화면에서 개인정보 노출 최소화.** POS 탭앱(`GET /api/pos/queue`)은 전화번호를 마스킹된 형태
  (`010-****-5678`)로만 내려받습니다 — 매장 직원이 대기열 화면에서 원본 전화번호를 볼 필요가 없기
  때문입니다. 관리자 대시보드(JWT)는 여전히 원본을 보여줍니다(고객 응대/환불 등에 필요).

## Render 배포

이미 https://chevroletcode.onrender.com 에 연결되어 있습니다. 새로 설정할 경우:

1. Render → New → Web Service → 이 저장소(`one030728-cloud/CHEVROLETcode`) 연결
2. Root Directory: 비워두기 (저장소 루트)
3. Build Command: `cd backend && npm install && npx prisma migrate deploy && cd ../pos-plugin && npm install && npm run build`
4. Start Command: `cd backend && npm start`
5. Environment 탭에서 위 `DATABASE_URL`(Postgres 연결 문자열 — Render 무료 플랜은 재배포 시 로컬 파일이 초기화되므로
   SQLite가 아니라 반드시 외부 Postgres 사용), `JWT_SECRET`, `ADMIN_BOOTSTRAP_*`, `SOLAPI_*` 키들을 등록.
   **Render는 기본적으로 `NODE_ENV=production`으로 실행되므로 `TOSS_WEBHOOK_SECRET`을 반드시 같이
   등록해야 합니다** — 비어 있으면 서버가 부팅 자체를 하지 못합니다(§환경 변수).
6. `main` 브랜치에 push하면 Render가 자동 재배포합니다 (Auto-Deploy 켜져 있는 경우)

> ⚠️ Render 무료 플랜은 트래픽이 없으면 슬립 상태가 되어 오전 10시 프로모션 스케줄러가 안 돌 수 있습니다.
> 이 문제를 없애려면 유료 플랜(항상 켜짐) 또는 외부 크론(예: cron-job.org가 `/health`를 주기적으로 호출)이 필요합니다.

## GCP 이전 및 트래픽 확장

GCP 이전을 위한 애플리케이션·데이터베이스·배포 기반 작업은 완료되어 있습니다.

- Prisma datasource를 PostgreSQL로 전환하고 운영용 migration을 추가했습니다.
- 저장소 루트의 `Dockerfile`로 Cloud Run에서 빌드·실행할 수 있습니다. 이제 `npm ci`(lockfile 고정)로
  빌드하고, `RUN_MIGRATIONS_ON_BOOT=true`(기본값)면 기존처럼 컨테이너 부팅 시 `prisma migrate deploy`를
  실행합니다 — 콜드스타트마다 여러 인스턴스가 동시에 뜨는 Cloud Run 환경에서는 이게 advisory lock
  경합/크래시 루프의 원인이 될 수 있으므로, 트래픽이 늘면 이 값을 `false`로 바꾸고 마이그레이션을
  별도 사전 단계(Cloud Run Job 등)로 분리하는 걸 권장합니다(자세한 이유는 `Dockerfile` 주석,
  변수 목록은 `backend/.env.example` 참고).
- Cloud Run의 상태 확인(startup/liveness probe)은 `GET /health`(DB 접근 없는 liveness)와
  `GET /health/ready`(`SELECT 1`로 DB 연결까지 확인하는 readiness)를 구분해서 등록하세요.
- Cloud Scheduler가 호출할 `/internal/jobs/send-promotions`(프로모션 발송)와
  `/internal/jobs/purge-expired`(개인정보 보관기간 경과분 파기, §개인정보·광고성 정보 처리) 작업
  endpoint와 인증(`X-Promotion-Job-Token`)을 추가했습니다.
- Front/POS API 주소를 환경별 설정으로 분리했습니다.
- Cloud Run은 트래픽에 따라 인스턴스를 자동 확장하는데, Prisma 커넥션 풀은 인스턴스마다 따로 생기므로
  `DATABASE_URL`에 `?connection_limit=`을 지정해 Cloud SQL 커넥션 한도를 넘지 않게 해야 합니다
  (`backend/.env.example` 참고, 구체적인 값 결정은 아직 안 됨 — TODO).
- 현재 확인된 운영 리소스는 `chevrolet-postgres` Cloud SQL과
  `chevrolet-api` Cloud Run(`asia-northeast3`)입니다.

Secret Manager 이전, 운영 데이터 마이그레이션, Toss ACL 전환, 부하·복구 검증 등
실제 운영 전환에 필요한 남은 작업은 [`TODO.md`](TODO.md)와
[`docs/gcp-migration-and-scale-plan.md`](docs/gcp-migration-and-scale-plan.md)에 정리되어 있습니다.

## 알려진 제한사항 & 다음 단계

<details open>
<summary><strong>현재 상태</strong></summary>

- **프로덕션 하드닝 1차 완료 (2026-08-24).** 크래시 방지(`asyncHandler`, 전역 에러 핸들러,
  `unhandledRejection`/`uncaughtException` 처리, graceful shutdown), 보안 헤더/CSP, 관리자 API
  CORS 제한(`ADMIN_ALLOWED_ORIGINS`), 로그인 계정 잠금, POS 탭앱 토큰 인증(`X-Store-Token`,
  merchantId 기반 인증 폐지), 예약/결제 목록 페이지네이션, 예약/영수증 수동 재시도(`retry-notify`/
  `retry-receipt`)와 취소 API, 개인정보 수집·광고 수신 동의 수집 + 보관기간 경과 파기 작업
  (`purge-expired`), `npm ci` 기반 재현 가능한 Docker 빌드, Cloud Run 크래시 루프 방지용
  `RUN_MIGRATIONS_ON_BOOT` 옵션, CI에 POS 번들 빌드 검증/구문 검사 추가까지 반영했습니다.
  **아직 안 된 것**: 개인정보·광고 문구 법무 검토, Render/Cloud Run 중 운영 정본 확정,
  Redis/Cloud Armor 등 인스턴스 간 공유 레이트리밋, 실제 부하 테스트 — 자세한 남은 작업은
  [`TODO.md`](TODO.md) 참고.
- **GCP용 DB 전환 기반 완료 (PostgreSQL, Prisma).** `backend/prisma/schema.prisma`의 provider를
  PostgreSQL로 전환하고 `backend/prisma/migrations/20260805120000_init_postgresql/` 운영 migration을
  추가했습니다. Cloud Run 컨테이너는 `DATABASE_URL`로 Cloud SQL에 연결합니다. 운영 데이터 export/import,
  Secret Manager 연결, 재배포 후 데이터 유지와 부하 검증은 아직 남아 있습니다.
- **멀티 가맹점 지원 (Phase 1~4 완료).** `merchantId` 기반 매장 식별 + DB 스코핑, 이메일/비밀번호 + JWT 기반
  2계층 관리자 인증(`hq_admin`/`store_admin`), 매장 대량 등록(`POST /api/admin/stores/bulk`), 알림톡
  발신 정책(브랜드 공용 + `#{매장명}` 변수 구분), 결제 웹훅 수신 엔드포인트(백업 경로, 실제 등록은 토스 담당자
  문의 필요)까지 구현되었습니다. 남은 건 Phase 5(운영 Postgres 전환, 스케일/부하 검증) —
  `docs/01-plan/features/multi-store-support.plan.md` 참고.
- **토스 SDK 공식 문서 대조 재검토 완료 (2026-07-30).** 실제 `docs.tossplace.com`을 확인해서 아래 2가지 Critical
  버그를 찾아 수정했습니다.
  - `sdk.merchant`/`sdk.serialNumber`는 **실존하지 않는 API**였습니다 — 실제로는 App API의 비동기 함수
    `await sdk.app.getMerchant()` / `await sdk.app.getSerialNumber()`([문서](https://docs.tossplace.com/reference/plugin-sdk/front/app.html))만 존재합니다.
    이전 코드로는 **실제 단말기에서 merchantId가 항상 undefined**가 되어 모든 예약/결제 요청이 실패했을
    것입니다. `reservation.html`/`payment.html`/`sdk.js`를 실제 API 기준으로 수정했습니다.
  - 웹훅 서명 검증 방식을 실제 스펙(`HMAC-SHA256(secret, "{timestamp}.{rawBody}")` → hex, `v1=` 접두사,
    `x-toss-timestamp` 신선도 검사)에 맞게 다시 구현했습니다([문서](https://docs.tossplace.com/reference/open-api/webhook.html)).
  - Template API(`renderIdlePage`/`renderInputPage`/`renderSelectPage`/`renderResultPage`)와
    `sdk.payment.requestPayment()` 파라미터는 실제 문서와 대조해 **일치함을 확인**했습니다 (수정 불필요).
  - ⚠️ **여전히 미해결**: 결제 웹훅 payload(`data.payment` 객체)에는 `paymentKey` 필드가 없습니다. 우리
    시스템이 클라이언트에서 생성해 `sdk.payment.requestPayment()`에 넘기는 `paymentKey`가 이 payment
    객체의 어떤 필드(`orderId`?)와 대응되는지 공개 문서로는 확인이 안 되어, 지금은 웹훅 수신 시 로그만
    남기고 자동으로 결제 레코드를 만들지 않습니다(엉뚱한 예약에 영수증이 나가는 것 방지). 확정하려면
    `developer-support@tossplace.com`에 직접 문의해야 합니다.
- **솔라피 키 미발급.** `.env`의 `SOLAPI_*` 값이 전부 비어 있어도 예약/결제 접수 API는 정상 동작하고,
  알림톡 발송만 실패 로그를 남기고 넘어갑니다 (요청 자체는 실패시키지 않음).
- **3개월 프로모션 스케줄러는 `node-cron`으로 매일 10시 실행.** 서버가 그 시각에 떠 있지 않으면(예: 무료 플랜 슬립) 그날은 건너뛰지만,
  다음 실행 때 `promoAt`이 이미 지난 건은 다시 잡혀서 발송 시도합니다 (재시도 자체는 됨, 정시 발송은 보장 안 됨).
- **레이트리밋 적용됨.** `POST /api/reservations`는 IP당 10분에 5회, `POST /api/payments`는 10분에 10회로 제한됩니다.
- **토스프론트/POS 플러그인은 아직 실제 계정에 라이브 배포 안 됨.** 코드·ZIP 생성은 준비됐지만,
  토스플레이스 개발자센터 플러그인 등록·테스트 가맹점/단말기 연결·개발 배포는 사업자 계정 로그인이 필요해서
  사용자가 직접 진행해야 합니다.

</details>

**TODO**

- [ ] **운영 정본 배포(Render vs GCP Cloud Run) 확정** — 이 문서 상단 배포 주소의
      `TODO(운영)` 주석 참고, 결정되면 레거시 쪽 항목 정리
- [ ] 개인정보 수집·이용 동의 문구, 광고 수신동의/수신거부 문구(`PROMO_OPT_OUT_TEXT`),
      보관기간(`DATA_RETENTION_DAYS`) 법무 검토 (§개인정보·광고성 정보 처리)
- [ ] 솔라피 알림톡 키/템플릿 4종 발급받아 Render Environment와 로컬 `.env`에 채우기
- [ ] Cloud SQL 운영 데이터 export/import 및 재배포 후 데이터 유지 확인
- [ ] GCP Secret Manager에 `DATABASE_URL`, `JWT_SECRET`, 관리자 계정, Solapi 키에 더해
      `TOSS_WEBHOOK_SECRET`(운영 필수), `ADMIN_ALLOWED_ORIGINS`, `DATA_RETENTION_DAYS`,
      `PROMO_OPT_OUT_TEXT`, `PROMO_MAX_PER_RUN` 등록
- [ ] Cloud Run 배포 시 `RUN_MIGRATIONS_ON_BOOT=false`로 전환하고 `prisma migrate deploy`를
      별도 사전 단계(Cloud Run Job 등)로 분리
- [ ] Cloud Run 동시성·최대 인스턴스·DB 커넥션 풀(`DATABASE_URL`의 `connection_limit`) 및 p95 응답시간 검증
- [ ] 인스턴스 간 공유 레이트리밋(Redis/Cloud Armor/API Gateway) 도입 — 지금은 인스턴스별 메모리
      기준이라 여러 인스턴스로 확장되면 전역 한도가 느슨해짐
- [ ] POS 토큰 인증·목록 페이지네이션 적용 후 부하 테스트(동시 예약/POS 폴링/관리자 목록 조회) 재검증
- [ ] Cloud Scheduler 재시도 시 프로모션 중복 발송 방지와 Cloud Logging/복구 검증
- [ ] Toss Front/POS ACL과 운영 API 주소를 GCP URL로 전환
- [ ] **토스플레이스 개발자센터에서 실제 플러그인 등록·테스트 가맹점 연결·단말기 온보딩** (사업자 계정 필요, [토스프론트 플러그인 연동](#토스프론트-플러그인-연동) 섹션 절차대로)
- [ ] `front-plugin/` ZIP(`npm run zip`) 개발 배포 → 실제 프론트 단말기에서 화면/결제 흐름 확인
- [ ] `pos-plugin/` ZIP(`npm run zip`) 개발 배포 → 실제 POS에서 대기열 탭 확인
- [ ] 결제 승인 웹훅 등록 — 개발자센터 → 내 애플리케이션 → OpenAPI → 웹훅에서 수신 URL
      (`https://<운영 도메인>/api/webhooks/toss/payment`)과 서명 secret을 직접 설정하고, 같은 secret 값을
      서버의 `TOSS_WEBHOOK_SECRET` 환경변수에 넣는다 (production에서는 이 값이 없으면 서버가 부팅되지 않는다)
