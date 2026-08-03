-- CreateEnum
CREATE TYPE "TaskSource" AS ENUM ('MANUAL', 'GITHUB_ISSUE', 'WORKFLOW_RUN');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('CREATED', 'QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'APPROVED', 'PR_CREATED', 'PR_FAILED', 'RESOLVED', 'REJECTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'DISPATCHED', 'RUNNING', 'VERIFYING', 'INTERRUPTED', 'RECOVERING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CRASHED', 'TIMED_OUT', 'LEASE_EXPIRED');

-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('SELF_LANGGRAPH', 'MINI_SWE');

-- CreateEnum
CREATE TYPE "TraceEventType" AS ENUM ('MODEL_CALL', 'TOOL_CALL', 'FILE_CHANGE', 'COMMAND_EXEC', 'STATE_TRANSITION', 'CHECKPOINT_SAVED', 'FAILURE_DETECTED', 'RECOVERY_ACTION', 'VERIFICATION_RESULT', 'APPROVAL_EVENT', 'BUDGET_UPDATE');

-- CreateEnum
CREATE TYPE "FailureCode" AS ENUM ('MODEL_RATE_LIMIT', 'MODEL_API_ERROR', 'MODEL_BAD_OUTPUT', 'TOOL_EXEC_ERROR', 'PATCH_APPLY_FAILED', 'SANDBOX_START_FAILED', 'SANDBOX_CRASHED', 'WORKER_LOST', 'BUDGET_TOKENS_EXCEEDED', 'BUDGET_TIME_EXCEEDED', 'BUDGET_TURNS_EXCEEDED', 'AGENT_STUCK', 'VERIFY_PATCH_MALFORMED', 'VERIFY_SCOPE_VIOLATION', 'VERIFY_STATIC_FAILED', 'VERIFY_TARGET_TESTS_FAILED', 'VERIFY_REGRESSION_FAILED', 'VERIFY_TEST_TAMPERING', 'HUMAN_REJECTED', 'CANCELLED_BY_USER');

-- CreateEnum
CREATE TYPE "PolicyAction" AS ENUM ('RESUME', 'RESTART_ATTEMPT', 'ESCALATE_HUMAN', 'ABORT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('PATCH', 'TEST_REPORT', 'LOG');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "githubRepo" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" "TaskSource" NOT NULL,
    "sourceRef" TEXT,
    "fixtureId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'CREATED',
    "allowedPaths" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentKind" "AgentKind" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "baseCommit" TEXT NOT NULL,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "budgetTokens" INTEGER NOT NULL DEFAULT 200000,
    "budgetSeconds" INTEGER NOT NULL DEFAULT 900,
    "budgetTurns" INTEGER NOT NULL DEFAULT 30,
    "usedTokens" INTEGER NOT NULL DEFAULT 0,
    "usedSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "no" INTEGER NOT NULL,
    "workerId" TEXT,
    "status" "AttemptStatus" NOT NULL DEFAULT 'CLAIMED',
    "failureCode" "FailureCode",
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraceEvent" (
    "id" BIGSERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "runSequence" INTEGER NOT NULL,
    "attemptSequence" INTEGER NOT NULL,
    "type" "TraceEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TraceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Checkpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "appliedPatchSha" TEXT,
    "completedToolCalls" JSONB NOT NULL,
    "usedTokens" INTEGER NOT NULL,
    "usedSeconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "failureCode" "FailureCode",
    "detail" JSONB NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyDecision" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "failureCode" "FailureCode" NOT NULL,
    "action" "PolicyAction" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewer" TEXT,
    "decidedAt" TIMESTAMP(3),
    "prUrl" TEXT,
    "prError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "taskId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("deliveryId")
);

-- CreateTable
CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "suite" TEXT NOT NULL,
    "agentKind" "AgentKind" NOT NULL,
    "faultInjection" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationResult" (
    "id" TEXT NOT NULL,
    "evaluationRunId" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL,
    "firstTrySuccess" BOOLEAN NOT NULL,
    "recovered" BOOLEAN,
    "recoveryMode" TEXT,
    "scopeViolations" INTEGER NOT NULL,
    "tokens" INTEGER NOT NULL,
    "costUsd" DECIMAL(10,4) NOT NULL,
    "wallSeconds" INTEGER NOT NULL,
    "judgeScores" JSONB NOT NULL,

    CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attempt_status_leaseExpiresAt_idx" ON "Attempt"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_runId_no_key" ON "Attempt"("runId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "TraceEvent_idempotencyKey_key" ON "TraceEvent"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TraceEvent_runId_runSequence_key" ON "TraceEvent"("runId", "runSequence");

-- CreateIndex
CREATE INDEX "Checkpoint_runId_createdAt_idx" ON "Checkpoint"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "Artifact_runId_kind_idx" ON "Artifact"("runId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_taskId_key" ON "Approval"("taskId");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_createdAt_idx" ON "OutboxMessage"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "EvaluationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
