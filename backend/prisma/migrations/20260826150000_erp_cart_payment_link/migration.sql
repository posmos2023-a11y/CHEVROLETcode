-- 전산 장바구니에 (1) 결제 결과와 (2) 예약 연결을 기록할 자리를 만든다.
--
-- 전부 nullable 컬럼 추가라 기존 로우를 다시 쓰지 않는다 — 백필도, NOT NULL 승격도 없다.
-- ErpCart는 아직 운영 데이터가 적고 예약/결제 같은 뜨거운 테이블이 아니라 잠금 부담도 없다.
-- Reservation에는 컬럼을 만들지 않는다(역참조는 Prisma 쪽 표현일 뿐 DB 변경이 아니다).

-- ============================================================
-- 1) 결제 결과 — POS에서 실제 결제가 끝났을 때 채워진다.
--    Payment 테이블에 넣지 않는 이유는 schema.prisma 주석 참고(동의 없는 흐름이라 분리).
-- ============================================================
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "tossPaymentId" TEXT;
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "tossOrderId" TEXT;

-- ============================================================
-- 2) 예약 연결 — 전산이 보낸 차량번호로 그날 대기 중인 손님과 이어준다.
-- ============================================================
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "carNumber" TEXT;
ALTER TABLE "ErpCart" ADD COLUMN IF NOT EXISTS "reservationId" TEXT;

-- 차량번호로 그날 예약을 찾을 때 쓰는 인덱스.
CREATE INDEX IF NOT EXISTS "ErpCart_storeId_carNumber_idx" ON "ErpCart"("storeId", "carNumber");

-- 예약이 지워져도 장바구니 이력은 남아야 하므로 ON DELETE SET NULL을 쓴다.
-- (Reservation은 개인정보 파기 시 익명화만 하고 삭제하지 않지만, 관리자 삭제 경로가 있다.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ErpCart_reservationId_fkey'
  ) THEN
    ALTER TABLE "ErpCart"
      ADD CONSTRAINT "ErpCart_reservationId_fkey"
      FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
