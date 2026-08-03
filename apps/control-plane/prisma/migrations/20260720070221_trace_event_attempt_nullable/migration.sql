-- DropForeignKey
ALTER TABLE "TraceEvent" DROP CONSTRAINT "TraceEvent_attemptId_fkey";

-- AlterTable
ALTER TABLE "TraceEvent" ALTER COLUMN "attemptId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
