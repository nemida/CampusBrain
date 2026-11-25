/**
 * GET    /api/resources              — list papers; filter by ?subjectId= &subjectCode= &semester= &branch= &year= &examType=
 * GET    /api/resources/by-topic     — semantic search: find papers related to a topic (?topic=&subjectId=)
 * POST   /api/resources              — upload a new paper (TEACHER | ADMIN only, multipart/form-data)
 * DELETE /api/resources/:id          — delete a paper + its Cloudinary file (TEACHER | ADMIN only)
 *
 * Response shape for each resource matches the frontend Paper type:
 *   { id, subjectCode, title, year, examType, size, pdfUrl }
 * plus extra fields the frontend can ignore: { subjectId, subjectName, branch, semester, uploadedAt }
 */
import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { Role, ExamType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { uploadFile, deleteFile } from "../lib/cloudinary.js";
import { requireAuth, requireStudyAccess } from "../middleware/requireAuth.js";
import { ingestResource } from "../lib/ingestion.js";
import { retrieveChunks } from "../lib/retriever.js";
import { detectUploadType } from "../lib/uploadValidation.js";

const router = Router();

// multer — keep file in memory so we can stream directly to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter(_req, file, cb) {
    if (
      file.mimetype === "application/pdf" ||
      ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)
    )
      cb(null, true);
    else
      cb(
        Object.assign(
          new Error("Only PDF, PNG, JPEG or WebP files are allowed"),
          { statusCode: 400 },
        ),
      );
  },
});

// ── helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function dbExamTypeToFrontend(examType: ExamType): string {
  return examType === ExamType.MID_SEM ? "Mid-Sem" : "End-Sem";
}

function frontendExamTypeToDb(raw: string): ExamType {
  if (raw === "Mid-Sem" || raw === "MID_SEM") return ExamType.MID_SEM;
  if (raw === "End-Sem" || raw === "END_SEM") return ExamType.END_SEM;
  throw new Error(`Unknown examType: ${raw}`);
}

function shapeResource(r: {
  id: string;
  title: string;
  year: number;
  examType: ExamType;
  fileUrl: string;
  fileSizeBytes: number;
  createdAt: Date;
  subject: {
    id: string;
    code: string;
    name: string;
    semester: number;
    branch: { name: string; code: string };
  };
}) {
  return {
    id: r.id,
    subjectCode: r.subject.code,
    subjectId: r.subject.id,
    subjectName: r.subject.name,
    branch: r.subject.branch.name,
    branchCode: r.subject.branch.code,
    semester: r.subject.semester,
    title: r.title,
    year: r.year,
    examType: dbExamTypeToFrontend(r.examType),
    size: formatSize(r.fileSizeBytes),
    pdfUrl: r.fileUrl,
    uploadedAt: r.createdAt.toISOString(),
  };
}

// ── GET /api/resources ───────────────────────────────────────────────────────

