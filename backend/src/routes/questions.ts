/**
 * POST /api/questions/search — find the exact past-paper questions about one or more syllabus topics,
 *                              and which papers they appear in. Requires login.
 *
 * Body: { topics: string[1..10], subjectId?: string, perTopic?: number (1..15, default 6) }
 *
 * Mount in src/index.ts:   app.use("/api/questions", questionsRouter);
 */
import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { embedTexts, vectorToSql } from "../lib/embeddings.js";
import { groupDuplicates, rankCandidates, summarizePapers, yearsOf } from "../lib/questionSearch.js";
import { cleanTopic, findCandidates } from "../lib/pyqSearch.js";

const router = Router();

const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? "anonymous",
    message: { error: "Too many searches. Please try again in a while." },
});

const searchSchema = z.object({
    topics: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    subjectId: z.string().min(1).optional(),
    perTopic: z.number().int().min(1).max(15).default(6),
});

const CONCURRENCY = 5;

router.post("/search", requireAuth(), limiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = searchSchema.parse(req.body);
        const topics = [...new Set(body.topics.map(cleanTopic).filter((t) => t.length >= 2))];
        if (topics.length === 0) {
            res.status(400).json({ error: "Enter at least one topic (2+ characters)." });
            return;
        }

        // One batched embedding call for all topics. If it fails we still answer with keyword matches.
        let vectors: number[][] | null = null;
        let semanticUnavailable = false;
        try {
            vectors = await embedTexts(topics, "query");
        } catch (err) {
            semanticUnavailable = true;
            console.error("[Questions] topic embedding failed:", err instanceof Error ? err.message : err);
        }

        const subjectFilter = body.subjectId ? Prisma.sql`AND q."subjectId" = ${body.subjectId}` : Prisma.empty;
        const [coverageRows, totalPapers] = await Promise.all([
            prisma.$queryRaw<{ questions: number; papers: number }[]>(
                Prisma.sql`SELECT count(*)::int AS "questions", count(DISTINCT q."resourceId")::int AS "papers"
          FROM "PaperQuestion" q WHERE true ${subjectFilter}`,
            ),
            prisma.resource.count({
                where: { type: "PAPER", ...(body.subjectId ? { subjectId: body.subjectId } : {}) },
            }),
        ]);

        const results = [];
        for (let i = 0; i < topics.length; i += CONCURRENCY) {
            const batch = topics.slice(i, i + CONCURRENCY);
            results.push(
                ...(await Promise.all(
                    batch.map(async (topic, j) => {
                        const v = vectors?.[i + j];
                        const candidates = await findCandidates(topic, v ? vectorToSql(v) : null, body.subjectId);
                        // rank wide, merge repeats across years, then keep the best `perTopic`
                        const ranked = rankCandidates(topic, candidates, { limit: body.perTopic * 3 });
                        const questions = groupDuplicates(ranked).slice(0, body.perTopic);
                        const papers = summarizePapers(questions);
                        return { topic, questions, papers, years: yearsOf(papers) };
                    }),
                )),
            );
        }

        res.json({
            ragEnabled: vectors !== null,
            semanticUnavailable,
            coverage: {
                questionsIndexed: coverageRows[0]?.questions ?? 0,
                papersIndexed: coverageRows[0]?.papers ?? 0,
                totalPapers,
            },
            results,
        });
    } catch (err) {
        next(err);
    }
});

export default router;