/**
 * GET    /api/branches          — list all branches
 * GET    /api/branches/:id      — single branch with its subjects grouped by semester
 * POST   /api/branches          — create a branch (ADMIN only)
 * DELETE /api/branches/:id      — delete a branch (ADMIN only, blocked if subjects exist)
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Role, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { lockRow } from "../lib/rowLocks.js";

const router = Router();

// GET /api/branches
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const branches = await prisma.branch.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    });
    res.json({ branches });
  } catch (err) {
    next(err);
  }
});

// GET /api/branches/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branch = await prisma.branch.findUnique({
      where: { id: String(String(req.params["id"])) },
      include: {
        subjects: {
          orderBy: [{ semester: "asc" }, { code: "asc" }],
          select: { id: true, code: true, name: true, semester: true },
        },
      },
    });
    if (!branch) {
      res.status(404).json({ error: "Branch not found" });
      return;
    }
    res.json({ branch });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/branches — create (ADMIN only) ────────────────────────────────

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(20),
});

router.post(
  "/",
  requireAuth([Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createBodySchema.parse(req.body);

      const branch = await prisma.branch.create({
        data: { name: body.name, code: body.code },
        select: { id: true, name: true, code: true },
      });

      res.status(201).json({ branch });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const target = (err.meta?.target as string[] | undefined)?.join(", ");
        const field = target?.includes("name") ? "name" : "code";
        res
          .status(409)
          .json({ error: `A branch with this ${field} already exists` });
        return;
      }
      next(err);
    }
  },
);

// ── DELETE /api/branches/:id — delete (ADMIN only) ───────────────────────────

router.delete(
  "/:id",
  requireAuth([Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(String(req.params["id"]));

      // Block deletion when subjects still exist — cascading would destroy them.
      const count = await prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, "Branch", id))) return -1;
        const count = await tx.subject.count({ where: { branchId: id } });
        if (count === 0) await tx.branch.delete({ where: { id } });
        return count;
      });
      if (count === -1) {
        res.status(404).json({ error: "Branch not found" });
        return;
      }
      if (count > 0) {
        res
          .status(409)
          .json({
            error: `Cannot delete: ${count} subject(s) belong to this branch. Remove them first.`,
          });
        return;
      }

      res.status(204).send();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        res.status(404).json({ error: "Branch not found" });
        return;
      }
      next(err);
    }
  },
);

export default router;
