-- 쉐보레 전산(ERP) 연동 마이그레이션 (ERP_CONTRACT_V1 §2)
-- Store.erpStoreCode는 nullable 추가만, ErpOrder는 신규 테이블 생성이라 둘 다 기존 로우를
-- 다시 쓰지 않는다 -- 20260824120000_production_hardening처럼 "nullable 추가 -> 백필 ->
-- NOT NULL 승격" 3단계가 필요 없고, 그래서 Store/Reservation 같은 뜨거운 테이블에 긴 쓰기
-- 잠금을 걸지 않는다.

-- ============================================================
-- 1) Store.erpStoreCode -- 전산이 매장을 지정할 때 쓰는 코드
-- ============================================================

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "erpStoreCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Store_erpStoreCode_key" ON "Store"("erpStoreCode");

-- ============================================================
-- 2) ErpOrder -- 전산 주문 참조번호(referenceId) <-> 토스 주문 매핑
-- ============================================================

-- CreateTable
CREATE TABLE "ErpOrder" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "tossOrderKey" TEXT NOT NULL,
    "tossOrderId" TEXT,
    "totalAmount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "itemsJson" TEXT NOT NULL,
    "memo" TEXT,
    "tossRawJson" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "ErpOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ErpOrder_referenceId_key" ON "ErpOrder"("referenceId");
CREATE UNIQUE INDEX IF NOT EXISTS "ErpOrder_tossOrderKey_key" ON "ErpOrder"("tossOrderKey");
CREATE INDEX IF NOT EXISTS "ErpOrder_storeId_createdAt_idx" ON "ErpOrder"("storeId", "createdAt");
CREATE INDEX IF NOT EXISTS "ErpOrder_status_idx" ON "ErpOrder"("status");

-- AddForeignKey
ALTER TABLE "ErpOrder" ADD CONSTRAINT "ErpOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
