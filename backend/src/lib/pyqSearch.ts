/**
 * backend/src/lib/pyqSearch.ts
 * Past-paper question search shared by POST /api/questions/search and the AI coach.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { embedTexts, vectorToSql } from "./embeddings.js";
import { buildProfiles, getCachedProfile, keyOf, type TopicProfile } from "./topicProfile.js";
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

export interface ResolvedTopic {
    topic: string;
    vec: string | null;
    aliases: string[];
}

/**
 * Turns raw topics into searchable ones.
 *  - Cached profiles: DB read only, 0 API calls.
 *  - Uncached topics WITH a context (subject): built together in ONE LLM call + ONE embedding call.
 *  - No context, or a failed build: falls back to embedding the bare topic (one batched call).
 */
export async function resolveTopics(
    rawTopics: string[],
    context?: string,
): Promise<{ resolved: ResolvedTopic[]; semantic: boolean }> {
    const topics = [...new Set(rawTopics.map(cleanTopic).filter((t) => t.length >= 2))];
    if (topics.length === 0) return { resolved: [], semantic: false };

    const profiles: (TopicProfile | null)[] = await Promise.all(
        topics.map((t) => getCachedProfile(t, context)), // DB read only
    );

    if (context) {
        const uncached = topics.map((_, i) => i).filter((i) => !profiles[i]);
        if (uncached.length > 0) {
            try {
                const built = await buildProfiles(uncached.map((i) => topics[i]!), context);
                for (const i of uncached) profiles[i] = built.get(keyOf(topics[i]!, context)) ?? null;
            } catch (e) {
                console.error("[pyqSearch] batch profile build failed:", e instanceof Error ? e.message : e);
            }
        }
    }

    const missing = topics.map((_, i) => i).filter((i) => !profiles[i]?.embedding);
    let fallback: number[][] | null = null;
    if (missing.length > 0) {
        try {
            fallback = await embedTexts(missing.map((i) => topics[i]!), "query");
        } catch (e) {
            console.error("[pyqSearch] embedding failed:", e instanceof Error ? e.message : e);
        }
    }

    let semantic = false;
    const resolved = topics.map((topic, i) => {
        const p = profiles[i];
        const v = p?.embedding ?? fallback?.[missing.indexOf(i)] ?? null;
        if (v) semantic = true;
        return { topic, vec: v ? vectorToSql(v) : null, aliases: p?.aliases ?? [] };
    });
    return { resolved, semantic };
}

/** Candidates from two angles: nearest by meaning, and literal mentions of the topic or its aliases. */
export async function findCandidates(
    topic: string,
    vec: string | null,
    subjectId: string | undefined,
    aliases: string[] = [],
): Promise<Candidate[]> {
    const subjectFilter = subjectId ? Prisma.sql`AND q."subjectId" = ${subjectId}` : Prisma.empty;
    const patterns = [topic, ...aliases].map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
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
      WHERE q."text" ILIKE ANY(${patterns}::text[]) ${subjectFilter}
      ORDER BY r."year" DESC
      LIMIT ${Prisma.raw(String(TEXT_CANDIDATES))}`),
    ]);
    return [...byMeaning, ...byWords].map(toCandidate);
}

export interface TopicQuestions {
    topic: string;
    groups: QuestionGroup[];
}

/** Ranked, de-duplicated past questions for each topic (used by the AI coach). */
export async function searchTopicQuestions(
    rawTopics: string[],
    subjectId: string | undefined,
    perTopic: number,
    context?: string,
): Promise<{ results: TopicQuestions[]; semantic: boolean }> {
    const { resolved, semantic } = await resolveTopics(rawTopics, context);
    if (resolved.length === 0) return { results: [], semantic: false };

    const results: TopicQuestions[] = [];
    for (let i = 0; i < resolved.length; i += CONCURRENCY) {
        const batch = resolved.slice(i, i + CONCURRENCY);
        results.push(
            ...(await Promise.all(
                batch.map(async (r) => {
                    const candidates = await findCandidates(r.topic, r.vec, subjectId, r.aliases);
                    const ranked = rankCandidates(r.topic, candidates, { limit: perTopic * 3, aliases: r.aliases });
                    return { topic: r.topic, groups: groupDuplicates(ranked).slice(0, perTopic) };
                }),
            )),
        );
    }
    return { results, semantic };
}