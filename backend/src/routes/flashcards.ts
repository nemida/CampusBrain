/**
 * GET    /api/flashcards                       — list user's flashcard sets
 * POST   /api/flashcards                       — create a set
 * POST   /api/flashcards/generate              — generate flashcards via AI
 * GET    /api/flashcards/:id                   — get a set with due cards
 * GET    /api/flashcards/:id/all               — get all cards in a set
 * POST   /api/flashcards/:id/cards             — manually add a card
 * PATCH  /api/flashcards/cards/:cardId/review  — submit SM-2 review
 * DELETE /api/flashcards/:id                   — delete a set
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { chatComplete, extractJSON } from "../lib/ai.js";
import { retrieveChunks } from "../lib/retriever.js";

const router = Router();

// ── SM-2 algorithm ────────────────────────────────────────────────────────────

interface SM2State {
  easeFactor: number;
  interval: number;
  repetitions: number;
}

function applySpacedRepetition(state: SM2State, quality: number): SM2State & { nextReview: Date } {
  let { easeFactor, interval, repetitions } = state;

  if (quality >= 3) {
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions += 1;
  } else {
    repetitions = 0;
    interval = 1;
  }

  easeFactor = easeFactor + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  easeFactor = Math.max(1.3, easeFactor);

  const nextReview = new Date(Date.now() + interval * 24 * 60 * 60 * 1000);

  return { easeFactor, interval, repetitions, nextReview };
}

// ── AI generation helpers ─────────────────────────────────────────────────────

interface GeneratedCard {
  front: string;
  back: string;
}

async function generateFlashcardsWithAI(
  topic: string,
  subjectName: string | undefined,
  count: number,
  subjectId?: string,
): Promise<GeneratedCard[]> {
  const context = subjectName ? ` in the context of "${subjectName}"` : "";

  // ── RAG: retrieve relevant syllabus + PYQ chunks ──────────────────────────
  let ragContext = "";
  if (subjectId) {
    const chunks = await retrieveChunks(`${topic} ${subjectName ?? ""}`, {
      type: "both",
      subjectId,
      topK: 5,
    });
    if (chunks.length > 0) {
      ragContext = `\n\nUse the following excerpts from the syllabus and past exam papers to inform the flashcards — ground them in real content:\n\n${chunks.map((c, i) => `[Source ${i + 1}]\n${c.text}`).join("\n\n")}\n`;
    }
  }

  const prompt = `Generate ${count} flashcards for the topic "${topic}"${context}.${ragContext}
Return a JSON object with a "cards" array of objects with:
- "front": the question or concept (concise, one sentence)
- "back": the answer or explanation (concise, 1-2 sentences)`;

  const result = await chatComplete([{ role: "user", content: prompt }]);
  if (result) {
    const parsed = extractJSON<{ cards?: GeneratedCard[] } | GeneratedCard[]>(result.content);
    if (parsed) {
      const cards = Array.isArray(parsed) ? parsed : (parsed.cards ?? []);
      if (cards.length > 0) return cards.slice(0, count);
    }
    console.error("[Flashcards] Could not parse AI response as JSON");
  }
  return generatePlaceholderCards(topic, count);
}

function generatePlaceholderCards(topic: string, count: number): GeneratedCard[] {
  const templates: GeneratedCard[] = [
    {
      front: `What is the definition of ${topic}?`,
      back: `${topic} is a fundamental concept that involves structured analysis and systematic problem solving.`,
    },
    {
      front: `What are the key characteristics of ${topic}?`,
      back: `Key characteristics include modularity, abstraction, and systematic organisation.`,
    },
    {
      front: `How is ${topic} applied in practice?`,
      back: `It is applied by breaking down complex problems into smaller manageable sub-problems.`,
    },
    {
      front: `What are common challenges when working with ${topic}?`,
      back: `Common challenges include scalability, maintainability, and managing complexity.`,
    },
    {
      front: `Name an important technique used in ${topic}.`,
      back: `Divide and conquer is a fundamental technique that simplifies complex scenarios.`,
    },
  ];
  return templates.slice(0, Math.min(count, templates.length));
}

// ── GET /api/flashcards ──────────────────────────────────────────────────────

router.get("/", requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sets = await prisma.flashcardSet.findMany({
      where: { userId: req.user!.id },
      include: { _count: { select: { cards: true } } },
      orderBy: { updatedAt: "desc" },
    });

    const dueGroups = await prisma.flashcard.groupBy({
      by: ["setId"],
      where: { setId: { in: sets.map((s) => s.id) }, nextReview: { lte: new Date() } },
      _count: { _all: true },
    });
    const dueBySet = new Map(dueGroups.map((g) => [g.setId, g._count._all]));

    res.json({
      sets: sets.map((s) => ({
        ...s,
        cardCount: s._count.cards,
        dueCount: dueBySet.get(s.id) ?? 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/flashcards ─────────────────────────────────────────────────────

const createSetSchema = z.object({
  title: z.string().min(1),
  subjectId: z.string().optional(),
  topic: z.string().optional(),
});

router.post("/", requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSetSchema.parse(req.body);

    const set = await prisma.flashcardSet.create({
      data: {
        userId: req.user!.id,
        title: body.title,
        subjectId: body.subjectId,
        topic: body.topic,
      },
    });
    res.status(201).json({ set });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/flashcards/generate ────────────────────────────────────────────
// Must be before /:id

const generateSchema = z.object({
  subjectId: z.string().optional(),
  topic: z.string().min(1),
  count: z.number().int().min(1).max(50).default(10),
});

router.post("/generate", requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = generateSchema.parse(req.body);

    let subjectName: string | undefined;
    if (body.subjectId) {
      const subject = await prisma.subject.findUnique({ where: { id: body.subjectId } });
      if (!subject) {
        res.status(404).json({ error: "Subject not found" });
        return;
      }
      subjectName = subject.name;
    }

    const generated = await generateFlashcardsWithAI(body.topic, subjectName, body.count, body.subjectId);

    const title = subjectName ? `${subjectName} — ${body.topic}` : body.topic;

    const set = await prisma.flashcardSet.create({
      data: {
        userId: req.user!.id,
        title,
        subjectId: body.subjectId,
        topic: body.topic,
        cards: {
          create: generated.map((c) => ({
            front: c.front,
            back: c.back,
          })),
        },
      },
      include: { cards: true },
    });

    res.status(201).json({ set });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/flashcards/cards/:cardId/review ───────────────────────────────
// Must be before /:id

const reviewSchema = z.object({
  quality: z.number().int().min(0).max(5),
});

router.patch(
  "/cards/:cardId/review",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { quality } = reviewSchema.parse(req.body);

      const card = await prisma.flashcard.findUnique({
        where: { id: String(req.params["cardId"]) },
        include: { set: { select: { userId: true } } },
      });

      if (!card) {
        res.status(404).json({ error: "Flashcard not found" });
        return;
      }
      if (card.set.userId !== req.user!.id) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      const { easeFactor, interval, repetitions, nextReview } = applySpacedRepetition(
        { easeFactor: card.easeFactor, interval: card.interval, repetitions: card.repetitions },
        quality,
      );

      const updated = await prisma.flashcard.update({
        where: { id: card.id },
        data: { easeFactor, interval, repetitions, nextReview },
      });

      res.json({ card: updated });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/flashcards/:id ──────────────────────────────────────────────────

router.get("/:id", requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const set = await prisma.flashcardSet.findUnique({
      where: { id: String(req.params["id"]) },
      include: {
        cards: {
          where: { nextReview: { lte: new Date() } },
          orderBy: { nextReview: "asc" },
        },
      },
    });

    if (!set) {
      res.status(404).json({ error: "Flashcard set not found" });
      return;
    }
    if (set.userId !== req.user!.id) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    res.json({ set });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/flashcards/:id/all ──────────────────────────────────────────────

router.get("/:id/all", requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const set = await prisma.flashcardSet.findUnique({
      where: { id: String(req.params["id"]) },
      include: { cards: { orderBy: { createdAt: "asc" } } },
    });

    if (!set) {
      res.status(404).json({ error: "Flashcard set not found" });
      return;
    }
    if (set.userId !== req.user!.id) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    res.json({ set });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/flashcards/:id/cards ───────────────────────────────────────────

const addCardSchema = z.object({
  front: z.string().min(1),
  back: z.string().min(1),
});

router.post(
  "/:id/cards",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = addCardSchema.parse(req.body);

      const set = await prisma.flashcardSet.findUnique({ where: { id: String(req.params["id"]) } });
      if (!set) {
        res.status(404).json({ error: "Flashcard set not found" });
        return;
      }
      if (set.userId !== req.user!.id) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      const card = await prisma.flashcard.create({
        data: { setId: set.id, front: body.front, back: body.back },
      });

      res.status(201).json({ card });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/flashcards/:id ───────────────────────────────────────────────

router.delete("/:id", requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const set = await prisma.flashcardSet.findUnique({ where: { id: String(req.params["id"]) } });
    if (!set) {
      res.status(404).json({ error: "Flashcard set not found" });
      return;
    }
    if (set.userId !== req.user!.id) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    await prisma.flashcardSet.delete({ where: { id: String(req.params["id"]) } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