const listQuerySchema = z.object({
  subjectId: z.string().optional(),
  subjectCode: z.string().optional(),
  semester: z.coerce.number().int().min(1).max(8).optional(),
  branch: z.string().optional(), // branch name
  branchCode: z.string().optional(), // branch code e.g. "CS"
  year: z.coerce.number().int().optional(),
  examType: z.string().optional(), // "Mid-Sem" | "End-Sem"
  search: z.string().optional(),
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);

    let dbExamType: ExamType | undefined;
    if (query.examType) {
      try {
        dbExamType = frontendExamTypeToDb(query.examType);
      } catch {
        /* ignore bad value */
      }
    }

    // All subject-level filters must live in ONE `subject` object — spreading several
    // `{ subject: ... }` objects would make the last one silently overwrite the rest.
    const subjectFilter: Prisma.SubjectWhereInput = {
      ...(query.subjectCode ? { code: query.subjectCode } : {}),
      ...(query.semester ? { semester: query.semester } : {}),
      ...(query.branch || query.branchCode
        ? {
            branch: {
              ...(query.branch ? { name: query.branch } : {}),
              ...(query.branchCode ? { code: query.branchCode } : {}),
            },
          }
        : {}),
    };

    const resources = await prisma.resource.findMany({
      where: {
        ...(query.subjectId ? { subjectId: query.subjectId } : {}),
        ...(Object.keys(subjectFilter).length > 0
          ? { subject: subjectFilter }
          : {}),
        ...(query.year ? { year: query.year } : {}),
        ...(dbExamType ? { examType: dbExamType } : {}),
        ...(query.search
          ? { title: { contains: query.search, mode: "insensitive" } }
          : {}),
      },
      orderBy: [{ year: "desc" }, { examType: "asc" }],
      include: {
        subject: {
          include: { branch: { select: { name: true, code: true } } },
        },
      },
    });

    res.json({ resources: resources.map(shapeResource) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/resources/by-topic ──────────────────────────────────────────────
// Semantic search: find PYQ papers that contain content related to a topic.
// Query params: ?topic=Binary+Trees  &subjectId=abc123  (&topK=5)

const byTopicQuerySchema = z.object({
  topic: z.string().min(1),
  subjectId: z.string().optional(),
  topK: z.coerce.number().int().min(1).max(20).default(5),
});

router.get(
  "/by-topic",
  requireStudyAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = byTopicQuerySchema.parse(req.query);

      // Retrieve relevant resource chunks via semantic search
      const chunks = await retrieveChunks(query.topic, {
        type: "resource",
        subjectId: query.subjectId,
        topK: query.topK * 3, // over-fetch chunks so we can deduplicate by resource
      });

      if (chunks.length === 0) {
        res.json({ resources: [], ragEnabled: false });
        return;
      }

      // Deduplicate: keep the best (highest similarity) chunk per resource
      const bestByResource = new Map<
        string,
        { resourceId: string; similarity: number }
      >();
      for (const chunk of chunks) {
        const existing = bestByResource.get(chunk.sourceId);
        if (!existing || chunk.similarity > existing.similarity) {
          bestByResource.set(chunk.sourceId, {
            resourceId: chunk.sourceId,
            similarity: chunk.similarity,
          });
        }
      }

      // Sort by similarity and take topK unique resources
      const topResourceIds = [...bestByResource.values()]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, query.topK)
        .map((r) => r.resourceId);

      // Fetch full resource details from DB
      const dbResources = await prisma.resource.findMany({
        where: { id: { in: topResourceIds } },
        include: {
          subject: {
            include: { branch: { select: { name: true, code: true } } },
          },
        },
      });

      // Preserve similarity ordering
      const ordered = topResourceIds
        .map((id) => dbResources.find((r) => r.id === id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);

      res.json({
        resources: ordered.map((r) => ({
          ...shapeResource(r),
          similarityScore: bestByResource.get(r.id)?.similarity ?? 0,
        })),
        ragEnabled: true,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/resources ──────────────────────────────────────────────────────

const uploadBodySchema = z.object({
  subjectCode: z.string().min(1),
  branch: z.string().optional(), // branch name — disambiguates subject codes shared across branches
  year: z.coerce.number().int().min(2000).max(2099),
  examType: z.string().min(1), // "Mid-Sem" | "End-Sem"
});

router.post(
  "/",
  requireAuth([Role.TEACHER, Role.ADMIN]),
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "PDF file is required" });
        return;
      }

      const detectedType = detectUploadType(req.file.buffer);
      if (!detectedType || detectedType !== req.file.mimetype) {
        res
          .status(400)
          .json({
            error: "File content must match its PDF, PNG, JPEG or WebP type",
          });
        return;
      }

      const body = uploadBodySchema.parse(req.body);
      const dbExamType = frontendExamTypeToDb(body.examType);

      // Resolve subject
      const matches = await prisma.subject.findMany({
        where: {
          code: body.subjectCode,
          ...(body.branch ? { branch: { name: body.branch } } : {}),
        },
        include: { branch: { select: { name: true, code: true } } },
        take: 2,
      });
      if (matches.length > 1) {
        res
          .status(400)
          .json({
            error:
              "This subject code exists in multiple branches. Select a branch.",
          });
        return;
      }
      const subject = matches[0];
      if (!subject) {
        res
          .status(404)
          .json({ error: `Subject with code "${body.subjectCode}" not found` });
        return;
      }

      // Upload to Cloudinary
      const cloudResult = await uploadFile(
        req.file.buffer,
        req.file.originalname,
        body.subjectCode,
        req.file.mimetype,
      );

      // Build human-readable title matching frontend pattern
      const season = dbExamType === ExamType.MID_SEM ? "Summer" : "Winter";
      const title = `${season} ${body.year} ${dbExamTypeToFrontend(dbExamType)} Exam`;

      const resource = await prisma.resource
        .create({
          data: {
            subjectId: subject.id,
            uploadedById: req.user!.id,
            title,
            year: body.year,
            examType: dbExamType,
            fileUrl: cloudResult.secureUrl,
            publicId: cloudResult.publicId,
            fileSizeBytes: cloudResult.bytes,
          },
          include: {
            subject: {
              include: { branch: { select: { name: true, code: true } } },
            },
          },
        })
        .catch(async (error: unknown) => {
          // Compensate if the database write fails after the external upload succeeded.
          await deleteFile(cloudResult.publicId, cloudResult.secureUrl).catch(
            (cleanupError) =>
              console.error(
                "[Upload] Failed to clean up orphaned asset",
                cleanupError,
              ),
          );
          throw error;
        });

      res.status(201).json({ resource: shapeResource(resource) });

      // Fire-and-forget RAG ingestion — runs in background, never blocks the response
      ingestResource(resource.id, resource.fileUrl, resource.subjectId).catch(
        () => undefined,
      );
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/resources/:id ────────────────────────────────────────────────

router.delete(
  "/:id",
  requireAuth([Role.TEACHER, Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resource = await prisma.resource.findUnique({
        where: { id: String(String(req.params["id"])) },
      });
      if (!resource) {
        res.status(404).json({ error: "Resource not found" });
        return;
      }

      // TEACHERs can only delete their own uploads; ADMINs can delete anything
      if (
        req.user!.role === Role.TEACHER &&
        resource.uploadedById !== req.user!.id
      ) {
        res.status(403).json({ error: "You can only delete your own uploads" });
        return;
      }

      // Delete from Cloudinary first — if this fails the DB row stays intact (safe)
      await deleteFile(resource.publicId, resource.fileUrl);
      await prisma.resource.delete({
        where: { id: String(String(req.params["id"])) },
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
