/**
 * RAG Retriever — semantic search over ResourceChunk and SyllabusChunk tables.
 *
 * Uses raw SQL with pgvector cosine distance (<=>). All user-influenced values
 * (subjectId, topK, vectors) are passed as bound parameters, never string-interpolated.
 * Falls back to an empty array if no embedding provider is configured or it fails.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { embedText, embedTexts, vectorToSql } from "./embeddings.js";

export interface RetrievedChunk {
  id: string;
  text: string;
  similarity: number;
  sourceType: "resource" | "syllabus";
  sourceId: string; // resourceId or syllabusItemId
  subjectId: string | null;
  pageNumber?: number | null;
  chunkIndex?: number;
}

export interface RetrieverOptions {
  type?: "resource" | "syllabus" | "both";
  subjectId?: string | undefined; // filter to a specific subject
  topK?: number | undefined; // how many chunks to return per source type
  paperOnly?: boolean | undefined; // resource chunks: only from Resource.type = PAPER (skip notes/syllabus files)
  minSimilarity?: number | undefined; // drop weak matches so irrelevant context isn't injected into prompts
}

// ── Core vector search ────────────────────────────────────────────────────────

async function searchByVector(vecSql: string, opts: RetrieverOptions): Promise<RetrievedChunk[]> {
  const { type = "both", subjectId, paperOnly = false, minSimilarity } = opts;
  // topK is a number we control; inline it as a validated integer literal
  const limit = Prisma.raw(String(Math.max(1, Math.min(100, Math.floor(opts.topK ?? 5)))));
  const subjectFilter = subjectId ? Prisma.sql`AND c."subjectId" = ${subjectId}` : Prisma.empty;
  const results: RetrievedChunk[] = [];

  // ── Resource chunks (PYQ papers) ─────────────────────────────────────────
  if (type === "resource" || type === "both") {
    const paperFilter = paperOnly
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "Resource" r WHERE r."id" = c."resourceId" AND r."type" = 'PAPER')`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<
      {
        id: string;
        text: string;
        resourceId: string;
        subjectId: string;
        pageNumber: number | null;
        chunkIndex: number;
        similarity: number;
      }[]
    >(Prisma.sql`
      SELECT c."id", c."text", c."resourceId", c."subjectId", c."pageNumber", c."chunkIndex",
             1 - (c."embedding" <=> ${vecSql}::vector) AS similarity
      FROM "ResourceChunk" c
      WHERE c."embedding" IS NOT NULL ${subjectFilter} ${paperFilter}
      ORDER BY c."embedding" <=> ${vecSql}::vector
      LIMIT ${limit}
    `);

    for (const row of rows) {
      results.push({
        id: row.id,
        text: row.text,
        similarity: Number(row.similarity),
        sourceType: "resource",
        sourceId: row.resourceId,
        subjectId: row.subjectId,
        pageNumber: row.pageNumber,
        chunkIndex: row.chunkIndex,
      });
    }
  }

  // ── Syllabus chunks ───────────────────────────────────────────────────────
  if (type === "syllabus" || type === "both") {
    const rows = await prisma.$queryRaw<
      { id: string; text: string; syllabusItemId: string; subjectId: string | null; similarity: number }[]
    >(Prisma.sql`
      SELECT c."id", c."text", c."syllabusItemId", c."subjectId",
             1 - (c."embedding" <=> ${vecSql}::vector) AS similarity
      FROM "SyllabusChunk" c
      WHERE c."embedding" IS NOT NULL ${subjectFilter}
      ORDER BY c."embedding" <=> ${vecSql}::vector
      LIMIT ${limit}
    `);

    for (const row of rows) {
      results.push({
        id: row.id,
        text: row.text,
        similarity: Number(row.similarity),
        sourceType: "syllabus",
        sourceId: row.syllabusItemId,
        subjectId: row.subjectId,
        pageNumber: null,
      });
    }
  }

  return results
    .filter((r) => minSimilarity === undefined || r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve the most semantically relevant chunks for a natural-language query.
 * Returns [] if no embedding provider is configured or the embedding call fails.
 */
export async function retrieveChunks(query: string, opts: RetrieverOptions = {}): Promise<RetrievedChunk[]> {
  const embedding = await embedText(query, "query");
  if (!embedding) return []; // callers degrade gracefully to prompt-only LLM
  return searchByVector(vectorToSql(embedding), opts);
}

const SCORE_TOP_K = 10;
const SCORE_CONCURRENCY = 5;

/**
 * Rank topics by how strongly they show up in a subject's past papers.
 *
 * Score = sum of cosine similarities of the top-K matching paper chunks. It's a continuous
 * score, so the ordering doesn't depend on absolute similarity thresholds (which differ between
 * embedding models). Only the relative order matters to callers.
 *
 * All topics are embedded in batched requests (not one request per topic), so a long syllabus
 * doesn't hit provider rate limits.
 */
export async function scoreTopicsByPYQFrequency(
  topics: string[],
  subjectId: string,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>(topics.map((t) => [t, 0]));
  const unique = [...new Set(topics.map((t) => t.trim()).filter(Boolean))];
  if (unique.length === 0) return scores;

  let vectors: number[][] | null;
  try {
    vectors = await embedTexts(unique, "query");
  } catch (err) {
    console.error("[Retriever] topic scoring skipped, embedding failed:", err instanceof Error ? err.message : err);
    return scores; // all zeros → caller keeps syllabus order
  }
  if (!vectors) return scores;

  // Run the (cheap, local) SQL searches a few at a time
  for (let i = 0; i < unique.length; i += SCORE_CONCURRENCY) {
    const batch = unique.slice(i, i + SCORE_CONCURRENCY);
    const scored = await Promise.all(
      batch.map(async (topic, j) => {
        const chunks = await searchByVector(vectorToSql(vectors![i + j]!), {
          type: "resource",
          subjectId,
          topK: SCORE_TOP_K,
          paperOnly: true,
        });
        const score = chunks.reduce((acc, c) => acc + Math.max(0, c.similarity), 0);
        return { topic, score: Math.round(score * 1000) / 1000 };
      }),
    );
    for (const { topic, score } of scored) scores.set(topic, score);
  }

  // Map original (untrimmed) topic strings to their trimmed scores
  for (const t of topics) {
    const s = scores.get(t.trim());
    if (s !== undefined) scores.set(t, s);
  }
  return scores;
}