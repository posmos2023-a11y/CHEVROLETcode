-- 매장이 손으로 보낸 홍보 메시지 기록.
--
-- 신규 테이블 하나뿐이라 기존 로우를 다시 쓰지 않고, 뜨거운 테이블에 잠금도 걸지 않는다.
--
-- 왜 Payment.promoSent와 따로 두나: 전산으로만 정비받은 손님은 Payment가 없어서 그 플래그를
-- 쓸 수 없고, 광고 발송은 "누가 언제 누구에게"가 남아야 하는데 플래그 하나로는 안 된다.

CREATE TABLE IF NOT EXISTS "PromoSend" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "carNumber" TEXT,
    "phone" TEXT,
    "sentBy" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anonymizedAt" TIMESTAMP(3),

    CONSTRAINT "PromoSend_pkey" PRIMARY KEY ("id")
);

-- 같은 차에 최근에 보냈는지 확인하는 조회에 쓴다(반복 발송 차단).
CREATE INDEX IF NOT EXISTS "PromoSend_storeId_carNumber_sentAt_idx"
    ON "PromoSend"("storeId", "carNumber", "sentAt");
CREATE INDEX IF NOT EXISTS "PromoSend_storeId_sentAt_idx"
    ON "PromoSend"("storeId", "sentAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PromoSend_storeId_fkey') THEN
    ALTER TABLE "PromoSend"
      ADD CONSTRAINT "PromoSend_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "Store"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
