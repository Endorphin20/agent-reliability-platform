-- 评测实验开关（T11）：--no-recovery 与 --feedback {structured|raw}
ALTER TABLE "Run" ADD COLUMN "recoveryDisabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Run" ADD COLUMN "feedbackMode" TEXT NOT NULL DEFAULT 'structured';
