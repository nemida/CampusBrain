/** Opt-in, read-only PostgreSQL/pgvector check. No AI requests, writes or migrations. */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { env } from "../src/lib/env.js";
import { prisma } from "../src/lib/prisma.js";
import { scoreTopicsByPYQFrequency } from "../src/lib/retriever.js";

async function main() {
  const originalFetch = globalThis.fetch;
  const originalKey = env.GEMINI_API_KEY;
  try {
    const rows = await prisma.$queryRaw<
      { subjectId: string; vector: string }[]
    >(Prisma.sql`
      SELECT "subjectId", "embedding"::text AS vector FROM "ResourceChunk"
      WHERE "embedding" IS NOT NULL LIMIT 1
    `);
    const row = rows[0];
    const vector: number[] = row
      ? JSON.parse(row.vector)
      : [1, ...Array(767).fill(0)];
    const subjectId = row?.subjectId ?? "__missing_smoke_test_subject__";
    // Only embedding HTTP calls are replaced. Prisma still exercises the real database.
    env.GEMINI_API_KEY = "local-smoke-test";
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      return Response.json({
        embeddings: body.requests.map(() => ({ values: vector })),
      });
    };
    const scores = await scoreTopicsByPYQFrequency(
      ["smoke first", "smoke second"],
      subjectId,
    );
    const literal = `[${vector.join(",")}]`;
    const reference = await prisma.$queryRaw<{ score: number }[]>(Prisma.sql`
      SELECT COALESCE(SUM(GREATEST(0, similarity)), 0)::float8 AS score FROM (
        SELECT 1 - (c."embedding" <=> ${literal}::vector) AS similarity
        FROM "ResourceChunk" c JOIN "Resource" r ON r."id" = c."resourceId"
        WHERE c."embedding" IS NOT NULL AND c."subjectId" = ${subjectId} AND r."type" = 'PAPER'
        ORDER BY c."embedding" <=> ${literal}::vector LIMIT 10
      ) matches
    `);
    const expected = Math.round(Number(reference[0]?.score ?? 0) * 1000) / 1000;
    for (const score of scores.values()) assert.equal(score, expected);
    console.log(
      "Read-only pgvector check passed: batched scores match the reference query.",
    );
  } finally {
    globalThis.fetch = originalFetch;
    env.GEMINI_API_KEY = originalKey;
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  console.error(
    "Read-only retrieval check failed. Verify database access and committed migrations.",
  );
  process.exitCode = 1;
});
