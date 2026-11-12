// agentTools.ts
/**
 * Agent tools — wraps CampusBrain's existing capabilities as LangChain tools
 * that the LangGraph ReAct agent can call autonomously.
 *
 * Each tool returns a JSON string that the LLM reads to decide its next step.
 * Write tools (generate_mcq, generate_flashcards) create real DB rows for the
 * authenticated user, so the student sees results in their existing dashboards.
 *
 * Design notes:
 *  - Free-tier LLM quotas are token-based, and every agent step re-sends all
 *    previous tool output. So tool results and descriptions are kept small.
 *  - The student's profile is fetched once up front via fetchUserProfile() and
 *    placed in the system prompt, so there is no get_user_profile tool.
 *  - Groq validates tool calls against the schema BEFORE our code runs, so a
 *    model sending 13 topics where max is 3 would fail the whole request. We keep
 *    schemas permissive (limits live in descriptions) and clamp in code.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { prisma } from "./prisma.js";
import { retrieveChunks } from "./retriever.js";
import { chatComplete, extractJSON } from "./ai.js";
import { searchTopicQuestions } from "./pyqSearch.js";
import { analyzeSubject, buildMockPaper, type MockPaper } from "./mockPaper.js";

/** Rich output a tool hands straight to the student's UI (not through the model). */
export type AgentArtifact = { kind: "mock_paper"; paper: MockPaper };

const MAX_TOPICS = 3;
const MAX_MCQ = 15;
const MAX_FLASHCARDS = 20;
const PAPER_CHUNKS = 4; // excerpts returned by search_papers
const PAPER_CHUNK_CHARS = 300;
const QUESTIONS_PER_TOPIC = 4;
const QUESTION_CHARS = 200;
const ANSWER_CONTEXT_CHUNKS = 6; // RAG chunks used to ground model answers
const ANSWER_QUESTION_CHARS = 600; // max question length forwarded to the LLM

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(Math.trunc(Number.isFinite(n) ? n : min), min), max);

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* ------------------------------------------------------------------ */
/* Profile (pre-fetched into the system prompt)                        */
/* ------------------------------------------------------------------ */

