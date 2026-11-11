/**
 * Question-level indexing of past papers (powers the PYQ finder).
 *
 *   PDF ──► extractFromPdf() ──► embed each question ──► PaperQuestion rows
 *
 * Two extraction paths:
 *   - text PDFs:   an LLM only marks where each question STARTS; the stored text is a verbatim slice of the
 *                  paper (see questionSegmenter.ts). Falls back to a "Q1 / Q2" heuristic if the LLM is down.
 *   - scanned PDFs (no text layer): a Gemini vision model transcribes the pages. These rows are flagged
 *                  source = "scan" and carry a page number, because a transcription can contain small errors.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { chatComplete, extractJSON } from "./ai.js";
import { embedTexts, vectorToSql } from "./embeddings.js";
import { hasUsableText, type PdfFile } from "./pdfText.js";
import { extractQuestionsWithVision } from "./visionExtract.js";
import {
    parseAnchorResponse,
    segmentByQuestionNumbers,
    sliceByAnchors,
    type Anchor,
    type RawQuestion,
} from "./questionSegmenter.js";

const WINDOW_CHARS = 9000; // text sent to the LLM per call
const STEP_CHARS = 8000; // windows overlap by 1000 chars so a question on the boundary isn't lost
const MAX_TEXT_CHARS = 40_000;
const INSERT_BATCH = 100;

export type ExtractMethod = "llm" | "heuristic" | "vision" | "none";
export type QuestionSource = "text" | "scan";

function anchorPrompt(windowText: string): string {
    return `You are given the raw text of a university exam question paper. Identify where each individual question STARTS.

Rules:
- Treat lettered sub-parts such as (a), (b) as separate questions when they are separate tasks.
- Do NOT split a multiple-choice question from its options.
- Ignore headers, course codes, instructions ("Attempt any five..."), section titles and "OR".
- Never rewrite, summarise or correct anything.

For every question return:
- "label": the number exactly as printed, e.g. "Q3(b)" or "5" (null if none)
- "startsWith": the FIRST 6 TO 10 WORDS of the question, copied EXACTLY as they appear in the text (same spelling, punctuation and symbols), starting AFTER the label
- "marks": integer if marks are printed for it (e.g. [5], (10 marks)), otherwise null

Return ONLY JSON, in order of appearance: {"questions":[{"label":"Q1(a)","startsWith":"...","marks":5}]}

Paper text:
"""
${windowText}
"""`;
}

export async function extractQuestions(
    text: string,
): Promise<{ questions: RawQuestion[]; method: ExtractMethod; unanchored: number }> {
    const clean = text.replace(/\r/g, "").slice(0, MAX_TEXT_CHARS);
    if (clean.trim().length < 40) return { questions: [], method: "none", unanchored: 0 };

    // 1) LLM anchors → verbatim slices
    try {
        const anchors: Anchor[] = [];
        for (let start = 0; start < clean.length; start += STEP_CHARS) {
            const result = await chatComplete([
                { role: "user", content: anchorPrompt(clean.slice(start, start + WINDOW_CHARS)) },
            ]);
            if (!result) throw new Error("LLM unavailable");
            anchors.push(...parseAnchorResponse(extractJSON<{ questions?: unknown }>(result.content)));
            if (start + WINDOW_CHARS >= clean.length) break;
        }
        const { questions, unanchored } = sliceByAnchors(clean, anchors);
        if (questions.length > 0) return { questions, method: "llm", unanchored };
    } catch (err) {
        console.warn("[Questions] LLM extraction failed, using heuristic:", err instanceof Error ? err.message : err);
    }

    // 2) Heuristic fallback
    const heuristic = segmentByQuestionNumbers(clean);
    return heuristic.length > 0
        ? { questions: heuristic, method: "heuristic", unanchored: 0 }
        : { questions: [], method: "none", unanchored: 0 };
}

export interface ExtractedQuestion extends RawQuestion {
    page: number | null; // 1-based PDF page (known for scans)
}

export interface Extraction {
    questions: ExtractedQuestion[];
    method: ExtractMethod;
    source: QuestionSource;
    unanchored: number;
}

/**
 * Get the questions out of a PDF, choosing the right path. THROWS if a needed service (vision) keeps failing,
 * so callers can treat that as retryable rather than as "this paper has no questions".
 */
