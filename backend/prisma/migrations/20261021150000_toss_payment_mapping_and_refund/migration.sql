-- 토스 결제내역 매핑 + 전산 주문 결제 취소.
--
-- 1) TossPayment: 토스 결제 웹훅으로 받은 결제 기록. 토스 Open API에는 결제 목록 조회가 없어
--    웹훅이 올 때마다 남겨두고 전산 주문(ErpCart)과 맞춘다.
-- 2) ErpCart: 프론트 승인번호(매핑 열쇠), 토스 확인 시각, 결제 취소 관련 컬럼.
--
-- 전부 새 테이블·nullable 컬럼 추가라 백필이 필요 없고, 이전 버전 서버가 떠 있어도 영향이 없다.

-- CreateTable
CREATE TABLE IF NOT EXISTS "TossPayment" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "storeId" TEXT,
    "orderId" TEXT,
    "state" TEXT NOT NULL,
    "sourceType" TEXT,
    "amount" INTEGER,
    "approvedNo" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TossPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TossPayment_storeId_approvedNo_idx" ON "TossPayment"("storeId", "approvedNo");
CREATE INDEX IF NOT EXISTS "TossPayment_createdAt_idx" ON "TossPayment"("createdAt");

-- AlterTable
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "frontApprovalNo" TEXT;
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "tossVerifiedAt" TIMESTAMP(3);
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "refundRequestedAt" TIMESTAMP(3);
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "refundNote" TEXT;

CREATE INDEX IF NOT EXISTS "ErpCart_storeId_frontApprovalNo_idx" ON "ErpCart"("storeId", "frontApprovalNo");
CREATE INDEX IF NOT EXISTS "ErpCart_tossPaymentId_idx" ON "ErpCart"("tossPaymentId");
