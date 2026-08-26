-- 쉐보레 전산(ERP) "물건 담기" -> POS 플러그인 장바구니 중계 (POS-CART-BRIDGE §1)
-- ErpCart는 완전히 새로운 테이블이다. 기존 Store/ErpOrder 등 어떤 테이블도 ALTER하지 않으므로
-- 이 마이그레이션은 기존 로우를 다시 쓰지 않고, 기존 테이블에 잠금을 걸지도 않는다
-- (20260824190000_erp_order와 동일한 이유 -- "nullable 추가 -> 백필 -> NOT NULL 승격" 3단계가
-- 필요 없는, 순수 CREATE TABLE 하나짜리 변경이다).

-- ============================================================
-- ErpCart -- 전산 참조번호(referenceId) 단위로 쌓이는 "결제 전 장바구니" 큐.
-- POS 플러그인이 GET /api/pos/erp-carts로 pending 건을 가져가 자기 장바구니에 담고,
-- POST /api/pos/erp-carts/:id/consume으로 결과(loaded/failed)를 되돌려준다.
-- ============================================================

-- CreateTable
CREATE TABLE "ErpCart" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "itemsJson" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "memo" TEXT,
    "autoPay" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loadedAt" TIMESTAMP(3),

    CONSTRAINT "ErpCart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ErpCart_referenceId_key" ON "ErpCart"("referenceId");
CREATE INDEX IF NOT EXISTS "ErpCart_storeId_status_createdAt_idx" ON "ErpCart"("storeId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ErpCart" ADD CONSTRAINT "ErpCart_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
