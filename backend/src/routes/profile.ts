/**
 * GET   /api/profile        — get current user's profile (creates one if missing)
 * PUT   /api/profile        — upsert profile (year, branchId, semester)
 * POST  /api/profile/subjects/:subjectId  — add a subject to profile
 * DELETE /api/profile/subjects/:subjectId — remove a subject from profile
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireStudyAccess } from "../middleware/requireAuth.js";

const router = Router();

async function getOrCreateProfile(userId: string) {
  const include = {
    branch: { select: { id: true, name: true, code: true } },
    subjects: {
      include: {
        subject: {
          select: { id: true, code: true, name: true, semester: true },
        },
      },
    },
  };
  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    include,
  });
  return (
    profile ??
    prisma.userProfile.upsert({
      where: { userId },
      update: {},
      create: { userId },
      include,
    })
  );
}

// GET /api/profile
router.get(
  "/",
  requireStudyAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await getOrCreateProfile(req.user!.id);
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  },
);

// PUT /api/profile
const updateSchema = z.object({
  year: z.number().int().min(1).max(4).optional().nullable(),
  semester: z.number().int().min(1).max(8).optional().nullable(),
  branchId: z.string().optional().nullable(),
});

router.put(
  "/",
  requireStudyAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = updateSchema.parse(req.body);
      const profile = await prisma.userProfile.upsert({
        where: { userId: req.user!.id },
        update: {
          ...(body.year !== undefined ? { year: body.year } : {}),
          ...(body.semester !== undefined ? { semester: body.semester } : {}),
          ...(body.branchId !== undefined ? { branchId: body.branchId } : {}),
        },
        create: {
          userId: req.user!.id,
          year: body.year ?? null,
          semester: body.semester ?? null,
          branchId: body.branchId ?? null,
        },
        include: {
          branch: { select: { id: true, name: true, code: true } },
          subjects: {
            include: {
              subject: {
                select: { id: true, code: true, name: true, semester: true },
              },
            },
          },
        },
      });
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/profile/subjects/:subjectId
router.post(
  "/subjects/:subjectId",
  requireStudyAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subjectId = String(req.params["subjectId"]);
      const subject = await prisma.subject.findUnique({
        where: { id: subjectId },
      });
      if (!subject) {
        res.status(404).json({ error: "Subject not found" });
        return;
      }

      const profile = await prisma.userProfile.upsert({
        where: { userId: req.user!.id },
        update: {},
        create: { userId: req.user!.id },
      });

      await prisma.userProfileSubject.upsert({
        where: {
          profileId_subjectId: { profileId: profile.id, subjectId: subject.id },
        },
        update: {},
        create: { profileId: profile.id, subjectId: subject.id },
      });

      const updated = await getOrCreateProfile(req.user!.id);
      res.json({ profile: updated });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/profile/subjects/:subjectId
router.delete(
  "/subjects/:subjectId",
  requireStudyAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subjectId = String(req.params["subjectId"]);
      const profile = await prisma.userProfile.findUnique({
        where: { userId: req.user!.id },
      });
      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      await prisma.userProfileSubject.deleteMany({
        where: { profileId: profile.id, subjectId },
      });

      const updated = await getOrCreateProfile(req.user!.id);
      res.json({ profile: updated });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
