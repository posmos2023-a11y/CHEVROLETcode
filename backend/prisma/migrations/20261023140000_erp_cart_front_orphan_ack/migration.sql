-- AlterTable
ALTER TABLE "ErpCart" ADD COLUMN     "frontOrphanAckAt" TIMESTAMP(3),
ADD COLUMN     "frontOrphanPaymentJson" TEXT,
ADD COLUMN     "frontOrphanPaymentKey" TEXT;

-- CreateIndex
CREATE INDEX "ErpCart_storeId_frontOrphanAt_idx" ON "ErpCart"("storeId", "frontOrphanAt");