export async function extractFromPdf(pdf: Pick<PdfFile, "buffer" | "text">, mimeType = "application/pdf"): Promise<Extraction> {
    if (hasUsableText(pdf.text)) {
        const r = await extractQuestions(pdf.text);
        if (r.questions.length > 0) {
            return {
                questions: r.questions.map((q) => ({ ...q, page: null })),
                method: r.method,
                source: "text",
                unanchored: r.unanchored,
            };
        }
        // a text layer exists but nothing question-like was found: let the vision model have a look
    }
    const v = await extractQuestionsWithVision(pdf.buffer, mimeType);
    return {
        questions: v.questions.map((q, i) => ({ index: i, label: q.label, marks: q.marks, text: q.text, page: q.page })),
        method: v.questions.length > 0 ? "vision" : "none",
        source: "scan",
        unanchored: 0,
    };
}

/** Plain text of the questions, used to build RAG chunks for scanned papers (which have no text layer). */
export function questionsAsText(questions: Pick<ExtractedQuestion, "label" | "text">[]): string {
    return questions.map((q) => `${q.label ? `${q.label}. ` : ""}${q.text}`).join("\n\n");
}

export interface QuestionIngestResult {
    status: "ok" | "no_questions" | "error";
    count: number;
    embedded: number;
    method: ExtractMethod;
    source: QuestionSource;
    error?: string | undefined;
}

/**
 * Store an extraction (replaces the paper's existing rows). Never throws.
 * Existing rows are only deleted once the new ones are ready, in one transaction. If embedding is not
 * configured the questions are still stored (keyword search works without embeddings).
 */
export async function persistExtraction(
    resourceId: string,
    subjectId: string,
    ex: Extraction,
): Promise<QuestionIngestResult> {
    const { questions, method, source, unanchored } = ex;
    try {
        if (questions.length === 0) return { status: "no_questions", count: 0, embedded: 0, method, source };

        // null = no provider configured; throws if the provider keeps failing (nothing is touched, can be retried)
        const vectors = await embedTexts(
            questions.map((q) => q.text),
            "document",
        );

        await prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`DELETE FROM "PaperQuestion" WHERE "resourceId" = ${resourceId}`;
                for (let i = 0; i < questions.length; i += INSERT_BATCH) {
                    const rows = questions.slice(i, i + INSERT_BATCH).map((q, j) => {
                        const v = vectors?.[i + j];
                        const emb = v ? Prisma.sql`${vectorToSql(v)}::vector` : Prisma.sql`NULL::vector`;
                        return Prisma.sql`(gen_random_uuid()::text, ${resourceId}, ${subjectId}, ${q.index}, ${q.label}::text, ${q.marks}::int, ${q.page}::int, ${source}, ${q.text}, ${emb}, now())`;
                    });
                    await tx.$executeRaw`INSERT INTO "PaperQuestion" ("id", "resourceId", "subjectId", "questionIndex", "label", "marks", "pageNumber", "source", "text", "embedding", "createdAt") VALUES ${Prisma.join(rows)}`;
                }
            },
            { timeout: 60_000, maxWait: 10_000 },
        );

        console.log(
            `[Questions] ${resourceId}: ${questions.length} questions via ${method} (${source})${unanchored ? `, ${unanchored} anchors not found` : ""}${vectors ? "" : ", no embeddings"}`,
        );
        return { status: "ok", count: questions.length, embedded: vectors ? questions.length : 0, method, source };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Questions] Failed to store questions for ${resourceId}:`, msg);
        return { status: "error", count: 0, embedded: 0, method, source, error: msg };
    }
}

/** Extract + store in one step (used by the backfill script). Never throws. */
export async function ingestPaperQuestions(
    resourceId: string,
    subjectId: string,
    pdf: Pick<PdfFile, "buffer" | "text">,
): Promise<QuestionIngestResult> {
    try {
        return await persistExtraction(resourceId, subjectId, await extractFromPdf(pdf));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Questions] Failed for resource ${resourceId}:`, msg);
        return { status: "error", count: 0, embedded: 0, method: "none", source: "text", error: msg };
    }
}