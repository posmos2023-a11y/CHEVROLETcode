-- 조회용 인덱스. 지금 테이블 크기에서는 일반 CREATE INDEX가 잠깐이면 끝나므로 잠금 대기 제한(lock_timeout)을 두지 않는다 --
-- 제한에 걸려 실패하면 _prisma_migrations에 실패 기록이 남고, 그 뒤 migrate deploy는 배포를 다시 돌려도 P3009로 계속 막힌다.
-- (그런 일이 생기면 `npx prisma migrate resolve --rolled-back 20261023150000_query_indexes`로 기록을 정리한 뒤 다시 배포한다.)
-- 테이블이 커진 뒤에 비슷한 인덱스를 더할 때는 CREATE INDEX CONCURRENTLY를 문장 하나짜리 별도 마이그레이션으로 둔다.

-- CreateIndex
CREATE INDEX "ErpCart_storeId_paidAt_idx" ON "ErpCart"("storeId", "paidAt");

-- CreateIndex
CREATE INDEX "ErpCart_createdAt_idx" ON "ErpCart"("createdAt");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "Reservation_storeId_status_idx" ON "Reservation"("storeId", "status");

-- CreateIndex
CREATE INDEX "Reservation_serviceDate_status_idx" ON "Reservation"("serviceDate", "status");

-- CreateIndex
CREATE INDEX "Reservation_createdAt_idx" ON "Reservation"("createdAt");
