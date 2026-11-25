import assert from "node:assert/strict";
import { createRequire } from "node:module";
const requireBackend = createRequire(
  process.cwd() + "/tests/textbooks.test.ts",
);
import { after, before, test, type TestContext } from "node:test";
import type { Server } from "node:http";
import {
  textbookSubjects,
  textbookUnits,
} from "../../frontend/src/lib/textbookSelection.js";
import type { ApiSubject, ApiSyllabus } from "../../frontend/src/lib/api.js";
import express from "express";
import {
  chunkTextbookPage,
  rankTextbookEvidence,
  validateNoteSection,
  noteIsStale,
  sourceSnapshot,
  noteRequestSchema,
  type TextbookEvidence,
} from "../src/lib/textbookNotes.js";

const evidence: TextbookEvidence = {
  id: "chunk1",
  materialId: "book1",
  title: "Trees textbook",
  fileUrl: "https://example.com/book.pdf",
  pageNumber: 7,
  text: "A binary tree is a tree in which each node has at most two children. Inorder traversal visits the left subtree, the root, then the right subtree.",
  source: "scan",
};

test("textbook subject choices exclude other branches and semesters even with shared names", () => {
  const base: ApiSubject = {
    id: "cs3",
    code: "OS",
    name: "Operating Systems",
    semester: 3,
    branch: "Computer Science",
    branchCode: "CS",
    paperCount: 0,
  };
  const subjects = [
    base,
    { ...base, id: "it3", branch: "Information Technology", branchCode: "IT" },
    { ...base, id: "cs4", semester: 4 },
  ];
  assert.deepEqual(
    textbookSubjects(subjects, "CS", 3).map((subject) => subject.id),
    ["cs3"],
  );
  assert.deepEqual(textbookSubjects(subjects, undefined, 3), []);
  assert.deepEqual(textbookSubjects(subjects, "CS", undefined), []);
});

test("textbook unit choices reject other subjects, unassigned units and mismatched courses", () => {
  const unit = {
    id: "trees",
    subjectId: "data",
    subjectName: "Data Structures",
    unitNumber: 2,
    title: "Trees",
    topics: ["Trees"],
    hours: null,
  };
  const syllabus: ApiSyllabus = {
    id: "syllabus",
    branchId: "cs",
    branchName: "Computer Science",
    branchCode: "CS",
    semester: 3,
    scheme: "2021",
    description: null,
    items: [
      unit,
      { ...unit, id: "other", subjectId: "operating" },
      { ...unit, id: "unassigned", subjectId: null },
    ],
  };
  const syllabi = [
    syllabus,
    {
      ...syllabus,
      id: "it",
      branchId: "it",
      items: [{ ...unit, id: "wrong-branch" }],
    },
    {
      ...syllabus,
      id: "sem4",
      semester: 4,
      items: [{ ...unit, id: "wrong-semester" }],
    },
  ];
  assert.deepEqual(
    textbookUnits(syllabi, "data", "cs", 3).map((item) => item.id),
    ["trees"],
  );
  assert.deepEqual(textbookUnits(syllabi, "missing-subject", "cs", 3), []);
});

test("textbook chunks retain overlapping context without tiny duplicate tails", () => {
  const text = "a".repeat(3200);
  const chunks = chunkTextbookPage(text);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.slice(-200), chunks[1]!.slice(0, 200));
  assert.equal(chunkTextbookPage("\u0000 short").length, 0);
});

test("textbook retrieval ranks relevant passages, drops weak matches and limits duplicate pages", () => {
  const candidates = [
    evidence,
    { ...evidence, id: "chunk2" },
    { ...evidence, id: "chunk3" },
    {
      ...evidence,
      id: "other",
      pageNumber: 8,
      text: "The mitochondrial membrane supports cellular respiration.",
      similarity: 0.2,
    },
    {
      ...evidence,
      id: "semantic",
      pageNumber: 9,
      text: "Each parent has a pair of descendants.",
      similarity: 0.8,
    },
  ];
  const ranked = rankTextbookEvidence("binary tree", candidates);
  assert.deepEqual(
    ranked.map((item) => item.id),
    ["chunk1", "chunk2", "semantic"],
  );
});

