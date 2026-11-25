/**
 * backend/src/routes/questions.ts
 * POST /api/questions/search — find past-paper questions about one or more syllabus topics.
 * Body: { topics: string[1..10], subjectId?: string, context?: string, perTopic?: number (1..15, default 6) }
 */
import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { requireStudyAccess } from "../middleware/requireAuth.js";
import {
  groupDuplicates,
  rankCandidates,
  summarizePapers,
  yearsOf,
} from "../lib/questionSearch.js";
import { findCandidates, resolveTopics } from "../lib/pyqSearch.js";

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
  context: z.string().trim().max(200).optional(),
  perTopic: z.number().int().min(1).max(15).default(6),
});

const CONCURRENCY = 5;

router.post(
  "/search",
  requireStudyAccess,
  limiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = searchSchema.parse(req.body);

      // No context sent (e.g. the PYQ Finder) -> use the subject's name so cache keys match the syllabus page
      let context = body.context;
      if (body.subjectId) {
        const subj = await prisma.subject.findUnique({
          where: { id: body.subjectId },
          select: { name: true },
        });
        if (!subj) {
          res.status(404).json({ error: "Subject not found" });
          return;
        }
        context = subj.name;
      }

      const { resolved, semantic } = await resolveTopics(body.topics, context);
      if (resolved.length === 0) {
        res
          .status(400)
          .json({ error: "Enter at least one topic (2+ characters)." });
        return;
      }

      const subjectFilter = body.subjectId
        ? Prisma.sql`AND q."subjectId" = ${body.subjectId}`
        : Prisma.empty;
      const [coverageRows, totalPapers] = await Promise.all([
        prisma.$queryRaw<{ questions: number; papers: number }[]>(
          Prisma.sql`SELECT count(*)::int AS "questions", count(DISTINCT q."resourceId")::int AS "papers"
          FROM "PaperQuestion" q WHERE true ${subjectFilter}`,
        ),
        prisma.resource.count({
          where: {
            type: "PAPER",
            ...(body.subjectId ? { subjectId: body.subjectId } : {}),
          },
        }),
      ]);

      const results = [];
      for (let i = 0; i < resolved.length; i += CONCURRENCY) {
        const batch = resolved.slice(i, i + CONCURRENCY);
        results.push(
          ...(await Promise.all(
            batch.map(async (r) => {
              const candidates = await findCandidates(
                r.topic,
                r.vec,
                body.subjectId,
                r.aliases,
              );
              const ranked = rankCandidates(r.topic, candidates, {
                limit: body.perTopic * 3,
                aliases: r.aliases,
              });
              const questions = groupDuplicates(ranked).slice(0, body.perTopic);
              const papers = summarizePapers(questions);
              console.log(
                "[pyq]",
                r.topic,
                questions.map((q) => [
                  q.text.slice(0, 50),
                  q.score.toFixed(2),
                  q.exactMatch,
                  q.termMatch,
                ]),
              ); // temporary, remove after tuning
              return {
                topic: r.topic,
                questions,
                papers,
                years: yearsOf(papers),
              };
            }),
          )),
        );
      }

      res.json({
        ragEnabled: semantic,
        semanticUnavailable: !semantic,
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
  },
);

export default router;
