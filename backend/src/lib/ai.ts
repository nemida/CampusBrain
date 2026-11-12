/**
 * Thin AI wrapper — tries a chain of Groq models first (free), then OpenAI if
 * configured. If nothing works, returns null so callers can fall back.
 *
 * visionComplete() is the image-input variant (used for scanned PDFs). Default order is
 * Groq → Gemini → OpenAI; only providers with a key are tried. Override with
 * VISION_PROVIDERS="gemini,groq" (Gemini is generally stronger on dense tables).
 */
import { env } from "./env.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResult {
  content: string;
  /** which vision provider answered (vision calls only) */
  provider?: string;
}

const GROQ_MODELS = (
  process.env.GROQ_MODELS ?? "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GROQ_VISION_MODELS = (
  process.env.GROQ_VISION_MODELS ?? "qwen/qwen3.8-27b"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";

const MAX_TOKENS = 3000;
const MAX_WAIT_MS = 15_000;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isModelUnavailable = (err: unknown) =>
  /model_not_found|does not exist or you do not have access|decommissioned/i.test(errText(err));
const isRateLimit = (err: unknown) => /\b429\b|rate.?limit/i.test(errText(err));
const isDailyLimit = (err: unknown) => /per day|\(TPD\)|\(RPD\)|daily/i.test(errText(err));

function parseRetryAfterMs(err: unknown): number {
  const m = errText(err).match(/try again in\s+(?:(\d+)m)?\s*([\d.]+)(ms|s)/i);
  if (!m) return 6000;
  const minutes = m[1] ? Number(m[1]) : 0;
  const value = Number(m[2]);
  const ms = m[3]!.toLowerCase() === "ms" ? value : value * 1000;
  return Math.ceil(minutes * 60_000 + ms) + 250;
}

export async function chatComplete(
  messages: ChatMessage[],
  jsonMode = true,
): Promise<ChatResult | null> {
  // Groq (and OpenAI) require the word "json" to appear somewhere in the messages
  // when response_format json_object is used. Enforce this here so callers don't
  // have to remember.
  let effectiveMessages = messages;
  if (jsonMode) {
    const allText = messages.map((m) => m.content).join(" ");
    if (!/json/i.test(allText)) {
      // Append a silent instruction to the last user message.
      effectiveMessages = messages.map((m, i) =>
        i === messages.length - 1 && m.role === "user"
          ? { ...m, content: `${m.content}\n\nReturn your answer as JSON.` }
          : m,
      );
    }
  }

  if (env.GROQ_API_KEY) {
    const { default: Groq } = await import("groq-sdk");
    const groq = new Groq({ apiKey: env.GROQ_API_KEY, maxRetries: 0 });
    const skip = new Set<string>();

    for (let round = 0; round < 2; round++) {
      let rateLimited = false;
      let waitMs = 0;

      for (const model of GROQ_MODELS) {
        if (skip.has(model)) continue;
        try {
          const completion = await groq.chat.completions.create({
            model,
            messages: effectiveMessages,
            temperature: 0.4,
            max_tokens: MAX_TOKENS,
            ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
            ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
          });

          const content = completion.choices[0]?.message?.content ?? null;
          if (content) return { content };
          console.warn(`[AI] ${model} returned empty content; trying next model.`);
        } catch (err) {
          console.error(`[AI] Groq ${model} failed:`, errText(err));
          if (isModelUnavailable(err)) {
            skip.add(model);
          } else if (isRateLimit(err)) {
            if (isDailyLimit(err)) skip.add(model);
            else {
              rateLimited = true;
              waitMs = Math.max(waitMs, parseRetryAfterMs(err));
            }
          }
        }
      }

      if (!rateLimited) break;
      if (round === 0) await sleep(Math.min(waitMs, MAX_WAIT_MS));
    }
  }

  if (env.OPENAI_API_KEY) {
    try {
      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: effectiveMessages,
        temperature: 0.4,
        ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      });

      const content = completion.choices[0]?.message?.content ?? null;
      if (content) return { content };
    } catch (err) {
      console.error("[AI] OpenAI also failed:", errText(err));
    }
  }

  return null;
}

// ── Vision ────────────────────────────────────────────────────────────────────

async function visionOpenAI(prompt: string, images: string[]): Promise<ChatResult | null> {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: OPENAI_VISION_MODEL,
      temperature: 0,
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" as const },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((url) => ({
              type: "image_url" as const,
              image_url: { url, detail: "high" as const },
            })),
          ],
        },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? null;
    return content ? { content } : null;
  } catch (err) {
    console.error("[AI] OpenAI vision failed:", errText(err));
    return null;
  }
}

// ── Groq: pace requests under the tokens-per-minute limit instead of hitting 429 ────────────────
// Free tier for the vision model is ~7000 input tokens/min; each image costs ~2048 tokens.
const GROQ_VISION_ITPM = Number(process.env.GROQ_VISION_ITPM ?? 7000);
const groqUsage: { t: number; tokens: number }[] = [];

