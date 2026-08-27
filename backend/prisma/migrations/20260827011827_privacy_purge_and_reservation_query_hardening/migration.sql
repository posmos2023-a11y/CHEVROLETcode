-- 개인정보 3년 파기 범위 확대 (ERP_CONTRACT_V1 §2.2 / 정보통신망법)
--
-- 1) ErpOrder에 anonymizedAt을 더한다. 이 테이블은 그동안 파기 대상에 아예 없었다 --
--    memo/itemsJson에 전산이 보낸 차량번호·고객명이 들어가는데도 purgeExpiredPersonalData가
--    부르지 않았다. nullable 컬럼 추가라 백필이 필요 없고 뜨거운 테이블에 긴 잠금도 걸지 않는다.
--
-- 2) WebhookEvent는 개인정보라기보다 무한 증가가 문제라 삭제 대상이 되고, 삭제 쿼리가
--    (receivedAt < cutoff)로 대상을 찾으므로 인덱스를 둔다.

-- AlterTable
ALTER TABLE "ErpOrder" ADD COLUMN IF NOT EXISTS "anonymizedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");
