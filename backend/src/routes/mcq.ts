/**
 * POST /api/mcq/generate            — generate MCQ questions via OpenAI (or placeholder)
 * POST /api/mcq/sessions/:id/answer — submit answers, compute score
 * GET  /api/mcq/sessions            — list user's past sessions
 * GET  /api/mcq/sessions/:id        — get a session with questions + answers
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { chatComplete, extractJSON } from "../lib/ai.js";
import { retrieveChunks } from "../lib/retriever.js";

const router = Router();

// ── OpenAI integration (optional) ────────────────────────────────────────────

interface MCQGeneratedQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  topic: string;
}

async function generateMCQsWithAI(
  subjectName: string,
  topic: string | undefined,
  count: number,
  subjectId?: string,
): Promise<MCQGeneratedQuestion[]> {
  const topicClause = topic ? ` focusing on the topic "${topic}"` : "";

  // ── RAG: retrieve relevant PYQ + syllabus chunks ──────────────────────────
  let ragContext = "";
  if (subjectId) {
    const query = topic ? `${subjectName} ${topic}` : subjectName;
    const chunks = await retrieveChunks(query, { type: "both", subjectId, topK: 6 });
    if (chunks.length > 0) {
      ragContext = `\n\nHere are excerpts from actual past exam papers and the syllabus for "${subjectName}". Use these as the basis for your questions — mirror the style, difficulty, and terminology:\n\n${chunks.map((c, i) => `[Excerpt ${i + 1}]\n${c.text}`).join("\n\n")}\n`;
    }
  }

  const prompt = `Generate ${count} multiple-choice questions about "${subjectName}"${topicClause}.${ragContext}
Return a JSON object with a "questions" array. Each element must have:
- "question": string
- "options": array of exactly 4 strings
- "correctIndex": number 0-3
- "explanation": string (brief explanation of the correct answer)
- "topic": string (the specific topic of the question)`;

  const result = await chatComplete([{ role: "user", content: prompt }]);
  if (result) {
    const parsed = extractJSON<{ questions?: MCQGeneratedQuestion[] } | MCQGeneratedQuestion[]>(
      result.content,
    );
    if (parsed) {
      const raw = Array.isArray(parsed) ? parsed : (parsed.questions ?? []);
      const questions = raw
        .filter(
          (q) =>
            q &&
            typeof q.question === "string" &&
            Array.isArray(q.options) &&
            q.options.length === 4 &&
            Number.isInteger(q.correctIndex) &&
            q.correctIndex >= 0 &&
            q.correctIndex <= 3,
        )
        .map((q) => ({
          question: q.question,
          options: q.options.map(String),
          correctIndex: q.correctIndex,
          explanation: typeof q.explanation === "string" ? q.explanation : "",
          topic: typeof q.topic === "string" && q.topic ? q.topic : (topic ?? subjectName),
        }));
      if (questions.length > 0) return questions.slice(0, count);
    }
    console.error("[MCQ] Could not parse AI response as JSON");
  }
  return generatePlaceholderMCQs(subjectName, topic, count);
}

function generatePlaceholderMCQs(
  subjectName: string,
  topic: string | undefined,
  count: number,
): MCQGeneratedQuestion[] {
  const label = topic ?? subjectName;
  const templates: MCQGeneratedQuestion[] = [
    {
      question: `What is the primary purpose of ${label}?`,
      options: ["Data storage", "Problem solving", "Network communication", "User interface"],
      correctIndex: 1,
      explanation: `${label} is fundamentally about structured problem solving.`,
      topic: label,
    },
    {
      question: `Which concept is most closely associated with ${label}?`,
      options: ["Abstraction", "Compilation", "Encryption", "Serialisation"],
      correctIndex: 0,
      explanation: "Abstraction is a core principle across most computer science topics.",
      topic: label,
    },
    {
      question: `When studying ${label}, which skill is most important?`,
      options: ["Memorisation", "Analytical thinking", "Speed reading", "Typing speed"],
      correctIndex: 1,
      explanation:
        "Analytical thinking allows you to generalise concepts and solve novel problems.",
      topic: label,
    },
    {
      question: `Which of the following best describes a key challenge in ${label}?`,
      options: [
        "Performance optimisation",
        "Colour theory",
        "Language grammar",
        "Hardware selection",
      ],
      correctIndex: 0,
      explanation: "Performance is a recurring challenge in most areas of computer science.",
      topic: label,
    },
    {
      question: `In ${label}, what does efficiency typically refer to?`,
      options: [
        "Using minimal resources to achieve a goal",
        "Writing the most lines of code",
        "Maximising file size",
        "Reducing code readability",
      ],
      correctIndex: 0,
      explanation:
        "Efficiency in computing means achieving the goal with the least resource usage.",
      topic: label,
    },
  ];
  return templates.slice(0, Math.min(count, templates.length));
}

// ── POST /api/mcq/generate ───────────────────────────────────────────────────

const generateSchema = z.object({
  subjectId: z.string().optional(),
  topic: z.string().optional(),
  count: z.number().int().min(1).max(30).default(10),
});

router.post("/generate", requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = generateSchema.parse(req.body);
    const userId = req.user!.id;

    let subjectName = "General Studies";
    if (body.subjectId) {
      const subject = await prisma.subject.findUnique({ where: { id: body.subjectId } });
      if (!subject) {
        res.status(404).json({ error: "Subject not found" });
        return;
      }
      subjectName = subject.name;
    }

    const generated = await generateMCQsWithAI(subjectName, body.topic, body.count, body.subjectId);

    // Persist session + questions
    const session = await prisma.mCQSession.create({
      data: {
        userId,
        subjectId: body.subjectId,
        // Fall back to the subject name so weak-topic analytics still group sensibly
        topic: body.topic?.trim() || (body.subjectId ? subjectName : undefined),
        totalQ: generated.length,
        questions: {
          create: generated.map((q) => ({
            question: q.question,
            options: q.options,
            correctIndex: q.correctIndex,
            explanation: q.explanation,
            topic: q.topic,
          })),
        },
      },
      include: { questions: true },
    });

    // Return questions WITHOUT correctIndex
    const safeQuestions = session.questions.map(({ id, question, options, topic }) => ({
      id,
      question,
      options,
      topic,
    }));

    res.status(201).json({ sessionId: session.id, questions: safeQuestions });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mcq/sessions/:id/answer ───────────────────────────────────────

const submitAnswersSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string(),
      chosenIndex: z.number().int().min(0).max(3),
    }),
  ),
});

router.post(
  "/sessions/:id/answer",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = submitAnswersSchema.parse(req.body);
      const sessionId = String(req.params["id"]);

      const session = await prisma.mCQSession.findUnique({
        where: { id: sessionId },
        include: { questions: true },
      });

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.userId !== req.user!.id) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      let correctCount = 0;
      const answeredIds = new Set<string>();
      const results: {
        questionId: string;
        correct: boolean;
        correctIndex: number;
        explanation: string | null;
      }[] = [];

      for (const answer of body.answers) {
        const question = session.questions.find((q) => q.id === answer.questionId);
        if (!question || answeredIds.has(question.id)) continue;
        answeredIds.add(question.id);

        const correct = question.correctIndex === answer.chosenIndex;
        if (correct) correctCount++;

        await prisma.mCQQuestion.update({
          where: { id: question.id },
          data: { chosenIndex: answer.chosenIndex },
        });

        results.push({
          questionId: question.id,
          correct,
          correctIndex: question.correctIndex,
          explanation: question.explanation,
        });
      }

      // Unanswered questions are reported too, so the client can show the full breakdown
      for (const q of session.questions) {
        if (answeredIds.has(q.id)) continue;
        results.push({
          questionId: q.id,
          correct: false,
          correctIndex: q.correctIndex,
          explanation: q.explanation,
        });
      }

      const score = session.totalQ > 0 ? (correctCount / session.totalQ) * 100 : 0;

      await prisma.mCQSession.update({
        where: { id: sessionId },
        data: { correctQ: correctCount, score },
      });

      prisma.userActivity
        .create({
          data: {
            userId: req.user!.id,
            activityType: "QUIZ_ATTEMPT",
            metadata: { score, topic: session.topic },
          },
        })
        .catch((e) => console.error("activity write failed", e));

      res.json({
        score: Math.round(score * 10) / 10,
        correctQ: correctCount,
        totalQ: session.totalQ,
        results,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/mcq/sessions ────────────────────────────────────────────────────

router.get("/sessions", requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Fetch answered-question IDs so we can tell attempted (answeredCount > 0)
    // from unattempted quizzes (e.g. ones the AI agent created for the student).
    const sessions = await prisma.mCQSession.findMany({
      where: { userId: req.user!.id },
      include: {
        questions: {
          where: { chosenIndex: { not: null } },
          select: { id: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      sessions: sessions.map(({ questions: answered, ...session }) => ({
        ...session,
        answeredCount: answered.length,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/mcq/sessions/:id ────────────────────────────────────────────────

router.get(
  "/sessions/:id",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.mCQSession.findUnique({
        where: { id: String(req.params["id"]) },
        include: { questions: true },
      });

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.userId !== req.user!.id) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      res.json({ session });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/mcq/sessions/:id ────────────────────────────────────────────

router.delete(
  "/sessions/:id",
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.mCQSession.findUnique({
        where: { id: String(req.params["id"]) },
        select: { userId: true },
      });
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (session.userId !== req.user!.id) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      // Questions cascade-delete via the schema's onDelete: Cascade
      await prisma.mCQSession.delete({ where: { id: String(req.params["id"]) } });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
