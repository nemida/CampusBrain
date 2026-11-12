import { prisma } from "./prisma.js";
import { env } from "./env.js";
import { embedTexts, embeddingModelName } from "./embeddings.js";

const GEN_MODEL = "gemini-2.5-flash"; // any free Gemini flash model you have access to
const GEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEN_MODEL}:generateContent`;

export interface TopicProfile {
    description: string;
    aliases: string[];
    embedding: number[] | null;
}

export const keyOf = (topic: string, context?: string) =>
    `${(context ?? "").trim()}|${topic.trim()}`.toLowerCase();

async function generateJson<T>(prompt: string): Promise<T> {
    const res = await fetch(GEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY ?? "" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "null") as T;
}

/** ONE LLM call + ONE embedding call for up to ~20 topics. Stores and returns the profiles. */
export async function buildProfiles(topics: string[], context?: string): Promise<Map<string, TopicProfile>> {
    const out = new Map<string, TopicProfile>();
    if (topics.length === 0) return out;

    const raw = await generateJson<{ topic: string; description: string; aliases: string[] }[]>(
        `Engineering exam topics${context ? ` for the course "${context}"` : ""}: ${JSON.stringify(topics)}.
For EACH topic return an object {"topic": <exactly as given>, "description": one sentence on what the topic is and what
exam questions on it ask students to do, "aliases": up to 6 short phrases that exam questions on this topic would
literally contain (NOT the topic name itself; no generic words like "equation" or "solve")}.
Return a JSON array in the same order.`,
    );
    const gen = Array.isArray(raw) ? raw : [];

    const items = topics.map((t, i) => {
        const g = gen.find((x) => x.topic?.toLowerCase() === t.toLowerCase()) ?? gen[i];
        return { topic: t, description: g?.description?.trim() || t, aliases: (g?.aliases ?? []).slice(0, 6) };
    });

    const vecs = await embedTexts(items.map((i) => `${i.topic}: ${i.description}`), "query"); // 1 call
    for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        const embedding = vecs?.[i] ?? null;
        const key = keyOf(it.topic, context);
        const data = {
            description: it.description,
            aliases: it.aliases,
            embedding: embedding ?? undefined,
            model: embeddingModelName(),
        };
        await prisma.topicProfile.upsert({
            where: { key },
            create: { key, topic: it.topic, ...data },
            update: data,
        });
        out.set(key, { description: it.description, aliases: it.aliases, embedding });
    }
    return out;
}

/** Reads a cached profile from the DB. Never calls any API. */
export async function getCachedProfile(topic: string, context?: string): Promise<TopicProfile | null> {
    const row = await prisma.topicProfile.findUnique({ where: { key: keyOf(topic, context) } });
    if (row && row.model === embeddingModelName() && Array.isArray(row.embedding)) {
        return { description: row.description, aliases: row.aliases, embedding: row.embedding as number[] };
    }
    return null;
}