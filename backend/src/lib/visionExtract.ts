/**
 * Reads SCANNED question papers with a Gemini vision model (the PDF is sent as-is; pages are read as images).
 *
 * This is a transcription by a model, not text copied from the file, so scan-derived questions are flagged
 * source = "scan" and carry a page number so students can check them against the original.
 */
import { env } from "./env.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const MAX_INLINE_BYTES = 18 * 1024 * 1024; // the API's inline limit is ~20 MB for the whole request
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 4;

export interface VisionQuestion {
    label: string | null;
    page: number | null;
    marks: number | null;
    text: string;
}

// ── Model selection ───────────────────────────────────────────────────────────
// Google renames/retires models regularly, so don't hard-code one. Use GEMINI_VISION_MODEL if set, otherwise
// pick the best Flash model the key can actually call (asked of the API itself).

const PREFERRED = [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash-lite",
];
let resolvedModel: string | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retryBaseMs = () => Number(process.env["GEMINI_RETRY_BASE_MS"]) || 4000;

export function pickModel(available: Set<string>): string | null {
    const preferred = PREFERRED.find((m) => available.has(m));
    if (preferred) return preferred;
    // newest "gemini-<version>-flash" that exists
    const flash = [...available]
        .map((n) => ({ n, m: /^gemini-(\d+(?:\.\d+)?)-flash$/.exec(n) }))
        .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
        .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
    return flash[0]?.n ?? null;
}

export async function resolveVisionModel(): Promise<string> {
    const override = process.env["GEMINI_VISION_MODEL"];
    if (override) return override;
    if (resolvedModel) return resolvedModel;

    const key = env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set; it is needed to read scanned papers.");

    const available = new Set<string>();
    try {
        let pageToken = "";
        for (let i = 0; i < 5; i++) {
            const res = await fetch(`${API}/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`, {
                headers: { "x-goog-api-key": key },
                signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) break;
            const data = (await res.json()) as {
                models?: { name?: string; supportedGenerationMethods?: string[] }[];
                nextPageToken?: string;
            };
            for (const m of data.models ?? []) {
                if (m.name && (m.supportedGenerationMethods ?? []).includes("generateContent")) {
                    available.add(m.name.replace(/^models\//, ""));
                }
            }
            if (!data.nextPageToken) break;
            pageToken = data.nextPageToken;
        }
    } catch {
        /* fall through to the default */
    }

    resolvedModel = pickModel(available) ?? "gemini-2.5-flash";
    console.log(`[Vision] using model ${resolvedModel}`);
    return resolvedModel;
}

// ── Request ───────────────────────────────────────────────────────────────────

const PROMPT = `This is a scanned university exam question paper. Transcribe EVERY question exactly as printed.

Rules:
- Copy each question word for word. Do NOT correct, paraphrase, summarise, translate or solve anything.
- Write mathematical expressions in plain text / Unicode (for example x^2, sqrt(x), ∫, ≤, α), keeping the original wording.
- Treat lettered sub-parts such as (a), (b) as separate questions when they are separate tasks.
  Keep a multiple-choice question together with its options.
- Skip headers, course codes, general instructions ("Attempt any five..."), section titles and "OR".
- If a word is illegible, write [illegible] instead of guessing.
- "label": the question number as printed (e.g. "Q3(b)"), or null.
- "page": the 1-based page of the PDF where the question starts.
- "marks": the marks printed for it as an integer, or null.
- If the document contains no exam questions, return an empty list.`;

const RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
        questions: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    label: { type: "STRING", nullable: true },
                    page: { type: "INTEGER", nullable: true },
                    marks: { type: "INTEGER", nullable: true },
                    text: { type: "STRING" },
                },
                required: ["text"],
            },
        },
    },
    required: ["questions"],
};

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

async function generate(model: string, base64Data: string, withSchema: boolean, mimeType: string): Promise<string> {
    const key = env.GEMINI_API_KEY ?? "";
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(`${API}/models/${model}:generateContent`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": key },
                body: JSON.stringify({
                    contents: [
                        { role: "user", parts: [{ inlineData: { mimeType, data: base64Data } }, { text: PROMPT }] },
                    ],
                    generationConfig: {
                        temperature: 0,
                        maxOutputTokens: 16000,
                        responseMimeType: "application/json",
                        ...(withSchema ? { responseSchema: RESPONSE_SCHEMA } : {}),
                    },
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (res.ok) {
                const data = (await res.json()) as {
                    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
                    promptFeedback?: { blockReason?: string };
                };
                if (data.promptFeedback?.blockReason) throw new HttpError(400, `Blocked: ${data.promptFeedback.blockReason}`);
                const cand = data.candidates?.[0];
                const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
                if (!text.trim()) throw new HttpError(502, `Empty response (${cand?.finishReason ?? "no candidates"})`);
                return text;
            }
            const body = (await res.text()).slice(0, 300);
            // rate limits / overload are worth retrying; anything else is our request or the key
            if (res.status !== 429 && res.status < 500) throw new HttpError(res.status, `HTTP ${res.status}: ${body}`);
            lastErr = new HttpError(res.status, `HTTP ${res.status}: ${body}`);
            await sleep(retryBaseMs() * 3 ** attempt);
        } catch (e) {
            if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
            lastErr = e;
            await sleep(retryBaseMs() * 3 ** attempt);
        }
    }
    throw new Error(`Vision request failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export const MIN_VISION_LENGTH = 15;
export const MAX_VISION_LENGTH = 2500;

export function parseVisionResponse(raw: string): VisionQuestion[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        const m = /\{[\s\S]*\}/.exec(raw);
        if (!m) throw new Error("Vision model did not return JSON");
        parsed = JSON.parse(m[0]);
    }
    const list = (parsed as { questions?: unknown }).questions;
    if (!Array.isArray(list)) return [];
    const out: VisionQuestion[] = [];
    for (const q of list) {
        if (!q || typeof q !== "object") continue;
        const { label, page, marks, text } = q as Record<string, unknown>;
        if (typeof text !== "string") continue;
        const t = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        if (t.length < MIN_VISION_LENGTH || t.length > MAX_VISION_LENGTH) continue;
        const int = (v: unknown, max: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : null);
        out.push({
            label: typeof label === "string" && label.trim() ? label.trim().slice(0, 20) : null,
            page: int(page, 500),
            marks: int(marks, 100),
            text: t,
        });
    }
    return out;
}

export async function extractQuestionsWithVision(file: Buffer, mimeType = "application/pdf"): Promise<{ questions: VisionQuestion[]; model: string }> {
    if (file.length > MAX_INLINE_BYTES) {
        throw new Error(`File is ${(file.length / 1048576).toFixed(1)} MB; too large to send inline (limit ~18 MB).`);
    }
    const model = await resolveVisionModel();
    const base64 = file.toString("base64");

    let raw: string;
    try {
        raw = await generate(model, base64, true, mimeType);
    } catch (e) {
        // some models reject a response schema; retry once with plain JSON mode
        if (e instanceof HttpError && e.status === 400) raw = await generate(model, base64, false, mimeType);
        else throw e;
    }
    return { questions: parseVisionResponse(raw), model };
}