/** Returns a compact JSON string describing the student, for the system prompt. */
export async function fetchUserProfile(userId: string): Promise<string> {
  try {
    const [profile, user] = await Promise.all([
      prisma.userProfile.findUnique({
        where: { userId },
        include: {
          branch: { select: { name: true, code: true } },
          subjects: {
            include: {
              subject: { select: { id: true, code: true, name: true, semester: true } },
            },
          },
        },
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);

    if (!profile) {
      return JSON.stringify({
        name: user?.name,
        note: "Profile not set up (no branch or enrolled subjects). Suggest the student visit the Profile page.",
      });
    }

    return JSON.stringify({
      name: user?.name,
      year: profile.year,
      semester: profile.semester,
      branch: profile.branch ? `${profile.branch.name} (${profile.branch.code})` : null,
      subjects: profile.subjects.map((s) => ({
        id: s.subject.id,
        code: s.subject.code,
        name: s.subject.name,
        sem: s.subject.semester,
      })),
    });
  } catch (err) {
    return JSON.stringify({ note: `Profile unavailable: ${errMsg(err)}` });
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/** Build the tool set for a specific user (userId is baked into closures). */
export function buildAgentTools(userId: string, onArtifact?: (artifact: AgentArtifact) => void) {
  // ── search_papers ───────────────────────────────────────────────────────────
  const searchPapers = tool(
    async ({ topic, subjectId }) => {
      try {
        const chunks = await retrieveChunks(topic, {
          type: "both",
          subjectId,
          topK: PAPER_CHUNKS,
        });
        if (chunks.length === 0) {
          return "No relevant papers or syllabus content found. The index may be empty or the topic too specific. Suggest the student upload papers.";
        }
        return JSON.stringify(
          chunks.map((c) => ({
            text: c.text.slice(0, PAPER_CHUNK_CHARS),
            source: c.sourceType,
            sim: Math.round(c.similarity * 100) / 100,
          })),
        );
      } catch (err) {
        return `Search failed: ${errMsg(err)}`;
      }
    },
    {
      name: "search_papers",
      description:
        "Semantic search over past exam papers and syllabus text for a topic. Returns excerpts with similarity scores.",
      schema: z.object({
        topic: z.string().describe("Topic, e.g. 'binary trees'"),
        subjectId: z.string().optional().describe("Restrict to a subject ID"),
      }),
    },
  );

  // ── search_questions ─────────────────────────────────────────────────────────
  // Same ranking + de-duplication as the PYQ Finder page, so answers match what students see there.
  const searchQuestions = tool(
    async ({ topics: rawTopics, subjectId }) => {
      try {
        // Models sometimes exceed limits or send near-duplicates: dedupe and clamp.
        const topics = [...new Set(rawTopics.map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TOPICS);
        if (topics.length === 0) return "No topics provided. Pass at least one topic.";

        const { results } = await searchTopicQuestions(topics, subjectId, QUESTIONS_PER_TOPIC);
        if (results.every((r) => r.groups.length === 0)) {
          return "No past exam questions found for these topics. Papers may not be ingested yet.";
        }
        return JSON.stringify(
          results.map((r) => ({
            topic: r.topic,
            questions: r.groups.map((g) => ({
              q: g.text.slice(0, QUESTION_CHARS),
              marks: g.marks,
              subj: g.appearances[0]?.paper.subjectCode,
              // every paper it appeared in: repeats across years show how likely it is to come again
              askedIn: g.appearances
                .slice(0, 4)
                .map((a) => `${a.paper.year} ${a.paper.examType}${a.label ? ` ${a.label}` : ""}`),
              timesAsked: g.appearances.length,
            })),
          })),
        );
      } catch (err) {
        return `Question search failed: ${errMsg(err)}`;
      }
    },
    {
      name: "search_questions",
      description: `Find actual past exam questions by topic (semantic + keyword), de-duplicated, with the papers/years each appeared in. At most ${MAX_TOPICS} topics per call; prefer a few focused ones.`,
      schema: z.object({
        topics: z.array(z.string()).min(1).describe(`Up to ${MAX_TOPICS} topics`),
        subjectId: z.string().optional().describe("Restrict to a subject ID"),
      }),
    },
  );

  // ── get_common_topics ────────────────────────────────────────────────────────
  const getCommonTopics = tool(
    async ({ subjectId, limit }) => {
      try {
        const a = await analyzeSubject(subjectId);
        if ("error" in a) return a.error;
        if (a.questionsIndexed === 0) {
          return `No past questions are indexed for ${a.subject.name} yet (${a.papers} paper(s) uploaded), so topic frequency can't be computed.`;
        }
        const n = clamp(limit ?? 8, 1, 15);
        const asked = a.stats.filter((s) => s.timesAsked > 0);
        return JSON.stringify({
          subject: `${a.subject.code} ${a.subject.name}`,
          basis: `${a.questionsIndexed} questions from ${a.papers} papers, matched to syllabus topics`,
          topics: asked.slice(0, n).map((s) => ({
            topic: s.topic,
            unit: s.unit,
            timesAsked: s.timesAsked,
            years: s.years.slice(0, 6),
            marks: s.totalMarks || null,
          })),
          neverAsked: a.stats
            .filter((s) => s.timesAsked === 0)
            .slice(0, 5)
            .map((s) => s.topic),
        });
      } catch (err) {
        return `Topic analysis failed: ${errMsg(err)}`;
      }
    },
    {
      name: "get_common_topics",
      description:
        "Rank a subject's syllabus topics by how often past papers ask about them (with years and marks). Use for 'most common / important / repeated topics' questions.",
      schema: z.object({
        subjectId: z.string().describe("Subject ID"),
        limit: z.number().optional().describe("How many topics to return (default 8, max 15)"),
      }),
    },
  );

  // ── build_mock_paper ──────────────────────────────────────────────────────────────────────
  const buildMockPaperTool = tool(
    async ({ subjectId, totalMarks, mode, topics }) => {
      try {
        const built = await buildMockPaper({
          subjectId,
          totalMarks,
          mode: mode === "existing" || mode === "variants" ? mode : "mixed",
          topics: topics?.slice(0, 10),
        });
        if ("error" in built) return built.error;

        // The full paper goes straight to the student's screen (with a PDF button); the model only needs a summary.
        onArtifact?.({ kind: "mock_paper", paper: built.paper });
        return JSON.stringify({
          message: `Built "${built.paper.title}" (${built.paper.totalMarks} marks, ${built.paper.durationMinutes} min). The student can preview it and download it as a PDF right below this chat message.`,
          questions: built.paper.sections.reduce((n, s) => n + s.questions.length, 0),
          fromPastPapers: built.counts.pyq,
          variants: built.counts.variant,
          newQuestions: built.counts.new,
          coverage: built.paper.coverage,
          warnings: built.warnings,
        });
      } catch (err) {
        return `Failed to build the mock paper: ${errMsg(err)}`;
      }
    },
    {
      name: "build_mock_paper",
      description:
        "Build an exam-style mock paper (sections A/B/C) covering the syllabus, weighted by unit hours and how often past papers ask each topic. Uses real past questions, AI variants of them, or both. The student gets a preview and a PDF download button; do NOT paste the paper into chat.",
      schema: z.object({
        subjectId: z.string().describe("Subject ID"),
        totalMarks: z.number().optional().describe("Total marks (default 50, 10-100)"),
        mode: z
          .string()
          .optional()
          .describe("'existing' = only real past questions, 'variants' = rewritten variants, 'mixed' (default) = both"),
        topics: z
          .array(z.string())
          .optional()
          .describe("Optional: only cover these topics or units (max 10)"),
      }),
    },
  );

  // ── get_syllabus ─────────────────────────────────────────────────────────────
  const getSyllabus = tool(
    async ({ subjectId }) => {
      try {
        const items = await prisma.syllabusItem.findMany({
          where: { subjectId },
          orderBy: { unitNumber: "asc" },
          select: { unitNumber: true, title: true, topics: true, hours: true },
        });
        if (items.length === 0) {
          return "No syllabus found for this subject. A teacher may need to add one.";
        }
        return JSON.stringify(items);
      } catch (err) {
        return `Error fetching syllabus: ${errMsg(err)}`;
      }
    },
    {
      name: "get_syllabus",
      description: "Get a subject's syllabus units and topics.",
      schema: z.object({
        subjectId: z.string().describe("Subject ID"),
      }),
    },
  );

  // ── get_mcq_history ──────────────────────────────────────────────────────────
  const getMcqHistory = tool(
    async () => {
      try {
        const sessions = await prisma.mCQSession.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            topic: true,
            score: true,
            totalQ: true,
            correctQ: true,
            createdAt: true,
          },
        });
        if (sessions.length === 0) {
          return "No quiz history yet. The student hasn't taken any practice quizzes.";
        }
        return JSON.stringify(
          sessions.map((s) => ({
            topic: s.topic,
            score: s.score,
            correct: s.correctQ,
            total: s.totalQ,
            date: s.createdAt.toISOString().slice(0, 10),
          })),
        );
      } catch (err) {
        return `Error fetching quiz history: ${errMsg(err)}`;
      }
    },
    {
      name: "get_mcq_history",
      description: "Get the student's last 10 quiz results (topic, score) to find weak areas.",
      schema: z.object({}),
    },
  );

  // ── generate_mcq ─────────────────────────────────────────────────────────────
  const generateMcq = tool(
    async ({ topic, subjectId, count }) => {
      try {
        const n = clamp(count ?? 5, 1, MAX_MCQ);

        let subjectName = "General Studies";
        if (subjectId) {
          const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
          if (subject) subjectName = subject.name;
        }

        // RAG: retrieve relevant chunks
        let ragContext = "";
        if (subjectId) {
          const chunks = await retrieveChunks(`${subjectName} ${topic}`, {
            type: "both",
            subjectId,
            topK: 6,
          });
          if (chunks.length > 0) {
            ragContext = `\n\nHere are excerpts from past papers and syllabus:\n\n${chunks.map((c) => c.text).join("\n\n")}\n`;
          }
        }

        const prompt = `Generate ${n} multiple-choice questions about "${subjectName}" focusing on "${topic}".${ragContext}
Return a JSON object: {"questions":[{"question":"","options":["","","",""],"correctIndex":0,"explanation":"","topic":""}]}`;

        const result = await chatComplete([{ role: "user", content: prompt }]);
        if (!result) return "Failed to generate questions — the AI service is unavailable.";

        const parsed = extractJSON<{ questions?: unknown[] } | unknown[]>(result.content);
        if (!parsed) return "Failed to parse the generated questions.";

        const raw = Array.isArray(parsed) ? parsed : (parsed.questions ?? []);
        const questions = raw
          .filter(
            (q): q is { question: string; options: string[]; correctIndex: number; explanation?: string; topic?: string } =>
              q !== null &&
              typeof q === "object" &&
              typeof (q as Record<string, unknown>).question === "string" &&
              Array.isArray((q as Record<string, unknown>).options) &&
              ((q as Record<string, unknown>).options as unknown[]).length === 4,
          )
          .map((q) => ({
            question: q.question,
            options: q.options.map(String),
            correctIndex: clamp(Number(q.correctIndex), 0, 3),
            explanation: typeof q.explanation === "string" ? q.explanation : "",
            topic: typeof q.topic === "string" && q.topic ? q.topic : topic,
          }))
          .slice(0, n);

        if (questions.length === 0) return "Failed to generate valid questions.";

        const session = await prisma.mCQSession.create({
          data: {
            userId,
            subjectId: subjectId ?? null,
            topic,
            totalQ: questions.length,
            questions: {
              create: questions.map((q) => ({
                question: q.question,
                options: q.options,
                correctIndex: q.correctIndex,
                explanation: q.explanation,
                topic: q.topic,
              })),
            },
          },
        });

        return JSON.stringify({
          message: `Created a ${questions.length}-question quiz on "${topic}".`,
          sessionId: session.id,
          topic,
          questionCount: questions.length,
          location: "The student can take this quiz in the MCQ section (/mcq).",
        });
      } catch (err) {
        return `Failed to create quiz: ${errMsg(err)}`;
      }
    },
    {
      name: "generate_mcq",
      description: `Create a practice quiz (multiple-choice) on a topic that the student can take. Max ${MAX_MCQ} questions.`,
      schema: z.object({
        topic: z.string().describe("Quiz topic, e.g. 'binary trees'"),
        subjectId: z.string().optional().describe("Subject ID to ground questions in real exam content"),
        count: z.number().optional().describe(`Number of questions (default 5, max ${MAX_MCQ})`),
      }),
    },
  );

  // ── generate_flashcards ──────────────────────────────────────────────────────
  const generateFlashcards = tool(
    async ({ topic, subjectId, count }) => {
      try {
        const n = clamp(count ?? 8, 1, MAX_FLASHCARDS);

        let subjectName: string | undefined;
        if (subjectId) {
          const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
          subjectName = subject?.name;
        }

        let ragContext = "";
        if (subjectId) {
          const chunks = await retrieveChunks(`${topic} ${subjectName ?? ""}`, {
            type: "both",
            subjectId,
            topK: 5,
          });
          if (chunks.length > 0) {
            ragContext = `\n\nUse these excerpts from the syllabus and past papers:\n\n${chunks.map((c) => c.text).join("\n\n")}\n`;
          }
        }

        const prompt = `Generate ${n} flashcards for the topic "${topic}"${subjectName ? ` in the context of "${subjectName}"` : ""}.${ragContext}
Return a JSON object: {"cards":[{"front":"","back":""}]}`;

        const result = await chatComplete([{ role: "user", content: prompt }]);
        if (!result) return "Failed to generate flashcards — the AI service is unavailable.";

        const parsed = extractJSON<{ cards?: unknown[] } | unknown[]>(result.content);
        if (!parsed) return "Failed to parse the generated flashcards.";

        const raw = Array.isArray(parsed) ? parsed : (parsed.cards ?? []);
        const cards = raw
          .filter(
            (c): c is { front: string; back: string } =>
              c !== null &&
              typeof c === "object" &&
              typeof (c as Record<string, unknown>).front === "string" &&
              typeof (c as Record<string, unknown>).back === "string",
          )
          .slice(0, n);

        if (cards.length === 0) return "Failed to generate valid flashcards.";

        const title = subjectName ? `${subjectName} — ${topic}` : topic;
        const set = await prisma.flashcardSet.create({
          data: {
            userId,
            title,
            subjectId: subjectId ?? null,
            topic,
            cards: { create: cards.map((c) => ({ front: c.front, back: c.back })) },
          },
        });

        return JSON.stringify({
          message: `Created a flashcard set "${title}" with ${cards.length} cards.`,
          setId: set.id,
          cardCount: cards.length,
          location: "The student can review these flashcards in the Flashcards section (/flashcards).",
        });
      } catch (err) {
        return `Failed to create flashcards: ${errMsg(err)}`;
      }
    },
    {
      name: "generate_flashcards",
      description: `Create a flashcard set on a topic that the student can review. Max ${MAX_FLASHCARDS} cards.`,
      schema: z.object({
        topic: z.string().describe("Flashcard topic, e.g. 'sorting algorithms'"),
        subjectId: z.string().optional().describe("Subject ID to ground cards in real content"),
        count: z.number().optional().describe(`Number of cards (default 8, max ${MAX_FLASHCARDS})`),
      }),
    },
  );

  // ── list_papers ──────────────────────────────────────────────────────────────
  // Lets the agent (and student) know what papers are available before diving in.
  const listPapers = tool(
    async ({ subjectId }) => {
      try {
        const papers = await prisma.resource.findMany({
          where: { subjectId, type: "PAPER" },
          orderBy: [{ year: "desc" }, { examType: "asc" }],
          select: {
            id: true,
            title: true,
            year: true,
            examType: true,
            fileUrl: true,
            _count: { select: { paperQuestions: true } },
          },
        });
        if (papers.length === 0) {
          return "No papers have been uploaded for this subject yet. Suggest the student or a teacher uploads some.";
        }
        return JSON.stringify(
          papers.map((p) => ({
            id: p.id,
            title: p.title,
            year: p.year,
            examType: p.examType,
            questions: p._count.paperQuestions,
            fileUrl: p.fileUrl,
          })),
        );
      } catch (err) {
        return `Failed to list papers: ${errMsg(err)}`;
      }
    },
    {
      name: "list_papers",
      description:
        "List the past exam papers available for a subject (year, exam type, question count, paper ID, and a fileUrl to the PDF). When presenting papers to the student, format each one as a markdown link: [Year ExamType](fileUrl) so they can open the PDF in a new tab.",
      schema: z.object({
        subjectId: z.string().describe("Subject ID"),
      }),
    },
  );

  // ── get_paper_questions ───────────────────────────────────────────────────────
  // Fetches all questions from a specific paper so the agent can present or answer them.
  const getPaperQuestions = tool(
    async ({ paperId }) => {
      try {
        const resource = await prisma.resource.findUnique({
          where: { id: paperId },
          select: {
            title: true,
            year: true,
            examType: true,
            subject: { select: { code: true, name: true } },
            paperQuestions: {
              orderBy: { questionIndex: "asc" },
              select: {
                id: true,
                questionIndex: true,
                label: true,
                marks: true,
                text: true,
              },
            },
          },
        });
        if (!resource) return "Paper not found. Use list_papers to get valid paper IDs.";
        if (resource.paperQuestions.length === 0) {
          return `The paper "${resource.title}" exists but has no extracted questions yet. It may still be processing.`;
        }
        return JSON.stringify({
          paper: `${resource.subject.code} ${resource.subject.name} — ${resource.year} ${resource.examType}`,
          title: resource.title,
          totalQuestions: resource.paperQuestions.length,
          questions: resource.paperQuestions.map((q) => ({
            id: q.id,
            index: q.questionIndex,
            label: q.label ?? null,
            marks: q.marks ?? null,
            text: q.text,
          })),
        });
      } catch (err) {
        return `Failed to fetch paper questions: ${errMsg(err)}`;
      }
    },
    {
      name: "get_paper_questions",
      description:
        "Fetch all extracted questions from a specific past paper by its ID (get IDs from list_papers). Returns the full question text, label, and marks for each question.",
      schema: z.object({
        paperId: z.string().describe("Resource/paper ID from list_papers"),
      }),
    },
  );

  // ── answer_question ───────────────────────────────────────────────────────────
  // Generates a model answer for a given question, grounded in RAG context from
  // the subject's papers and syllabus. The marks guide the expected answer depth.
  const answerQuestion = tool(
    async ({ questionText, marks, subjectId, context: extraContext }) => {
      try {
        const questionSlice = questionText.slice(0, ANSWER_QUESTION_CHARS);

        // Pull relevant content from the RAG store to ground the answer
        let ragContext = "";
        if (subjectId) {
          const chunks = await retrieveChunks(questionSlice, {
            type: "both",
            subjectId,
            topK: ANSWER_CONTEXT_CHUNKS,
          });
          if (chunks.length > 0) {
            ragContext = `\n\nRelevant excerpts from past papers and syllabus (use these to ground your answer):\n\n${chunks.map((c) => c.text).join("\n\n")}\n`;
          }
        }

        // Marks-aware depth hints so the answer length is exam-appropriate
        const depthHint =
          !marks || marks <= 2
            ? "This is a short-answer question (1–2 marks). Give a concise, direct answer of 2–4 sentences."
            : marks <= 5
              ? "This is a medium question (3–5 marks). Give a structured answer with key points, definitions, and a brief example if relevant."
              : "This is a long-answer question (6+ marks). Give a thorough answer with headings or numbered steps, definitions, derivations or examples as needed, and a brief conclusion.";

        const extraHint = extraContext ? `\n\nAdditional context from the student: ${extraContext}` : "";

        const prompt = `You are an expert university exam tutor. Write a model answer for the following exam question.

Question: ${questionSlice}
${marks ? `Marks: ${marks}` : ""}

${depthHint}${extraHint}${ragContext}

Format your answer clearly. Use bullet points or numbered steps where appropriate. Be precise and exam-ready. Do NOT copy-paste the excerpts verbatim — synthesise them into a clean answer.`;

        const result = await chatComplete([{ role: "user", content: prompt }]);
        if (!result) return "Failed to generate an answer — the AI service is unavailable.";

        return JSON.stringify({
          question: questionSlice,
          marks: marks ?? null,
          answer: result.content,
        });
      } catch (err) {
        return `Failed to generate answer: ${errMsg(err)}`;
      }
    },
    {
      name: "answer_question",
      description:
        "Generate a model answer for a specific exam question. Grounded in real past-paper and syllabus content via RAG. Use this when the student asks to answer, solve, or explain a question. Pass the full question text and marks where known.",
      schema: z.object({
        questionText: z.string().describe("Full text of the exam question to answer"),
        marks: z.number().optional().describe("Marks allocated to the question (guides answer depth)"),
        subjectId: z.string().optional().describe("Subject ID to pull relevant RAG context"),
        context: z.string().optional().describe("Any extra context from the student (e.g. topic focus, what they tried)"),
      }),
    },
  );

  return [
    searchPapers,
    searchQuestions,
    getCommonTopics,
    buildMockPaperTool,
    getSyllabus,
    getMcqHistory,
    generateMcq,
    generateFlashcards,
    listPapers,
    getPaperQuestions,
    answerQuestion,
  ];
}