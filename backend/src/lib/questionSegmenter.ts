/**
 * Splits the text of an exam paper into individual questions.
 *
 * EXACTNESS GUARANTEE: question text is always a verbatim slice of the paper's own text.
 * The LLM (when used) only points at where each question STARTS ("anchors"); it never rewrites anything.
 * If the LLM is unavailable, a simple "Q1 / Question 2" heuristic is used instead.
 */

export interface Anchor {
    label: string | null; // as printed, e.g. "Q3(b)"
    startsWith: string; // first words of the question, copied from the paper (after the label)
    marks: number | null;
}

export interface RawQuestion {
    index: number;
    label: string | null;
    marks: number | null;
    text: string;
}

export const MIN_QUESTION_LENGTH = 15;
export const MAX_QUESTION_LENGTH = 2500; // anything longer is almost certainly several questions / filler, so it is dropped, not truncated

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Small text helpers ───────────────────────────────────────────────────────

/** Remove CRs and trailing spaces, collapse blank-line runs. Content is otherwise untouched. */
function tidy(s: string): string {
    return s
        .replace(/\r/g, "")
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/g, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// Labels / separators that belong to the NEXT question but end up at the tail of this one
const TAIL_Q_LABEL = /(?:^|\s)Q(?:uestion)?\.?[ \t]*\d{1,2}(?:[ \t]*[.):\-–])?(?:[ \t]*\(?[a-z]\)[.)]?)?[ \t]*$/i;
const TAIL_SUB_LABEL = /(?:^|\n)[ \t]*(?:\(?[a-z]\)|\(\d{1,2}\)|\d{1,2}[.)])[ \t]*$/i;
const TAIL_SEPARATOR =
    /(?:^|\n)[ \t]*(?:OR|SECTION[ \t]*[-–:]?[ \t]*[A-Z0-9]+|Section[ \t]*[-–:]?[ \t]*[A-Z0-9]+|UNIT[ \t]*[-–:]?[ \t]*[IVX0-9]+)[ \t]*$/;
const TAIL_FOOTER =
    /\n[ \t]*(?:[*\-_=~ ]{2,})?[ \t]*(?:End of (?:Paper|Exam(?:ination)?)|Page[ \t]*\d+(?:[ \t]*(?:of|\/)[ \t]*\d+)?|P\.?T\.?O\.?)[ \t]*(?:[*\-_=~ ]{2,})?[ \t]*$/i;

export function stripTrailingNoise(input: string): string {
    let s = input.replace(/\s+$/g, "");
    for (let i = 0; i < 6; i++) {
        const tailStart = Math.max(0, s.length - 60);
        const tail = s.slice(tailStart);
        let cut = -1;
        for (const re of [TAIL_FOOTER, TAIL_SEPARATOR, TAIL_Q_LABEL, TAIL_SUB_LABEL]) {
            const m = re.exec(tail);
            if (m && m.index !== undefined && (cut === -1 || m.index < cut)) cut = m.index;
        }
        if (cut === -1) break;
        s = s.slice(0, tailStart + cut).replace(/\s+$/g, "");
    }
    return s;
}

const LEADING_LABEL = /^\s*(?:Q(?:uestion)?\.?[ \t]*(\d{1,2})[ \t]*[.):\-–]?[ \t]*(?:\(?([a-z])\)[.)]?[ \t]*)?)/i;

/** If the text starts with a printed label ("Q3." / "Q3(b)"), split it off. */
export function splitLeadingLabel(text: string): { label: string | null; rest: string } {
    const m = LEADING_LABEL.exec(text);
    if (!m) return { label: null, rest: text };
    return { label: `Q${m[1]}${m[2] ? `(${m[2].toLowerCase()})` : ""}`, rest: text.slice(m[0].length) };
}

/** Marks as printed: "[5]", "(10 marks)", "5 marks". Uses the LAST mention (marks usually end the question). */
export function parseMarks(s: string): number | null {
    let found: number | null = null;
    for (const m of s.matchAll(/\[\s*(\d{1,2})\s*\]|\(\s*(\d{1,2})\s*marks?\s*\)|\b(\d{1,2})\s*marks?\b/gi)) {
        const v = Number(m[1] ?? m[2] ?? m[3]);
        if (Number.isInteger(v) && v > 0 && v <= 100) found = v;
    }
    return found;
}

// ── Swallow guard ────────────────────────────────────────────────────────────
// If the LLM misses a question's anchor, the previous question would swallow it. Any further printed
// "Q<n>" line inside a slice is therefore treated as a question start of its own.

const INNER_Q_MARKER = /\n[ \t]*Q(?:uestion)?[ \t]*\.?[ \t]*(\d{1,2})[ \t]*[.):\-–]?[ \t]*/gi;

