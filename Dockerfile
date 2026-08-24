# Cloud Run 배포용. 저장소 루트를 빌드 컨텍스트로 사용한다.
# backend/server.js가 형제 폴더 front-plugin/, pos-plugin/dist/를 정적 서빙하므로
# 이미지 안에 두 폴더가 모두 포함되어야 한다.
ARG CHEVROLET_API_BASE_URL=
FROM node:18-slim AS pos-plugin-build
ARG CHEVROLET_API_BASE_URL
WORKDIR /app/pos-plugin
# package-lock.json이 없으면 즉시 실패한다(npm ci는 lockfile을 강제한다) — 재현 가능한 빌드를 위해 의도된 동작.
COPY pos-plugin/package.json pos-plugin/package-lock.json ./
RUN npm ci
COPY pos-plugin/ ./
RUN CHEVROLET_API_BASE_URL="$CHEVROLET_API_BASE_URL" npm run build

FROM node:18-slim
WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend/ ./backend/
COPY front-plugin/ ./front-plugin/
COPY --from=pos-plugin-build /app/pos-plugin/dist ./pos-plugin/dist

RUN cd backend && npx prisma generate

ENV NODE_ENV=production
ENV PORT=8080

# 컨테이너 부팅 시 `npx prisma migrate deploy`를 실행할지 여부.
# 기본값 true는 기존 배포 방식과 동일하다(하위 호환). 하지만 Cloud Run처럼 동시에 여러 인스턴스가
# 콜드스타트되는 환경에서는 매 부팅마다 마이그레이션을 시도하면:
#   - 동시 인스턴스들이 Prisma의 advisory lock을 두고 경합한다
#   - 마이그레이션 자체가 실패하면(예: 잘못된 SQL, 락 타임아웃) 그 인스턴스는 기동에 실패하고,
#     Cloud Run이 계속 재시작을 시도하면서 크래시 루프에 빠진다(모든 인스턴스가 트래픽을 못 받음)
# 운영 권장 구성: 배포 파이프라인에서 `npx prisma migrate deploy`를 별도 사전 단계(Cloud Run Job 등)로
# 한 번만 실행하고, 이 값을 false로 설정해 컨테이너는 마이그레이션 없이 바로 기동하게 한다.
ENV RUN_MIGRATIONS_ON_BOOT=true

EXPOSE 8080

# Cloud Run은 Docker HEALTHCHECK 지시어를 사용하지 않는다(자체 startup/liveness probe 설정을 씀).
# 그래서 여기서는 HEALTHCHECK을 선언하지 않고 대신 확인해야 할 경로를 문서로 남긴다.
#   - GET /health       liveness. DB 접근 없이 즉시 200 'ok' 반환.
#   - GET /health/ready  readiness. `SELECT 1`이 성공해야 200 { ok:true }, 실패 시 503 { ok:false }.
# Cloud Run 서비스 설정의 "상태 확인"에서 liveness probe는 /health, startup probe는 /health/ready를
# 가리키도록 등록할 것(README의 Cloud Run 섹션 참고).

WORKDIR /app/backend

# node:18-slim은 uid 1000의 비root 사용자 'node'를 기본 제공한다. 백엔드는 파일시스템에
# 쓰기(로그는 stdout, DB는 Postgres)를 하지 않으므로 실행 사용자를 root에서 내려도 안전하다.
RUN chown -R node:node /app
USER node

# ⚠️ 마지막이 반드시 `exec node`여야 한다.
# `sh -c "... && node server.js"` 형태로 쓰면 PID 1이 sh로 남고 node는 그 자식 프로세스가 된다.
# Cloud Run은 인스턴스를 내릴 때 SIGTERM을 PID 1에게만 보내는데, POSIX sh는 그 시그널을 자식에게
# 전달하지 않는다. 그러면 server.js의 graceful shutdown(진행 중 요청 마무리 + prisma.$disconnect())이
# 아예 실행되지 않고, 유예시간이 끝난 뒤 SIGKILL로 강제 종료되면서 처리 중이던 요청과
# DB 커넥션이 그대로 끊긴다. exec로 node가 sh를 대체해 PID 1이 되면 SIGTERM을 직접 받는다.
CMD ["sh", "-c", "if [ \"$RUN_MIGRATIONS_ON_BOOT\" = \"true\" ]; then npx prisma migrate deploy || exit 1; fi; exec node server.js"]
