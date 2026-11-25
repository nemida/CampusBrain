import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { readJsonEventStream } from "../../frontend/src/lib/sse.js";
import { RequestPool } from "../../frontend/src/lib/requestPool.js";
import {
  uploadError,
  MAX_UPLOAD_BYTES,
} from "../../frontend/src/lib/uploads.js";
import { AsyncBatchCache } from "../src/lib/asyncBatchCache.js";
import { subjectPlanProgress } from "../src/lib/planProgress.js";
import {
  parseGeneratedCards,
  parseGeneratedQuestions,
} from "../src/lib/studyGeneration.js";
import { allowedOrigins } from "../src/lib/cors.js";
import { detectUploadType } from "../src/lib/uploadValidation.js";
import {
  buildSmartDays,
  istDayDiff,
  istMidnight,
  matchExamDatesDetailed,
  parseExamDate,
  prioritizeTopics,
} from "../src/lib/planBuilder.js";
import {
  groupDuplicates,
  rankCandidates,
  type Candidate,
} from "../src/lib/questionSearch.js";
import { aggregateGroupWeakTopics } from "../src/lib/topics.js";

test("production CORS trusts explicit origins, not other tenants on the same host", () => {
  const origins = allowedOrigins(
    "https://campus.example/",
    "https://preview.vercel.app",
  );
  assert.ok(origins.has("https://campus.example"));
  assert.ok(origins.has("https://preview.vercel.app"));
  assert.equal(origins.has("https://attacker.vercel.app"), false);
  assert.equal(origins.has("http://localhost:3000"), false);
  assert.ok(
    allowedOrigins("https://campus.example", "", true).has(
      "http://localhost:3000",
    ),
  );
});

test("CORS rejects credentials, paths and non-HTTP schemes", () => {
  for (const origin of [
    "https://user:pass@campus.example",
    "https://campus.example/path",
    "file:///tmp",
    "https://campus.example/?x=1",
  ]) {
    assert.throws(() => allowedOrigins(origin));
  }
});

test("AI streams retain split Unicode, CRLF and the last event without a newline", async () => {
  const bytes = new TextEncoder().encode(
    ': heartbeat\r\ndata: {"type":"token","content":"Study 😀"}\r\n\r\ndata: broken\n\ndata:{"type":"done"}',
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Byte-by-byte chunks deliberately split the emoji's UTF-8 sequence.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const events: unknown[] = [];
  await readJsonEventStream(body, (event) => events.push(event));
  assert.deepEqual(events, [
    { type: "token", content: "Study 😀" },
    { type: "done" },
  ]);
  assert.equal(body.locked, false);
});

test("AI stream consumer failures propagate and release the reader", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  await assert.rejects(
    readJsonEventStream(body, () => {
      throw new Error("render failure");
    }),
    /render failure/,
  );
  assert.equal(body.locked, false);
});

test("uploads identify supported signatures and reject SVG or disguised HTML", () => {
  assert.equal(detectUploadType(Buffer.from("%PDF-1.7\n")), "application/pdf");
  assert.equal(
    detectUploadType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/png",
  );
  assert.equal(
    detectUploadType(Buffer.from([255, 216, 255, 224])),
    "image/jpeg",
  );
  assert.equal(detectUploadType(Buffer.from("RIFF1234WEBP")), "image/webp");
  for (const text of ["<svg></svg>", "<html>fake.pdf</html>", "", "%PDF"])
    assert.equal(detectUploadType(Buffer.from(text)), null);
});

test("calendar boundaries follow IST even before UTC midnight", () => {
  assert.equal(
    istMidnight(new Date("2026-11-14T20:00:00Z")).toISOString(),
    "2026-11-14T18:30:00.000Z",
  );
  assert.equal(
    istDayDiff(
      new Date("2026-11-14T18:29:00Z"),
      new Date("2026-11-14T18:31:00Z"),
    ),
    1,
  );
  assert.equal(parseExamDate("2026-02-31"), null);
  assert.equal(
    parseExamDate("2028-02-29")?.toISOString(),
    "2028-02-28T18:30:00.000Z",
  );
});

test("timetable matching distinguishes theory, lab and numbered courses", () => {
  const subjects = [
    { id: "one", name: "Engineering Mathematics I", code: "BS101" },
    { id: "two", name: "Engineering Mathematics II", code: "BS201" },
    { id: "lab", name: "Physics Lab", code: "BS112" },
  ];
  const result = matchExamDatesDetailed(subjects, [
    { subjectName: "Engineering Maths II", date: "2026-12-01" },
    { subjectName: "Physics", date: "2026-12-02" },
  ]);
  assert.deepEqual([...result.matched.keys()], ["two"]);
  assert.equal(result.unmatched.length, 1);
});

