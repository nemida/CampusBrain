import { prisma } from "./prisma.js";
import { env } from "./env.js";
import {
  embedTexts,
  embeddingModelName,
  isValidEmbedding,
} from "./embeddings.js";
import { z } from "zod";

const GEN_MODEL = "gemini-2.5-flash"; // any free Gemini flash model you have access to
const GEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEN_MODEL}:generateContent`;

export interface TopicProfile {
  description: string;
  aliases: string[];
  embedding: number[] | null;
}

export const keyOf = (topic: string, context?: string) =>
  `${(context ?? "").trim()}|${topic.trim()}`
    .toLowerCase()
    .replace(/\s+/g, " ");

const generatedProfile = z.object({
  topic: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1500).default(""),
  aliases: z.array(z.string().trim().min(3).max(120)).max(6).default([]),
});

const GENERIC_ALIASES = new Set([
  "equation",
  "equations",
  "solve",
  "solution",
  "solutions",
  "function",
  "functions",
  "question",
  "questions",
  "problem",
  "problems",
  "example",
  "examples",
  "method",
  "methods",
  "algorithm",
  "algorithms",
  "formula",
  "formulas",
  "definition",
  "definitions",
  "concept",
  "concepts",
]);
function cleanAliases(aliases: string[], topic = ""): string[] {
  return [
    ...new Map(
      aliases
        .map((alias) => alias.trim().replace(/\s+/g, " "))
        .filter(
          (alias) =>
            alias.length >= 3 &&
            alias.length <= 120 &&
            !GENERIC_ALIASES.has(alias.toLowerCase()) &&
            keyOf(alias) !== keyOf(topic),
        )
        .map((alias) => [alias.toLowerCase(), alias]),
    ).values(),
  ].slice(0, 6);
}

async function generateJson<T>(prompt: string): Promise<T> {
  const res = await fetch(GEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY ?? "",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return JSON.parse(
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "null",
  ) as T;
}

/** ONE LLM call + ONE embedding call for up to ~20 topics. Stores and returns the profiles. */
const building = new Map<string, Promise<Map<string, TopicProfile>>>();
export function buildProfiles(
  topics: string[],
  context?: string,
): Promise<Map<string, TopicProfile>> {
  if (!topics.length || !env.GEMINI_API_KEY) return Promise.resolve(new Map());
  const key = JSON.stringify([
    embeddingModelName(),
    topics.map((topic) => keyOf(topic, context)).sort(),
  ]);
  const existing = building.get(key);
  if (existing) return existing;
  const request = buildUncachedProfiles(topics, context).finally(() =>
    building.delete(key),
  );
  building.set(key, request);
  return request;
}

async function buildUncachedProfiles(
  topics: string[],
  context?: string,
): Promise<Map<string, TopicProfile>> {
  const out = new Map<string, TopicProfile>();
  if (topics.length === 0 || !env.GEMINI_API_KEY) return out;

  const raw = await generateJson<
    { topic: string; description: string; aliases: string[] }[]
  >(
    `Engineering exam topics${context ? ` for the course "${context}"` : ""}: ${JSON.stringify(topics)}.
For EACH topic return an object {"topic": <exactly as given>, "description": one sentence on what the topic is and what
exam questions on it ask students to do, "aliases": up to 6 short phrases that exam questions on this topic would
literally contain (NOT the topic name itself; no generic words like "equation" or "solve")}.
Return a JSON array in the same order.`,
  );
  const gen = (Array.isArray(raw) ? raw : []).flatMap((value) => {
    const parsed = generatedProfile.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });

  const items = topics.map((t) => {
    const g = gen.find((x) => keyOf(x.topic) === keyOf(t));
    return {
      topic: t,
      description: g?.description || t,
      aliases: cleanAliases(g?.aliases ?? [], t),
    };
  });

  const vecs = await embedTexts(
    items.map((i) => `${i.topic}: ${i.description}`),
    "query",
  ); // 1 call
  const writes = items.map((it, i) => {
    const embedding = vecs?.[i] ?? null;
    const key = keyOf(it.topic, context);
    const data = {
      description: it.description,
      aliases: it.aliases,
      embedding: embedding ?? undefined,
      model: embeddingModelName(),
    };
    const write = prisma.topicProfile.upsert({
      where: { key },
      create: { key, topic: it.topic, ...data },
      update: data,
    });
    out.set(key, {
      description: it.description,
      aliases: it.aliases,
      embedding,
    });
    return write;
  });
  await prisma.$transaction(writes);
  return out;
}

/** Reads a cached profile from the DB. Never calls any API. */
export async function getCachedProfile(
  topic: string,
  context?: string,
): Promise<TopicProfile | null> {
  return (
    (await getCachedProfiles([topic], context)).get(keyOf(topic, context)) ??
    null
  );
}

/** One round trip for the complete topic selection; validate cached JSON before using it in SQL. */
export async function getCachedProfiles(
  topics: string[],
  context?: string,
): Promise<Map<string, TopicProfile>> {
  const profiles = new Map<string, TopicProfile>();
  if (!topics.length) return profiles;
  const rows = await prisma.topicProfile.findMany({
    where: { key: { in: topics.map((topic) => keyOf(topic, context)) } },
  });
  for (const row of rows) {
    if (row.model !== embeddingModelName()) continue;
    profiles.set(row.key, {
      description: row.description,
      aliases: cleanAliases(row.aliases, row.topic),
      embedding: isValidEmbedding(row.embedding) ? row.embedding : null,
    });
  }
  return profiles;
}
