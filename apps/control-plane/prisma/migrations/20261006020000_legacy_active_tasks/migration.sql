-- Do not manufacture a historical SHA for previously running legacy tasks.
-- Deploy with old workers stopped. Terminal history remains untouched.
UPDATE "Attempt" SET status = 'FAILED', "endedAt" = CURRENT_TIMESTAMP
 WHERE "runId" IN (SELECT r.id FROM "Run" r JOIN "Task" t ON t.id = r."taskId"
   WHERE t.snapshot IS NULL AND r.status::text IN ('PENDING','DISPATCHED','RUNNING','VERIFYING','RECOVERING','INTERRUPTED'))
 AND status::text IN ('CLAIMED','RUNNING');
UPDATE "Run" SET status = 'INTERRUPTED', phase = 'NEEDS_ATTENTION', "activeStartedAt" = NULL
 WHERE "taskId" IN (SELECT id FROM "Task" WHERE snapshot IS NULL)
 AND status::text IN ('PENDING','DISPATCHED','RUNNING','VERIFYING','RECOVERING','INTERRUPTED');
UPDATE "Task" SET status = 'NEEDS_ATTENTION', "attentionReason" = 'LEGACY_NEEDS_RECONFIRM'
 WHERE snapshot IS NULL AND status::text IN ('CREATED','QUEUED','RUNNING');