test("plans respect daily time budgets and stop learning at the exam deadline", () => {
  const examDate = parseExamDate("2026-12-04")!;
  const result = buildSmartDays(
    [
      {
        id: "s1",
        name: "Algorithms",
        code: "CS301",
        topics: ["Trees", "Graphs", "Sorting", "Hashing"],
        examDate,
      },
    ],
    parseExamDate("2026-12-01")!,
    6,
    [],
    { hoursPerDay: 2 },
  );
  assert.equal(result.days.length, 6);
  for (const day of result.days) {
    assert.ok(day.totalMinutes <= 120);
    if (istDayDiff(examDate, day.date) >= 0)
      assert.equal(
        day.sessions.some((session) => session.kind === "learn"),
        false,
      );
  }
});

test("topic prioritization promotes strong evidence without scrambling the rest", () => {
  assert.deepEqual(
    prioritizeTopics(["A", "B", "C", "D"], new Map([["D", 8]]), 0.25),
    ["D", "A", "B", "C"],
  );
});

const paper = {
  id: "p1",
  title: "Winter exam",
  year: 2026,
  examType: "End-Sem",
  subjectCode: "CS301",
  subjectName: "Data Structures",
  fileUrl: "https://example.com/paper.pdf",
};
const candidate = (
  id: string,
  text: string,
  similarity: number | null,
): Candidate => ({
  id,
  text,
  similarity,
  paper,
  questionIndex: 1,
  label: "1",
  marks: 5,
  pageNumber: 1,
  source: "text",
});

test("retrieval keeps lexical evidence ahead of semantic guesses and caps guesses", () => {
  const candidates = [
    candidate("real", "Explain AVL tree rotations", 0.4),
    ...Array.from({ length: 8 }, (_, index) =>
      candidate(`guess${index}`, "A different concept", 0.9),
    ),
    candidate("weak", "Unrelated", 0.2),
  ];
  const ranked = rankCandidates("AVL trees", candidates);
  assert.equal(ranked[0]?.id, "real");
  assert.equal(ranked.filter((item) => !item.lexical).length, 3);
  assert.equal(
    ranked.some((item) => item.id === "weak"),
    false,
  );
});

test("duplicate questions preserve appearances in different years", () => {
  const first = candidate("q1", "Explain binary tree traversal", 0.8);
  const second = {
    ...candidate("q2", first.text, 0.8),
    paper: { ...paper, id: "p2", year: 2025 },
  };
  const groups = groupDuplicates(
    rankCandidates("binary tree", [first, second]),
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.appearances.length, 2);
});

test("group analytics give each student equal weight", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => ({
      userId: "active",
      topic: "Trees",
      score: 100,
    })),
    { userId: "quiet", topic: "Trees", score: 0 },
  ];
  const result = aggregateGroupWeakTopics(rows);
  assert.equal(result[0]?.avgScore, 50);
  assert.equal(result[0]?.memberCount, 2);
});

