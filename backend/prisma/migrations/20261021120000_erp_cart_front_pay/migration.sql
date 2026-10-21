-- 전산 주문을 플러그인 모드 프론트에서 직접 결제하는 경로.
--
-- 토스는 프론트 플러그인과 토스 POS 동시 연결을 지원하지 않는다(연동 가이드 FAQ). 그래서 프론트
-- 결제 건은 POS 탭앱을 거치지 않고, 프론트 플러그인이 서버에서 바로 가져가 결제한다.
--
-- payTarget은 NOT NULL DEFAULT 'pos'라 기존 로우가 전부 'pos'로 채워진다 -- 지금까지의 전산 주문은
-- 모두 POS 결제 건이었으므로 뜻이 그대로 유지된다. 나머지는 nullable 컬럼이라 백필이 필요 없다.

-- AlterTable
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "payTarget" TEXT NOT NULL DEFAULT 'pos';
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "frontPaymentKey" TEXT;
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "frontPayingAt" TIMESTAMP(3);
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "frontPaymentJson" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ErpCart_frontPaymentKey_key" ON "ErpCart"("frontPaymentKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ErpCart_storeId_payTarget_status_createdAt_idx" ON "ErpCart"("storeId", "payTarget", "status", "createdAt");
