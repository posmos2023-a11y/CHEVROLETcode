-- AlterTable
ALTER TABLE "ErpCart" ADD COLUMN     "consumeAttemptId" TEXT,
ADD COLUMN     "frontReleasedKey" TEXT,
ADD COLUMN     "refundAttemptId" TEXT,
ADD COLUMN     "refundReleasedAttemptId" TEXT,
ADD COLUMN     "refundStartedAt" TIMESTAMP(3);