// Route tests use fake secrets, no AI keys, and mocked database methods.
// They never read or modify the developer's database.
let server: Server;
let base: string;
let token: string;
let prisma: typeof import("../src/lib/prisma.js").prisma;
let signRefreshToken: typeof import("../src/lib/jwt.js").signRefreshToken;
before(async () => {
  Object.assign(process.env, {
    STUDY_FEATURE_ACCESS: "signed-in",
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    DIRECT_URL: "postgresql://test:test@127.0.0.1:1/test",
    JWT_ACCESS_SECRET: "test-access-secret-32-characters-long",
    JWT_REFRESH_SECRET: "test-refresh-secret-32-characters-long",
    CLOUDINARY_CLOUD_NAME: "test",
    CLOUDINARY_API_KEY: "test",
    CLOUDINARY_API_SECRET: "test",
    BOT_BASE_URL: "https://example.com",
    GROQ_API_KEY: "",
    GEMINI_API_KEY: "",
    HUGGINGFACE_API_KEY: "",
    OPENAI_API_KEY: "",
  });
  const auth = await import("../src/lib/jwt.js");
  signRefreshToken = auth.signRefreshToken;
  token = auth.signAccessToken({
    sub: "student1",
    email: "student@example.com",
    role: "STUDENT",
  });
  prisma = (await import("../src/lib/prisma.js")).prisma;
  const app = express();
  app.use(express.json());
  app.use("/auth", (await import("../src/routes/auth.js")).default);
  app.use("/mcq", (await import("../src/routes/mcq.js")).default);
  app.use("/flashcards", (await import("../src/routes/flashcards.js")).default);
  app.use("/resources", (await import("../src/routes/resources.js")).default);
  app.use("/bot", (await import("../src/routes/bot.js")).default);
  app.use("/plans", (await import("../src/routes/studyPlans.js")).default);
  app.use("/questions", (await import("../src/routes/questions.js")).default);
  app.use("/profile", (await import("../src/routes/profile.js")).default);
  app.use("/groups", (await import("../src/routes/studyGroups.js")).default);
  app.use("/syllabus", (await import("../src/routes/syllabus.js")).default);
  app.use("/branches", (await import("../src/routes/branches.js")).default);
  app.use("/subjects", (await import("../src/routes/subjects.js")).default);
  app.use((await import("../src/middleware/errorHandler.js")).errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  // The first PDF parser load can take several seconds on CI/Windows. Keep
  // local test sockets alive across it rather than racing the idle timeout.
  server.keepAliveTimeout = 60_000;
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma?.$disconnect();
});
function request(path: string, body?: unknown, access = token) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Prisma delegates are proxies; Node's descriptor-based mock.method cannot
// discover their methods. Replace and restore through the proxy instead.
function stub(
  context: TestContext,
  target: object,
  method: string,
  value: unknown,
) {
  const original = Reflect.get(target, method);
  Reflect.set(target, method, value);
  context.after(() => {
    Reflect.set(target, method, original);
  });
}

test("signed tokens with malformed claims cannot authenticate", async () => {
  const malformed = jwt.sign(
    { sub: "student1" },
    process.env.JWT_ACCESS_SECRET!,
  );
  assert.equal(
    (await request("/mcq/sessions", undefined, malformed)).status,
    401,
  );
});

test("students cannot upload resources", async () => {
  assert.equal((await request("/resources", {})).status, 403);
});

test("upload routes reject disguised files before storage or database access", async () => {
  const auth = await import("../src/lib/jwt.js");
  const teacher = auth.signAccessToken({
    sub: "teacher1",
    email: "teacher@example.com",
    role: "TEACHER",
  });
  const form = new FormData();
  form.set(
    "file",
    new Blob(["<html>fake PDF</html>"], { type: "application/pdf" }),
    "paper.pdf",
  );
  const response = await fetch(`${base}/resources`, {
    method: "POST",
    headers: { Authorization: `Bearer ${teacher}` },
    body: form,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /File content must match/);
});

test("uploads require a branch when a subject code is ambiguous", async (context) => {
  stub(context, prisma.subject, "findMany", async () => [
    { id: "s1" },
    { id: "s2" },
  ]);
  const auth = await import("../src/lib/jwt.js");
  const teacher = auth.signAccessToken({
    sub: "teacher1",
    email: "teacher@example.com",
    role: "TEACHER",
  });
  const form = new FormData();
  form.set(
    "file",
    new Blob(["%PDF-1.7\n"], { type: "application/pdf" }),
    "paper.pdf",
  );
  form.set("subjectCode", "CS101");
  form.set("year", "2025");
  form.set("examType", "End-Sem");
  const response = await fetch(`${base}/resources`, {
    method: "POST",
    headers: { Authorization: `Bearer ${teacher}` },
    body: form,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /multiple branches/);
});

test("study plan dates reject overflow dates and trailing text", async () => {
  for (const startDate of [
    "2026-02-31",
    "2026-12-01garbage",
    "2026-12-01T00:00:00Z",
  ]) {
    assert.equal(
      (await request("/plans/generate", { title: "Exam revision", startDate }))
        .status,
      400,
    );
  }
});

test("an unmatched timetable cannot silently schedule every enrolled subject", async (context) => {
  stub(context, prisma.userProfile, "findUnique", async () => ({
    subjects: [
      {
        subject: {
          id: "maths",
          name: "Mathematics",
          code: "BS101",
          syllabusItems: [],
        },
      },
    ],
  }));
  const response = await request("/plans/generate", {
    title: "Exam revision",
    startDate: "2026-12-01",
    exams: [{ subjectName: "Organic Chemistry", date: "2026-12-10" }],
  });
  assert.equal(response.status, 400);
  assert.match(
    (await response.json()).error,
    /None of the exam entries matched/,
  );
});

test("quiz submission resets old answers and saves choices and score in one transaction", async (context) => {
  const session = {
    id: "quiz",
    userId: "student1",
    totalQ: 2,
    topic: "Trees",
    questions: [
      { id: "q1", correctIndex: 1, explanation: "First" },
      { id: "q2", correctIndex: 2, explanation: "Second" },
    ],
  };
  stub(context, prisma.mCQSession, "findUnique", async () => session);
  const writes: unknown[] = [];
  stub(context, prisma.mCQQuestion, "updateMany", async (args: unknown) => {
    writes.push(args);
    return { count: 2 };
  });
  stub(context, prisma.mCQQuestion, "update", async (args: unknown) => {
    writes.push(args);
    return {};
  });
  stub(context, prisma.mCQSession, "update", async (args: unknown) => {
    writes.push(args);
    return {};
  });
  stub(context, prisma.userActivity, "create", async () => ({}));
  let transactions = 0;
  stub(context, prisma, "$transaction", async (queries: Promise<unknown>[]) => {
    transactions++;
    assert.equal(queries.length, 3);
    return Promise.all(queries);
  });
  const response = await request("/mcq/sessions/quiz/answer", {
    answers: [{ questionId: "q1", chosenIndex: 1 }],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).score, 50);
  assert.equal(transactions, 1);
  assert.deepEqual(writes, [
    { where: { sessionId: "quiz" }, data: { chosenIndex: null } },
    {
      where: { sessionId: "quiz", id: { in: ["q1"] } },
      data: { chosenIndex: 1 },
    },
    { where: { id: "quiz" }, data: { correctQ: 1, score: 50 } },
  ]);
});

test("registration rejects whitespace names and passwords bcrypt would truncate", async () => {
  for (const body of [
    { name: " ", password: "abcdefgh" },
    { name: "Student", password: "😀".repeat(20) },
  ]) {
    assert.equal(
      (
        await request("/auth/register-student", {
          email: "student@example.com",
          ...body,
        })
      ).status,
      400,
    );
  }
});

test("quiz submission rejects duplicate question IDs", async () => {
  assert.equal(
    (
      await request("/mcq/sessions/test/answer", {
        answers: [
          { questionId: "q1", chosenIndex: 0 },
          { questionId: "q1", chosenIndex: 1 },
        ],
      })
    ).status,
    400,
  );
});

test("unattempted quizzes never expose their answer key", async (context) => {
  stub(context, prisma.mCQSession, "findUnique", async () => ({
    id: "quiz",
    userId: "student1",
    questions: [
      {
        id: "q1",
        question: "Q?",
        options: ["A", "B", "C", "D"],
        chosenIndex: null,
        correctIndex: 2,
        explanation: "Secret",
      },
    ],
  }));
  const response = await request("/mcq/sessions/quiz");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal("correctIndex" in body.session.questions[0], false);
  assert.equal("explanation" in body.session.questions[0], false);
});

test("quiz submission rejects questions from another session", async (context) => {
  stub(context, prisma.mCQSession, "findUnique", async () => ({
    id: "quiz",
    userId: "student1",
    questions: [{ id: "q1" }],
  }));
  assert.equal(
    (
      await request("/mcq/sessions/quiz/answer", {
        answers: [{ questionId: "other", chosenIndex: 0 }],
      })
    ).status,
    400,
  );
});

test("AI outages return a clear 503 instead of fabricated study material", async () => {
  assert.equal(
    (await request("/mcq/generate", { topic: "Trees", count: 3 })).status,
    503,
  );
  assert.equal(
    (await request("/flashcards/generate", { topic: "Trees", count: 3 }))
      .status,
    503,
  );
});

test("only one concurrent refresh can consume the same token", async (context) => {
  const refreshToken = signRefreshToken({ sub: "student1", jti: "refresh1" });
  stub(context, prisma.refreshToken, "findUnique", async () => ({
    id: "refresh1",
    userId: "student1",
    token: refreshToken,
    expiresAt: new Date(Date.now() + 60000),
  }));
  stub(context, prisma.user, "findUnique", async () => ({
    id: "student1",
    email: "student@example.com",
    role: "STUDENT",
  }));
  let consumed = false;
  let created = 0;
  stub(
    context,
    prisma,
    "$transaction",
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        refreshToken: {
          deleteMany: async () => {
            if (consumed) return { count: 0 };
            consumed = true;
            return { count: 1 };
          },
          create: async () => {
            created++;
            return {};
          },
        },
      }),
  );
  const responses = await Promise.all([
    request("/auth/refresh", { refreshToken }),
    request("/auth/refresh", { refreshToken }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 401],
  );
  assert.equal(created, 1);
});

test("overlapping embedding batches load each unique input once and preserve order", async () => {
  const cache = new AsyncBatchCache<string>();
  const calls: string[][] = [];
  const load = async (keys: string[]) => {
    calls.push(keys);
    return keys.map((key) => key.toUpperCase());
  };
  const results = await Promise.all([
    cache.getMany(["a", "b", "a"], load),
    cache.getMany(["b", "c"], load),
  ]);
  assert.deepEqual(results, [
    ["A", "B", "A"],
    ["B", "C"],
  ]);
  assert.deepEqual(calls, [["a", "b"], ["c"]]);
  assert.deepEqual(await cache.getMany(["b"], load), ["B"]);
  assert.equal(calls.length, 2);
});

test("failed embedding batches reject all waiters and can be retried", async () => {
  const cache = new AsyncBatchCache<string>();
  const fail = async () => {
    throw new Error("provider unavailable");
  };
  const results = await Promise.allSettled([
    cache.getMany(["topic"], fail),
    cache.getMany(["topic"], fail),
  ]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.deepEqual(await cache.getMany(["topic"], async () => ["recovered"]), [
    "recovered",
  ]);
});

test("embedding cache evicts least recently used entries and expires old ones", async () => {
  const cache = new AsyncBatchCache<string>(2);
  const calls: string[][] = [];
  const load = async (keys: string[]) => {
    calls.push(keys);
    return keys;
  };
  await cache.getMany(["a", "b"], load);
  await cache.getMany(["a"], load);
  await cache.getMany(["c"], load);
  await cache.getMany(["b"], load);
  assert.deepEqual(calls, [["a", "b"], ["c"], ["b"]]);
  const expired = new AsyncBatchCache<string>(2, 0);
  await expired.getMany(["x"], load);
  await expired.getMany(["x"], load);
  assert.deepEqual(calls.slice(-2), [["x"], ["x"]]);
});

test("concurrent API reads share work without caching settled data or crossing scopes", async () => {
  const pool = new RequestPool();
  let calls = 0;
  const load = async () => ++calls;
  assert.deepEqual(
    await Promise.all([
      pool.run("user-a:profile", load),
      pool.run("user-a:profile", load),
      pool.run("user-b:profile", load),
    ]),
    [1, 1, 2],
  );
  assert.equal(await pool.run("user-a:profile", load), 3);
});

test("failed API reads do not poison the request pool", async () => {
  const pool = new RequestPool();
  await assert.rejects(
    pool.run("profile", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(await pool.run("profile", async () => "online"), "online");
});

test("upload preflight matches backend types and rejects oversized or empty files", () => {
  assert.equal(
    uploadError({ type: "application/pdf", size: MAX_UPLOAD_BYTES }),
    null,
  );
  for (const type of ["image/gif", "image/svg+xml", "text/html"])
    assert.match(uploadError({ type, size: 1024 })!, /PDF, PNG, JPEG or WebP/);
  assert.match(uploadError({ type: "image/png", size: 0 })!, /empty/);
  assert.match(
    uploadError({ type: "image/jpeg", size: MAX_UPLOAD_BYTES + 1 })!,
    /25 MB/,
  );
});

test("one shared word does not make a multi-word PYQ topic a trusted match", () => {
  assert.deepEqual(
    rankCandidates("binary trees", [
      candidate("partial", "Explain binary arithmetic", null),
    ]),
    [],
  );
  const ranked = rankCandidates("binary trees", [
    candidate("partial", "Explain binary arithmetic", 0.9),
  ]);
  assert.equal(ranked[0]?.lexical, false);
});

test("PYQ grouping preserves numerical variants and programming-language variants", () => {
  const numerical = [
    candidate("n1", "Calculate the area of a circle with radius 10 units", 0.9),
    candidate("n2", "Calculate the area of a circle with radius 20 units", 0.9),
  ];
  assert.equal(groupDuplicates(rankCandidates("circle", numerical)).length, 2);
  const languages = [
    candidate("c1", "Write a program to sort an array using C++", 0.9),
    candidate("c2", "Write a program to sort an array using C#", 0.9),
  ];
  assert.equal(groupDuplicates(rankCandidates("program", languages)).length, 2);
});

test("repeated candidate rows cannot inflate the number of PYQ appearances", () => {
  const row = rankCandidates("binary tree", [
    candidate("same", "Explain binary tree traversal", 0.9),
  ])[0]!;
  assert.equal(groupDuplicates([row, row])[0]?.appearances.length, 1);
});

test("invalid, zero and non-finite embedding vectors are rejected", async () => {
  const { isValidEmbedding } = await import("../src/lib/embeddings.js");
  assert.equal(isValidEmbedding(Array(768).fill(0)), false);
  assert.equal(isValidEmbedding(Array(768).fill(NaN)), false);
  assert.equal(isValidEmbedding(Array(768).fill(Infinity)), false);
  assert.equal(isValidEmbedding([1, 2]), false);
  assert.equal(isValidEmbedding(Array(768).fill(0.01)), true);
});

test("cached PYQ profiles use one lookup, deduplicate topics and reject corrupt vectors", async (context) => {
  const { resolveTopics } = await import("../src/lib/pyqSearch.js");
  let reads = 0;
  stub(context, prisma.topicProfile, "findMany", async () => {
    reads++;
    return [
      {
        key: "|binary trees",
        description: "Trees",
        aliases: ["tree traversal"],
        embedding: [1, 2],
        model: null,
      },
    ];
  });
  const result = await resolveTopics([
    "[Unit 1] Binary   trees",
    "binary trees",
  ]);
  assert.equal(reads, 1);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0]?.vec, null);
  assert.deepEqual(result.resolved[0]?.aliases, ["tree traversal"]);
  assert.equal(result.semantic, false);
});

test("topic expansion skips network calls when Gemini is not configured", async (context) => {
  const { buildProfiles } = await import("../src/lib/topicProfile.js");
  stub(context, globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  assert.equal((await buildProfiles(["Trees"], "Data Structures")).size, 0);
});

test("lexical PYQ queries include topic words, escape wildcards and bind the subject", async (context) => {
  const { findCandidates } = await import("../src/lib/pyqSearch.js");
  let values: unknown[] = [];
  stub(context, prisma, "$queryRaw", async (query: { values: unknown[] }) => {
    values = query.values;
    return [];
  });
  await findCandidates("binary trees", null, "subject1", ["50%_tree"]);
  const arrays = values.filter(Array.isArray).flat();
  assert.ok(arrays.includes("%binary%"));
  assert.ok(arrays.includes("%tree%"));
  assert.ok(arrays.includes("%50\\%\\_tree%"));
  assert.ok(values.includes("subject1"));
});

test("unknown PYQ subjects fail before profile expansion or embedding", async (context) => {
  stub(context, prisma.subject, "findUnique", async () => null);
  assert.equal(
    (
      await request("/questions/search", {
        topics: ["Trees"],
        subjectId: "missing",
      })
    ).status,
    404,
  );
});

test("profile reads avoid an upsert for an existing profile", async (context) => {
  stub(context, prisma.userProfile, "findUnique", async () => ({
    id: "profile1",
    userId: "student1",
    subjects: [],
  }));
  stub(context, prisma.userProfile, "upsert", async () => {
    throw new Error("Unexpected write");
  });
  const response = await request("/profile");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.id, "profile1");
});

test("empty flashcard libraries do not run a due-count query", async (context) => {
  stub(context, prisma.flashcardSet, "findMany", async () => []);
  stub(context, prisma.flashcard, "groupBy", async () => {
    throw new Error("Unnecessary query");
  });
  assert.deepEqual(await (await request("/flashcards")).json(), { sets: [] });
});

test("flashcard review locks before reading and updating its schedule", async (context) => {
  const calls: string[] = [];
  stub(
    context,
    prisma,
    "$transaction",
    async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRaw: async () => {
          calls.push("lock");
          return [{ id: "card1" }];
        },
        flashcard: {
          findUnique: async () => {
            calls.push("read");
            return {
              id: "card1",
              set: { userId: "student1" },
              easeFactor: 2.5,
              repetitions: 0,
              interval: 0,
            };
          },
          update: async (args: { data: unknown }) => {
            calls.push("update");
            return args.data;
          },
        },
      }),
  );
  const response = await fetch(`${base}/flashcards/cards/card1/review`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ quality: 5 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).card.repetitions, 1);
  assert.deepEqual(calls, ["lock", "read", "update"]);
});

