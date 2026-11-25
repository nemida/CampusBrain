-- CreateEnum
CREATE TYPE "MaterialStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'DELETING');

-- CreateTable
CREATE TABLE "TextbookMaterial" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "status" "MaterialStatus" NOT NULL DEFAULT 'PENDING',
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "processedPages" INTEGER NOT NULL DEFAULT 0,
    "unreadablePages" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "error" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "processingRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TextbookMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TextbookChunk" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'text',
    "embedding" vector,
    "model" TEXT,

    CONSTRAINT "TextbookChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "inputs" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TextbookMaterial_unitId_status_idx" ON "TextbookMaterial"("unitId", "status");

CREATE INDEX "TextbookMaterial_status_createdAt_idx" ON "TextbookMaterial"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TextbookChunk_materialId_chunkIndex_key" ON "TextbookChunk"("materialId", "chunkIndex");

-- CreateIndex
CREATE INDEX "UnitNote_userId_unitId_createdAt_idx" ON "UnitNote"("userId", "unitId", "createdAt");

-- AddForeignKey
ALTER TABLE "TextbookMaterial" ADD CONSTRAINT "TextbookMaterial_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "SyllabusItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextbookMaterial" ADD CONSTRAINT "TextbookMaterial_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextbookChunk" ADD CONSTRAINT "TextbookChunk_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "TextbookMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitNote" ADD CONSTRAINT "UnitNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitNote" ADD CONSTRAINT "UnitNote_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "SyllabusItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
