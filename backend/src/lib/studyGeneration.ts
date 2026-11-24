import { z } from "zod";

const questionSchema = z.object({
  question: z.string().trim().min(1).max(3000),
  options: z
    .array(z.string().trim().min(1).max(1000))
    .length(4)
    .refine(
      (options) =>
        new Set(options.map((option) => option.toLowerCase())).size === 4,
    ),
  correctIndex: z.number().int().min(0).max(3),
  explanation: z.string().trim().max(5000).default(""),
  topic: z.string().trim().max(200).default(""),
});
const cardSchema = z.object({
  front: z.string().trim().min(1).max(2000),
  back: z.string().trim().min(1).max(5000),
});

function collection(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && key in value) {
    const items = (value as Record<string, unknown>)[key];
    if (Array.isArray(items)) return items;
  }
  return [];
}

/** The HTTP routes and agent tools must enforce the same answer-key contract. */
export function parseGeneratedQuestions(
  value: unknown,
  fallbackTopic: string,
  count: number,
) {
  const seen = new Set<string>();
  return collection(value, "questions")
    .flatMap((raw) => {
      const parsed = questionSchema.safeParse(raw);
      if (!parsed.success) return [];
      const question = parsed.data;
      const key = question.question.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...question, topic: question.topic || fallbackTopic }];
    })
    .slice(0, count);
}

export function parseGeneratedCards(value: unknown, count: number) {
  const seen = new Set<string>();
  return collection(value, "cards")
    .flatMap((raw) => {
      const parsed = cardSchema.safeParse(raw);
      if (!parsed.success) return [];
      const key = parsed.data.front.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) return [];
      seen.add(key);
      return [parsed.data];
    })
    .slice(0, count);
}