test("full study groups reject new members while holding the group lock", async (context) => {
  const calls: string[] = [];
  stub(
    context,
    prisma,
    "$transaction",
    async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRaw: async () => {
          calls.push("lock");
          return [{ id: "group1" }];
        },
        groupMembership: {
          findUnique: async () => {
            calls.push("membership");
            return null;
          },
          count: async () => {
            calls.push("count");
            return 50;
          },
          create: async () => {
            throw new Error("Group overflow");
          },
        },
      }),
  );
  const response = await request("/groups/join", { inviteCode: "ABC234" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /full/);
  assert.deepEqual(calls, ["lock", "membership", "count"]);
});

test("existing group members get the correct error even when the group is full", async (context) => {
  stub(
    context,
    prisma,
    "$transaction",
    async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRaw: async () => [{ id: "group1" }],
        groupMembership: {
          findUnique: async () => ({ role: "MEMBER" }),
          count: async () => {
            throw new Error("Unnecessary query");
          },
        },
      }),
  );
  const response = await request("/groups/join", { inviteCode: "ABC234" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already/);
});

test("syllabus suggestions query only the requested subject and its units", async (context) => {
  let args:
    { where: unknown; include: { items: { where: unknown } } } | undefined;
  stub(context, prisma.syllabus, "findMany", async (query: typeof args) => {
    args = query;
    return [];
  });
  assert.equal((await request("/syllabus?subjectId=subject1")).status, 200);
  assert.deepEqual(args?.where, { items: { some: { subjectId: "subject1" } } });
  assert.deepEqual(args?.include.items.where, { subjectId: "subject1" });
});

