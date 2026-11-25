import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z
    .string()
    .regex(/^[1-9]\d*[smhd]$/, "Use a positive duration such as 15m or 7d")
    .default("15m"),
  JWT_REFRESH_EXPIRES_IN: z
    .string()
    .regex(/^[1-9]\d*[smhd]$/, "Use a positive duration such as 15m or 7d")
    .default("7d"),
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),
  BOT_BASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  // ── RAG embeddings ──────────────────────────────────────────────────────────
  // Set a key to enable embeddings. Changing providers requires re-indexing.
  // Gemini gemini-embedding-001 (768 dims)
  GEMINI_API_KEY: z.string().optional(),
  // HuggingFace Inference API — BAAI/bge-base-en-v1.5 (768 dims) → https://huggingface.co/settings/tokens
  HUGGINGFACE_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default(""),
  STUDY_FEATURE_ACCESS: z.enum(["admin", "signed-in"]).default("admin"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "❌  Invalid environment variables:\n",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = parsed.data;