async function reserveGroqTokens(est: number): Promise<void> {
  const limit = GROQ_VISION_ITPM * 0.95;
  for (let i = 0; i < 20; i++) {
    const now = Date.now();
    while (groqUsage.length && now - groqUsage[0]!.t >= 60_000) groqUsage.shift();
    const used = groqUsage.reduce((a, b) => a + b.tokens, 0);
    if (groqUsage.length === 0 || used + est <= limit) {
      groqUsage.push({ t: now, tokens: est });
      return;
    }
    const wait = groqUsage[0]!.t + 60_000 - now + 250;
    console.log(`[AI] Groq vision: waiting ${Math.ceil(wait / 1000)}s to stay under the tokens-per-minute limit`);
    await sleep(wait);
  }
}

async function visionGroq(prompt: string, images: string[]): Promise<ChatResult | null> {
  if (!env.GROQ_API_KEY) return null;
  const { default: Groq } = await import("groq-sdk");
  const groq = new Groq({ apiKey: env.GROQ_API_KEY, maxRetries: 0 });
  const est = images.length * 2048 + Math.ceil(prompt.length / 3.3);

  for (const model of GROQ_VISION_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await reserveGroqTokens(est);
      try {
        const completion = await groq.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 6000, // reasoning-capable models spend part of this on thinking
          // No response_format here: JSON mode isn't reliable with images; extractJSON() copes.
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                ...images.map((url) => ({ type: "image_url", image_url: { url } })),
              ],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          ],
        });
        const raw = completion.choices[0]?.message?.content ?? null;
        const content = raw ? raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : null;
        if (content) return { content };
        break;
      } catch (err) {
        if (isRateLimit(err) && !isDailyLimit(err) && attempt === 0) {
          const wait = Math.min(parseRetryAfterMs(err), 65_000);
          console.warn(`[AI] Groq vision ${model} rate-limited; retrying in ${Math.ceil(wait / 1000)}s`);
          await sleep(wait);
          continue;
        }
        console.error(`[AI] Groq vision ${model} failed:`, errText(err));
        break;
      }
    }
  }
  return null;
}

// ── Gemini: retry temporary errors (503 "high demand", 429, network blips) ──────────────────────
// Model names get retired often; list several (first that works wins). Override via env.
const GEMINI_VISION_MODELS = (process.env.GEMINI_VISION_MODELS ?? process.env.GEMINI_VISION_MODEL ?? "gemini-3.8-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GEMINI_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const GEMINI_BACKOFF_MS = [3000, 8000];

async function visionGemini(prompt: string, images: string[]): Promise<ChatResult | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const parts: unknown[] = [{ text: prompt }];
  for (const url of images) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) continue;
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8000, // thinking models count reasoning tokens against this
      responseMimeType: "application/json",
    },
  });

  for (const model of GEMINI_VISION_MODELS) {
    for (let attempt = 0; attempt <= GEMINI_BACKOFF_MS.length; attempt++) {
      let retryable = false;
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          if (text) return { content: text };
          break; // empty answer: next model
        }
        retryable = GEMINI_RETRY_STATUS.has(res.status);
        console.error(`[AI] Gemini vision ${model} HTTP ${res.status}:`, (await res.text()).slice(0, 200));
      } catch (err) {
        retryable = true; // "fetch failed" and similar network errors
        console.error(`[AI] Gemini vision ${model} failed:`, errText(err));
      }
      if (!retryable || attempt === GEMINI_BACKOFF_MS.length) break;
      await sleep(GEMINI_BACKOFF_MS[attempt]!);
    }
  }
  return null;
}

// GEMINI_FIRST=true puts Gemini ahead of Groq; VISION_PROVIDERS="a,b,c" overrides the order entirely.
const DEFAULT_VISION_ORDER = process.env.GEMINI_FIRST === "true" ? "gemini,groq,openai" : "groq,gemini,openai";
const VISION_PROVIDERS = (process.env.VISION_PROVIDERS ?? DEFAULT_VISION_ORDER)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// After a provider fails completely, skip it briefly so every batch doesn't pay its retry delays.
const COOLDOWN_MS = 30_000;
const cooldownUntil: Record<string, number> = {};

function callProvider(provider: string, prompt: string, images: string[]): Promise<ChatResult | null> {
  return provider === "groq"
    ? visionGroq(prompt, images)
    : provider === "gemini"
      ? visionGemini(prompt, images)
      : provider === "openai"
        ? visionOpenAI(prompt, images)
        : Promise.resolve(null);
}

/**
 * Ask a vision model about up to 3 images (data URLs; Groq's limit). Providers are tried in order;
 * one that just failed is skipped for a while, but still used as a last resort. Returns null if
 * no provider is configured or all fail.
 */
export async function visionComplete(prompt: string, images: string[]): Promise<ChatResult | null> {
  if (images.length === 0) return null;
  const skipped: string[] = [];

  for (const provider of VISION_PROVIDERS) {
    if ((cooldownUntil[provider] ?? 0) > Date.now()) {
      skipped.push(provider);
      continue;
    }
    const result = await callProvider(provider, prompt, images);
    if (result) return { ...result, provider };
    cooldownUntil[provider] = Date.now() + COOLDOWN_MS;
  }
  for (const provider of skipped) {
    const result = await callProvider(provider, prompt, images);
    if (result) return { ...result, provider };
  }
  return null;
}

export function extractJSON<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    const objMatch = content.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]) as T; } catch { /* */ }
    }
    const arrMatch = content.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]) as T; } catch { /* */ }
    }
  }
  return null;
}