test("admin guarded deletes lock before checking children and never cascade occupied branches", async (context) => {
  const { signAccessToken } = await import("../src/lib/jwt.js");
  const admin = signAccessToken({
    sub: "admin1",
    email: "admin@example.com",
    role: "ADMIN",
  });
  const calls: string[] = [];
  stub(
    context,
    prisma,
    "$transaction",
    async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRaw: async () => {
          calls.push("lock");
          return [{ id: "branch1" }];
        },
        subject: {
          count: async () => {
            calls.push("count");
            return 2;
          },
        },
        branch: {
          delete: async () => {
            throw new Error("Unsafe cascade");
          },
        },
      }),
  );
  const response = await fetch(`${base}/branches/branch1`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(calls, ["lock", "count"]);
});

test("exact PYQ phrases survive and outrank high-similarity alias-only matches", () => {
  const ranked = rankCandidates(
    "binary trees",
    [
      candidate("exact", "Explain binary trees", 0.2),
      candidate("alias", "Discuss traversal", 0.99),
    ],
    { aliases: ["traversal"] },
  );
  assert.equal(ranked[0]?.id, "exact");
});

test("embedding requests share provider calls and return independent vectors", async (context) => {
  const { env } = await import("../src/lib/env.js");
  const { embedTexts } = await import("../src/lib/embeddings.js");
  stub(context, env, "GEMINI_API_KEY", "fake-key-for-tests");
  let calls = 0;
  stub(
    context,
    globalThis,
    "fetch",
    async (_url: unknown, init: { body: string }) => {
      calls++;
      const body = JSON.parse(init.body) as { requests: unknown[] };
      return Response.json({
        embeddings: body.requests.map(() => ({
          values: [1, ...Array(767).fill(0)],
        })),
      });
    },
  );
  const [first, second] = await Promise.all([
    embedTexts(["shared-cache-regression"], "query"),
    embedTexts(["shared-cache-regression"], "query"),
  ]);
  assert.equal(calls, 1);
  first![0]![0] = 999;
  assert.equal(second![0]![0], 1);
  assert.equal(
    (await embedTexts(["shared-cache-regression"], "query"))![0]![0],
    1,
  );
  await embedTexts(["shared-cache-regression"], "document");
  assert.equal(calls, 2); // Query and document tasks must not share vectors.
});

