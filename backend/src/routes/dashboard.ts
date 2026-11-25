/**
 * GET  /api/dashboard/me        — "what should I do next" dashboard for the authenticated user
 * POST /api/dashboard/activity  — track a resource interaction (VIEW / DOWNLOAD only)
 */
import { Router, Request, Response, NextFunction } from "express";
import { ActivityType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireStudyAccess } from "../middleware/requireAuth.js";
import { subjectPlanProgress } from "../lib/planProgress.js";

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
// India has no DST, so a fixed offset is exact. Swap for a per-user tz later if needed.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDayKey = (d: Date) =>
  new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

const STREAK_LOOKBACK_DAYS = 400;
const WEAK_TOPIC_THRESHOLD = 60;
const RECENT_ATTEMPTS = 5; // only the latest N attempts per topic / subject count
const MAX_PRACTICE_TOPICS = 5;
const MAX_READINESS_SUBJECTS = 12;

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Consecutive IST days with activity, ending today. If there is no activity yet today
 * but there was yesterday, the streak is still alive; otherwise it is 0.
 */
function computeStreak(activeDays: Set<string>, now: Date): number {
  let cursor = now;
  if (!activeDays.has(istDayKey(cursor)))
    cursor = new Date(now.getTime() - DAY_MS);
  let streak = 0;
  while (activeDays.has(istDayKey(cursor))) {
    streak++;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}

/** Junk topics ("1", "", "ab") are bucketed under "General". */
function normalizeTopic(raw: string | null | undefined): string {
  const t = (raw ?? "").trim().replace(/\s+/g, " ");
  if (t.length < 3 || /^\d+$/.test(t)) return "General";
  return t;
}

// ── GET /api/dashboard/me ────────────────────────────────────────────────────

router.get(
  "/me",
  requireStudyAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const now = new Date();
      const todayKey = istDayKey(now);

      const [
        user,
        profile,
        viewedRows,
        answeredSessions,
        streakRows,
        lastRead,
        activePlans,
      ] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { name: true },
        }),

        // Enrolled subjects (+ number of papers each has, counted in the DB)
        prisma.userProfile.findUnique({
          where: { userId },
          select: {
            subjects: {
              select: {
                subject: {
                  select: {
                    id: true,
                    name: true,
                    code: true,
                    semester: true,
                    _count: {
                      select: { resources: { where: { type: "PAPER" } } },
                    },
                  },
                },
              },
            },
          },
        }),

        // Distinct PAPERS the user viewed or downloaded
        prisma.userActivity.findMany({
          where: {
            userId,
            activityType: { in: [ActivityType.VIEW, ActivityType.DOWNLOAD] },
            resourceId: { not: null },
            resource: { is: { type: "PAPER" } },
          },
          select: {
            resourceId: true,
            resource: { select: { subjectId: true } },
          },
          distinct: ["resourceId"],
        }),

        // Sessions with no answered question were abandoned, so they are ignored.
        prisma.mCQSession.findMany({
          where: {
            userId,
            questions: { some: { chosenIndex: { not: null } } },
          },
          select: { topic: true, score: true, subjectId: true },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),

        prisma.userActivity.findMany({
          where: {
            userId,
            createdAt: {
              gte: new Date(now.getTime() - STREAK_LOOKBACK_DAYS * DAY_MS),
            },
          },
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 5000,
        }),

        // Last paper opened → "continue where you left off"
        prisma.userActivity.findFirst({
          where: {
            userId,
            activityType: { in: [ActivityType.VIEW, ActivityType.DOWNLOAD] },
            resourceId: { not: null },
          },
          orderBy: { createdAt: "desc" },
          select: {
            createdAt: true,
            resource: {
              select: {
                id: true,
                title: true,
                fileUrl: true,
                subject: { select: { name: true, code: true } },
              },
            },
          },
        }),

        prisma.studyPlan.findMany({
          where: { userId, status: "ACTIVE" },
          select: {
            id: true,
            title: true,
            examDate: true,
            totalDays: true,
            createdAt: true,
            days: {
              orderBy: { dayNumber: "asc" },
              select: {
                id: true,
                dayNumber: true,
                date: true,
                topics: true,
                isCompleted: true,
                sessions: true,
                subjectId: true,
                subject: { select: { id: true, name: true, code: true } },
              },
            },
          },
        }),
      ]);

      // ── Streak + last 7 days ────────────────────────────────────────────────
      const activeDays = new Set(streakRows.map((r) => istDayKey(r.createdAt)));
      const week = Array.from({ length: 7 }, (_, i) => {
        const t = new Date(now.getTime() - (6 - i) * DAY_MS);
        const date = istDayKey(t);
        return {
          date,
          label:
            WEEKDAY_LABELS[new Date(t.getTime() + IST_OFFSET_MS).getUTCDay()] ??
            "",
          active: activeDays.has(date),
          isToday: date === todayKey,
        };
      });
      const streak = { current: computeStreak(activeDays, now), week };

      // ── Today's plan + exam countdown ───────────────────────────────────────
      // Primary plan = the one with the soonest upcoming exam, else the newest.
      const rank = (p: (typeof activePlans)[number]) =>
        p.examDate && istDayKey(p.examDate) >= todayKey
          ? p.examDate.getTime()
          : Number.MAX_SAFE_INTEGER;
      const primary = [...activePlans].sort(
        (a, b) =>
          rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime(),
      )[0];

      let today: {
        plan: {
          id: string;
          title: string;
          examDate: Date | null;
          daysLeft: number | null;
          totalDays: number;
          doneDays: number;
          pace: { status: "ahead" | "on_track" | "behind"; delta: number };
        };
        kind: "today" | "overdue" | "upcoming" | "none";
        day: {
          id: string;
          dayNumber: number;
          date: Date | null;
          topics: string[];
          isCompleted: boolean;
          subject: { id: string; name: string; code: string } | null;
        } | null;
        overdueCount: number;
        activePlanCount: number;
      } | null = null;

      if (primary) {
        const dated = primary.days.filter(
          (d): d is typeof d & { date: Date } => d.date !== null,
        );
        const doneDays = primary.days.filter((d) => d.isCompleted).length;
        // Days strictly before today count as "should be done by now"
        const expected = dated.filter(
          (d) => istDayKey(d.date) < todayKey,
        ).length;
        const delta = doneDays - expected;

        const todayDay =
          dated.find((d) => istDayKey(d.date) === todayKey) ?? null;
        const overdue = dated.filter(
          (d) => !d.isCompleted && istDayKey(d.date) < todayKey,
        );
        const upcoming =
          dated.find((d) => !d.isCompleted && istDayKey(d.date) > todayKey) ??
          null;

        let kind: "today" | "overdue" | "upcoming" | "none" = "none";
        let day = null as (typeof primary.days)[number] | null;
        if (todayDay) {
          kind = "today";
          day = todayDay;
        } else if (overdue[0]) {
          kind = "overdue";
          day = overdue[0];
        } else if (upcoming) {
          kind = "upcoming";
          day = upcoming;
        }

        const daysLeft = primary.examDate
          ? Math.round(
              (Date.parse(istDayKey(primary.examDate)) - Date.parse(todayKey)) /
                DAY_MS,
            )
          : null;

        today = {
          plan: {
            id: primary.id,
            title: primary.title,
            examDate: primary.examDate,
            daysLeft,
            totalDays: primary.totalDays,
            doneDays,
            pace: {
              status: delta < 0 ? "behind" : delta > 0 ? "ahead" : "on_track",
              delta,
            },
          },
          kind,
          day: day
            ? {
                id: day.id,
                dayNumber: day.dayNumber,
                date: day.date,
                topics: day.topics,
                isCompleted: day.isCompleted,
                subject: day.subject,
              }
            : null,
          // overdue days other than the one being shown
          overdueCount:
            kind === "overdue"
              ? overdue.length - 1
              : kind === "today"
                ? overdue.length
                : 0,
          activePlanCount: activePlans.length,
        };
      }

      // ── Practice next (weak topics, latest attempts only, with trend) ───────
      const topicMap = new Map<
        string,
        { label: string; subjectId: string | null; scores: number[] }
      >();
      for (const s of answeredSessions) {
        const label = normalizeTopic(s.topic);
        const key = label.toLowerCase();
        const entry = topicMap.get(key) ?? {
          label,
          subjectId: null,
          scores: [],
        };
        if (entry.subjectId === null && s.subjectId)
          entry.subjectId = s.subjectId;
        if (entry.scores.length < RECENT_ATTEMPTS) entry.scores.push(s.score);
        topicMap.set(key, entry);
      }
      const practice = [...topicMap.values()]
        .map(({ label, subjectId, scores }) => {
          const latest = scores[0] ?? 0;
          const earlier = scores.slice(1);
          return {
            topic: label,
            subjectId,
            averageScore: Math.round(avg(scores) * 10) / 10,
            latestScore: Math.round(latest),
            trend:
              earlier.length > 0 ? Math.round(latest - avg(earlier)) : null,
            attempts: scores.length,
          };
        })
        .filter((t) => t.averageScore < WEAK_TOPIC_THRESHOLD)
        .sort((a, b) => a.averageScore - b.averageScore)
        .slice(0, MAX_PRACTICE_TOPICS);

      // ── Subject readiness (enrolled subjects only) ──────────────────────────
      const viewedBySubject = new Map<string, number>();
      for (const row of viewedRows) {
        if (!row.resource) continue;
        viewedBySubject.set(
          row.resource.subjectId,
          (viewedBySubject.get(row.resource.subjectId) ?? 0) + 1,
        );
      }

      const quizBySubject = new Map<string, number[]>();
      for (const s of answeredSessions) {
        if (!s.subjectId) continue;
        const arr = quizBySubject.get(s.subjectId) ?? [];
        if (arr.length < RECENT_ATTEMPTS) arr.push(s.score);
        quizBySubject.set(s.subjectId, arr);
      }

      const planBySubject = subjectPlanProgress(
        activePlans.flatMap((plan) => plan.days),
      );

      const enrolled = profile?.subjects.map((ps) => ps.subject) ?? [];
      const WEIGHTS = { quiz: 0.5, plan: 0.3, papers: 0.2 };

      const readiness = enrolled
        .map((s) => {
          const totalPapers = s._count.resources;
          const viewedPapers = Math.min(
            viewedBySubject.get(s.id) ?? 0,
            totalPapers,
          );
          const quizScores = quizBySubject.get(s.id);
          const quizAvg =
            quizScores && quizScores.length > 0 ? avg(quizScores) : null;
          const plan = planBySubject.get(s.id);

          const parts: { w: number; v: number }[] = [];
          if (quizAvg !== null) parts.push({ w: WEIGHTS.quiz, v: quizAvg });
          if (plan && plan.total > 0)
            parts.push({ w: WEIGHTS.plan, v: (plan.done / plan.total) * 100 });
          if (totalPapers > 0)
            parts.push({
              w: WEIGHTS.papers,
              v: (viewedPapers / totalPapers) * 100,
            });

          const started =
            quizAvg !== null || (plan?.done ?? 0) > 0 || viewedPapers > 0;
          const wSum = parts.reduce((a, p) => a + p.w, 0);
          const score =
            started && wSum > 0
              ? Math.round(parts.reduce((a, p) => a + p.w * p.v, 0) / wSum)
              : null;

          return {
            subjectId: s.id,
            subjectName: s.name,
            subjectCode: s.code,
            semester: s.semester,
            score,
            quizAverage: quizAvg === null ? null : Math.round(quizAvg),
            planDone: plan?.done ?? 0,
            planTotal: plan?.total ?? 0,
            viewedPapers,
            totalPapers,
          };
        })
        // weakest first; "not started" (null) before everything else
        .sort(
          (a, b) =>
            (a.score ?? -1) - (b.score ?? -1) ||
            a.subjectName.localeCompare(b.subjectName),
        )
        .slice(0, MAX_READINESS_SUBJECTS);

      // ── Continue reading ────────────────────────────────────────────────────
      const continueReading = lastRead?.resource
        ? {
            resourceId: lastRead.resource.id,
            title: lastRead.resource.title,
            fileUrl: lastRead.resource.fileUrl,
            subjectName: lastRead.resource.subject.name,
            subjectCode: lastRead.resource.subject.code,
            viewedAt: lastRead.createdAt,
          }
        : null;

      res.json({
        userName: user?.name ?? "",
        needsOnboarding: enrolled.length === 0,
        hasTakenQuiz: answeredSessions.length > 0,
        streak,
        today,
        practice,
        continueReading,
        readiness,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/dashboard/activity ────────────────────────────────────────────

// Clients may only report resource interactions. QUIZ_ATTEMPT and PLAN_DAY_COMPLETE
// are written server-side by the mcq / study-plan routes, so they can't be forged here.
const activitySchema = z.object({
  resourceId: z.string().min(1),
  activityType: z.enum(["VIEW", "DOWNLOAD"]),
  metadata: z
    .record(z.unknown())
    .optional()
    .refine((m) => !m || JSON.stringify(m).length <= 2000, {
      message: "metadata too large",
    }),
});

// Repeat events for the same user + resource + type inside this window are collapsed.
const DEDUPE_WINDOW_MS: Record<"VIEW" | "DOWNLOAD", number> = {
  VIEW: 30 * 60 * 1000,
  DOWNLOAD: 5 * 60 * 1000,
};

router.post(
  "/activity",
  requireStudyAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = activitySchema.parse(req.body);
      const userId = req.user!.id;

      const resource = await prisma.resource.findUnique({
        where: { id: body.resourceId },
        select: { id: true },
      });
      if (!resource) {
        res.status(404).json({ error: "Resource not found" });
        return;
      }

      const existing = await prisma.userActivity.findFirst({
        where: {
          userId,
          resourceId: body.resourceId,
          activityType: body.activityType,
          createdAt: {
            gte: new Date(Date.now() - DEDUPE_WINDOW_MS[body.activityType]),
          },
        },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        res.status(200).json({ activity: existing, deduped: true });
        return;
      }

      const activity = await prisma.userActivity.create({
        data: {
          userId,
          resourceId: body.resourceId,
          activityType: body.activityType,
          metadata: body.metadata
            ? (body.metadata as Prisma.InputJsonObject)
            : undefined,
        },
      });

      res.status(201).json({ activity });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
