-- AlterTable
ALTER TABLE "ErpCart" ADD COLUMN     "consumeReleasedAttemptId" TEXT,
ADD COLUMN     "frontOrphanAmount" INTEGER,
ADD COLUMN     "frontOrphanApprovalNo" TEXT,
ADD COLUMN     "frontOrphanAt" TIMESTAMP(3);

