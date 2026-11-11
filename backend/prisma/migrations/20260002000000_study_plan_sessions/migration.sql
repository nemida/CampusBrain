-- Add config to StudyPlan
ALTER TABLE "StudyPlan" ADD COLUMN IF NOT EXISTS "config" JSONB;

-- Add sessions to StudyPlanDay
ALTER TABLE "StudyPlanDay" ADD COLUMN IF NOT EXISTS "sessions" JSONB;

-- Add pageNumber and source to PaperQuestion
ALTER TABLE "PaperQuestion" ADD COLUMN IF NOT EXISTS "pageNumber" INTEGER;
ALTER TABLE "PaperQuestion" ADD COLUMN IF NOT EXISTS "source" TEXT;