test("concurrent topic expansion shares calls and never assigns another topic's aliases", async (context) => {
  const { env } = await import("../src/lib/env.js");
  const { buildProfiles, keyOf } = await import("../src/lib/topicProfile.js");
  stub(context, env, "GEMINI_API_KEY", "fake-key-for-tests");
  let generationCalls = 0;
  let embeddingCalls = 0;
  stub(
    context,
    globalThis,
    "fetch",
    async (url: string, init: { body: string }) => {
      if (url.includes("generateContent")) {
        generationCalls++;
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      {
                        topic: "Unique graphs",
                        description: "Graph concepts",
                        aliases: ["graph traversal"],
                      },
                    ]),
                  },
                ],
              },
            },
          ],
        });
      }
      embeddingCalls++;
      const body = JSON.parse(init.body) as { requests: unknown[] };
      return Response.json({
        embeddings: body.requests.map(() => ({
          values: [1, ...Array(767).fill(0)],
        })),
      });
    },
  );
  stub(context, prisma.topicProfile, "upsert", async () => ({}));
  stub(context, prisma, "$transaction", async (writes: Promise<unknown>[]) =>
    Promise.all(writes),
  );
  const [profiles] = await Promise.all([
    buildProfiles(["Unique trees", "Unique graphs"], "Test course"),
    buildProfiles(["Unique trees", "Unique graphs"], "Test course"),
  ]);
  assert.equal(generationCalls, 1);
  assert.equal(embeddingCalls, 1);
  assert.deepEqual(
    profiles.get(keyOf("Unique trees", "Test course"))?.aliases,
    [],
  );
  assert.deepEqual(
    profiles.get(keyOf("Unique graphs", "Test course"))?.aliases,
    ["graph traversal"],
  );
});

