/**
 * RAG Ingestion Pipeline
 *
 * Called after:
 *   1. A PYQ PDF is uploaded   → ingestResource(resourceId, pdfUrl, subjectId)  (chunks + question index)
 *   2. A syllabus item is saved → ingestSyllabusItem(syllabusItemId, subjectId, title, topics)
 *
 * Both are safe to fire-and-forget: they never throw, and they return an IngestResult
 * so callers (e.g. the backfill script) can see what actually happened.
 *
 * Safety rule: embeddings are computed BEFORE anything is deleted, and the delete +
 * insert happen in one transaction. If embedding fails, the existing chunks stay intact.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { embedTexts, vectorToSql } from "./embeddings.js";
import { downloadDocument, fetchPdf, hasUsableText } from "./pdfText.js";
import {
  extractFromPdf,
  persistExtraction,
  questionsAsText,
  type Extraction,
} from "./questionIngestion.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IngestResult {
  status: "ok" | "no_text" | "no_key" | "error";
  total: number;
  embedded: number;
  error?: string | undefined;
}

export interface BackfillSummary {
  attempted: number;
  ok: number;
  noText: string[]; // ids with no extractable text (scanned PDFs → need OCR)
  failed: { id: string; error: string }[];
  aborted?: "no_key" | undefined;
}

// ── PDF chunking ──────────────────────────────────────────────────────────────

const CHUNK_SIZE = 500; // characters per chunk (≈ 100-150 tokens)
const CHUNK_OVERLAP = 80; // overlap between adjacent chunks
const INSERT_BATCH = 200; // rows per INSERT statement

/** Split extracted PDF text into overlapping chunks (page-aware when per-page text is available). */
function chunkText(
  fullText: string,
  pageTexts: string[],
): { text: string; pageNumber: number | null; chunkIndex: number }[] {
  const sourceChunks: { text: string; page: number | null }[] = [];
  const slide = (text: string, page: number | null) => {
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + CHUNK_SIZE, text.length);
      const chunk = text.slice(start, end).trim();
      if (chunk.length > 20) sourceChunks.push({ text: chunk, page });
      if (end >= text.length) break; // avoid a tiny trailing overlap-only chunk
      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  };

  if (pageTexts.length > 0) pageTexts.forEach((t, idx) => slide(t, idx + 1));
  else slide(fullText, null);

  return sourceChunks.map((c, idx) => ({
    text: c.text,
    pageNumber: c.page,
    chunkIndex: idx,
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Chunk + embed a paper's text into ResourceChunk (atomic replace). Never throws. */
async function ingestChunks(
  resourceId: string,
  subjectId: string,
  fullText: string,
  pageTexts: string[],
): Promise<IngestResult> {
  try {
    const chunks = chunkText(fullText, pageTexts);
    if (chunks.length === 0) {
      console.warn(
        `[Ingest] No text extracted from resource ${resourceId} (scanned PDF?)`,
      );
      return { status: "no_text", total: 0, embedded: 0 };
    }

    // 1) Embed everything first. Throws if the provider keeps failing → nothing is deleted.
    const vectors = await embedTexts(
      chunks.map((c) => c.text),
      "document",
    );
    if (!vectors)
      return { status: "no_key", total: chunks.length, embedded: 0 };

    // 2) Atomically replace the old chunks.
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`DELETE FROM "ResourceChunk" WHERE "resourceId" = ${resourceId}`;
        for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
          const rows = chunks.slice(i, i + INSERT_BATCH).map((c, j) => {
            const v = vectors[i + j]!;
            return Prisma.sql`(gen_random_uuid()::text, ${resourceId}, ${subjectId}, ${c.chunkIndex}, ${c.pageNumber}::int, ${c.text}, ${vectorToSql(v)}::vector, now())`;
          });
          await tx.$executeRaw`INSERT INTO "ResourceChunk" ("id", "resourceId", "subjectId", "chunkIndex", "pageNumber", "text", "embedding", "createdAt") VALUES ${Prisma.join(rows)}`;
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    console.log(
      `[Ingest] Resource ${resourceId}: ${chunks.length}/${chunks.length} chunks embedded`,
    );
    return { status: "ok", total: chunks.length, embedded: chunks.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Ingest] Failed for resource ${resourceId}:`, msg);
    return { status: "error", total: 0, embedded: 0, error: msg };
  }
}

/** Text of questions already indexed for a paper (lets us skip paying for a second vision read). */
async function loadIndexedQuestionText(
  resourceId: string,
): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<
      { label: string | null; text: string }[]
    >(
      Prisma.sql`SELECT "label", "text" FROM "PaperQuestion" WHERE "resourceId" = ${resourceId} ORDER BY "questionIndex"`,
    );
    return rows.length > 0 ? questionsAsText(rows) : null;
  } catch {
    return null; // table not created yet
  }
}

// ── Image vs PDF detection ───────────────────────────────────────────────────
// Cloudinary URLs include the file extension, so we can detect the type without
// storing a separate mimeType column.

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

function isImageFile(url: string): boolean {
  return IMAGE_EXT.test(url);
}

function mimeFromUrl(url: string): string {
  if (/\.png$/i.test(url)) return "image/png";
  if (/\.jpe?g$/i.test(url)) return "image/jpeg";
  if (/\.webp$/i.test(url)) return "image/webp";
  if (/\.gif$/i.test(url)) return "image/gif";
  return "application/pdf";
}

/**
 * Ingest a PYQ PDF resource:
 *   1. chunk + embed it for semantic search (ResourceChunk), and
 *   2. for papers, extract and index the individual questions (PaperQuestion, used by the PYQ finder).
 * Scanned papers (no text layer) are read once with a vision model and that single result feeds BOTH steps.
 * Images (photos of papers) follow the same scanned/vision path — they have no text layer.
 * The file is downloaded once. Idempotent. Never throws; the returned result describes the chunk step.
 */
export async function ingestResource(
  resourceId: string,
  pdfUrl: string,
  subjectId: string,
): Promise<IngestResult> {
  console.log(`[Ingest] Starting resource ${resourceId}`);

  const isImage = isImageFile(pdfUrl);
  const mimeType = mimeFromUrl(pdfUrl);

  let pdf: { buffer: Buffer; text: string; pages: string[] };
  try {
    if (isImage) {
      // Images have no text layer — download raw bytes for the vision model (pdf-parse can't read them)
      const buffer = await downloadDocument(pdfUrl);
      pdf = { buffer, text: "", pages: [] };
    } else {
      pdf = await fetchPdf(pdfUrl);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Ingest] Failed for resource ${resourceId}:`, msg);
    return { status: "error", total: 0, embedded: 0, error: msg };
  }

  let chunkSource = pdf.text;
  let pages = pdf.pages;
  let fromQuestions = false; // chunk text was rebuilt from transcribed questions, not taken from the PDF text layer
  let extraction: Extraction | null = null;

  try {
    const r = await prisma.resource.findUnique({
      where: { id: resourceId },
      select: { type: true },
    });
    if (r?.type === "PAPER") {
      if (hasUsableText(pdf.text)) {
        extraction = await extractFromPdf(pdf, mimeType);
      } else {
        // scanned: reuse what was indexed before if there is any, otherwise read it with the vision model
        const prior = await loadIndexedQuestionText(resourceId);
        if (prior) {
          chunkSource = prior;
        } else {
          extraction = await extractFromPdf(pdf, mimeType);
          chunkSource = questionsAsText(extraction.questions);
        }
        fromQuestions = true;
        pages = [];
      }
    }
  } catch (err) {
    // vision / extraction service failed: report it so a retry picks this paper up again
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Ingest] Reading ${resourceId} failed:`, msg);
    if (!hasUsableText(pdf.text))
      return { status: "error", total: 0, embedded: 0, error: msg };
  }

  // never turn "-- 1 of 2 --" page markers into a chunk (only raw PDF text can be that kind of noise)
  if (!fromQuestions && !hasUsableText(chunkSource)) {
    chunkSource = "";
    pages = [];
  }

  const result = await ingestChunks(resourceId, subjectId, chunkSource, pages);

  if (extraction && extraction.questions.length > 0) {
    await persistExtraction(resourceId, subjectId, extraction);
  }
  return result;
}

/**
 * Ingest a SyllabusItem into the vector store: one overview chunk + one chunk per topic.
 * Idempotent: replaces this item's chunks atomically. Never throws.
 */
export async function ingestSyllabusItem(
  syllabusItemId: string,
  subjectId: string | null,
  unitTitle: string,
  topics: string[],
): Promise<IngestResult> {
  try {
    console.log(`[Ingest] Syllabus item ${syllabusItemId}`);

    const texts: string[] = [
      `${unitTitle}: ${topics.join(", ")}`, // overview chunk
      ...topics.map((t) => `${unitTitle} — ${t}`), // per-topic chunks
    ];

    const vectors = await embedTexts(texts, "document");
    if (!vectors) return { status: "no_key", total: texts.length, embedded: 0 };

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`DELETE FROM "SyllabusChunk" WHERE "syllabusItemId" = ${syllabusItemId}`;
        for (let i = 0; i < texts.length; i += INSERT_BATCH) {
          const rows = texts.slice(i, i + INSERT_BATCH).map((text, j) => {
            const v = vectors[i + j]!;
            return Prisma.sql`(gen_random_uuid()::text, ${syllabusItemId}, ${subjectId}::text, ${text}, ${vectorToSql(v)}::vector, now())`;
          });
          await tx.$executeRaw`INSERT INTO "SyllabusChunk" ("id", "syllabusItemId", "subjectId", "text", "embedding", "createdAt") VALUES ${Prisma.join(rows)}`;
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    console.log(
      `[Ingest] Syllabus item ${syllabusItemId}: ${texts.length} chunks embedded`,
    );
    return { status: "ok", total: texts.length, embedded: texts.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Ingest] Failed for syllabus item ${syllabusItemId}:`, msg);
    return { status: "error", total: 0, embedded: 0, error: msg };
  }
}

