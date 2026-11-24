/**
 * GET    /api/groups                        — list groups the user is a member of
 * POST   /api/groups                        — create a group (creator becomes OWNER)
 * POST   /api/groups/join                   — join a group by invite code
 * GET    /api/groups/:id                    — group + members + analytics (members only)
 * PATCH  /api/groups/:id                    — edit name/description/branch/semester (OWNER)
 * DELETE /api/groups/:id                    — delete the group (OWNER)
 * DELETE /api/groups/:id/leave              — leave a group
 * POST   /api/groups/:id/transfer           — hand ownership to another member (OWNER)
 * DELETE /api/groups/:id/members/:userId    — remove a member (OWNER)
 * POST   /api/groups/:id/invite/regenerate  — replace the invite code (OWNER)
 * GET    /api/groups/:id/plan/options       — shared subjects + syllabus units for the plan wizard (OWNER)
 * POST   /api/groups/:id/plan/generate      — auto-build a shared plan from the group's weak topics + shared subjects (OWNER)
 * POST   /api/groups/:id/plan               — shared plan from topics the owner supplies (OWNER)
 * DELETE /api/groups/:id/plan               — delete every member's copy of the group plan (OWNER)
 * GET    /api/groups/:id/progress           — each member's progress on the group plan
 */
import { Router, Request, Response, NextFunction } from "express";
import { GroupRole, Prisma } from "@prisma/client";
import { randomInt } from "node:crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { lockRow } from "../lib/rowLocks.js";
import { scoreTopicsByPYQFrequency } from "../lib/retriever.js";
import { aggregateGroupWeakTopics } from "../lib/topics.js";
import {
  buildPlanConfig,
  buildSmartDays,
  istDayDiff,
  istMidnight,
  prioritizeTopics,
  splitEvenly,
  spreadTopics,
  type PlanConfig,
  type PlanOptions,
  type PlanSubject,
  type PlannedDay,
} from "../lib/planBuilder.js";

const router = Router();

const MAX_MEMBERS = 50;
const QUIZ_WINDOW_DAYS = 120; // analytics only look at recent quizzes
const MAX_QUIZ_SESSIONS = 3000;
const MAX_SHARED_SUBJECTS_IN_PLAN = 6;
const DAY_MS = 86_400_000;

// ── helpers ───────────────────────────────────────────────────────────────────

/** 6-char uppercase invite code, no 0/O/1/I. Uses a cryptographic RNG (Math.random is predictable). */
function makeInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars.charAt(randomInt(chars.length));
  return code;
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** Joining is guessable by brute force in principle, so cap attempts per user. */
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "anonymous",
  message: {
    error: "Too many join attempts. Please try again in a few minutes.",
  },
});

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), "invalid date");

const memberInclude = {
  memberships: {
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { joinedAt: "asc" as const },
  },
};

const planInclude = {
  days: {
    orderBy: { dayNumber: "asc" as const },
    include: { subject: { select: { id: true, name: true, code: true } } },
  },
};

/** "jo***@gmail.com": members see each other's names, not each other's full email addresses. */
function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

function shapeGroup(
  g: {
    id: string;
    name: string;
    description: string | null;
    inviteCode: string;
    branch: string | null;
    semester: number | null;
    ownerId: string;
    memberships: {
      role: GroupRole;
      user: { id: string; name: string; email: string };
    }[];
  },
  viewerId: string,
) {
  const mine = g.memberships.find((m) => m.user.id === viewerId);
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    inviteCode: g.inviteCode,
    branch: g.branch,
    semester: g.semester,
    myRole: (mine?.role ?? null) as "OWNER" | "MEMBER" | null,
    memberCount: g.memberships.length,
    members: g.memberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.id === viewerId ? m.user.email : maskEmail(m.user.email),
      role: m.role as "OWNER" | "MEMBER",
    })),
  };
}

async function getRole(
  groupId: string,
  userId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<GroupRole | null> {
  const m = await db.groupMembership.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { role: true },
  });
  return m?.role ?? null;
}

