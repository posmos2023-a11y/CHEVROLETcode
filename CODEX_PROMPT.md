# Codex 작업 프롬프트 — GCP 이전 후속 조치

아래 내용을 그대로 Codex에 붙여넣어 작업을 이어받게 하세요.

---

## 작업 경로

`C:\Users\han\Desktop\토스포스 쉐보레\CHEVROLETcode-main` — 이 저장소 루트에서 작업할 것.

## 배경

이전 세션에서 GCP 이전 작업(Cloud SQL, Cloud Run, Secret Manager, Cloud Scheduler, idempotency,
조건부 상태전이, 프로모션 claim 로직 등)을 완료하고 실제로 배포까지 마쳤다. 자세한 내용은
[`docs/gcp-migration-and-scale-plan.md`](docs/gcp-migration-and-scale-plan.md)의
"2026-08-05 실행 기록" 섹션과 [`TODO.md`](TODO.md)를 참고할 것.

배포 현황:

- GCP 프로젝트: `tossplugincar-dev`, 리전: `asia-northeast3`
- Cloud SQL: `chevrolet-postgres` (PostgreSQL 16, db-f1-micro)
- Cloud Run 서비스: `chevrolet-api` (`https://chevrolet-api-813801981857.asia-northeast3.run.app`), 전체 공개(allUsers invoker)
- Cloud Scheduler: `chevrolet-promotion-daily` (매일 10:00 Asia/Seoul)
- Secret Manager: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`,
  `PROMOTION_JOB_TOKEN`, `TOSS_WEBHOOK_SECRET` 등록 완료. **SOLAPI_* 키는 아직 미등록.**

이번 세션에서 사람이 코드 리뷰를 했고, 아래 3가지 이슈를 발견했다. 이것부터 처리할 것.

## 지금 처리해야 할 것

### 1. (우선순위 높음) `PROMOTION_JOB_TOKEN` 재발급

리뷰 중 `gcloud scheduler jobs describe`로 헤더 값을 확인하는 과정에서 실제 토큰 값이
사람과의 대화 로그에 평문으로 노출됐다 (`Fl2dHi3vWAjTCwLxaF3g2sgK7apBIa66Wt2Ejm-lZag`).
이 값은 더 이상 신뢰할 수 없으므로 교체가 필요하다.

절차:
1. 새 랜덤 토큰 생성 (예: `openssl rand -base64 32` 또는 node `crypto.randomBytes`)
2. Secret Manager `PROMOTION_JOB_TOKEN`에 새 버전 추가
   (`gcloud secrets versions add PROMOTION_JOB_TOKEN --data-file=- --project=tossplugincar-dev`)
3. Cloud Scheduler 작업 `chevrolet-promotion-daily`의 `x-promotion-job-token` 헤더를 새 값으로 갱신
   (`gcloud scheduler jobs update http ...`)
4. Cloud Run 서비스 `chevrolet-api`를 새 리비전으로 재배포해 컨테이너가 새 시크릿 버전을 반영하도록 함
   (env var는 컨테이너 시작 시점에 고정되므로 기존 실행 중인 인스턴스는 재배포해야 갱신됨)
5. 재배포 후 Cloud Scheduler 작업을 수동 실행(`gcloud scheduler jobs run`)해서 200 응답 확인

### 2. `/healthz` 엔드포인트가 공개 Cloud Run URL에서 도달 불가

`curl https://chevrolet-api-813801981857.asia-northeast3.run.app/healthz` 및 프로젝트 번호 기반 URL 둘 다에서
Google 엣지 단계의 일반 404 페이지가 응답되고 ([backend/server.js:715](backend/server.js:715)의
Express 핸들러까지 도달하지 못함 — 응답에 `x-powered-by: Express` 헤더가 없음), 반면
`/`, `/api/nonexistent-xyz` 같은 다른 경로는 정상적으로 Express까지 도달해 Express 자체 404를 반환한다.
즉 `/healthz`라는 경로 자체가 Cloud Run/Google 인프라 단에서 특별 취급되는 것으로 보인다.

조치: `backend/server.js`의 헬스체크 경로를 `/healthz`가 아닌 다른 경로(예: `/health` 또는
`/api/health`)로 변경하고, 배포 후 공개 URL에서 실제로 Express 응답(200 "ok")이 오는지 curl로 검증할 것.
Cloud Run 자체 startup/liveness probe 설정이 있다면 그것도 새 경로로 맞출 것.

### 3. 사용하지 않는 `listDuePromotions` 정리

`backend/src/store.js`에서 프로모션 발송 로직이 `claimDuePromotions`(claim 기반 중복 방지)로
교체됐는데, 이전 함수 `listDuePromotions`가 여전히 정의·export되어 있다. `server.js`에서 더 이상
import하지 않으므로 죽은 코드다. 삭제할 것. (주의: claim 없이 조회만 하는 예전 방식이라, 나중에
누가 실수로 다시 가져다 쓰면 Cloud Run 다중 인스턴스 환경에서 프로모션 중복 발송 버그가 재발한다.)

## 그다음 진행할 것 (TODO.md 기준 남은 항목)

- Render SQLite 데이터 export/import
- SOLAPI 운영 키를 Secret Manager에 등록하고 Cloud Run 환경에 연결
- 웹훅 중복 처리·재시도 정책 점검
- Cloud SQL public IP 비활성화 검토 (`ipv4Enabled: false`로 전환하고 Private IP + VPC 커넥터만 사용 —
  현재는 authorized network가 비어 있어 당장 위험하진 않지만 불필요한 공격면임)
- 인스턴스 간 공유 rate limit 검토 (현재 express-rate-limit은 인스턴스 로컬 메모리 기준)
- Toss 개발자센터에서 Front/POS ACL을 실제 Cloud Run URL로 전환 (이건 사람이 콘솔에서 직접 해야 함)
- 부하 테스트 및 결과 기록

## 작업 시 주의사항

- GCP 프로젝트/결제 계정/Cloud SQL/Cloud Run은 이미 만들어져 있으니 새로 만들지 말 것
- Cloud Run 서비스는 이미 운영 트래픽을 받을 수 있는 상태이므로, 재배포 전 기존 리비전이 정상 응답하는지
  먼저 확인하고 진행할 것
