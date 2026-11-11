/**
 * Ranking, de-duplication and summarising of PYQ question search results (pure functions).
 *
 * Vector similarity alone ranks loosely for short topics ("Binary Trees") against long questions, so it is
 * blended with a lexical signal: how many topic words appear in the question, and whether the whole phrase does.
 * Questions that repeat across years are merged into one entry listing every paper they appeared in.
 */

export interface PaperRef {
    id: string;
    title: string;
    year: number;
    examType: string; // "Mid-Sem" | "End-Sem"
    subjectCode: string;
    subjectName: string;
    fileUrl: string;
}

export interface Candidate {
    id: string;
    questionIndex: number;
    label: string | null;
    marks: number | null;
    pageNumber: number | null; // known for scanned papers
    source: "text" | "scan"; // "scan" = transcribed from a scanned page by a vision model
    text: string;
    similarity: number | null; // cosine similarity, null if the question has no embedding
    paper: PaperRef;
}

export interface Ranked extends Candidate {
    score: number;
    exactMatch: boolean; // the topic phrase appears in the question
    termMatch: number; // 0..1, share of topic words present
}

export interface Appearance {
    questionId: string;
    label: string | null;
    marks: number | null;
    pageNumber: number | null;
    paper: PaperRef;
}

export interface QuestionGroup {
    id: string;
    text: string;
    label: string | null;
    marks: number | null;
    source: "text" | "scan"; // of the best-matching appearance
    score: number;
    similarity: number | null;
    exactMatch: boolean;
    termMatch: number;
    appearances: Appearance[]; // newest paper first; includes the primary one
}

export interface PaperSummary {
    paper: PaperRef;
    questionCount: number;
    labels: string[];
}

const STOP = new Set([
    "the", "and", "for", "with", "from", "that", "this", "what", "write", "explain", "define", "short", "note",
    "notes", "give", "discuss", "describe", "state", "using", "also", "are", "its", "any", "all", "how", "why",
]);

function stem(w: string): string {
    if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
    return w;
}

/** Lowercased, de-pluralised words (keeps things like c++ / c#); drops stop-words and 1-2 letter words. */
export function tokens(s: string): string[] {
    const words = s.toLowerCase().match(/[a-z0-9+#]+/g) ?? [];
    return words.filter((w) => (w.length >= 3 || /[+#]/.test(w)) && !STOP.has(w)).map(stem);
}

function containsSequence(hay: string[], needle: string[]): boolean {
    if (needle.length === 0 || needle.length > hay.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
        let ok = true;
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) {
                ok = false;
                break;
            }
        }
        if (ok) return true;
    }
    return false;
}

export function rankCandidates(
    topic: string,
    candidates: Candidate[],
    opts: { limit?: number; window?: number } = {},
): Ranked[] {
    const { limit = 12, window = 0.1 } = opts;
    const byId = new Map<string, Candidate>();
    for (const c of candidates) {
        const prev = byId.get(c.id);
        if (!prev || (c.similarity ?? -1) > (prev.similarity ?? -1)) byId.set(c.id, c);
    }

    const tTokens = tokens(topic);
    const tUnique = [...new Set(tTokens)];

    // Questions without an embedding get a neutral similarity (median of the rest), so a literal match for the topic
    // can still compete with embedded questions instead of being scored as "0% similar".
    const known = [...byId.values()].map((c) => c.similarity).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const neutral = known.length > 0 ? known[Math.floor(known.length / 2)]! : 0.5;

    const ranked: Ranked[] = [];
    for (const c of byId.values()) {
        const qTokens = tokens(c.text);
        const qSet = new Set(qTokens);
        const hit = tUnique.filter((t) => qSet.has(t)).length;
        const termMatch = tUnique.length > 0 ? hit / tUnique.length : 0;
        const exactMatch = containsSequence(qTokens, tTokens);
        if (c.similarity === null && termMatch === 0) continue; // nothing connects this question to the topic
        // Drop weak semantic-only matches (no lexical signal + low similarity).
        // These are tangentially related questions the embedding model pulls in.
        if (termMatch === 0 && !exactMatch && (c.similarity ?? 0) < 0.45) continue;
        ranked.push({
            ...c,
            // Stronger lexical weights ensure questions that literally mention the topic
            // rank above purely semantic matches ("tree traversal" vs "binary trees").
            score: (c.similarity ?? neutral) + 0.15 * termMatch + (exactMatch ? 0.12 : 0),
            exactMatch,
            termMatch,
        });
    }

    ranked.sort((a, b) => b.score - a.score || b.paper.year - a.paper.year);
    const best = ranked[0]?.score;
    if (best === undefined) return [];
    return ranked.filter((r) => r.score >= best - window).slice(0, limit);
}

const wordSet = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

/** Merge questions that repeat across papers/years (near-identical wording). Input must be best-first. */
export function groupDuplicates(ranked: Ranked[], threshold = 0.8): QuestionGroup[] {
    const groups: { g: QuestionGroup; words: Set<string> }[] = [];
    for (const r of ranked) {
        const words = wordSet(r.text);
        const appearance: Appearance = { questionId: r.id, label: r.label, marks: r.marks, pageNumber: r.pageNumber, paper: r.paper };
        const existing = groups.find((x) => jaccard(x.words, words) >= threshold);
        if (existing) {
            existing.g.appearances.push(appearance);
            continue;
        }
        groups.push({
            words,
            g: {
                id: r.id,
                text: r.text,
                label: r.label,
                marks: r.marks,
                source: r.source,
                score: r.score,
                similarity: r.similarity,
                exactMatch: r.exactMatch,
                termMatch: r.termMatch,
                appearances: [appearance],
            },
        });
    }
    for (const { g } of groups) {
        g.appearances.sort((a, b) => b.paper.year - a.paper.year || a.paper.examType.localeCompare(b.paper.examType));
    }
    return groups.map((x) => x.g);
}

/** Which papers the matched questions come from (newest first), with the question labels in each. */
export function summarizePapers(groups: QuestionGroup[]): PaperSummary[] {
    const byPaper = new Map<string, PaperSummary>();
    for (const g of groups) {
        for (const a of g.appearances) {
            const s = byPaper.get(a.paper.id) ?? { paper: a.paper, questionCount: 0, labels: [] };
            s.questionCount++;
            if (a.label && !s.labels.includes(a.label)) s.labels.push(a.label);
            byPaper.set(a.paper.id, s);
        }
    }
    return [...byPaper.values()].sort(
        (a, b) => b.paper.year - a.paper.year || a.paper.examType.localeCompare(b.paper.examType),
    );
}

export function yearsOf(papers: PaperSummary[]): number[] {
    return [...new Set(papers.map((p) => p.paper.year))].sort((a, b) => b - a);
}