-- Enable pgvector extension (Supabase / Neon both support this)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── ResourceChunk ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ResourceChunk" (
    "id"          TEXT NOT NULL,
    "resourceId"  TEXT NOT NULL,
    "subjectId"   TEXT NOT NULL,
    "chunkIndex"  INTEGER NOT NULL,
    "pageNumber"  INTEGER,
    "text"        TEXT NOT NULL,
    "embedding"   vector(768),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ResourceChunk_resourceId_idx" ON "ResourceChunk"("resourceId");
CREATE INDEX IF NOT EXISTS "ResourceChunk_subjectId_idx"  ON "ResourceChunk"("subjectId");

-- IVFFlat index for fast approximate nearest-neighbour search
CREATE INDEX IF NOT EXISTS "ResourceChunk_embedding_idx"
    ON "ResourceChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ResourceChunk_resourceId_fkey'
  ) THEN
    ALTER TABLE "ResourceChunk"
      ADD CONSTRAINT "ResourceChunk_resourceId_fkey"
      FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── SyllabusChunk ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SyllabusChunk" (
    "id"             TEXT NOT NULL,
    "syllabusItemId" TEXT NOT NULL,
    "subjectId"      TEXT,
    "text"           TEXT NOT NULL,
    "embedding"      vector(768),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyllabusChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SyllabusChunk_syllabusItemId_idx" ON "SyllabusChunk"("syllabusItemId");
CREATE INDEX IF NOT EXISTS "SyllabusChunk_subjectId_idx"      ON "SyllabusChunk"("subjectId");

CREATE INDEX IF NOT EXISTS "SyllabusChunk_embedding_idx"
    ON "SyllabusChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 50);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SyllabusChunk_syllabusItemId_fkey'
  ) THEN
    ALTER TABLE "SyllabusChunk"
      ADD CONSTRAINT "SyllabusChunk_syllabusItemId_fkey"
      FOREIGN KEY ("syllabusItemId") REFERENCES "SyllabusItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
