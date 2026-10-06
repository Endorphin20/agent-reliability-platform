-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'NEEDS_ATTENTION';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "readCredential" TEXT,
ADD COLUMN     "repoUrl" TEXT,
ADD COLUMN     "writeCredential" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "attentionReason" TEXT,
ADD COLUMN     "confirmationKey" TEXT,
ADD COLUMN     "parentTaskId" TEXT,
ADD COLUMN     "snapshot" JSONB,
ADD COLUMN     "snapshotDigest" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "activeStartedAt" TIMESTAMP(3),
ADD COLUMN     "baseline" JSONB,
ADD COLUMN     "deadlineAt" TIMESTAMP(3),
ADD COLUMN     "environmentId" TEXT,
ADD COLUMN     "imageId" TEXT,
ADD COLUMN     "phase" TEXT NOT NULL DEFAULT 'QUEUED';

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN     "leaseToken" TEXT;

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "patchDigest" TEXT;

-- AlterTable
ALTER TABLE "OutboxMessage" ADD COLUMN     "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "RepositoryConfigVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDraft" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvironmentVersion" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARING',
    "imageId" TEXT,
    "registryDigest" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetCall" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "reserved" INTEGER NOT NULL,
    "used" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryJob" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "patchDigest" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT,
    "prUrl" TEXT,
    "error" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryConfigVersion_projectId_version_key" ON "RepositoryConfigVersion"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVersion_fingerprint_key" ON "EnvironmentVersion"("fingerprint");

-- CreateIndex
CREATE INDEX "BudgetCall_runId_idx" ON "BudgetCall"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryJob_approvalId_key" ON "DeliveryJob"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_eventKey_key" ON "Notification"("eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "Task_confirmationKey_key" ON "Task"("confirmationKey");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_leaseToken_key" ON "Attempt"("leaseToken");

-- AddForeignKey
ALTER TABLE "RepositoryConfigVersion" ADD CONSTRAINT "RepositoryConfigVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDraft" ADD CONSTRAINT "TaskDraft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetCall" ADD CONSTRAINT "BudgetCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryJob" ADD CONSTRAINT "DeliveryJob_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
