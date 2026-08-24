# GCP 이전 및 트래픽 확장 계획

작성일: 2026-08-03

이 문서는 현재 Render에서 동작 중인 Chevrolet 토스 Front/POS 예약 시스템을
GCP로 이전하고, 트래픽 증가에 대비할 때 이어서 작업할 수 있도록 만든 인수인계 문서다.

## 현재 상태

- 운영 API 주소: `https://chevroletcode.onrender.com`
- 백엔드: Node.js + Express + Prisma
- 현재 DB provider: SQLite
- 현재 로컬/Render 테스트 DB: `DATABASE_URL=file:./dev.db`
- 플러그인:
  - `front-plugin/`: 토스 프론트 기기용 ZIP
  - `pos-plugin/`: 토스 POS iframe 탭앱 ZIP
- 예약 접수는 항상 `waiting` 상태로 생성된다.
- `called` 전환과 순서 알림은 POS/관리자 화면에서 수동 호출할 때만 발생한다.
- 현재 Render에서는 POS/Front API가 정상 응답하는 상태다.

## 핵심 결론

GCP의 더 비싼 인스턴스를 선택하는 것만으로는 충분하지 않다.
Cloud Run은 요청량에 따라 인스턴스를 늘릴 수 있지만, DB 영속성·DB 연결 수·중복 실행·동시성은
애플리케이션과 인프라를 함께 구성해야 해결된다.

운영 이전의 최소 조건은 다음과 같다.

1. SQLite를 PostgreSQL로 이전한다.
2. Cloud Run을 저장소 루트 기준으로 배포한다.
3. `node-cron` 프로모션 작업을 Cloud Scheduler 또는 Cloud Run Job으로 분리한다.
4. 호출·웹훅·알림 발송에 중복 실행 방지 처리를 추가한다.
5. 부하 테스트 후 Cloud Run 동시성·최대 인스턴스·DB 커넥션 풀을 결정한다.

## 목표 구조

```text
토스 Front / 토스 POS
          │ HTTPS
          ▼
Cloud Run: Express API + 정적 파일
          │
          ├── Cloud SQL for PostgreSQL
          ├── Secret Manager
          ├── Cloud Scheduler / Cloud Run Job
          └── (필요 시) Memorystore Redis / Cloud Armor
```

Cloud Run 서비스는 stateless 인스턴스로 동작하므로 데이터 파일을 인스턴스 로컬 디스크에
보관하면 안 된다. Cloud SQL 연결 시에는 인스턴스가 늘어날 때 DB 연결 수도 함께 늘어나는 점을
고려해야 한다.

참고:

