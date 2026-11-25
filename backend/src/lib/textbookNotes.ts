import { z } from "zod";

export const MAX_TEXTBOOK_PAGES = 60;
export const MAX_NOTE_TOPICS = 8;

export interface TextbookEvidence {
  id: string;
  materialId: string;
  title: string;
  fileUrl: string;
  pageNumber: number;
  text: string;
  source: string;
  similarity?: number;
  excerpts?: { id: string; text: string }[];
}

export interface NoteCitation {
  materialId: string;
  title: string;
  fileUrl: string;
  pageNumber: number;
  quote: string;
  source: string;
}

export interface NoteSection {
  topic: string;
  status: "covered" | "insufficient";
  blocks: { text: string; citations: NoteCitation[] }[];
}

const normalize = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();
const words = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}+#]+/gu) ?? []);

export class NoteValidationError extends Error {
  constructor(
    public readonly reason:
      | "invalid_structure"
      | "unknown_source"
      | "unknown_excerpt"
      | "quote_mismatch",
  ) {
    super(reason);
    this.name = "NoteValidationError";
  }
}

/** nemida: short source/excerpt IDs let models select evidence instead of retyping
 * UUIDs and OCR typography. Quotes are copied by the server from the original text.
 */
export function prepareTextbookEvidence(
  evidence: TextbookEvidence[],
): TextbookEvidence[] {
  return evidence.map((source, index) => {
    const excerpts: { id: string; text: string }[] = [];
    let start = 0;
    while (start < source.text.length) {
      let end = Math.min(start + 450, source.text.length);
      if (end < source.text.length) {
        const boundary = source.text.lastIndexOf(" ", end);
        if (boundary > start + 200) end = boundary;
      }
      // Include a short tail with its predecessor instead of creating an unusable excerpt.
      if (source.text.length - end < 20) end = source.text.length;
      const text = source.text.slice(start, end).trim();
      if (text.length >= 20)
        excerpts.push({ id: `E${excerpts.length + 1}`, text });
      start = end;
    }
    return { ...source, id: `S${index + 1}`, excerpts };
  });
}

/** Page-bounded chunks preserve PDF page numbers, including skipped/unreadable pages. */
export function chunkTextbookPage(text: string): string[] {
  const clean = text.replace(/\u0000/g, "").trim();
  const result: string[] = [];
  for (let start = 0; start < clean.length; start += 1400) {
    const chunk = clean.slice(start, start + 1600).trim();
    if (chunk.length >= 30) result.push(chunk);
    if (start + 1600 >= clean.length) break;
  }
  return result;
}

/** Hybrid ranking: require lexical overlap or strong semantic evidence, with page diversity. */
export function rankTextbookEvidence(
  topic: string,
  candidates: TextbookEvidence[],
): TextbookEvidence[] {
  const terms = words(topic);
  const phrase = normalize(topic).toLowerCase();
  const ranked = candidates
    .map((item) => {
      const tokens = words(item.text);
      const overlap =
        [...terms].filter((term) => tokens.has(term)).length /
        Math.max(terms.size, 1);
      const exact = normalize(item.text).toLowerCase().includes(phrase);
      return {
        item,
        score: overlap + (exact ? 0.5 : 0) + (item.similarity ?? 0) * 0.5,
        relevant: overlap >= 0.5 || exact || (item.similarity ?? 0) >= 0.55,
      };
    })
    .filter((entry) => entry.relevant)
    .sort((a, b) => b.score - a.score);
  const pageCounts = new Map<string, number>();
  const seen = new Set<string>();
  return ranked
    .filter(({ item }) => {
      const page = `${item.materialId}:${item.pageNumber}`;
      if (seen.has(item.id) || (pageCounts.get(page) ?? 0) >= 2) return false;
      seen.add(item.id);
      pageCounts.set(page, (pageCounts.get(page) ?? 0) + 1);
      return true;
    })
    .slice(0, 8)
    .map(({ item }) => item);
}

const generatedSection = z.object({
  status: z.enum(["covered", "insufficient"]),
  blocks: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(3000),
        citations: z
          .array(
            z
              .object({
                chunkId: z.string().trim().min(1),
                excerptId: z.string().trim().min(1).optional(),
                quote: z.string().trim().min(20).max(600).optional(),
              })
              .refine((citation) => !!citation.excerptId || !!citation.quote),
          )
          .min(1)
          .max(4),
      }),
    )
    .max(8),
});

/** Accept only citations to supplied passages with a verifiable verbatim excerpt.
 * This validates provenance, not factual entailment; students must still review notes.
 */
export function validateNoteSection(
  topic: string,
  value: unknown,
  evidence: TextbookEvidence[],
): NoteSection {
  const parsed = generatedSection.safeParse(value);
  if (!parsed.success) throw new NoteValidationError("invalid_structure");
  const section = parsed.data;
  if (section.status === "insufficient") {
    if (section.blocks.length)
      throw new NoteValidationError("invalid_structure");
    return { topic, status: "insufficient", blocks: [] };
  }
  if (!section.blocks.length)
    throw new NoteValidationError("invalid_structure");
  const allowed = new Map(evidence.map((item) => [item.id, item]));
  return {
    topic,
    status: "covered",
    blocks: section.blocks.map((block) => ({
      text: block.text,
      citations: block.citations.map((citation) => {
        const source = allowed.get(citation.chunkId);
        if (!source) throw new NoteValidationError("unknown_source");
        const excerpt = citation.excerptId
          ? source.excerpts?.find((item) => item.id === citation.excerptId)
          : undefined;
        if (citation.excerptId && !excerpt)
          throw new NoteValidationError("unknown_excerpt");
        const quote = excerpt?.text ?? citation.quote;
        if (!quote || !normalize(source.text).includes(normalize(quote)))
          throw new NoteValidationError("quote_mismatch");
        return {
          materialId: source.materialId,
          title: source.title,
          fileUrl: source.fileUrl,
          pageNumber: source.pageNumber,
          quote,
          source: source.source,
        };
      }),
    })),
  };
}

export const noteRequestSchema = z.object({
  materialIds: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .transform((ids) => [...new Set(ids)]),
  topics: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(MAX_NOTE_TOPICS)
    .transform((topics) => [...new Set(topics)]),
});

export function sourceSnapshot(
  unit: { updatedAt: Date },
  materials: { id: string; updatedAt: Date }[],
) {
  return {
    unitUpdatedAt: unit.updatedAt.toISOString(),
    materials: materials
      .map((item) => ({ id: item.id, updatedAt: item.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function noteIsStale(
  inputs: unknown,
  unit: { updatedAt: Date },
  materials: { id: string; updatedAt: Date; status: string }[],
): boolean {
  const parsed = z
    .object({
      unitUpdatedAt: z.string(),
      materials: z.array(z.object({ id: z.string(), updatedAt: z.string() })),
    })
    .safeParse(inputs);
  if (
    !parsed.success ||
    parsed.data.unitUpdatedAt !== unit.updatedAt.toISOString()
  )
    return true;
  return parsed.data.materials.some(
    (saved) =>
      !materials.some(
        (current) =>
          current.id === saved.id &&
          current.status === "READY" &&
          current.updatedAt.toISOString() === saved.updatedAt,
      ),
  );
}
