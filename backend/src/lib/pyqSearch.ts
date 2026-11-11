/**
 * Past-paper question search shared by POST /api/questions/search and the AI coach.
 *
 * Candidates come from two angles (nearest by meaning, literal mentions of the topic), are ranked with a
 * blended semantic + lexical score, and repeats across years are merged into one entry listing every paper.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { embedTexts, vectorToSql } from "./embeddings.js";
import { groupDuplicates, rankCandidates, type Candidate, type QuestionGroup } from "./questionSearch.js";

const VECTOR_CANDIDATES = 40;
const TEXT_CANDIDATES = 30;
const CONCURRENCY = 5;

/** Study-plan topics look like "[Unit title] Topic": search for the topic only. */
export const cleanTopic = (t: string) => t.replace(/^\[[^\]]*\]\s*/, "").trim();

interface Row {
    id: string;
    questionIndex: number;
    label: string | null;
    marks: number | null;
    pageNumber: number | null;
    source: string;
    text: string;
    similarity: number | null;
    resourceId: string;
    title: string;
    year: number;
    examType: string;
    fileUrl: string;
    subjectCode: string;
    subjectName: string;
}

const SELECT = Prisma.sql`SELECT q."id", q."questionIndex", q."label", q."marks", q."pageNumber", q."source", q."text", q."resourceId",
  r."title", r."year", r."examType"::text AS "examType", r."fileUrl",
  s."code" AS "subjectCode", s."name" AS "subjectName"`;
const FROM = Prisma.sql`FROM "PaperQuestion" q
  JOIN "Resource" r ON r."id" = q."resourceId"
  JOIN "Subject" s ON s."id" = q."subjectId"`;

function toCandidate(r: Row): Candidate {
    return {
        id: r.id,
        questionIndex: r.questionIndex,
        label: r.label,
        marks: r.marks,
        pageNumber: r.pageNumber,
        source: r.source === "scan" ? "scan" : "text",
        text: r.text,
        similarity: r.similarity === null ? null : Number(r.similarity),
        paper: {
            id: r.resourceId,
            title: r.title,
            year: r.year,
            examType: r.examType === "MID_SEM" ? "Mid-Sem" : "End-Sem",
            subjectCode: r.subjectCode,
            subjectName: r.subjectName,
            fileUrl: r.fileUrl,
        },
    };
}

/** Candidates from two angles: nearest by meaning, and literal mentions of the topic. */
export async function findCandidates(
    topic: string,
    vec: string | null,
    subjectId: string | undefined,
): Promise<Candidate[]> {
    const subjectFilter = subjectId ? Prisma.sql`AND q."subjectId" = ${subjectId}` : Prisma.empty;
    const pattern = `%${topic.replace(/[\\%_]/g, "\\$&")}%`;
    const similarity = vec
        ? Prisma.sql`CASE WHEN q."embedding" IS NULL THEN NULL ELSE 1 - (q."embedding" <=> ${vec}::vector) END`
        : Prisma.sql`NULL::float8`;

    const [byMeaning, byWords] = await Promise.all([
        vec
            ? prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT}, ${similarity} AS "similarity" ${FROM}
          WHERE q."embedding" IS NOT NULL ${subjectFilter}
          ORDER BY q."embedding" <=> ${vec}::vector
          LIMIT ${Prisma.raw(String(VECTOR_CANDIDATES))}`)
            : Promise.resolve<Row[]>([]),
        prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT}, ${similarity} AS "similarity" ${FROM}
      WHERE q."text" ILIKE ${pattern} ${subjectFilter}
      ORDER BY r."year" DESC
      LIMIT ${Prisma.raw(String(TEXT_CANDIDATES))}`),
    ]);
    return [...byMeaning, ...byWords].map(toCandidate);
}

export interface TopicQuestions {
    topic: string;
    groups: QuestionGroup[];
}

/**
 * Ranked, de-duplicated past questions for each topic. One batched embedding call; if embedding fails we still
 * answer from keyword matches. `semantic` tells callers which mode was used.
 */
export async function searchTopicQuestions(
    rawTopics: string[],
    subjectId: string | undefined,
    perTopic: number,
): Promise<{ results: TopicQuestions[]; semantic: boolean }> {
    const topics = [...new Set(rawTopics.map(cleanTopic).filter((t) => t.length >= 2))];
    if (topics.length === 0) return { results: [], semantic: false };

    let vectors: number[][] | null = null;
    try {
        vectors = await embedTexts(topics, "query");
    } catch (err) {
        console.error("[pyqSearch] topic embedding failed:", err instanceof Error ? err.message : err);
    }

    const results: TopicQuestions[] = [];
    for (let i = 0; i < topics.length; i += CONCURRENCY) {
        const batch = topics.slice(i, i + CONCURRENCY);
        results.push(
            ...(await Promise.all(
                batch.map(async (topic, j) => {
                    const v = vectors?.[i + j];
                    const candidates = await findCandidates(topic, v ? vectorToSql(v) : null, subjectId);
                    const ranked = rankCandidates(topic, candidates, { limit: perTopic * 3 });
                    return { topic, groups: groupDuplicates(ranked).slice(0, perTopic) };
                }),
            )),
        );
    }
    return { results, semantic: vectors !== null };
}