// ── Backfill ──────────────────────────────────────────────────────────────────

function tally(
  summary: BackfillSummary,
  id: string,
  r: IngestResult,
): "continue" | "stop" {
  summary.attempted++;
  if (r.status === "ok") summary.ok++;
  else if (r.status === "no_text") summary.noText.push(id);
  else if (r.status === "no_key") {
    summary.aborted = "no_key";
    return "stop";
  } else summary.failed.push({ id, error: r.error ?? "unknown error" });
  return "continue";
}

/**
 * Re-ingest resources for a subject. With onlyMissing, resources that already have chunks are skipped
 * (use this to retry after a partial run; do NOT use it when switching embedding models).
 */
export async function backfillSubjectResources(
  subjectId: string,
  opts: {
    onlyMissing?: boolean | undefined;
    delayMs?: number | undefined;
  } = {},
): Promise<BackfillSummary> {
  const resources = await prisma.resource.findMany({
    where: { subjectId, ...(opts.onlyMissing ? { chunks: { none: {} } } : {}) },
    select: { id: true, fileUrl: true, subjectId: true },
  });
  console.log(
    `[Backfill] ${resources.length} resources for subject ${subjectId}`,
  );

  const summary: BackfillSummary = {
    attempted: 0,
    ok: 0,
    noText: [],
    failed: [],
  };
  for (const r of resources) {
    const res = await ingestResource(r.id, r.fileUrl, r.subjectId);
    if (tally(summary, r.id, res) === "stop") break;
    if (opts.delayMs && opts.delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
  }
  return summary;
}

/** Re-ingest syllabus items for a syllabus. */
export async function backfillSyllabus(
  syllabusId: string,
  opts: {
    onlyMissing?: boolean | undefined;
    delayMs?: number | undefined;
  } = {},
): Promise<BackfillSummary> {
  const items = await prisma.syllabusItem.findMany({
    where: {
      syllabusId,
      ...(opts.onlyMissing ? { chunks: { none: {} } } : {}),
    },
    select: { id: true, subjectId: true, title: true, topics: true },
  });
  console.log(
    `[Backfill] ${items.length} syllabus items for syllabus ${syllabusId}`,
  );

  const summary: BackfillSummary = {
    attempted: 0,
    ok: 0,
    noText: [],
    failed: [],
  };
  for (const item of items) {
    const res = await ingestSyllabusItem(
      item.id,
      item.subjectId,
      item.title,
      item.topics,
    );
    if (tally(summary, item.id, res) === "stop") break;
    if (opts.delayMs && opts.delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
  }
  return summary;
}