test("note citations derive titles, PDF URLs and page numbers from trusted evidence", () => {
  const result = validateNoteSection(
    "Binary trees",
    {
      status: "covered",
      blocks: [
        {
          text: "Each node can have up to two children.",
          citations: [
            { chunkId: "chunk1", quote: "each node has at most two children" },
          ],
        },
      ],
    },
    [evidence],
  );
  assert.equal(result.blocks[0]!.citations[0]!.pageNumber, 7);
  assert.equal(result.blocks[0]!.citations[0]!.fileUrl, evidence.fileUrl);
  assert.equal(result.blocks[0]!.citations[0]!.source, "scan");
});

test("notes reject invented sources, altered quotes and uncited explanations", () => {
  for (const citations of [
    [{ chunkId: "foreign", quote: evidence.text }],
    [
      {
        chunkId: "chunk1",
        quote: "Binary trees always have exactly three children.",
      },
    ],
    [],
  ]) {
    assert.throws(() =>
      validateNoteSection(
        "Trees",
        { status: "covered", blocks: [{ text: "An explanation", citations }] },
        [evidence],
      ),
    );
  }
  assert.throws(() =>
    validateNoteSection("Trees", { status: "covered", blocks: [] }, [evidence]),
  );
  assert.throws(() =>
    validateNoteSection(
      "Trees",
      {
        status: "insufficient",
        blocks: [
          {
            text: "Unsupported",
            citations: [{ chunkId: "chunk1", quote: evidence.text }],
          },
        ],
      },
      [evidence],
    ),
  );
  assert.deepEqual(
    validateNoteSection("Trees", { status: "insufficient", blocks: [] }, []),
    { topic: "Trees", status: "insufficient", blocks: [] },
  );
});

test("notes become stale after source deletion, reprocessing or syllabus changes", () => {
  const updatedAt = new Date("2026-11-25T00:00:00Z");
  const unit = { updatedAt };
  const materials = [{ id: "book1", updatedAt, status: "READY" }];
  const snapshot = sourceSnapshot(unit, materials);
  assert.equal(noteIsStale(snapshot, unit, materials), false);
  assert.equal(noteIsStale(snapshot, unit, []), true);
  assert.equal(
    noteIsStale(snapshot, unit, [{ ...materials[0]!, status: "PROCESSING" }]),
    true,
  );
  assert.equal(
    noteIsStale(
      snapshot,
      { updatedAt: new Date(updatedAt.getTime() + 1) },
      materials,
    ),
    true,
  );
  assert.equal(noteIsStale({}, unit, materials), true);
});

test("note generation bounds topics and source counts and deduplicates selections", () => {
  assert.equal(
    noteRequestSchema.safeParse({
      topics: Array(9).fill("Trees"),
      materialIds: ["book"],
    }).success,
    false,
  );
  assert.equal(
    noteRequestSchema.safeParse({ topics: ["Trees"], materialIds: [] }).success,
    false,
  );
  assert.deepEqual(
    noteRequestSchema.parse({
      topics: ["Trees", "Trees"],
      materialIds: ["book", "book"],
    }),
    { topics: ["Trees"], materialIds: ["book"] },
  );
});

