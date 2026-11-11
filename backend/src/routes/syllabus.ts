/**
 * GET    /api/syllabus                        — list syllabi (filter by ?branchId=&semester=&scheme=). Public.
 * GET    /api/syllabus/:id                    — get syllabus + all items. Public.
 * POST   /api/syllabus                        — create a syllabus. TEACHER|ADMIN.
 * POST   /api/syllabus/:id/items              — add a unit. TEACHER|ADMIN.
 * PATCH  /api/syllabus/:id/items/:itemId      — update a unit. TEACHER|ADMIN.
 * DELETE /api/syllabus/:id/items/:itemId      — delete a unit. TEACHER|ADMIN.
 * DELETE /api/syllabus/:id                    — delete whole syllabus. ADMIN.
 */
import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { chatComplete, extractJSON } from "../lib/ai.js";
import { ingestSyllabusItem } from "../lib/ingestion.js";

const router = Router();

// ── response shaping ─────────────────────────────────────────────────────────────────────────────
// The frontend expects flat `branchName` / `branchCode` / `subjectName` fields.

const subjectSelect = { select: { id: true, code: true, name: true } } as const;

type ItemWithSubject = {
  id: string;
  unitNumber: number;
  title: string;
  topics: string[];
  hours: number | null;
  subjectId: string | null;
  subject?: { id: string; code: string; name: string } | null;
};

function shapeItem(i: ItemWithSubject) {
  return {
    id: i.id,
    unitNumber: i.unitNumber,
    title: i.title,
    topics: i.topics,
    hours: i.hours,
    subjectId: i.subjectId,
    subjectName: i.subject?.name ?? null,
    subjectCode: i.subject?.code ?? null,
  };
}

function shapeSyllabus(s: {
  id: string;
  branchId: string;
  semester: number;
  scheme: string;
  description: string | null;
  branch: { id: string; name: string; code: string };
  items: ItemWithSubject[];
}) {
  return {
    id: s.id,
    branchId: s.branchId,
    branchName: s.branch.name,
    branchCode: s.branch.code,
    semester: s.semester,
    scheme: s.scheme,
    description: s.description,
    items: s.items.map(shapeItem),
  };
}

