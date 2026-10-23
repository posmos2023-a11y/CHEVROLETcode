-- 손님이 접수 때 적는 차종(선택). 기본값 없는 nullable 컬럼 추가라 PostgreSQL 11 이상에서는 테이블을 다시 쓰지 않고 카탈로그만 바꾼다 --
-- 잠금은 아주 잠깐이라 잠금 대기 제한(lock_timeout)을 두지 않는다(20261023150000_query_indexes 주석과 같은 이유).
-- 기존 접수는 모두 null(차종 없음)로 남는다.

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "carModel" TEXT;