/** Sends the 403 itself and returns false when the caller doesn't have the needed role. */
async function authorize(
  res: Response,
  groupId: string,
  userId: string,
  need: "member" | "owner",
): Promise<boolean> {
  const role = await getRole(groupId, userId);
  if (!role) {
    res.status(403).json({ error: "You are not a member of this group" });
    return false;
  }
  if (need === "owner" && role !== GroupRole.OWNER) {
    res.status(403).json({ error: "Only the group owner can do this" });
    return false;
  }
  return true;
}

async function loadGroup(groupId: string) {
  return prisma.studyGroup.findUnique({
    where: { id: groupId },
    include: memberInclude,
  });
}

async function hasActivePlan(groupId: string): Promise<boolean> {
  return (
    (await prisma.studyPlan.count({ where: { groupId, status: "ACTIVE" } })) > 0
  );
}

/**
 * One StudyPlan (with days) per member, in two queries inside one transaction.
 * Returns the plan belonging to `requesterId`.
 */
async function createPlanForMembers(
  memberIds: string[],
  requesterId: string,
  opts: {
    groupId: string;
    title: string;
    totalDays: number;
    examDate: Date | null;
    days: PlannedDay[];
    config?: PlanConfig | null;
  },
) {
  const requesterPlanId = await prisma.$transaction(
    async (tx) => {
      await lockRow(tx, "StudyGroup", opts.groupId);
      if ((await getRole(opts.groupId, requesterId, tx)) !== GroupRole.OWNER)
        throw Object.assign(
          new Error("Only the group owner can create a shared plan"),
          { statusCode: 403 },
        );
      if (
        await tx.studyPlan.count({
          where: { groupId: opts.groupId, status: "ACTIVE" },
        })
      )
        throw Object.assign(
          new Error("This group already has an active plan"),
          { statusCode: 409 },
        );
      memberIds = (
        await tx.groupMembership.findMany({
          where: { groupId: opts.groupId },
          select: { userId: true },
        })
      ).map((member) => member.userId);
      const created = await tx.studyPlan.createManyAndReturn({
        data: memberIds.map((userId) => ({
          userId,
          groupId: opts.groupId,
          title: opts.title,
          examDate: opts.examDate,
          totalDays: opts.totalDays,
          ...(opts.config
            ? { config: opts.config as unknown as Prisma.InputJsonValue }
            : {}),
        })),
        select: { id: true, userId: true },
      });
      await tx.studyPlanDay.createMany({
        data: created.flatMap((p) =>
          opts.days.map((d) => ({
            studyPlanId: p.id,
            dayNumber: d.dayNumber,
            date: d.date,
            subjectId: d.subjectId,
            topics: d.topics,
            notes: d.notes,
            sessions: d.sessions as unknown as Prisma.InputJsonValue,
          })),
        ),
      });
      return created.find((p) => p.userId === requesterId)?.id ?? null;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  if (!requesterPlanId) return null;
  return prisma.studyPlan.findUnique({
    where: { id: requesterPlanId },
    include: planInclude,
  });
}

// ── POST /api/groups ─────────────────────────────────────────────────────────

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  branch: z.string().trim().max(100).optional(),
  semester: z.number().int().min(1).max(8).optional(),
});

