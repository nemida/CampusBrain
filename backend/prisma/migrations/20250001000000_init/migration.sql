-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'TEACHER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ExamType" AS ENUM ('MID_SEM', 'END_SEM');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('PAPER', 'NOTES', 'SYLLABUS');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'PAUSED');

-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('VIEW', 'DOWNLOAD', 'QUIZ_ATTEMPT', 'PLAN_DAY_COMPLETE');

-- CreateTable
CREATE TABLE "User" (
    "id"           TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "role"         "Role" NOT NULL DEFAULT 'STUDENT',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateTable
CREATE TABLE "UserProfile" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "year"      INTEGER,
    "branchId"  TEXT,
    "semester"  INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateTable
CREATE TABLE "UserProfileSubject" (
    "id"        TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,

    CONSTRAINT "UserProfileSubject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserProfileSubject_profileId_subjectId_key" ON "UserProfileSubject"("profileId", "subjectId");

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id"        TEXT NOT NULL,
    "token"     TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateTable
CREATE TABLE "Branch" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "code"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Branch_name_key" ON "Branch"("name");
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");

-- CreateTable
CREATE TABLE "Subject" (
    "id"       TEXT NOT NULL,
    "code"     TEXT NOT NULL,
    "name"     TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "branchId" TEXT NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subject_code_branchId_key" ON "Subject"("code", "branchId");
CREATE INDEX "Subject_branchId_semester_idx" ON "Subject"("branchId", "semester");

-- CreateTable
CREATE TABLE "Resource" (
    "id"            TEXT NOT NULL,
    "subjectId"     TEXT NOT NULL,
    "uploadedById"  TEXT NOT NULL,
    "type"          "ResourceType" NOT NULL DEFAULT 'PAPER',
    "title"         TEXT NOT NULL,
    "year"          INTEGER NOT NULL,
    "examType"      "ExamType" NOT NULL,
    "fileUrl"       TEXT NOT NULL,
    "publicId"      TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Resource_subjectId_idx" ON "Resource"("subjectId");
CREATE INDEX "Resource_year_idx" ON "Resource"("year");

-- CreateTable
CREATE TABLE "Syllabus" (
    "id"          TEXT NOT NULL,
    "branchId"    TEXT NOT NULL,
    "semester"    INTEGER NOT NULL,
    "scheme"      TEXT NOT NULL DEFAULT '2021',
    "description" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "Syllabus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Syllabus_branchId_semester_scheme_key" ON "Syllabus"("branchId", "semester", "scheme");
CREATE INDEX "Syllabus_branchId_semester_idx" ON "Syllabus"("branchId", "semester");

-- CreateTable
CREATE TABLE "SyllabusItem" (
    "id"         TEXT NOT NULL,
    "syllabusId" TEXT NOT NULL,
    "subjectId"  TEXT,
    "unitNumber" INTEGER NOT NULL,
    "title"      TEXT NOT NULL,
    "topics"     TEXT[],
    "hours"      INTEGER,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyllabusItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyllabusItem_syllabusId_idx" ON "SyllabusItem"("syllabusId");

-- CreateTable
CREATE TABLE "StudyPlan" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "examDate"  TIMESTAMP(3),
    "totalDays" INTEGER NOT NULL,
    "status"    "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "groupId"   TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "config"    JSONB,

    CONSTRAINT "StudyPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StudyPlan_userId_idx" ON "StudyPlan"("userId");
CREATE INDEX "StudyPlan_groupId_idx" ON "StudyPlan"("groupId");

-- CreateTable
CREATE TABLE "StudyPlanDay" (
    "id"          TEXT NOT NULL,
    "studyPlanId" TEXT NOT NULL,
    "dayNumber"   INTEGER NOT NULL,
    "date"        TIMESTAMP(3),
    "subjectId"   TEXT,
    "topics"      TEXT[],
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "notes"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "sessions"    JSONB,

    CONSTRAINT "StudyPlanDay_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StudyPlanDay_studyPlanId_idx" ON "StudyPlanDay"("studyPlanId");

-- CreateTable
CREATE TABLE "StudyGroup" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "inviteCode"  TEXT NOT NULL,
    "ownerId"     TEXT NOT NULL,
    "branch"      TEXT,
    "semester"    INTEGER,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudyGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StudyGroup_inviteCode_key" ON "StudyGroup"("inviteCode");
CREATE INDEX "StudyGroup_ownerId_idx" ON "StudyGroup"("ownerId");

-- CreateTable
CREATE TABLE "GroupMembership" (
    "id"       TEXT NOT NULL,
    "groupId"  TEXT NOT NULL,
    "userId"   TEXT NOT NULL,
    "role"     "GroupRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupMembership_groupId_userId_key" ON "GroupMembership"("groupId", "userId");
CREATE INDEX "GroupMembership_userId_idx" ON "GroupMembership"("userId");

-- CreateTable
CREATE TABLE "UserActivity" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "resourceId"   TEXT,
    "activityType" "ActivityType" NOT NULL,
    "metadata"     JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserActivity_userId_idx" ON "UserActivity"("userId");
CREATE INDEX "UserActivity_resourceId_idx" ON "UserActivity"("resourceId");
CREATE INDEX "UserActivity_userId_activityType_idx" ON "UserActivity"("userId", "activityType");

-- CreateTable
CREATE TABLE "MCQSession" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "subjectId"  TEXT,
    "topic"      TEXT,
    "totalQ"     INTEGER NOT NULL,
    "correctQ"   INTEGER NOT NULL DEFAULT 0,
    "score"      DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timeTakenS" INTEGER,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MCQSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MCQSession_userId_idx" ON "MCQSession"("userId");

-- CreateTable
CREATE TABLE "MCQQuestion" (
    "id"           TEXT NOT NULL,
    "sessionId"    TEXT NOT NULL,
    "question"     TEXT NOT NULL,
    "options"      TEXT[],
    "correctIndex" INTEGER NOT NULL,
    "chosenIndex"  INTEGER,
    "explanation"  TEXT,
    "topic"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MCQQuestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MCQQuestion_sessionId_idx" ON "MCQQuestion"("sessionId");

-- CreateTable
CREATE TABLE "FlashcardSet" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "subjectId" TEXT,
    "topic"     TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlashcardSet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FlashcardSet_userId_idx" ON "FlashcardSet"("userId");

-- CreateTable
CREATE TABLE "Flashcard" (
    "id"          TEXT NOT NULL,
    "setId"       TEXT NOT NULL,
    "front"       TEXT NOT NULL,
    "back"        TEXT NOT NULL,
    "easeFactor"  DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "interval"    INTEGER NOT NULL DEFAULT 1,
    "repetitions" INTEGER NOT NULL DEFAULT 0,
    "nextReview"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flashcard_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Flashcard_setId_idx" ON "Flashcard"("setId");
CREATE INDEX "Flashcard_nextReview_idx" ON "Flashcard"("nextReview");

-- CreateTable
CREATE TABLE "PaperQuestion" (
    "id"            TEXT NOT NULL,
    "resourceId"    TEXT NOT NULL,
    "subjectId"     TEXT NOT NULL,
    "questionIndex" INTEGER NOT NULL,
    "label"         TEXT,
    "marks"         INTEGER,
    "text"          TEXT NOT NULL,
    "pageNumber"    INTEGER,
    "source"        TEXT,
    "embedding"     vector(768),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperQuestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaperQuestion_resourceId_idx" ON "PaperQuestion"("resourceId");
CREATE INDEX "PaperQuestion_subjectId_idx" ON "PaperQuestion"("subjectId");

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserProfileSubject" ADD CONSTRAINT "UserProfileSubject_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserProfileSubject" ADD CONSTRAINT "UserProfileSubject_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subject" ADD CONSTRAINT "Subject_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Resource" ADD CONSTRAINT "Resource_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Resource" ADD CONSTRAINT "Resource_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Syllabus" ADD CONSTRAINT "Syllabus_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SyllabusItem" ADD CONSTRAINT "SyllabusItem_syllabusId_fkey"
    FOREIGN KEY ("syllabusId") REFERENCES "Syllabus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SyllabusItem" ADD CONSTRAINT "SyllabusItem_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "StudyGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StudyPlanDay" ADD CONSTRAINT "StudyPlanDay_studyPlanId_fkey"
    FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudyPlanDay" ADD CONSTRAINT "StudyPlanDay_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StudyGroup" ADD CONSTRAINT "StudyGroup_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "StudyGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserActivity" ADD CONSTRAINT "UserActivity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserActivity" ADD CONSTRAINT "UserActivity_resourceId_fkey"
    FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MCQSession" ADD CONSTRAINT "MCQSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MCQQuestion" ADD CONSTRAINT "MCQQuestion_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "MCQSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FlashcardSet" ADD CONSTRAINT "FlashcardSet_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Flashcard" ADD CONSTRAINT "Flashcard_setId_fkey"
    FOREIGN KEY ("setId") REFERENCES "FlashcardSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperQuestion" ADD CONSTRAINT "PaperQuestion_resourceId_fkey"
    FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
