/**
 * GET    /api/subjects                — list subjects, filter by ?branch=&semester=&search=
 * GET    /api/subjects/:id            — single subject with paper count
 * POST   /api/subjects                — create a subject (ADMIN only)
 * PATCH  /api/subjects/:id            — update a subject (ADMIN only)
 * DELETE /api/subjects/:id            — delete a subject (ADMIN only, blocked if papers exist)
 *
 * Response shape matches the frontend Subject type exactly:
 *   { id, code, name, semester, branch, branchCode, paperCount }
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Role, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

const querySchema = z.object({
  branch: z.string().optional(), // branch name, e.g. "Computer Science"
  branchCode: z.string().optional(), // branch code, e.g. "CS"
  semester: z.coerce.number().int().min(1).max(8).optional(),
  search: z.string().optional(),
});

/** Shape a subject row into the frontend Subject type. */
function shapeSubject(s: {
  id: string;
  code: string;
  name: string;
  semester: number;
  branch: { name: string; code: string };
  _count?: { resources: number };
}) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    semester: s.semester,
    branch: s.branch.name,
    branchCode: s.branch.code,
    paperCount: s._count?.resources ?? 0,
  };
}

const subjectInclude = {
  branch: { select: { name: true, code: true } },
  _count: { select: { resources: true } },
} as const;

// GET /api/subjects
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = querySchema.parse(req.query);

    const subjects = await prisma.subject.findMany({
      where: {
        ...(query.semester ? { semester: query.semester } : {}),
        ...(query.branch || query.branchCode
          ? {
              branch: {
                ...(query.branch ? { name: query.branch } : {}),
                ...(query.branchCode ? { code: query.branchCode } : {}),
              },
            }
          : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: "insensitive" } },
                { code: { contains: query.search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ semester: "asc" }, { code: "asc" }],
      include: subjectInclude,
    });

    res.json({ subjects: subjects.map(shapeSubject) });
  } catch (err) {
    next(err);
  }
});

// GET /api/subjects/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const subject = await prisma.subject.findUnique({
      where: { id: String(String(req.params["id"])) },
      include: subjectInclude,
    });
    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    res.json({ subject: shapeSubject(subject) });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/subjects — create (ADMIN only) ─────────────────────────────────

const createBodySchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  semester: z.number().int().min(1).max(8),
  branchId: z.string().min(1),
});

router.post(
  "/",
  requireAuth([Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createBodySchema.parse(req.body);

      const branch = await prisma.branch.findUnique({
        where: { id: body.branchId },
        select: { id: true, name: true, code: true },
      });
      if (!branch) {
        res.status(404).json({ error: "Branch not found" });
        return;
      }

      const subject = await prisma.subject.create({
        data: {
          code: body.code,
          name: body.name,
          semester: body.semester,
          branchId: body.branchId,
        },
        include: subjectInclude,
      });

      res.status(201).json({ subject: shapeSubject(subject) });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        res
          .status(409)
          .json({ error: `Subject code "${req.body.code}" already exists for this branch` });
        return;
      }
      next(err);
    }
  },
);

// ── PATCH /api/subjects/:id — update (ADMIN only) ────────────────────────────

const updateBodySchema = z.object({
  code: z.string().trim().min(1).max(50).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  semester: z.number().int().min(1).max(8).optional(),
  branchId: z.string().min(1).optional(),
});

router.patch(
  "/:id",
  requireAuth([Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(String(req.params["id"]));
      const body = updateBodySchema.parse(req.body);

      // If moving to a new branch, make sure it exists
      if (body.branchId) {
        const branch = await prisma.branch.findUnique({ where: { id: body.branchId } });
        if (!branch) {
          res.status(404).json({ error: "Branch not found" });
          return;
        }
      }

      const subject = await prisma.subject.update({
        where: { id },
        data: {
          ...(body.code !== undefined ? { code: body.code } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.semester !== undefined ? { semester: body.semester } : {}),
          ...(body.branchId !== undefined ? { branchId: body.branchId } : {}),
        },
        include: subjectInclude,
      });

      res.json({ subject: shapeSubject(subject) });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        res.status(409).json({ error: "Subject code already exists for this branch" });
        return;
      }
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        res.status(404).json({ error: "Subject not found" });
        return;
      }
      next(err);
    }
  },
);

// ── DELETE /api/subjects/:id — delete (ADMIN only) ───────────────────────────

router.delete(
  "/:id",
  requireAuth([Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(String(req.params["id"]));

      // Block deletion when papers/resources exist — cascading would destroy them.
      const count = await prisma.resource.count({ where: { subjectId: id } });
      if (count > 0) {
        res
          .status(409)
          .json({ error: `Cannot delete: ${count} paper(s) are attached to this subject. Remove them first.` });
        return;
      }

      await prisma.subject.delete({ where: { id } });
      res.status(204).send();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        res.status(404).json({ error: "Subject not found" });
        return;
      }
      next(err);
    }
  },
);

export default router;