test("multi-subject dashboard progress credits each subject's completed sessions", () => {
  const progress = subjectPlanProgress([
    {
      subjectId: "maths",
      isCompleted: false,
      sessions: [
        { subjectId: "maths", kind: "learn", done: true },
        { subjectId: "physics", kind: "learn", done: false },
      ],
    },
    {
      subjectId: "maths",
      isCompleted: false,
      sessions: [
        { subjectId: "maths", kind: "learn", done: true },
        { subjectId: "maths", kind: "revision", done: false },
      ],
    },
    { subjectId: "physics", isCompleted: true, sessions: null },
  ]);
  assert.deepEqual(progress.get("maths"), { done: 1, total: 2 });
  assert.deepEqual(progress.get("physics"), { done: 1, total: 2 });
});

test("completed days override session flags and exam-only days are excluded from readiness", () => {
  const progress = subjectPlanProgress([
    {
      subjectId: "s1",
      isCompleted: true,
      sessions: [{ subjectId: "s1", kind: "learn", done: false }],
    },
    {
      subjectId: "s1",
      isCompleted: false,
      sessions: [{ subjectId: "s1", kind: "exam" }],
    },
  ]);
  assert.deepEqual(progress.get("s1"), { done: 1, total: 1 });
});

test("text extraction recognizes non-Latin text without confusing page markers with content", async () => {
  const { hasUsableText, usableTextLength } =
    await import("../src/lib/pdfText.js");
  assert.equal(hasUsableText("अध्ययन".repeat(80)), true);
  assert.equal(usableTextLength("-- 1 of 2 --\n-- 2 of 2 --"), 0);
});