let server: Server;
let base: string;
let prisma: typeof import("../src/lib/prisma.js").prisma;
let signAccessToken: typeof import("../src/lib/jwt.js").signAccessToken;
before(async () => {
  Object.assign(process.env, {
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
  prisma = (await import("../src/lib/prisma.js")).prisma;
  signAccessToken = (await import("../src/lib/jwt.js")).signAccessToken;
  const app = express();
  app.use(express.json());
  app.use("/textbooks", (await import("../src/routes/textbooks.js")).default);
  app.use((await import("../src/middleware/errorHandler.js")).errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  server.keepAliveTimeout = 60000;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/textbooks`;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma?.$disconnect();
});
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
function access(
  role: "STUDENT" | "TEACHER" | "ADMIN" = "STUDENT",
  id = "student",
) {
  return signAccessToken({ sub: id, email: `${id}@example.com`, role });
}
function request(
  route: string,
  method = "GET",
  body?: unknown,
  token = access(),
) {
  return fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("textbook routes require sign-in and students cannot upload, delete or retry PDFs", async () => {
  assert.equal((await fetch(`${base}/units/unit`)).status, 401);
  for (const [route, method] of [
    ["/units/unit/materials", "POST"],
    ["/materials/book", "DELETE"],
    ["/materials/book/retry", "POST"],
  ])
    assert.equal((await request(route!, method)).status, 403);
});

test("teachers cannot delete or retry someone else's textbook PDF", async (context) => {
  stub(context, prisma.textbookMaterial, "findUnique", async () => ({
    id: "book",
    uploadedById: "other",
    status: "READY",
  }));
  const token = access("TEACHER", "teacher");
  assert.equal(
    (await request("/materials/book", "DELETE", undefined, token)).status,
    403,
  );
  assert.equal(
    (await request("/materials/book/retry", "POST", {}, token)).status,
    403,
  );
});

test("textbook uploads reject disguised PDFs before contacting storage", async () => {
  const body = new FormData();
  body.set("title", "Unit chapter");
  body.set(
    "file",
    new Blob(["<html>not a PDF</html>"], { type: "application/pdf" }),
    "chapter.pdf",
  );
  const response = await fetch(`${base}/units/unit/materials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access("TEACHER", "upload-teacher")}` },
    body,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Upload a PDF/);
});

test("admin deletion cannot race an active textbook processor", async (context) => {
  stub(context, prisma.textbookMaterial, "findUnique", async () => ({
    id: "book",
    uploadedById: "teacher",
    status: "PROCESSING",
  }));
  stub(
    context,
    prisma.textbookMaterial,
    "updateMany",
    async (args: { where: { status: unknown } }) => {
      assert.deepEqual(args.where.status, {
        notIn: ["PROCESSING", "DELETING"],
      });
      return { count: 0 };
    },
  );
  const response = await request(
    "/materials/book",
    "DELETE",
    undefined,
    access("ADMIN", "admin"),
  );
  assert.equal(response.status, 409);
});

test("textbook generation rejects topics outside the unit and sources from another unit", async (context) => {
  stub(context, prisma.syllabusItem, "findUnique", async () => ({
    id: "unit",
    topics: ["Trees"],
    updatedAt: new Date(),
  }));
  let response = await request("/units/unit/notes", "POST", {
    topics: ["Graphs"],
    materialIds: ["foreign"],
  });
  assert.equal(response.status, 400);
  stub(
    context,
    prisma.textbookMaterial,
    "findMany",
    async (args: { where: { unitId: string; status: string } }) => {
      assert.equal(args.where.unitId, "unit");
      assert.equal(args.where.status, "READY");
      return [];
    },
  );
  response = await request("/units/unit/notes", "POST", {
    topics: ["Trees"],
    materialIds: ["foreign"],
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /belong to this unit/);
});

test("missing textbook evidence produces saved coverage gaps without invented notes", async (context) => {
  const updatedAt = new Date();
  stub(context, prisma.syllabusItem, "findUnique", async () => ({
    id: "unit",
    title: "Trees",
    unitNumber: 1,
    topics: ["Trees"],
    updatedAt,
  }));
  stub(context, prisma.textbookMaterial, "findMany", async () => [
    { id: "book1", unitId: "unit", status: "READY", updatedAt },
  ]);
  stub(context, prisma, "$queryRaw", async (query: { values: unknown[] }) => {
    assert.ok(query.values.includes("unit"));
    assert.ok(query.values.includes("book1"));
    return [];
  });
  stub(
    context,
    prisma,
    "$transaction",
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  stub(
    context,
    prisma.unitNote,
    "create",
    async (args: { data: { userId: string; content: unknown } }) => {
      assert.equal(args.data.userId, "student");
      assert.deepEqual(args.data.content, {
        sections: [{ topic: "Trees", status: "insufficient", blocks: [] }],
      });
      return { id: "note", ...args.data };
    },
  );
  const response = await request("/units/unit/notes", "POST", {
    topics: ["Trees"],
    materialIds: ["book1"],
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).note.stale, false);
});

test("saved notes reads and deletes are scoped to the signed-in account", async (context) => {
  stub(context, prisma.syllabusItem, "findUnique", async () => ({
    id: "unit",
    updatedAt: new Date(),
    subject: null,
  }));
  stub(context, prisma.textbookMaterial, "findMany", async () => []);
  stub(
    context,
    prisma.unitNote,
    "findMany",
    async (args: { where: { userId: string; unitId: string } }) => {
      assert.deepEqual(args.where, { userId: "student", unitId: "unit" });
      return [];
    },
  );
  assert.equal((await request("/units/unit")).status, 200);
  stub(
    context,
    prisma.unitNote,
    "deleteMany",
    async (args: { where: unknown }) => {
      assert.deepEqual(args.where, { id: "foreign", userId: "student" });
      return { count: 0 };
    },
  );
  assert.equal((await request("/notes/foreign", "DELETE")).status, 404);
});

test("notes are not saved if a source changes during generation", async (context) => {
  const updatedAt = new Date();
  stub(context, prisma.syllabusItem, "findUnique", async () => ({
    id: "unit",
    topics: ["Trees"],
    updatedAt,
  }));
  let reads = 0;
  stub(context, prisma.textbookMaterial, "findMany", async () => [
    { id: "book", updatedAt, status: reads++ ? "PROCESSING" : "READY" },
  ]);
  stub(context, prisma, "$queryRaw", async () => []);
  stub(
    context,
    prisma,
    "$transaction",
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  stub(context, prisma.unitNote, "create", () => {
    assert.fail("Stale notes must not be saved");
  });
  const response = await request("/units/unit/notes", "POST", {
    topics: ["Trees"],
    materialIds: ["book"],
  });
  assert.equal(response.status, 409);
});

test("note generation validates provider citations before accepting a positive result", async () => {
  const { generateTextbookSection } =
    await import("../src/lib/textbookRetrieval.js");
  const result = await generateTextbookSection(
    "Trees",
    [evidence],
    async (messages) => {
      assert.ok(messages[1]!.content.includes("chunk1"));
      return {
        content: JSON.stringify({
          status: "covered",
          blocks: [
            {
              text: "A node can have two children.",
              citations: [
                {
                  chunkId: "chunk1",
                  quote: "each node has at most two children",
                },
              ],
            },
          ],
        }),
      };
    },
  );
  assert.equal(result.status, "covered");
  assert.equal(result.blocks[0]!.citations[0]!.pageNumber, 7);
  await assert.rejects(
    generateTextbookSection("Trees", [evidence], async () => null),
    /unavailable/,
  );
  await assert.rejects(
    generateTextbookSection("Trees", [evidence], async () => ({
      content: JSON.stringify({
        status: "covered",
        blocks: [
          {
            text: "Unsupported",
            citations: [{ chunkId: "invented", quote: evidence.text }],
          },
        ],
      }),
    })),
    /source validation/,
  );
});

test("PDF page limit is checked before textbook processing", async (context) => {
  const { PDFParse } = requireBackend(
    "pdf-parse",
  ) as typeof import("pdf-parse");
  const { textbookPageCount } = await import("../src/lib/textbookIngestion.js");
  stub(context, PDFParse.prototype, "getInfo", async () => ({ total: 61 }));
  await assert.rejects(
    textbookPageCount(Buffer.from("%PDF-1.4")),
    /1–60 pages/,
  );
});

test("mixed scanned/text PDFs retain PDF page numbers and flag unreadable pages", async (context) => {
  const { PDFParse } = requireBackend(
    "pdf-parse",
  ) as typeof import("pdf-parse");
  const { createCanvas } = await import("@napi-rs/canvas");
  const { processNextTextbook } =
    await import("../src/lib/textbookIngestion.js");
  stub(context, PDFParse.prototype, "getInfo", async () => ({ total: 3 }));
  stub(context, PDFParse.prototype, "getText", async () => ({
    total: 3,
    pages: [
      { num: 1, text: "" },
      { num: 2, text: evidence.text },
      { num: 3, text: "" },
    ],
  }));
  const png = createCanvas(100, 100).toBuffer("image/png");
  stub(context, PDFParse.prototype, "getScreenshot", async () => ({
    pages: [{ data: png }],
  }));
  let visionCalls = 0;
  stub(
    context,
    globalThis,
    "fetch",
    async () => new Response(Buffer.from("%PDF-1.4")),
  );
  stub(context, prisma.textbookMaterial, "findFirst", async () => ({
    id: "book",
    fileUrl: "https://example.com/book.pdf",
  }));
  const writes: { where: unknown; data: Record<string, unknown> }[] = [];
  stub(
    context,
    prisma.textbookMaterial,
    "updateMany",
    async (args: { where: unknown; data: Record<string, unknown> }) => {
      writes.push(args);
      return { count: 1 };
    },
  );
  stub(context, prisma.textbookChunk, "deleteMany", async () => ({ count: 0 }));
  stub(
    context,
    prisma,
    "$transaction",
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  const inserts: { values: unknown[] }[] = [];
  stub(
    context,
    prisma,
    "$executeRaw",
    async (_strings: unknown, query: { values: unknown[] }) => {
      inserts.push(query);
      return 2;
    },
  );
  assert.equal(
    await processNextTextbook({
      embed: async () => null,
      vision: async (prompt, images) => {
        assert.match(prompt, /Transcribe this textbook/);
        assert.equal(images.length, 1);
        visionCalls++;
        return {
          content: JSON.stringify(
            visionCalls === 1
              ? { readable: true, text: evidence.text }
              : { readable: false, text: "" },
          ),
        };
      },
    }),
    true,
  );
  assert.equal(visionCalls, 2);
  const ready = writes.find((write) => write.data.status === "READY");
  assert.ok(ready);
  assert.deepEqual(ready.data.unreadablePages, [3]);
  assert.ok(inserts[0]!.values.includes("scan"));
  assert.ok(inserts[0]!.values.includes("text"));
  assert.ok(inserts[0]!.values.includes(1));
  assert.ok(inserts[0]!.values.includes(2));
  assert.equal(inserts[0]!.values.includes(3), false);
});

test("a worker that loses its claim cannot replace a textbook index", async (context) => {
  const { PDFParse } = requireBackend(
    "pdf-parse",
  ) as typeof import("pdf-parse");
  const { processNextTextbook } =
    await import("../src/lib/textbookIngestion.js");
  stub(context, PDFParse.prototype, "getInfo", async () => ({ total: 1 }));
  stub(context, PDFParse.prototype, "getText", async () => ({
    total: 1,
    pages: [{ num: 1, text: evidence.text }],
  }));
  stub(
    context,
    globalThis,
    "fetch",
    async () => new Response(Buffer.from("%PDF-1.4")),
  );
  stub(context, prisma.textbookMaterial, "findFirst", async () => ({
    id: "book",
    fileUrl: "https://example.com/book.pdf",
  }));
  let updates = 0;
  stub(context, prisma.textbookMaterial, "updateMany", async () => ({
    count: updates++ ? 0 : 1,
  }));
  stub(context, prisma, "$transaction", () => {
    assert.fail("A worker without its claim must not write chunks");
  });
  assert.equal(await processNextTextbook(), true);
});
