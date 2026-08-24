-- 운영 하드닝 마이그레이션 (API 계약 v2 §1)
-- `npx prisma migrate dev`를 실행할 수 없는 환경이라 SQL을 손으로 작성했다.
-- 데이터가 이미 있는 운영 DB에서도 "실패 없이" 적용되도록, NOT NULL 컬럼은
-- "nullable로 추가 -> 백필 -> SET NOT NULL" 3단계로 나눈다(한 번에 NOT NULL로 추가하면
-- 기존 로우가 전부 위반이라 실패한다).
-- 이 순서는 실제 Postgres 엔진에 (a) 빈 DB (b) 기존 데이터가 있는 DB 두 경우로 적용해
-- 검증했다 — 백필 결과(KST 자정 경계 포함), NOT NULL 승격, posToken 유일성까지 확인함.
--
-- ⚠️ 배포 전 반드시 확인할 것 — "실패하지 않는 것"과 "서비스가 안 멈추는 것"은 다르다.
-- 아래 Reservation 관련 구문들(전체 UPDATE 백필 -> SET NOT NULL 검증 스캔 -> 인덱스 3개 생성)은
-- prisma migrate deploy가 하나의 트랜잭션으로 묶어 실행하며, 그동안 Reservation 테이블에
-- 쓰기 잠금이 걸린다. Reservation은 손님 접수와 POS 5초 폴링이 계속 때리는 가장 뜨거운 테이블이라,
-- 로우가 많으면 그 시간만큼 예약 접수와 POS 대기열이 멈춘다.
--   1) 배포 직전에 `SELECT count(*) FROM "Reservation";`을 먼저 확인할 것.
--   2) 수만 건 수준이면 1초 안에 끝나므로 그냥 배포하면 된다.
--   3) 수십만 건 이상이면 영업시간을 피해서 배포하거나, 이 파일을 쪼개서
--      (백필을 배치로 나누고, 인덱스는 CREATE INDEX CONCURRENTLY로 트랜잭션 밖에서)
--      수동 적용한 뒤 마이그레이션은 `prisma migrate resolve --applied`로 기록만 남길 것.
-- (CREATE INDEX CONCURRENTLY는 트랜잭션 안에서 못 쓰기 때문에 Prisma 마이그레이션 파일 안에
--  그대로 넣을 수 없다 — Prisma의 구조적 한계이지 이 파일의 실수가 아니다.)

-- ============================================================
-- 1) Store.posToken — POS 탭앱 인증 토큰(64자 hex, 매장별 고유)
-- ============================================================

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "posToken" TEXT;

-- 기존 매장은 전부 posToken이 비어있으니, 무작위 64자 hex 값으로 채운다.
-- md5()는 32자 hex를 반환하므로 두 번 이어붙여 64자를 만든다. random()과 clock_timestamp()를
-- 섞어 로우마다(그리고 두 번의 md5 호출마다) 값이 겹치지 않게 한다 — clock_timestamp()는
-- 트랜잭션 시작 시각으로 고정되는 now()와 달리 호출될 때마다 실제 시각을 반환하므로
-- 같은 UPDATE 문 안에서도 두 md5 호출이 서로 다른 입력을 받는다.
UPDATE "Store"
SET "posToken" = md5(random()::text || clock_timestamp()::text)
                 || md5(random()::text || clock_timestamp()::text || "id")
WHERE "posToken" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Store_posToken_key" ON "Store"("posToken");

-- ============================================================
-- 2) AdminUser — 로그인 실패 카운트/잠금 (계정 잠금, §3.22)
-- ============================================================

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AdminUser" ADD COLUMN "lockedUntil" TIMESTAMP(3);

-- ============================================================
-- 3) Reservation — serviceDate(NOT NULL) + 개인정보 동의/파기 시각
-- ============================================================

-- AlterTable: serviceDate를 nullable로 먼저 추가한다.
ALTER TABLE "Reservation" ADD COLUMN "serviceDate" TEXT;

-- 기존 예약은 접수 시각(createdAt, UTC)을 KST(UTC+9)로 보정한 날짜를 serviceDate로 백필한다.
-- 애플리케이션의 kstDateString()과 동일한 규칙(UTC 자정이 아니라 KST 자정 기준 날짜 경계)이다.
UPDATE "Reservation"
SET "serviceDate" = to_char("createdAt" + interval '9 hours', 'YYYY-MM-DD')
WHERE "serviceDate" IS NULL;

-- 백필이 끝났으니 이제부터는 NOT NULL을 강제한다.
ALTER TABLE "Reservation" ALTER COLUMN "serviceDate" SET NOT NULL;

-- AlterTable: 개인정보 동의/파기 시각(전부 nullable이라 백필 불필요 — 과거 예약은 동의 이력이
-- 없었으므로 NULL로 두고, 파기 잡은 anonymizedAt이 NULL인 오래된 로우를 대상으로 한다).
ALTER TABLE "Reservation" ADD COLUMN "privacyConsentAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN "marketingConsentAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN "anonymizedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Reservation_storeId_serviceDate_status_idx" ON "Reservation"("storeId", "serviceDate", "status");
CREATE INDEX IF NOT EXISTS "Reservation_storeId_createdAt_idx" ON "Reservation"("storeId", "createdAt");
CREATE INDEX IF NOT EXISTS "Reservation_storeId_phone_idx" ON "Reservation"("storeId", "phone");

-- ============================================================
-- 4) Payment — 개인정보 동의/파기 시각
-- ============================================================

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "privacyConsentAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "marketingConsentAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "anonymizedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payment_storeId_createdAt_idx" ON "Payment"("storeId", "createdAt");
