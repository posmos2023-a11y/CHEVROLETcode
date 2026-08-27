# Backend tests

테스트는 로컬 PostgreSQL의 `devdb`만 사용합니다. Cloud SQL/운영 `DATABASE_URL`을 지정한 상태로
실행하지 마세요. 테스트 파일은 `localhost`, `127.0.0.1`, `::1`의 `devdb`가 아니면 시작 단계에서
실패하도록 되어 있습니다.

```powershell
docker run --name chevrolet-test-pg `
  -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=devdb `
  -p 5432:5432 -d postgres:16-alpine

$env:DATABASE_URL = 'postgresql://postgres:devpass@localhost:5432/devdb?schema=public'
npx prisma migrate deploy
npm test
```

GitHub Actions에서는 동일한 PostgreSQL 서비스 컨테이너를 사용합니다. 테스트 종료 후 컨테이너가
필요 없으면 `docker rm -f chevrolet-test-pg`로 제거하세요.

## production 전용 부팅 가드는 테스트에 영향 없음

`server.js`는 `NODE_ENV === 'production'`일 때만 `JWT_SECRET`/`ADMIN_BOOTSTRAP_*`/`TOSS_WEBHOOK_SECRET`
누락 시 부팅을 막습니다(`backend/.env.example`의 각 변수 설명 참고). `backend/test/api.test.js`가 다른 코드를 불러오기 전에 자체적으로
`process.env.NODE_ENV = 'test'`를 설정하므로 이 가드는 테스트 중 절대 발동하지 않습니다 — 로컬에서
`npm test`를 돌릴 때 `TOSS_WEBHOOK_SECRET` 등을 따로 채워둘 필요가 없습니다. `ADMIN_ALLOWED_ORIGINS`,
`DATA_RETENTION_DAYS`, `PROMO_OPT_OUT_TEXT`, `PROMO_MAX_PER_RUN`, `RUN_MIGRATIONS_ON_BOOT`도 미설정 시
경고 로그만 남기거나 기본값으로 동작하도록 만들어져 있어 테스트 환경 변수에 추가하지 않았습니다
(`backend/.env.example` 참고).

## CI에 추가된 다른 검증

`.github/workflows/backend-tests.yml`에는 이 `test` 잡 외에 두 잡이 더 있습니다 — 실패해도 이
문서의 로컬 재현 절차와는 무관하니 혼동하지 마세요.

- **`syntax-check`** — `node --check`로 `backend/server.js`, `backend/src/*.js`,
  `backend/public/reservation.js`가 파싱 가능한지만 확인합니다(린터가 없는 프로젝트라 최소한의
  구문 오류 방지용, 런타임 동작은 검증하지 않음).
- **`pos-plugin-build`** — `pos-plugin/`에서 `npm ci && npm run build`를 실행해 POS 탭앱 번들이
  매 커밋 컴파일되는지 확인합니다. 백엔드 코드와는 별개 프로젝트지만 같은 워크플로 파일에서 관리합니다.