- [Cloud Run 자동 확장](https://docs.cloud.google.com/run/docs/about-instance-autoscaling)
- [Cloud Run 동시성 설정](https://docs.cloud.google.com/run/docs/about-concurrency)
- [Cloud Run에서 Cloud SQL PostgreSQL 연결](https://docs.cloud.google.com/sql/docs/postgres/connect-run)

## 단계별 작업 순서

### 1단계: GCP 기반 준비

- [ ] GCP 프로젝트, 리전, 결제 계정 결정
- [ ] Cloud Run 서비스 생성
- [ ] Cloud SQL PostgreSQL 생성
- [ ] Cloud SQL 백업·자동 유지보수·접속 정책 설정
- [ ] Secret Manager에 운영 비밀값 등록
- [ ] 사용할 API 도메인 결정
- [ ] GCP 도메인을 Toss Front/POS ACL에 등록할 준비

권장 Secret/환경변수:

```text
DATABASE_URL
JWT_SECRET
ADMIN_BOOTSTRAP_EMAIL
ADMIN_BOOTSTRAP_PASSWORD
SOLAPI_API_KEY
SOLAPI_API_SECRET
SOLAPI_SENDER
SOLAPI_KAKAO_PFID
SOLAPI_KAKAO_TEMPLATE_RESERVATION
SOLAPI_KAKAO_TEMPLATE_QUEUE_TURN
SOLAPI_KAKAO_TEMPLATE_RECEIPT
SOLAPI_KAKAO_TEMPLATE_PROMO
TOSS_WEBHOOK_SECRET
TRUST_PROXY_HOPS
PROMOTION_JOB_TOKEN
```

### 2단계: SQLite → PostgreSQL 전환

현재 [backend/prisma/schema.prisma](../backend/prisma/schema.prisma)는 `provider = "sqlite"`다.
운영 전환 시 다음을 수행한다.

1. `provider = "postgresql"`로 변경한다.
2. Cloud SQL 연결 문자열을 `DATABASE_URL`로 설정한다.
3. PostgreSQL용 migration을 생성·검토한다.
4. 기존 Render SQLite 데이터가 필요하면 별도 export/import 스크립트로 이전한다.
5. 매장 `merchantId`, 예약, 결제, 관리자 계정, webhook event의 개수를 비교한다.
6. 두 매장 이상을 사용해 매장 간 데이터가 섞이지 않는지 재검증한다.

주의:

- `DATABASE_URL`만 PostgreSQL로 바꾸고 SQLite migration을 그대로 실행하지 않는다.
- 운영 DB를 초기화하기 전에 Render SQLite 백업을 보관한다.
- `merchantId`는 실제 토스 SDK가 반환하는 값으로 매장별 등록해야 한다. 테스트용 `0`을 운영 매장에 사용하지 않는다.

### 3단계: Cloud Run 배포 구조 정리

현재 백엔드는 `backend/server.js`에서 형제 폴더인 `front-plugin/`과 `pos-plugin/dist/`를 정적으로 서빙한다.
따라서 Cloud Run 서비스의 Root Directory는 저장소 루트여야 한다.

현재 구조에 맞는 임시 Build/Start 명령:

```bash
# Build Command
cd backend && npm install && npx prisma migrate deploy && cd ../pos-plugin && npm install && npm run build

# Start Command
cd backend && npm start
```

장기적으로는 저장소 루트에 `Dockerfile` 또는 `render.yaml`과 동등한 GCP 배포 설정을 추가해
빌드·migration·실행 절차를 고정한다.

Cloud Run 초기 설정은 부하 테스트 전까지 보수적으로 잡는다.

- 최소 인스턴스: 1 (콜드 스타트가 문제가 될 때)
- 최대 인스턴스: Cloud SQL 연결 수를 고려해 제한
- 동시성: 낮은 값부터 시작해 측정 후 상향
- CPU/메모리: 알림톡·Prisma 응답시간을 측정해 결정
- 로그: Cloud Logging 및 오류 알림 활성화

### 4단계: 동시성·중복 실행 보완

#### 예약 생성

현재 예약 생성은 Prisma transaction으로 대기번호를 채번한다. PostgreSQL 전환 후에도 다음을
검증한다.

- 같은 매장에 동시에 예약을 넣어 대기번호 중복이 없는가
- 두 매장의 대기번호가 서로 독립적인가
- 재시도 요청으로 같은 예약이 중복 생성되지 않는가

필요하면 Front 요청에 idempotency key를 추가하고 DB에 unique constraint를 둔다.

#### 호출/완료

POS의 2단계 탭 UX만으로는 API 중복 요청을 완전히 막을 수 없다. 다음을 추가한다.

- `waiting → called`를 조건부 update로 한 번만 성공시킨다.
- 이미 `called`인 예약에 대한 재호출은 알림을 다시 보내지 않는다.
- `called → completed`도 조건을 확인한다.
- 알림 발송 성공 여부와 상태 변경을 구분해 재처리 정책을 둔다.

#### Rate limit

현재 `express-rate-limit`은 프로세스 메모리에 저장된다. Cloud Run 인스턴스가 여러 개가 되면
인스턴스마다 한도가 따로 적용된다. 전역 한도가 필요하면 Redis/Memorystore, Cloud Armor,
API Gateway 등 공유 계층을 검토한다.

#### 프로모션 스케줄러

현재 `backend/server.js`의 `node-cron`은 서비스 인스턴스마다 실행될 수 있다. Cloud Run 확장 후
중복 알림이 발생할 수 있으므로 제거하고 다음 중 하나로 옮긴다.

- Cloud Scheduler → 인증된 HTTP 작업 endpoint
- Cloud Scheduler → Cloud Run Job
- Pub/Sub → 알림 처리 worker

작업은 Cloud Scheduler의 재시도·중복 실행을 전제로 idempotent하게 만든다.

참고: [Cloud Scheduler는 최소 한 번 전달 방식](https://docs.cloud.google.com/scheduler/docs/overview)

### 5단계: API 주소와 ACL 전환

현재 Front/POS 소스에는 Render 주소가 운영 API로 들어가 있다.

- [front-plugin/reservation.html](../front-plugin/reservation.html)
- [front-plugin/payment.html](../front-plugin/payment.html)
- [pos-plugin/src/app.js](../pos-plugin/src/app.js)

GCP 이전 전에 API base URL을 한 곳의 환경별 설정으로 분리한다.

전환 순서:

1. GCP API를 별도 테스트 URL로 배포한다.
2. Front/POS 개발 ZIP에서 GCP 테스트 URL을 사용하게 빌드한다.
3. 실제 매장 ID로 예약·POS 대기열·호출·완료를 검증한다.
4. Toss 개발자센터에서 Front/POS ACL을 GCP URL로 변경한다.
5. 개발 트랙에서 재검증한다.
6. 운영 전환 후 DNS 또는 API base URL을 최종 GCP 주소로 고정한다.

### 6단계: 검증 및 부하 테스트

기능 검증:

- [ ] Front 예약 → POS 대기열에 표시
- [ ] 첫 예약도 `waiting` 유지
- [ ] POS 호출 2단계 탭 → `called` 및 알림 1회
- [ ] POS 완료 2단계 탭 → 대기열에서 제거
- [ ] 관리자 화면에서도 같은 상태 확인
- [ ] 두 매장 예약이 서로 섞이지 않음
- [ ] 실제 merchant ID가 등록되지 않으면 404로 차단
- [ ] 웹훅 같은 이벤트를 두 번 보내도 중복 처리되지 않음

부하 검증:

- [ ] 동시 예약 요청으로 대기번호 중복이 없는지 확인
- [ ] 동시 호출 요청으로 중복 알림이 없는지 확인
- [ ] Cloud Run 인스턴스 증가 시 DB 커넥션이 한도를 넘지 않는지 확인
- [ ] 알림톡 서비스 지연 시 API 응답시간과 재처리 상태 확인
- [ ] Cloud Scheduler 재시도 시 프로모션 중복 발송이 없는지 확인
- [ ] 목표 RPS, p95 응답시간, 오류율, 최대 인스턴스를 기록

## 전환 완료 기준

- [ ] Cloud SQL PostgreSQL과 migration이 운영 데이터 기준으로 검증됨
- [ ] Cloud Run이 저장소 루트 기준으로 배포됨
- [ ] 운영 비밀값이 Secret Manager에 있고 소스/로그에 노출되지 않음
- [ ] 스케줄러가 Cloud Scheduler/Job으로 분리됨
- [ ] 호출·예약·웹훅·프로모션 중복 처리가 완료됨
- [ ] 실제 Front/POS 개발 트랙에서 새 API 도메인으로 통합 테스트 완료
- [ ] 부하 테스트 결과와 Cloud Run/DB 설정값이 기록됨
- [ ] Render를 롤백용으로 유지할지 폐기할지 결정됨

## 롤백 원칙

- GCP DB migration 전 Render DB 백업을 보관한다.
- ACL과 API 주소를 한 번에 바꾸지 말고 개발 트랙에서 먼저 변경한다.
- 문제가 생기면 플러그인 ZIP을 이전 버전으로 되돌리고 API 도메인을 Render로 복귀한다.
- 양쪽 DB에 동시에 쓰는 이중 쓰기는 데이터 불일치 위험이 있으므로 별도 설계 없이 사용하지 않는다.

## 2026-08-05 실행 기록

- GCP 프로젝트: `tossplugincar-dev`, 리전: `asia-northeast3`
- Cloud SQL: `chevrolet-postgres` / 데이터베이스 `chevrolet` / 앱 사용자 `chevrolet_app`
- Cloud Run 서비스: `https://chevrolet-api-813801981857.asia-northeast3.run.app`
- 초기 Cloud Run 설정: 최소 1, 최대 5 인스턴스, 동시성 20, 1 vCPU, 512MiB
- Cloud Scheduler: `chevrolet-promotion-daily`, 매일 10:00 `Asia/Seoul`
- Auth Proxy를 통한 `prisma migrate deploy`와 `prisma migrate status` 검증 완료
- 현재 Solapi 운영값은 아직 Secret Manager에 등록하지 않았으므로 알림톡 기능과 실제 Toss ACL 전환은 보류한다.
- 후속 배포에서 노출된 `PROMOTION_JOB_TOKEN`을 교체하고 Scheduler 헤더를 갱신했다. 새 리비전 `chevrolet-api-00003-dmm` 배포 후 수동 실행에서 프로모션 엔드포인트 `POST 200`을 확인했다.
- Cloud Run 공개 URL에서 Google 엣지 경로와 충돌하던 `/healthz` 대신 `/health`를 사용하도록 변경했으며, Express 응답 `200 ok`를 확인했다.
- 프로모션 claim 로직으로 대체된 `listDuePromotions`를 제거했다.
