import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireStudyAccess } from "../middleware/requireAuth.js";
import { uploadFile, deleteFile } from "../lib/cloudinary.js";
import { detectUploadType } from "../lib/uploadValidation.js";
import {
  textbookPageCount,
  wakeTextbookWorker,
  TEXTBOOK_LEASE_MS,
} from "../lib/textbookIngestion.js";
import {
  noteIsStale,
  noteRequestSchema,
  sourceSnapshot,
  type NoteSection,
} from "../lib/textbookNotes.js";
import {
  generateTextbookSection,
  retrieveTextbookEvidence,
} from "../lib/textbookRetrieval.js";

const router = Router();
router.use(requireStudyAccess);
const editors = requireAuth([Role.TEACHER, Role.ADMIN]);
const expensive = rateLimit({
  windowMs: 10 * 60_000,
  max: 6,
  keyGenerator: (req) => req.user!.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Please wait before processing more PDFs or generating more notes.",
  },
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 3 },
});
const publicMaterial = {
  id: true,
  unitId: true,
  uploadedById: true,
  title: true,
  fileUrl: true,
  fileSizeBytes: true,
  status: true,
  pageCount: true,
  processedPages: true,
  unreadablePages: true,
  error: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TextbookMaterialSelect;
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const generating = new Set<string>();

router.get("/units/:unitId", async (req, res, next) => {
  try {
    const unitId = String(req.params.unitId);
    const unit = await prisma.syllabusItem.findUnique({
      where: { id: unitId },
      include: { subject: { select: { id: true, name: true, code: true } } },
    });
    if (!unit) throw fail("Syllabus unit not found", 404);
    const materials = await prisma.textbookMaterial.findMany({
      where: { unitId },
      select: publicMaterial,
      orderBy: { createdAt: "desc" },
    });
    const notes = await prisma.unitNote.findMany({
      where: { unitId, userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json({
      unit: {
        id: unit.id,
        title: unit.title,
        unitNumber: unit.unitNumber,
        topics: unit.topics,
        subject: unit.subject,
      },
      materials,
      notes: notes.map((note) => ({
        ...note,
        stale: noteIsStale(note.inputs, unit, materials),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/units/:unitId/materials",
  editors,
  expensive,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const unitId = String(req.params.unitId);
      const body = z
        .object({ title: z.string().trim().min(1).max(160) })
        .parse(req.body);
      if (
        !req.file ||
        req.file.mimetype !== "application/pdf" ||
        detectUploadType(req.file.buffer) !== "application/pdf"
      )
        throw fail(
          "Upload a PDF file containing textbook pages for this unit.",
        );
      const unit = await prisma.syllabusItem.findUnique({
        where: { id: unitId },
        select: { id: true, subjectId: true },
      });
      if (!unit) throw fail("Syllabus unit not found", 404);
      if (!unit.subjectId)
        throw fail(
          "Assign this syllabus unit to a subject before uploading textbook PDFs.",
        );
      let pageCount: number;
      try {
        pageCount = await textbookPageCount(req.file.buffer);
      } catch (error) {
        throw fail(
          error instanceof Error && error.message.startsWith("Upload a unit")
            ? error.message
            : "This PDF could not be opened. Upload an unlocked, valid PDF.",
        );
      }
      const cloud = await uploadFile(
        req.file.buffer,
        req.file.originalname,
        unitId,
        "application/pdf",
        "textbooks",
      );
      let material;
      try {
        material = await prisma.textbookMaterial.create({
          data: {
            unitId,
            uploadedById: req.user!.id,
            title: body.title,
            fileUrl: cloud.secureUrl,
            publicId: cloud.publicId,
            fileSizeBytes: req.file.size,
            pageCount,
          },
          select: publicMaterial,
        });
      } catch (error) {
        await deleteFile(cloud.publicId, cloud.secureUrl).catch((cleanup) =>
          console.error("[Textbooks] Orphan cleanup failed:", cleanup),
        );
        throw error;
      }
      res.status(202).json({ material });
      wakeTextbookWorker();
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/materials/:id/retry",
  editors,
  expensive,
  async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const material = await prisma.textbookMaterial.findUnique({
        where: { id },
      });
      if (!material) throw fail("Textbook PDF not found", 404);
      if (
        req.user!.role !== Role.ADMIN &&
        material.uploadedById !== req.user!.id
      )
        throw fail("You can only reprocess your own textbook PDFs", 403);
      const updated = await prisma.textbookMaterial.updateMany({
        where: {
          id,
          OR: [
            { status: "FAILED" },
            { status: "READY" },
            {
              status: "PROCESSING",
              processingStartedAt: {
                lt: new Date(Date.now() - TEXTBOOK_LEASE_MS),
              },
            },
          ],
        },
        data: {
          status: "PENDING",
          error: null,
          processedPages: 0,
          unreadablePages: [],
          processingRunId: null,
          processingStartedAt: null,
        },
      });
      if (!updated.count)
        throw fail("This PDF is already queued or being processed", 409);
      res.status(202).json({ queued: true });
      wakeTextbookWorker();
    } catch (error) {
      next(error);
    }
  },
);

router.delete("/materials/:id", editors, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const material = await prisma.textbookMaterial.findUnique({
      where: { id },
    });
    if (!material) throw fail("Textbook PDF not found", 404);
    if (req.user!.role !== Role.ADMIN && material.uploadedById !== req.user!.id)
      throw fail("You can only delete your own textbook PDFs", 403);
    const claim = await prisma.textbookMaterial.updateMany({
      where: { id, status: { notIn: ["PROCESSING", "DELETING"] } },
      data: { status: "DELETING" },
    });
    if (!claim.count)
      throw fail("Wait for processing to finish before deleting this PDF", 409);
    try {
      await deleteFile(material.publicId, material.fileUrl);
      await prisma.textbookMaterial.delete({ where: { id } });
    } catch (error) {
      await prisma.textbookMaterial.updateMany({
        where: { id, status: "DELETING" },
        data: {
          status: "FAILED",
          error: "Deletion failed. Retry removing this PDF.",
        },
      });
      throw error;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.post("/units/:unitId/notes", expensive, async (req, res, next) => {
  const unitId = String(req.params.unitId);
  const key = `${req.user!.id}:${unitId}`;
  if (generating.has(key)) {
    next(fail("Notes are already being generated for this unit", 409));
    return;
  }
  generating.add(key);
  try {
    const body = noteRequestSchema.parse(req.body);
    const unit = await prisma.syllabusItem.findUnique({
      where: { id: unitId },
    });
    if (!unit) throw fail("Syllabus unit not found", 404);
    if (body.topics.some((topic) => !unit.topics.includes(topic)))
      throw fail("Select topics from this unit's current syllabus.");
    const materials = await prisma.textbookMaterial.findMany({
      where: { id: { in: body.materialIds }, unitId, status: "READY" },
    });
    if (materials.length !== body.materialIds.length)
      throw fail("All selected PDFs must belong to this unit and be ready.");
    const inputs = sourceSnapshot(unit, materials);
    const sections: NoteSection[] = [];
    for (const topic of body.topics) {
      const evidence = await retrieveTextbookEvidence(
        unitId,
        body.materialIds,
        topic,
      );
      sections.push(await generateTextbookSection(topic, evidence));
    }
    const note = await prisma.$transaction(async (tx) => {
      const currentUnit = await tx.syllabusItem.findUnique({
        where: { id: unitId },
      });
      const currentMaterials = await tx.textbookMaterial.findMany({
        where: { id: { in: body.materialIds }, unitId },
      });
      if (!currentUnit || noteIsStale(inputs, currentUnit, currentMaterials))
        throw fail(
          "The syllabus or selected PDFs changed during generation. Please try again.",
          409,
        );
      return tx.unitNote.create({
        data: {
          userId: req.user!.id,
          unitId,
          title: `Unit ${unit.unitNumber}: ${unit.title}`,
          inputs,
          content: { sections } as unknown as Prisma.InputJsonValue,
        },
      });
    });
    res.status(201).json({ note: { ...note, stale: false } });
  } catch (error) {
    if (
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 503
    )
      res.status(503).json({ error: error.message });
    else next(error);
  } finally {
    generating.delete(key);
  }
});

router.delete("/notes/:id", async (req, res, next) => {
  try {
    const removed = await prisma.unitNote.deleteMany({
      where: { id: String(req.params.id), userId: req.user!.id },
    });
    if (!removed.count) throw fail("Saved notes not found", 404);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
