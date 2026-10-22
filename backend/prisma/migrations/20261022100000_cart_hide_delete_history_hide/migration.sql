-- AlterTable
ALTER TABLE "ErpCart" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "hiddenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "historyHiddenAt" TIMESTAMP(3);

