-- AlterTable
ALTER TABLE "PromoSend" ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'sent',
ADD COLUMN     "via" TEXT;

-- CreateTable
CREATE TABLE "MarketingOptOut" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" TEXT,
    "via" TEXT,

    CONSTRAINT "MarketingOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingOptOut_storeId_phone_key" ON "MarketingOptOut"("storeId", "phone");

-- CreateIndex
CREATE INDEX "Payment_storeId_phone_idx" ON "Payment"("storeId", "phone");

-- CreateIndex
CREATE INDEX "PromoSend_storeId_phone_sentAt_idx" ON "PromoSend"("storeId", "phone", "sentAt");

-- AddForeignKey
ALTER TABLE "MarketingOptOut" ADD CONSTRAINT "MarketingOptOut_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

