# Chevrolet Toss Plugin TODO

상세한 배경과 실행 방법은 [`docs/gcp-migration-and-scale-plan.md`](docs/gcp-migration-and-scale-plan.md)를 참고한다.

## P0 — 현재 운영 확인

- [ ] Render 환경변수(`DATABASE_URL`, `JWT_SECRET`, 관리자 계정, Solapi 키) 확인
- [ ] 실제 토스 Front의 `merchant.id`를 Render 관리자 화면에 매장으로 등록
- [ ] 새 예약이 `waiting` 상태로 생성되는지 확인
- [ ] POS에서 호출 2단계 탭 후 `called` 및 알림톡 1회 동작 확인
- [ ] POS에서 완료 2단계 탭 후 대기열에서 제거되는지 확인
- [ ] Front/POS 개발자센터 ZIP을 최신 커밋 기준으로 다시 생성·업로드

## P0 — 프로덕션 하드닝(2026-08-24) 후속 확정 필요

백엔드 크래시 방지·보안 헤더·POS 토큰 인증·개인정보 동의 수집/파기·Docker/CI 정비까지는
완료됐다(`README.md`의 "현재 상태" 참고). 아래는 코드로 끝나지 않고 사람이 결정하거나
운영 환경에서 확인해야 하는, 이번 하드닝이 새로 만들어낸 항목이다. 인스턴스 간 공유
레이트리밋과 부하 테스트는 기존 P1/P2 항목으로 이미 추적 중이므로 여기서 중복하지 않는다.

- [ ] **운영 정본 배포(Render vs GCP Cloud Run) 확정** — `README.md` 상단 배포 주소의
      `TODO(운영): 정본 확정 필요` 주석 참고. 결정되면 레거시 쪽 항목을 폐기/정리
- [ ] 개인정보 수집·이용 동의 문구, 광고 수신동의/수신거부 문구(`PROMO_OPT_OUT_TEXT`),
      보관기간(`DATA_RETENTION_DAYS`, 기본 1095일) **법무 검토** — `README.md`의
      "개인정보·광고성 정보 처리" 섹션에 명시된 미검토 상태 해소
- [ ] Cloud Run 배포에서 `RUN_MIGRATIONS_ON_BOOT=false`로 전환하고 `prisma migrate deploy`를
      별도 사전 단계(Cloud Run Job 등)로 분리 — 동시 콜드스타트 시 advisory lock 경합/크래시 루프 방지

## P1 — GCP 이전 준비

- [ ] GCP 프로젝트·리전·도메인 결정
- [x] Cloud SQL PostgreSQL 생성 및 백업 정책 설정
- [x] Prisma provider를 SQLite에서 PostgreSQL로 전환
- [x] 운영 PostgreSQL migration 생성·검증
- [ ] Render SQLite 데이터 export/import
- [x] Cloud Run 저장소 루트 배포 설정 작성
- [x] Cloud Run Build/Start 명령과 `PORT` 동작 확인
- [ ] Secret Manager로 운영 비밀값 이전. 이번 하드닝으로 늘어난 신규 환경변수도 포함:
      `TOSS_WEBHOOK_SECRET`(production 필수로 승격됨), `ADMIN_ALLOWED_ORIGINS`, `DATA_RETENTION_DAYS`,
      `PROMO_OPT_OUT_TEXT`, `PROMO_MAX_PER_RUN` (`backend/.env.example` 참고)
- [x] Front/POS API base URL을 환경별 설정으로 분리
- [ ] GCP API 도메인을 Toss Front/POS ACL에 등록

## P1 — 트래픽·중복 처리 보완

- [x] 예약 생성의 idempotency key와 중복 예약 방지 추가
- [x] `waiting → called` 조건부 update로 중복 호출 방지
- [x] `called → completed` 조건부 update 추가
- [x] 웹훅 중복 처리와 재시도 정책 점검 — `recordWebhookEventOnce`로 중복 방지한 뒤 서명검증 →
      본 처리 순서로 바꾸고, 본 처리 실패 시 웹훅 기록을 삭제하고 500을 반환해 토스가 재시도하게 함.
      `NODE_ENV=production`에서 `TOSS_WEBHOOK_SECRET` 미설정이면 부팅 자체를 막아 무서명 수신 사고 방지
- [x] `node-cron`을 Cloud Scheduler 또는 Cloud Run Job으로 분리
- [x] 프로모션 작업의 중복 실행 방지 추가
- [ ] 인스턴스 간 공유 rate limit 검토(Redis/Cloud Armor/API Gateway) — `GET /api/pos/queue`는
      토큰 인증이 붙어 인스턴스별 메모리 기준 레이트리밋으로 의도적으로 남겨둠(계약 §9). 그 외
      엔드포인트가 여러 인스턴스로 확장됐을 때도 지금의 `PostgresRateLimitStore` 방식으로 충분한지는
      아직 미검토
- [x] 알림톡 발송 지연·실패 시 재처리 정책 확정 — 관리자가 수동으로 재시도하는
      `POST /api/reservations/:id/retry-notify`/`POST /api/payments/:id/retry-receipt` API 추가(자동
      재처리는 아님, 사람이 실패 목록을 보고 눌러야 함 — 자동 재시도가 필요하면 추가 설계 필요)
- [ ] Cloud Run 동시성·최대 인스턴스·DB 커넥션 풀 결정 — `DATABASE_URL`에 `?connection_limit=` 지정
      가이드는 `backend/.env.example`에 추가했지만, 실제 인스턴스 수/풀 크기 숫자는 아직 미정

## P2 — 검증 및 전환

- [ ] 두 매장 동시 예약 시 데이터가 섞이지 않는지 확인
- [ ] 동시 예약에서 대기번호 중복이 없는지 부하 테스트
- [ ] 동시 호출에서 알림 중복이 없는지 부하 테스트
- [ ] POS 토큰 인증(`X-Store-Token`, 5초 폴링) + 관리자 목록 페이지네이션(`limit`/`offset`) 적용 후
      부하 테스트 재실행 — 이번 하드닝으로 인증 검증 비용과 쿼리 패턴이 바뀌어 이전 측정값이 유효하지 않음
- [ ] Cloud SQL 커넥션 한도와 p95 응답시간 측정
- [ ] Cloud Scheduler 재시도 시 프로모션 중복 발송 확인
- [ ] Cloud Logging·오류 알림·백업 복구 테스트
- [ ] Toss Front/POS 개발 트랙에서 GCP API 통합 검증
- [ ] 운영 ACL과 API 주소를 GCP로 전환
- [ ] Render 롤백 유지 기간과 폐기 시점 결정

## 완료 기준

- [ ] 운영 DB가 PostgreSQL이며 재배포 후 데이터가 유지됨
- [ ] 실제 Front 예약과 POS 호출/완료가 같은 DB에서 동작함
- [ ] 예약·호출·웹훅·프로모션 중복 처리가 검증됨
- [ ] 부하 테스트 결과와 Cloud Run/DB 설정값이 기록됨
- [ ] GCP 장애 시 Render 또는 이전 ZIP으로 롤백 가능함
