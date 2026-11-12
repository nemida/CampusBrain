-- CreateTable
CREATE TABLE "TopicProfile" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "aliases" TEXT[],
    "embedding" JSONB,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TopicProfile_key_key" ON "TopicProfile"("key");