test("PDF ingestion preserves page text for accurate source page links", async () => {
  const { parsePdfBuffer } = await import("../src/lib/pdfText.js");
  const content1 = "BT /F1 12 Tf 50 700 Td (Binary trees and traversal) Tj ET";
  const content2 = "BT /F1 12 Tf 50 700 Td (Graphs and shortest paths) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`,
    `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const result = await parsePdfBuffer(Buffer.from(pdf));
  assert.equal(result.pages.length, 2);
  assert.match(result.pages[0]!, /Binary trees/);
  assert.match(result.pages[1]!, /Graphs/);
});

test("document downloads enforce the size limit even without a Content-Length header", async (context) => {
  const { downloadDocument } = await import("../src/lib/pdfText.js");
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 26; i++) controller.enqueue(chunk);
      controller.close();
    },
  });
  stub(context, globalThis, "fetch", async () => new Response(stream));
  await assert.rejects(
    downloadDocument("https://example.com/test.pdf"),
    /25 MB/,
  );
  assert.equal(stream.locked, false);
});

test("owners cannot leave and delete a group that still has another member", async (context) => {
  stub(
    context,
    prisma,
    "$transaction",
    async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRaw: async () => [{ id: "group1" }],
        groupMembership: {
          findUnique: async () => ({ role: "OWNER" }),
          count: async () => 2,
        },
        studyGroup: {
          delete: async () => {
            throw new Error("Unexpected deletion");
          },
        },
      }),
  );
  const response = await fetch(`${base}/groups/group1/leave`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Transfer ownership/);
});

test("syllabus parsing rejects an out-of-course subject before spending an AI call", async (context) => {
  const { signAccessToken } = await import("../src/lib/jwt.js");
  const teacher = signAccessToken({
    sub: "teacher1",
    email: "teacher@example.com",
    role: "TEACHER",
  });
  stub(context, prisma.syllabus, "findUnique", async () => ({
    id: "syllabus1",
    branchId: "branch1",
    semester: 2,
  }));
  stub(context, prisma.subject, "findMany", async () => [
    { id: "valid", name: "Maths", code: "M1" },
  ]);
  const response = await request(
    "/syllabus/syllabus1/parse",
    { text: "Unit 1: Algebra and calculus", subjectId: "wrong-course" },
    teacher,
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /branch and semester/);
});

test("generated quizzes reject fabricated answer indexes, duplicate options and malformed containers", () => {
  const valid = {
    question: "  What is a tree?  ",
    options: ["A", "B", "C", "D"],
    correctIndex: 2,
  };
  const parsed = parseGeneratedQuestions(
    {
      questions: [
        valid,
        { ...valid, question: "Other", correctIndex: 9 },
        {
          ...valid,
          question: "Duplicate choices",
          options: ["A", "a", "B", "C"],
        },
        valid,
      ],
    },
    "Trees",
    10,
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.correctIndex, 2);
  assert.equal(parsed[0]?.topic, "Trees");
  assert.equal(parsed[0]?.question, "What is a tree?");
  assert.deepEqual(
    parseGeneratedQuestions({ questions: "invalid" }, "Trees", 10),
    [],
  );
});

test("generated flashcards reject blank content and remove duplicate prompts", () => {
  const cards = parseGeneratedCards(
    {
      cards: [
        { front: "  Trees  ", back: "A hierarchy" },
        { front: "trees", back: "Repeated" },
        { front: "", back: "Bad" },
        { front: "Graphs", back: " " },
      ],
    },
    10,
  );
  assert.deepEqual(cards, [{ front: "Trees", back: "A hierarchy" }]);
  assert.deepEqual(parseGeneratedCards({ cards: {} }, 10), []);
});

test("manual syllabus units cannot index a subject from another course", async (context) => {
  const { signAccessToken } = await import("../src/lib/jwt.js");
  const teacher = signAccessToken({
    sub: "teacher1",
    email: "teacher@example.com",
    role: "TEACHER",
  });
  stub(context, prisma.syllabus, "findUnique", async () => ({
    id: "syllabus1",
    branchId: "branch1",
    semester: 2,
  }));
  stub(context, prisma.subject, "findFirst", async () => null);
  stub(context, prisma.syllabusItem, "create", async () => {
    throw new Error("Invalid unit must not be persisted");
  });
  const response = await request(
    "/syllabus/syllabus1/items",
    {
      unitNumber: 1,
      title: "Trees",
      topics: ["Traversal"],
      subjectId: "another-course",
    },
    teacher,
  );
  assert.equal(response.status, 400);
});

test("generic and duplicate cached aliases cannot turn unrelated PYQs into trusted matches", async (context) => {
  const { getCachedProfiles } = await import("../src/lib/topicProfile.js");
  stub(context, prisma.topicProfile, "findMany", async () => [
    {
      key: "|trees",
      topic: "Trees",
      description: "Trees",
      model: null,
      embedding: null,
      aliases: [
        "equation",
        "functions",
        "trees",
        " tree traversal ",
        "Tree Traversal",
      ],
    },
  ]);
  const profiles = await getCachedProfiles(["Trees"]);
  assert.deepEqual(profiles.get("|trees")?.aliases, ["Tree Traversal"]);
});

test("external chatbot base URL is available without a resource lookup", async (context) => {
  stub(context, prisma.resource, "findUnique", async () => {
    throw new Error("Unexpected resource lookup");
  });
  const response = await request("/bot/url");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "https://example.com" });
});

test("paper-chat handoff restores all resource parameters with correct URL encoding", async (context) => {
  const fileUrl =
    "https://files.example.com/exam file.pdf?download=1&version=2";
  stub(context, prisma.resource, "findUnique", async () => ({
    id: "paper1",
    year: 2025,
    fileUrl,
    subject: {
      code: "CS101",
      name: "Data Structures & Algorithms",
      semester: 3,
      branch: { code: "CS", name: "Computer Science" },
    },
  }));
  const response = await request("/bot/url?resourceId=paper1");
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  assert.equal(url.origin, "https://example.com");
  assert.equal(url.searchParams.get("paperId"), "CS101_2025");
  assert.equal(url.searchParams.get("pdfUrl"), fileUrl);
  assert.equal(url.searchParams.get("subject"), "DataStructuresAlgorithms");
  assert.equal(url.searchParams.get("semester"), "3");
  assert.equal(url.searchParams.get("year"), "2025");
  assert.equal(url.searchParams.get("branch"), "CS");
});

test("paper-chat handoff reports a missing resource", async (context) => {
  stub(context, prisma.resource, "findUnique", async () => null);
  assert.equal((await request("/bot/url?resourceId=missing")).status, 404);
});