function splitAtQuestionMarkers(raw: string): { label: string | null; text: string }[] {
    const ms = [...raw.matchAll(INNER_Q_MARKER)];
    if (ms.length === 0) return [{ label: null, text: raw }];
    const out: { label: string | null; text: string }[] = [{ label: null, text: raw.slice(0, ms[0]!.index) }];
    ms.forEach((m, i) => {
        const start = m.index! + m[0].length;
        const end = i + 1 < ms.length ? ms[i + 1]!.index! : raw.length;
        out.push({ label: `Q${m[1]}`, text: raw.slice(start, end) });
    });
    return out;
}

// ── Anchor-based slicing (LLM tells us where questions start) ────────────────

/** Position of `startsWith` in `text` at or after `from`, tolerant to whitespace; -1 if not found. */
export function findAnchor(text: string, startsWith: string, from: number): number {
    const words = startsWith.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return -1;
    const lengths = [...new Set([words.length, Math.min(words.length, 6), Math.min(words.length, 4), Math.min(words.length, 3)])]
        .filter((n) => n >= 2)
        .sort((a, b) => b - a);
    const hay = text.slice(from);
    for (const n of lengths) {
        const re = new RegExp(words.slice(0, n).map(escapeRe).join("\\s+"), "i");
        const m = re.exec(hay);
        if (m) return from + m.index;
    }
    return -1;
}

export function sliceByAnchors(
    text: string,
    anchors: Anchor[],
): { questions: RawQuestion[]; unanchored: number } {
    const located: { a: Anchor; pos: number }[] = [];
    let cursor = 0;
    let unanchored = 0;
    const seen = new Set<string>();
    for (const a of anchors) {
        const key = a.startsWith.toLowerCase().replace(/\s+/g, " ").trim();
        if (seen.has(key)) continue; // overlapping LLM windows can repeat an anchor
        seen.add(key);
        const pos = findAnchor(text, a.startsWith, cursor);
        if (pos < 0) {
            unanchored++;
            continue;
        }
        located.push({ a, pos });
        cursor = pos + 1;
    }

    const questions: RawQuestion[] = [];
    const push = (label: string | null, marks: number | null, rawText: string) => {
        const t = tidy(stripTrailingNoise(rawText));
        if (t.length < MIN_QUESTION_LENGTH || t.length > MAX_QUESTION_LENGTH) return;
        questions.push({ index: questions.length, label, marks: marks ?? parseMarks(t), text: t });
    };

    located.forEach(({ a, pos }, i) => {
        const end = i + 1 < located.length ? located[i + 1]!.pos : text.length;
        const [first, ...recovered] = splitAtQuestionMarkers(text.slice(pos, end));
        // if the model included the label inside startsWith, move it out of the text
        const { label: inlineLabel, rest } = splitLeadingLabel(first!.text);
        push(a.label ?? inlineLabel, a.marks, rest);
        // questions the model missed, recovered from their printed numbers
        for (const r of recovered) push(r.label, null, r.text);
    });
    return { questions, unanchored };
}

/** Validate whatever the LLM returned into Anchors. */
export function parseAnchorResponse(raw: unknown): Anchor[] {
    if (!raw || typeof raw !== "object") return [];
    const list = (raw as { questions?: unknown }).questions;
    if (!Array.isArray(list)) return [];
    const out: Anchor[] = [];
    for (const q of list) {
        if (!q || typeof q !== "object") continue;
        const { label, startsWith, marks } = q as Record<string, unknown>;
        if (typeof startsWith !== "string" || startsWith.trim().split(/\s+/).length < 2) continue;
        const m = typeof marks === "number" && Number.isInteger(marks) && marks > 0 && marks <= 100 ? marks : null;
        out.push({
            label: typeof label === "string" && label.trim() ? label.trim().slice(0, 20) : null,
            startsWith: startsWith.trim().slice(0, 200),
            marks: m,
        });
    }
    return out;
}

// ── Heuristic fallback (no LLM): "Q1.", "Question 2:" ───────────────────────

const Q_MARKER = /(?:^|\n)[ \t]*Q(?:uestion)?[ \t]*\.?[ \t]*(\d{1,2})[ \t]*[.):\-–]?[ \t]*/gi;

export function segmentByQuestionNumbers(text: string): RawQuestion[] {
    const marks = [...text.matchAll(Q_MARKER)];
    if (marks.length < 2) return [];
    const out: RawQuestion[] = [];
    marks.forEach((m, i) => {
        const start = m.index! + m[0].length;
        const end = i + 1 < marks.length ? marks[i + 1]!.index! : text.length;
        let t = tidy(stripTrailingNoise(text.slice(start, end)));
        if (t.length < MIN_QUESTION_LENGTH) return;
        if (t.length > MAX_QUESTION_LENGTH) t = t.slice(0, MAX_QUESTION_LENGTH);
        out.push({ index: out.length, label: `Q${m[1]}`, marks: parseMarks(t), text: t });
    });
    return out;
}