router.post(
  "/",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createGroupSchema.parse(req.body);
      const userId = req.user!.id;

      // Retry on a (rare) invite-code collision instead of check-then-insert, which can race
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const group = await prisma.studyGroup.create({
            data: {
              name: body.name,
              description: body.description,
              branch: body.branch,
              semester: body.semester,
              ownerId: userId,
              inviteCode: makeInviteCode(),
              memberships: { create: { userId, role: GroupRole.OWNER } },
            },
            include: memberInclude,
          });
          res.status(201).json({ group: shapeGroup(group, userId) });
          return;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      res
        .status(503)
        .json({
          error: "Could not generate an invite code. Please try again.",
        });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/groups ──────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const memberships = await prisma.groupMembership.findMany({
        where: { userId },
        include: { group: { include: memberInclude } },
        orderBy: { joinedAt: "desc" },
      });
      res.json({ groups: memberships.map((m) => shapeGroup(m.group, userId)) });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/groups/join ─────────────────────────────────────────────────────
// MUST be before /:id

const joinSchema = z.object({ inviteCode: z.string().trim().min(1).max(20) });

router.post(
  "/join",
  requireAuth(),
  joinLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { inviteCode } = joinSchema.parse(req.body);
      const userId = req.user!.id;

      const outcome = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT "id" FROM "StudyGroup" WHERE "inviteCode" = ${inviteCode.toUpperCase()} FOR UPDATE`,
        );
        const group = rows[0];
        if (!group)
          return {
            status: 404 as const,
            error: "Invalid invite code — double-check and try again.",
          };
        const existing = await tx.groupMembership.findUnique({
          where: { groupId_userId: { groupId: group.id, userId } },
        });
        if (existing)
          return {
            status: 409 as const,
            error: "You're already in this group.",
          };
        if (
          (await tx.groupMembership.count({ where: { groupId: group.id } })) >=
          MAX_MEMBERS
        )
          return {
            status: 409 as const,
            error: `This group is full (${MAX_MEMBERS} members).`,
          };
        await tx.groupMembership.create({
          data: { groupId: group.id, userId, role: GroupRole.MEMBER },
        });
        return { status: 201 as const, groupId: group.id };
      });
      if (outcome.status !== 201) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      const group = { id: outcome.groupId };

      const full = await loadGroup(group.id);
      res.status(201).json({ group: shapeGroup(full!, userId) });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/groups/:id ───────────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const group = await loadGroup(String(req.params["id"]));
      if (!group) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (!group.memberships.some((m) => m.user.id === userId)) {
        res.status(403).json({ error: "You are not a member of this group" });
        return;
      }

      const memberIds = group.memberships.map((m) => m.user.id);
      const since = new Date(Date.now() - QUIZ_WINDOW_DAYS * DAY_MS);

      // Independent queries run together; quiz history is windowed and capped
      const [sessions, subjectRows] = await Promise.all([
        prisma.mCQSession.findMany({
          where: {
            userId: { in: memberIds },
            topic: { not: null },
            createdAt: { gte: since },
            questions: { some: { chosenIndex: { not: null } } },
          },
          select: { userId: true, topic: true, score: true },
          orderBy: { createdAt: "desc" },
          take: MAX_QUIZ_SESSIONS,
        }),
        prisma.userProfileSubject.findMany({
          where: { profile: { userId: { in: memberIds } } },
          select: {
            profile: { select: { userId: true } },
            subject: { select: { id: true, name: true, code: true } },
          },
        }),
      ]);

      const weakTopics = aggregateGroupWeakTopics(sessions);

      const byMember = new Map<
        string,
        { id: string; name: string; code: string }[]
      >();
      const bySubject = new Map<
        string,
        { id: string; name: string; code: string; memberCount: number }
      >();
      for (const row of subjectRows) {
        const list = byMember.get(row.profile.userId) ?? [];
        list.push(row.subject);
        byMember.set(row.profile.userId, list);
        const s = bySubject.get(row.subject.id) ?? {
          ...row.subject,
          memberCount: 0,
        };
        s.memberCount++;
        bySubject.set(row.subject.id, s);
      }

      res.json({
        group: shapeGroup(group, userId),
        weakTopics, // { topic, avgScore, memberCount, strugglingCount }
        memberSubjects: memberIds.map((id) => ({
          userId: id,
          subjects: byMember.get(id) ?? [],
        })),
        sharedSubjects: [...bySubject.values()]
          .sort((a, b) => b.memberCount - a.memberCount)
          .slice(0, 10),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /api/groups/:id ─────────────────────────────────────────────────────

const updateGroupSchema = createGroupSchema
  .partial()
  .refine((b) => Object.keys(b).length > 0, {
    message: "Nothing to update",
  });

router.patch(
  "/:id",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, userId, "owner"))) return;

      const body = updateGroupSchema.parse(req.body);
      const data: Prisma.StudyGroupUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.description !== undefined) data.description = body.description;
      if (body.branch !== undefined) data.branch = body.branch;
      if (body.semester !== undefined) data.semester = body.semester;

      await prisma.studyGroup.update({
        where: { id: groupId, ownerId: userId },
        data,
      });
      res.json({ group: shapeGroup((await loadGroup(groupId))!, userId) });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/groups/:id ────────────────────────────────────────────────────

router.delete(
  "/:id",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, req.user!.id, "owner"))) return;
      // Memberships cascade; members keep their own plan copies as personal plans (groupId → null)
      const deleted = await prisma.studyGroup.deleteMany({
        where: { id: groupId, ownerId: req.user!.id },
      });
      if (!deleted.count) {
        res
          .status(403)
          .json({ error: "Only the current owner can delete this group" });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/groups/:id/leave ──────────────────────────────────────────────

router.delete(
  "/:id/leave",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const groupId = String(req.params["id"]);

      const outcome = await prisma.$transaction(async (tx) => {
        await lockRow(tx, "StudyGroup", groupId);
        const role = await getRole(groupId, userId, tx);
        if (!role) {
          return {
            status: 404 as const,
            error: "You are not a member of this group",
          };
        }

        if (role === GroupRole.OWNER) {
          const memberCount = await tx.groupMembership.count({
            where: { groupId },
          });
          if (memberCount > 1) {
            return {
              status: 400 as const,
              error:
                "You're the owner. Transfer ownership to another member first, or delete the group.",
            };
          }
          await tx.studyGroup.delete({ where: { id: groupId } });
          return { status: 204 as const };
        }

        await tx.groupMembership.delete({
          where: { groupId_userId: { groupId, userId } },
        });
        // keep their copy of the plan, just detach it from the group
        await tx.studyPlan.updateMany({
          where: { groupId, userId },
          data: { groupId: null },
        });
        return { status: 204 as const };
      });
      if (outcome.status !== 204) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/groups/:id/transfer ─────────────────────────────────────────────

router.post(
  "/:id/transfer",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, userId, "owner"))) return;

      const { userId: newOwnerId } = z
        .object({ userId: z.string().min(1) })
        .parse(req.body);
      if (newOwnerId === userId) {
        res.status(400).json({ error: "You already own this group." });
        return;
      }
      const outcome = await prisma.$transaction(async (tx) => {
        await lockRow(tx, "StudyGroup", groupId);
        if ((await getRole(groupId, userId, tx)) !== GroupRole.OWNER)
          return {
            status: 403 as const,
            error: "Only the current owner can transfer ownership",
          };
        if (!(await getRole(groupId, newOwnerId, tx)))
          return {
            status: 404 as const,
            error: "That person isn't a member of this group.",
          };
        await tx.groupMembership.update({
          where: { groupId_userId: { groupId, userId: newOwnerId } },
          data: { role: GroupRole.OWNER },
        });
        await tx.groupMembership.update({
          where: { groupId_userId: { groupId, userId } },
          data: { role: GroupRole.MEMBER },
        });
        await tx.studyGroup.update({
          where: { id: groupId },
          data: { ownerId: newOwnerId },
        });
        return { status: 200 as const };
      });
      if (outcome.status !== 200) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      res.json({ group: shapeGroup((await loadGroup(groupId))!, userId) });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/groups/:id/members/:userId ────────────────────────────────────

router.delete(
  "/:id/members/:userId",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const groupId = String(req.params["id"]);
      const targetId = String(req.params["userId"]);
      if (!(await authorize(res, groupId, userId, "owner"))) return;

      if (targetId === userId) {
        res
          .status(400)
          .json({ error: "Use 'leave' to leave the group yourself." });
        return;
      }

      const removed = await prisma.$transaction(async (tx) => {
        await lockRow(tx, "StudyGroup", groupId);
        if ((await getRole(groupId, userId, tx)) !== GroupRole.OWNER)
          throw Object.assign(
            new Error("Only the current owner can remove members"),
            { statusCode: 403 },
          );
        const removed = await tx.groupMembership.deleteMany({
          where: { groupId, userId: targetId },
        });
        await tx.studyPlan.updateMany({
          where: { groupId, userId: targetId },
          data: { groupId: null },
        });
        return removed;
      });
      if (removed.count === 0) {
        res
          .status(404)
          .json({ error: "That person isn't a member of this group." });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/groups/:id/invite/regenerate ────────────────────────────────────

router.post(
  "/:id/invite/regenerate",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, req.user!.id, "owner"))) return;

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const inviteCode = makeInviteCode();
          const updated = await prisma.studyGroup.updateMany({
            where: { id: groupId, ownerId: req.user!.id },
            data: { inviteCode },
          });
          if (!updated.count) {
            res
              .status(403)
              .json({
                error: "Only the current owner can regenerate invitations",
              });
            return;
          }
          res.json({ inviteCode });
          return;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      res
        .status(503)
        .json({
          error: "Could not generate an invite code. Please try again.",
        });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/groups/:id/plan/generate ───────────────────────────────────────
// Auto plan: the subjects most members share (with their syllabus), plus dedicated
// "group focus" days on the topics the group struggles with.

const generatePlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  // Optional: if omitted, runs until the last upcoming exam (or 30 days)
  totalDays: z.number().int().min(1).max(60).optional(),
  examDate: isoDate.optional(),
  hoursPerDay: z.number().min(1).max(12).optional(),
  // Per-subject exam dates; when given, only subjects with a date are scheduled
  subjectExams: z
    .array(z.object({ subjectId: z.string(), date: isoDate }))
    .max(50)
    .optional(),
  // SyllabusItem IDs to skip — all other units are included
  excludedUnitIds: z.array(z.string()).max(500).optional(),
});

const DEFAULT_GROUP_PLAN_DAYS = 30;
const MAX_GROUP_PLAN_DAYS = 60;

/** Subjects shared by >=2 members (or by the only member of a one-person group), most shared first. */
async function loadSharedSubjectIds(memberIds: string[]): Promise<string[]> {
  const enrolments = await prisma.userProfileSubject.findMany({
    where: { profile: { userId: { in: memberIds } } },
    select: { subjectId: true },
  });
  const counts = new Map<string, number>();
  for (const e of enrolments)
    counts.set(e.subjectId, (counts.get(e.subjectId) ?? 0) + 1);
  const minShared = memberIds.length > 1 ? 2 : 1;
  return [...counts.entries()]
    .filter(([, n]) => n >= minShared)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SHARED_SUBJECTS_IN_PLAN)
    .map(([id]) => id);
}

// ── GET /api/groups/:id/plan/options ─────────────────────────────────────────
// Shared subjects + their syllabus units, so the owner can set exam dates and pick units.

router.get(
  "/:id/plan/options",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, req.user!.id, "owner"))) return;

      const memberIds = (
        await prisma.groupMembership.findMany({
          where: { groupId },
          select: { userId: true },
        })
      ).map((m) => m.userId);
      const sharedIds = await loadSharedSubjectIds(memberIds);
      const rows =
        sharedIds.length > 0
          ? await prisma.subject.findMany({
              where: { id: { in: sharedIds } },
              select: {
                id: true,
                name: true,
                code: true,
                syllabusItems: {
                  orderBy: { unitNumber: "asc" },
                  select: {
                    id: true,
                    unitNumber: true,
                    title: true,
                    topics: true,
                    hours: true,
                  },
                },
              },
            })
          : [];
      const order = new Map(sharedIds.map((id, i) => [id, i]));
      rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      res.json({
        subjects: rows.map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          units: s.syllabusItems,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/:id/plan/generate",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, userId, "owner"))) return;

      const body = generatePlanSchema.parse(req.body);
      if (await hasActivePlan(groupId)) {
        res.status(409).json({
          error:
            "This group already has an active plan. Delete it first to generate a new one.",
        });
        return;
      }

      const memberIds = (
        await prisma.groupMembership.findMany({
          where: { groupId },
          select: { userId: true },
        })
      ).map((m) => m.userId);
      const since = new Date(Date.now() - QUIZ_WINDOW_DAYS * DAY_MS);

      const [sessions, allSharedIds] = await Promise.all([
        prisma.mCQSession.findMany({
          where: {
            userId: { in: memberIds },
            topic: { not: null },
            createdAt: { gte: since },
            questions: { some: { chosenIndex: { not: null } } },
          },
          select: { userId: true, topic: true, score: true },
          orderBy: { createdAt: "desc" },
          take: MAX_QUIZ_SESSIONS,
        }),
        loadSharedSubjectIds(memberIds),
      ]);

      // Weakest-for-the-most-people first
      const weak = aggregateGroupWeakTopics(sessions, undefined, 12).map(
        (t) => t.topic,
      );

      // When per-subject exam dates are given, only schedule the shared subjects that have one
      const subjectExamDates = new Map<string, Date>();
      for (const e of body.subjectExams ?? []) {
        if (e.subjectId && e.date)
          subjectExamDates.set(e.subjectId, istMidnight(new Date(e.date)));
      }
      const sharedIds =
        subjectExamDates.size > 0
          ? allSharedIds.filter((id) => subjectExamDates.has(id))
          : allSharedIds;
      if (subjectExamDates.size > 0 && sharedIds.length === 0) {
        res
          .status(400)
          .json({
            error: "None of the exam dates match subjects shared by the group.",
          });
        return;
      }
      const excluded = new Set(body.excludedUnitIds ?? []);

      const warnings: string[] = [];
      const startDate = new Date();
      const examDate = body.examDate
        ? istMidnight(new Date(body.examDate))
        : null;
      const upcomingExamDays = [...subjectExamDates.values()]
        .map((d) => istDayDiff(startDate, d))
        .filter((n) => n > 0);
      const totalDays =
        body.totalDays ??
        (upcomingExamDays.length > 0
          ? Math.min(MAX_GROUP_PLAN_DAYS, Math.max(...upcomingExamDays))
          : DEFAULT_GROUP_PLAN_DAYS);

      const subjectRows =
        sharedIds.length > 0
          ? await prisma.subject.findMany({
              where: { id: { in: sharedIds } },
              select: {
                id: true,
                name: true,
                code: true,
                syllabusItems: {
                  orderBy: { unitNumber: "asc" },
                  select: { id: true, title: true, topics: true },
                },
              },
            })
          : [];

      const subjects: PlanSubject[] = subjectRows.map((s) => {
        const topics = new Set<string>();
        for (const unit of s.syllabusItems) {
          if (excluded.has(unit.id)) continue;
          for (const t of unit.topics)
            topics.add(`[${unit.title.replace(/^Unit \d+:?\s*/i, "")}] ${t}`);
        }
        if (topics.size === 0) {
          warnings.push(
            `${s.name}: no syllabus found, so it is scheduled as a single topic.`,
          );
          topics.add(s.name);
        }
        return {
          id: s.id,
          name: s.name,
          code: s.code,
          examDate: subjectExamDates.get(s.id) ?? examDate,
          topics: [...topics],
        };
      });

      // Pull topics that show up most in past papers forward (never blocks the plan)
      await Promise.all(
        subjects.map(async (subj) => {
          if (subj.topics.length <= 1) return;
          try {
            subj.topics = prioritizeTopics(
              subj.topics,
              await scoreTopicsByPYQFrequency(subj.topics, subj.id),
            );
          } catch (err) {
            console.error(
              `[groups] topic scoring failed for ${subj.name}:`,
              err,
            );
          }
        }),
      );

      let days: PlannedDay[];
      let config: PlanConfig | null = null;
      if (subjects.length > 0) {
        // up to ~1 focus day in 4, and always at least one day left for the subjects
        const focusCount =
          weak.length > 0 && totalDays >= 2
            ? Math.min(
                weak.length,
                Math.max(1, Math.floor(totalDays / 4)),
                totalDays - 1,
              )
            : 0;
        const focusDays = focusCount > 0 ? splitEvenly(weak, focusCount) : [];
        const options: PlanOptions = { hoursPerDay: body.hoursPerDay ?? 4 };
        const built = buildSmartDays(
          subjects,
          startDate,
          totalDays,
          focusDays,
          options,
        );
        days = built.days;
        warnings.push(...built.warnings);
        config = buildPlanConfig(subjects, startDate, totalDays, options);
      } else {
        warnings.push(
          "No subjects are shared by 2+ members, so this plan is built from weak topics only.",
        );
        days = spreadTopics(weak, totalDays, startDate);
      }

      // Headline exam date = the earliest exam still ahead
      const nextExam =
        [...subjects.map((s) => s.examDate), examDate]
          .filter(
            (d): d is Date =>
              d !== null && d.getTime() > istMidnight(startDate).getTime(),
          )
          .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

      const plan = await createPlanForMembers(memberIds, userId, {
        groupId,
        title: body.title,
        totalDays,
        examDate: nextExam,
        days,
        config,
      });

      res.status(201).json({
        plan,
        weakTopicsUsed: weak.length,
        subjectsUsed: subjects.length,
        warnings,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/groups/:id/plan ─────────────────────────────────────────────────
// Manual plan from topics the owner supplies

const groupPlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  examDate: isoDate.optional(),
  totalDays: z.number().int().min(1).max(120),
  topics: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
});

router.post(
  "/:id/plan",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, userId, "owner"))) return;

      const body = groupPlanSchema.parse(req.body);
      if (await hasActivePlan(groupId)) {
        res.status(409).json({
          error:
            "This group already has an active plan. Delete it first to create a new one.",
        });
        return;
      }

      const memberIds = (
        await prisma.groupMembership.findMany({
          where: { groupId },
          select: { userId: true },
        })
      ).map((m) => m.userId);

      const startDate = new Date();
      const exam = body.examDate ? istMidnight(new Date(body.examDate)) : null;
      const plan = await createPlanForMembers(memberIds, userId, {
        groupId,
        title: body.title,
        totalDays: body.totalDays,
        examDate:
          exam && exam.getTime() > istMidnight(startDate).getTime()
            ? exam
            : null,
        days: spreadTopics(body.topics ?? [], body.totalDays, startDate),
      });

      res.status(201).json({ plan });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/groups/:id/plan ───────────────────────────────────────────────

router.delete(
  "/:id/plan",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, req.user!.id, "owner"))) return;
      const { count } = await prisma.studyPlan.deleteMany({
        where: { groupId },
      });
      res.json({ deleted: count });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/groups/:id/progress ──────────────────────────────────────────────

router.get(
  "/:id/progress",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const groupId = String(req.params["id"]);
      if (!(await authorize(res, groupId, userId, "member"))) return;

      const [members, plans] = await Promise.all([
        prisma.groupMembership.findMany({
          where: { groupId },
          select: { user: { select: { id: true, name: true } } },
          orderBy: { joinedAt: "asc" },
        }),
        prisma.studyPlan.findMany({
          where: { groupId },
          orderBy: { createdAt: "desc" },
          select: {
            userId: true,
            title: true,
            totalDays: true,
            status: true,
            days: { select: { isCompleted: true } },
          },
        }),
      ]);

      const latest = new Map<string, (typeof plans)[number]>();
      for (const p of plans) if (!latest.has(p.userId)) latest.set(p.userId, p);

      const progress = members
        .map(({ user }) => {
          const p = latest.get(user.id);
          const doneDays = p ? p.days.filter((d) => d.isCompleted).length : 0;
          const totalDays = p?.totalDays ?? 0;
          return {
            userId: user.id,
            name: user.name,
            isMe: user.id === userId,
            hasPlan: p !== undefined,
            planTitle: p?.title ?? null,
            status: p?.status ?? null,
            doneDays,
            totalDays,
            percentage:
              totalDays > 0 ? Math.round((doneDays / totalDays) * 100) : 0,
          };
        })
        .sort((a, b) => b.percentage - a.percentage);

      res.json({ progress });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
