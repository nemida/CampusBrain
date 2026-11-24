/**
 * Embedding helper.
 *
 * ONE provider is used per deployment (Gemini if GEMINI_API_KEY is set, otherwise
 * Hugging Face). There is deliberately NO per-call fallback between providers:
 * vectors from different models are not comparable, so mixing them in one column
 * silently corrupts search results.
 *
 *  - Gemini: `gemini-embedding-001` with outputDimensionality=768 (L2-normalised here,
 *    because the model only returns unit vectors at its default 3072 dims).
 *    `text-embedding-004` was shut down by Google and no longer works.
 *  - Hugging Face: BAAI/bge-base-en-v1.5 via the Inference Providers router (768 dims).
 *
 * IMPORTANT: if the column already holds vectors from another model (e.g. the old
 * text-embedding-004), re-embed everything — old and new vectors are not compatible
 * even though both are 768-dimensional.
 */
import { env } from "./env.js";
import { AsyncBatchCache } from "./asyncBatchCache.js";

export const EMBEDDING_DIMS = 768;

export type EmbeddingVector = number[];
export type EmbeddingKind = "document" | "query";

// ── In-process cache ──────────────────────────────────────────────────────────
// Bound memory and share overlapping batches across searches, plans and ingestion.
const embedCache = new AsyncBatchCache<EmbeddingVector>();

const GEMINI_MODEL = "gemini-embedding-001";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:batchEmbedContents`;
const HF_URL =
  "https://router.huggingface.co/hf-inference/models/BAAI/bge-base-en-v1.5/pipeline/feature-extraction";

const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;
const BATCH_PAUSE_MS = 200;

type Provider = "gemini" | "huggingface";

function activeProvider(): Provider | null {
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.HUGGINGFACE_API_KEY) return "huggingface";
  return null;
}

export function embeddingsConfigured(): boolean {
  return activeProvider() !== null;
}

/** Human-readable id of the model currently in use (handy for logs). */
export function embeddingModelName(): string | null {
  const p = activeProvider();
  return p === "gemini"
    ? GEMINI_MODEL
    : p === "huggingface"
      ? "BAAI/bge-base-en-v1.5"
      : null;
}

// ── HTTP with retry ───────────────────────────────────────────────────────────

class NonRetryableError extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoff = (attempt: number) =>
  Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  query = false,
): Promise<unknown> {
  const attempts = query ? 2 : MAX_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(query ? 20_000 : REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as unknown;

      const text = (await res.text()).slice(0, 300);
      // 429 (rate limit) and 5xx are worth retrying; anything else is our bug / bad key
      if (res.status !== 429 && res.status < 500) {
        throw new NonRetryableError(`HTTP ${res.status}: ${text}`);
      }
      lastErr = new Error(`HTTP ${res.status}: ${text}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      if (attempt + 1 < attempts)
        await sleep(
          Math.min(
            query ? 2_000 : 30_000,
            retryAfter > 0 ? retryAfter * 1000 : backoff(attempt),
          ),
        );
    } catch (e) {
      if (e instanceof NonRetryableError) throw e;
      lastErr = e; // network error / timeout
      if (attempt + 1 < attempts)
        await sleep(Math.min(query ? 2_000 : 30_000, backoff(attempt)));
    }
  }
  throw new Error(
    `Embedding request failed after ${attempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

// ── Vector utils ──────────────────────────────────────────────────────────────

function l2Normalize(v: number[]): number[] {
  const norm = Math.hypot(...v);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

function validate(vecs: unknown[], expected: number): EmbeddingVector[] {
  if (vecs.length !== expected) {
    throw new Error(
      `Embedding provider returned ${vecs.length} vectors for ${expected} inputs`,
    );
  }
  return vecs.map((v) => {
    if (!isValidEmbedding(v)) {
      throw new Error(
        `Unexpected embedding shape (got length ${Array.isArray(v) ? v.length : "n/a"}, need ${EMBEDDING_DIMS})`,
      );
    }
    return l2Normalize(v as number[]);
  });
}

export function isValidEmbedding(value: unknown): value is EmbeddingVector {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMS &&
    value.every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    ) &&
    value.some((entry) => entry !== 0)
  );
}

// ── Providers ─────────────────────────────────────────────────────────────────

async function geminiBatch(
  texts: string[],
  kind: EmbeddingKind,
): Promise<EmbeddingVector[]> {
  const key = env.GEMINI_API_KEY ?? "";
  const taskType = kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const data = (await postJson(
    GEMINI_URL,
    { "x-goog-api-key": key },
    {
      requests: texts.map((text) => ({
        model: `models/${GEMINI_MODEL}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBEDDING_DIMS,
      })),
    },
    kind === "query",
  )) as { embeddings?: { values?: number[] }[] };
  return validate(
    (data.embeddings ?? []).map((e) => e.values),
    texts.length,
  );
}

async function hfBatch(
  texts: string[],
  kind: EmbeddingKind,
): Promise<EmbeddingVector[]> {
  const data = await postJson(
    HF_URL,
    { Authorization: `Bearer ${env.HUGGINGFACE_API_KEY ?? ""}` },
    { inputs: texts },
    kind === "query",
  );
  return validate(Array.isArray(data) ? data : [], texts.length);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed many texts. Returns null ONLY when no provider is configured.
 * THROWS if the provider keeps failing (after retries) — callers that write to the
 * database must treat that as "do not touch existing data".
 */
export async function embedTexts(
  texts: string[],
  kind: EmbeddingKind = "document",
): Promise<EmbeddingVector[] | null> {
  const provider = activeProvider();
  if (!provider) return null;
  if (texts.length === 0) return [];

  const prefix = `${provider}:${kind}:`;
  const keys = texts.map((text) => prefix + text.slice(0, 8000));
  const vectors = await embedCache.getMany(keys, async (missing) => {
    const batchSize = provider === "gemini" ? 50 : 16;
    const out: EmbeddingVector[] = [];
    for (let i = 0; i < missing.length; i += batchSize) {
      const slice = missing
        .slice(i, i + batchSize)
        .map((key) => key.slice(prefix.length));
      out.push(
        ...(provider === "gemini"
          ? await geminiBatch(slice, kind)
          : await hfBatch(slice, kind)),
      );
      if (i + batchSize < missing.length) await sleep(BATCH_PAUSE_MS);
    }
    return out;
  });
  return vectors.map((vector) => [...vector]);
}

/**
 * Embed one text. Never throws: returns null if unconfigured OR on failure, so request-time
 * callers (retriever, MCQ, flashcards) can degrade gracefully. Pass kind="query" for search queries.
 * Results share the bounded batch cache and overlapping in-flight requests.
 */
export async function embedText(
  text: string,
  kind: EmbeddingKind = "document",
): Promise<EmbeddingVector | null> {
  try {
    const res = await embedTexts([text], kind);
    const vec = res?.[0] ?? null;
    return vec;
  } catch (err) {
    console.error(
      "[Embeddings] failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Serialise a JS number[] as a pgvector literal string, e.g. "[0.1,0.2,...]" */
export function vectorToSql(vec: EmbeddingVector): string {
  return `[${vec.join(",")}]`;
}
