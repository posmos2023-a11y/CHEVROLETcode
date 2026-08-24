-- 접수 알림톡 실패 추적 (API 계약 v3 §1)
-- intakeNotifyStatus는 null(정상/미시도) 또는 'failed' 두 값만 쓰므로 nullable 컬럼 추가만으로
-- 충분하다 — v2 하드닝 마이그레이션과 달리 백필/NOT NULL 승격이 없어 기존 로우를 다시 쓰지 않고,
-- 그래서 Reservation 테이블(가장 뜨거운 테이블)에 긴 쓰기 잠금을 걸지 않는다.

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN "intakeNotifyStatus" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Reservation_storeId_intakeNotifyStatus_idx" ON "Reservation"("storeId", "intakeNotifyStatus");
