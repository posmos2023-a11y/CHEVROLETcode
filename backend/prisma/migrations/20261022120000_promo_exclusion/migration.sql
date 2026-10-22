-- CreateTable
CREATE TABLE "PromoExclusion" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoExclusion_storeId_phone_key" ON "PromoExclusion"("storeId", "phone");

-- AddForeignKey
ALTER TABLE "PromoExclusion" ADD CONSTRAINT "PromoExclusion_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