// ── GET /api/syllabus ────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  branchId: z.string().optional(),
  semester: z.coerce.number().int().min(1).max(8).optional(),
  scheme: z.string().optional(),
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);

    const syllabi = await prisma.syllabus.findMany({
      where: {
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.semester ? { semester: query.semester } : {}),
        ...(query.scheme ? { scheme: query.scheme } : {}),
      },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        items: { orderBy: { unitNumber: "asc" }, include: { subject: subjectSelect } },
      },
      orderBy: [{ semester: "asc" }, { scheme: "desc" }],
    });

    res.json({ syllabi: syllabi.map(shapeSyllabus) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/syllabus/:id ────────────────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const syllabus = await prisma.syllabus.findUnique({
      where: { id: String(req.params["id"]) },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        items: {
          orderBy: { unitNumber: "asc" },
          include: { subject: { select: { id: true, code: true, name: true } } },
        },
      },
    });

    if (!syllabus) {
      res.status(404).json({ error: "Syllabus not found" });
      return;
    }

    res.json({ syllabus: shapeSyllabus(syllabus) });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/syllabus ───────────────────────────────────────────────────────

const createSyllabusSchema = z.object({
  branchId: z.string().min(1),
  semester: z.number().int().min(1).max(8),
  scheme: z.string().default("2021"),
  description: z.string().optional(),
});

router.post(
  "/",
  requireAuth([Role.TEACHER, Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createSyllabusSchema.parse(req.body);

      const branch = await prisma.branch.findUnique({ where: { id: body.branchId } });
      if (!branch) {
        res.status(404).json({ error: "Branch not found" });
        return;
      }

      const syllabus = await prisma.syllabus.create({
        data: {
          branchId: body.branchId,
          semester: body.semester,
          scheme: body.scheme,
          description: body.description,
          createdById: req.user!.id,
        },
        include: {
          branch: { select: { id: true, name: true, code: true } },
          items: { include: { subject: subjectSelect } },
        },
      });

      res.status(201).json({ syllabus: shapeSyllabus(syllabus) });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/syllabus/:id/parse ── AI parse pasted syllabus text ─────────────

const parseSchema = z.object({
  text: z.string().min(10),
  subjectId: z.string().optional(),
});

router.post(
  "/:id/parse",
  requireAuth([Role.TEACHER, Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { text, subjectId: overrideSubjectId } = parseSchema.parse(req.body);
      const syllabusId = String(req.params["id"]);

      const syllabus = await prisma.syllabus.findUnique({ where: { id: syllabusId } });
      if (!syllabus) {
        res.status(404).json({ error: "Syllabus not found" });
        return;
      }

      // Get subjects for this branch+semester so AI can match them
      const subjects = await prisma.subject.findMany({
        where: { branchId: syllabus.branchId, semester: syllabus.semester },
        select: { id: true, name: true, code: true },
      });

      const subjectList = subjects.map((s) => `- ${s.code}: ${s.name}`).join("\n");

      const prompt = `You are given raw syllabus text. Parse it into structured units.

Available subjects for this semester (match units to these if possible):
${subjectList}

Raw syllabus text:
"""
${text.slice(0, 6000)}
"""

The text is formatted as "Unit N" followed by the unit's topics/content on the next lines, then "Unit N+1", etc.

Return a JSON object with key "units" containing an array of objects:
- "unitNumber": number (the unit number from the text)
- "title": string (create a short descriptive title from the topics, e.g. "Unit 1: Introduction to C")
- "topics": array of strings (split the content under each unit into individual topic names — these are what students study)
- "hours": number (only if hours are explicitly mentioned, otherwise omit)
- "subjectCode": string (match to one of the listed subjects by code if the unit clearly belongs to a subject, otherwise omit)

Important:
- Each "Unit N" header starts a new unit. Everything between two headers is that unit's content.
- Split the content into meaningful topic names (not full sentences, just topic labels like "Pointers", "Linked Lists", "Memory Allocation")
- If a unit has no clear topics, use the raw text as a single topic entry`;

      const result = await chatComplete([{ role: "user", content: prompt }]);
      if (!result) {
        res.status(502).json({ error: "AI service unavailable. Try adding units manually." });
        return;
      }

      const parsed = extractJSON<{
        units?: Array<{
          unitNumber: number;
          title: string;
          topics: string[];
          hours?: number;
          subjectCode?: string;
        }>;
      }>(result.content);

      if (!parsed?.units || parsed.units.length === 0) {
        res
          .status(422)
          .json({
            error: "Could not parse units from the pasted text. Try formatting it more clearly.",
          });
        return;
      }

      // Create SyllabusItem records
      const created: ReturnType<typeof shapeItem>[] = [];
      for (const [index, unit] of parsed.units.entries()) {
        const topics = Array.isArray(unit.topics) ? unit.topics.map(String).filter(Boolean) : [];
        const unitNumber =
          Number.isInteger(unit.unitNumber) && unit.unitNumber > 0 ? unit.unitNumber : index + 1;
        const hours = Number.isInteger(unit.hours) && unit.hours! > 0 ? unit.hours : undefined;
        // Use the explicitly chosen subject, or try AI's match, or leave null
        let subjectId: string | undefined;
        if (overrideSubjectId) {
          subjectId = overrideSubjectId;
        } else if (unit.subjectCode) {
          const match = subjects.find(
            (s) => s.code.toLowerCase() === unit.subjectCode!.toLowerCase(),
          );
          if (match) subjectId = match.id;
        }

        const item = await prisma.syllabusItem.create({
          data: {
            syllabusId,
            unitNumber,
            title: unit.title || `Unit ${unitNumber}`,
            topics: topics.length > 0 ? topics : ["General"],
            hours,
            subjectId,
          },
          include: { subject: subjectSelect },
        });
        created.push(shapeItem(item));

        // Fire-and-forget RAG ingestion for this unit
        ingestSyllabusItem(item.id, item.subjectId, item.title, item.topics).catch(() => undefined);
      }

      res.status(201).json({ items: created, count: created.length });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/syllabus/:id/items ─────────────────────────────────────────────

const createItemSchema = z.object({
  unitNumber: z.number().int().min(1),
  title: z.string().min(1),
  topics: z.array(z.string()).min(1),
  hours: z.number().int().min(1).optional(),
  subjectId: z.string().optional(),
});

router.post(
  "/:id/items",
  requireAuth([Role.TEACHER, Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createItemSchema.parse(req.body);

      const syllabus = await prisma.syllabus.findUnique({
        where: { id: String(req.params["id"]) },
      });
      if (!syllabus) {
        res.status(404).json({ error: "Syllabus not found" });
        return;
      }

      const item = await prisma.syllabusItem.create({
        data: {
          syllabusId: syllabus.id,
          unitNumber: body.unitNumber,
          title: body.title,
          topics: body.topics,
          hours: body.hours,
          subjectId: body.subjectId,
        },
        include: { subject: subjectSelect },
      });

      res.status(201).json({ item: shapeItem(item) });

      // Fire-and-forget RAG ingestion
      ingestSyllabusItem(item.id, item.subjectId, item.title, item.topics).catch(() => undefined);
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /api/syllabus/:id/items/:itemId ────────────────────────────────────

const updateItemSchema = z.object({
  unitNumber: z.number().int().min(1).optional(),
  title: z.string().min(1).optional(),
  topics: z.array(z.string()).optional(),
  hours: z.number().int().min(1).optional(),
  subjectId: z.string().optional(),
});

router.patch(
  "/:id/items/:itemId",
  requireAuth([Role.TEACHER, Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = updateItemSchema.parse(req.body);

      const item = await prisma.syllabusItem.findFirst({
        where: { id: String(req.params["itemId"]), syllabusId: String(req.params["id"]) },
      });
      if (!item) {
        res.status(404).json({ error: "Syllabus item not found" });
        return;
      }

      const updated = await prisma.syllabusItem.update({
        where: { id: item.id },
        data: {
          ...(body.unitNumber !== undefined ? { unitNumber: body.unitNumber } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.topics !== undefined ? { topics: body.topics } : {}),
          ...(body.hours !== undefined ? { hours: body.hours } : {}),
          ...(body.subjectId !== undefined ? { subjectId: body.subjectId } : {}),
        },
        include: { subject: subjectSelect },
      });

      res.json({ item: shapeItem(updated) });

      // Fire-and-forget re-ingestion when topics change
      ingestSyllabusItem(updated.id, updated.subjectId, updated.title, updated.topics).catch(() => undefined);
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/syllabus/:id/items/:itemId ───────────────────────────────────

router.delete(
  "/:id/items/:itemId",
  requireAuth([Role.TEACHER, Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await prisma.syllabusItem.findFirst({
        where: { id: String(req.params["itemId"]), syllabusId: String(req.params["id"]) },
      });
      if (!item) {
        res.status(404).json({ error: "Syllabus item not found" });
        return;
      }

      await prisma.syllabusItem.delete({ where: { id: item.id } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/syllabus/:id ─────────────────────────────────────────────────

router.delete(
  "/:id",
  requireAuth([Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const syllabus = await prisma.syllabus.findUnique({
        where: { id: String(req.params["id"]) },
      });
      if (!syllabus) {
        res.status(404).json({ error: "Syllabus not found" });
        return;
      }

      await prisma.syllabus.delete({ where: { id: String(req.params["id"]) } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
