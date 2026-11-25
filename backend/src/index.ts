import "./lib/env.js"; // validate env first — exits if invalid
import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { env } from "./lib/env.js";
import { allowedOrigins } from "./lib/cors.js";
import { prisma } from "./lib/prisma.js";
import { errorHandler } from "./middleware/errorHandler.js";
import authRouter from "./routes/auth.js";
import branchesRouter from "./routes/branches.js";
import subjectsRouter from "./routes/subjects.js";
import resourcesRouter from "./routes/resources.js";
import botRouter from "./routes/bot.js";
import studyPlansRouter from "./routes/studyPlans.js";
import studyGroupsRouter from "./routes/studyGroups.js";
import syllabusRouter from "./routes/syllabus.js";
import dashboardRouter from "./routes/dashboard.js";
import mcqRouter from "./routes/mcq.js";
import flashcardsRouter from "./routes/flashcards.js";
import profileRouter from "./routes/profile.js";
import questionsRouter from "./routes/questions.js";
import agentRouter from "./routes/agent.js";
import textbooksRouter from "./routes/textbooks.js";
import { startTextbookWorker, stopTextbookWorker } from "./lib/textbookIngestion.js";

// ── Safety net ───────────────────────────────────────────────────────────────
// LangGraph / Gemini can emit stream-parse errors as unhandled rejections that
// bypass the agent's try/catch. Log and continue rather than crashing.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // Only swallow errors that originate from known AI-stream internals.
  if (/GoogleGenerativeAI|Failed to parse stream|pregelTask/i.test(msg)) {
    console.error("[Process] Swallowed AI stream rejection:", msg);
  } else {
    // Re-throw anything unrelated so real bugs still surface.
    console.error("[Process] Unhandled rejection:", reason);
  }
});
const app = express();
const origins = allowedOrigins(
  env.FRONTEND_URL,
  env.CORS_ORIGINS,
  env.NODE_ENV === "development",
);

// Behind a reverse proxy (Render, Railway, Fly…) the client IP comes from X-Forwarded-For;
// without this every user shares the proxy's IP and hits the same rate-limit bucket.
if (env.NODE_ENV === "production") app.set("trust proxy", 1);

// ── Security & utility middleware ────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl)
      if (!origin) return callback(null, true);
      const allowed = origins.has(origin);
      if (allowed) return callback(null, true);
      return callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json());

// ── Rate limiting ────────────────────────────────────────────────────────────
// Tighter limit on auth endpoints to slow brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

app.use(globalLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/branches", branchesRouter);
app.use("/api/subjects", subjectsRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/bot", botRouter);
app.use("/api/study-plans", studyPlansRouter);
app.use("/api/groups", studyGroupsRouter);
app.use("/api/syllabus", syllabusRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/mcq", mcqRouter);
app.use("/api/flashcards", flashcardsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/questions", questionsRouter);
app.use("/api/agent", agentRouter);
app.use("/api/textbooks", textbooksRouter);
// Health check — used by Docker healthcheck and load balancers
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── 404 fallthrough ──────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(env.PORT, () => {
  console.log(`🚀  CampusBrain API running on http://localhost:${env.PORT}`);
  console.log(`    ENV: ${env.NODE_ENV}`);
  startTextbookWorker();
});

// Stop accepting new traffic, drain requests, then close database connections.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopTextbookWorker();
  console.log(`[Process] ${signal}: draining connections`);
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  server.close(() => {
    void prisma.$disconnect().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
