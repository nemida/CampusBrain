/**
 * Past-paper analytics and mock-paper building, on top of what the project already has:
 * syllabus units (SyllabusItem), indexed past questions (PaperQuestion + embeddings), and the LLM helper.
 *
 *  - analyzeSubject():  which syllabus topics the past papers keep asking about, and in which years.
 *  - buildMockPaper():  an exam-style paper that covers the syllabus (weighted by unit hours and how often a
 *                       topic is asked), using real past questions, AI variants of them, or new questions.
 */
import { prisma } from "./prisma.js";
import { chatComplete, extractJSON } from "./ai.js";
import { searchTopicQuestions, cleanTopic } from "./pyqSearch.js";
import type { QuestionGroup } from "./questionSearch.js";

const MAX_TOPICS_ANALYSED = 40;
const PER_TOPIC_QUESTIONS = 12;
const MAX_QUESTION_CHARS = 700;

/** A past question counts as "about" a topic only if it clearly relates (not just the nearest of a bad lot). */
const MIN_SIMILARITY = 0.62;
const MIN_TERM_MATCH = 0.5;

const relevant = (g: QuestionGroup) =>
    g.exactMatch || g.termMatch >= MIN_TERM_MATCH || (g.similarity ?? 0) >= MIN_SIMILARITY;

/* ------------------------------------------------------------------ */
/* Topic frequency                                                     */
/* ------------------------------------------------------------------ */

interface Unit {
    unitNumber: number;
    title: string;
    topics: string[];
    hours: number | null;
}

export interface TopicStat {
    topic: string;
    unit: string;
    timesAsked: number; // appearances across papers (a question repeated in 3 papers counts 3)
    distinctQuestions: number;
    years: number[]; // newest first
    totalMarks: number; // marks across all appearances, where known
}

export interface SubjectAnalysis {
    subject: { id: string; name: string; code: string };
    units: Unit[];
    papers: number;
    questionsIndexed: number;
    semantic: boolean;
    stats: TopicStat[]; // sorted: most asked first
    /** per topic: the past questions assigned to it (each question belongs to its best-matching topic only) */
    pool: Map<string, QuestionGroup[]>;
    topicUnit: Map<string, Unit>;
}

const unitLabel = (u: Unit) => `Unit ${u.unitNumber}: ${u.title.replace(/^Unit \d+:?\s*/i, "")}`;

export async function analyzeSubject(
    subjectId: string,
    onlyTopics?: string[],
): Promise<SubjectAnalysis | { error: string }> {
    const subject = await prisma.subject.findUnique({
        where: { id: subjectId },
        select: { id: true, name: true, code: true },
    });
    if (!subject) return { error: "Subject not found." };

    const units = await prisma.syllabusItem.findMany({
        where: { subjectId },
        orderBy: { unitNumber: "asc" },
        select: { unitNumber: true, title: true, topics: true, hours: true },
    });
    if (units.length === 0) return { error: `No syllabus is available for ${subject.name}.` };

    // (topic -> unit), trimmed to a budget that spreads evenly over the units
    const perUnit = Math.max(3, Math.ceil(MAX_TOPICS_ANALYSED / units.length));
    const filter = onlyTopics?.map((t) => t.toLowerCase().trim()).filter(Boolean) ?? [];
    const topicUnit = new Map<string, Unit>();
    for (const u of units) {
        let taken = 0;
        for (const raw of u.topics) {
            const t = cleanTopic(raw);
            if (t.length < 2 || topicUnit.has(t)) continue;
            if (
                filter.length > 0 &&
                !filter.some((f) => t.toLowerCase().includes(f) || u.title.toLowerCase().includes(f))
            ) {
                continue;
            }
            if (taken >= perUnit) break;
            topicUnit.set(t, u);
            taken++;
        }
    }
    if (topicUnit.size === 0) return { error: "None of those topics are in this subject's syllabus." };

    const [papers, questionsIndexed] = await Promise.all([
        prisma.resource.count({ where: { subjectId, type: "PAPER" } }),
        prisma.paperQuestion.count({ where: { subjectId } }),
    ]);

    const { results, semantic } =
        questionsIndexed > 0
            ? await searchTopicQuestions([...topicUnit.keys()], subjectId, PER_TOPIC_QUESTIONS)
            : { results: [], semantic: false };

    // Give every question to the one topic it matches best, so it isn't counted for several topics.
    const best = new Map<string, { topic: string; group: QuestionGroup }>();
    for (const r of results) {
        for (const g of r.groups) {
            if (!relevant(g)) continue;
            const prev = best.get(g.id);
            if (!prev || g.score > prev.group.score) best.set(g.id, { topic: r.topic, group: g });
        }
    }
    const pool = new Map<string, QuestionGroup[]>();
    for (const { topic, group } of best.values()) {
        const list = pool.get(topic) ?? [];
        list.push(group);
        pool.set(topic, list);
    }

    const stats: TopicStat[] = [...topicUnit.entries()].map(([topic, unit]) => {
        const groups = pool.get(topic) ?? [];
        const years = new Set<number>();
        let timesAsked = 0;
        let totalMarks = 0;
        for (const g of groups) {
            for (const a of g.appearances) {
                years.add(a.paper.year);
                timesAsked++;
                totalMarks += a.marks ?? g.marks ?? 0;
            }
        }
        return {
            topic,
            unit: unitLabel(unit),
            timesAsked,
            distinctQuestions: groups.length,
            years: [...years].sort((a, b) => b - a),
            totalMarks,
        };
    });
    stats.sort(
        (a, b) =>
            b.timesAsked - a.timesAsked ||
            b.totalMarks - a.totalMarks ||
            (b.years[0] ?? 0) - (a.years[0] ?? 0) ||
            a.topic.localeCompare(b.topic),
    );

    return { subject, units, papers, questionsIndexed, semantic, stats, pool, topicUnit };
}

/* ------------------------------------------------------------------ */
/* Mock paper                                                          */
/* ------------------------------------------------------------------ */

export type MockMode = "existing" | "variants" | "mixed";

export interface MockQuestion {
    no: number;
    text: string;
    marks: number;
    origin: "pyq" | "variant" | "new";
    unit: string;
    topic: string;
    /** where a real/original question came from, e.g. "Winter 2023 End-Sem" */
    source?: string;
}

export interface MockSection {
    name: string;
    instructions: string;
    questions: MockQuestion[];
}

export interface MockPaper {
    title: string;
    subjectName: string;
    subjectCode: string;
    totalMarks: number;
    durationMinutes: number;
    instructions: string[];
    sections: MockSection[];
    coverage: { unit: string; questions: number; marks: number }[];
    generatedOn: string;
}

interface Slot {
    section: number;
    marks: number;
    topic?: string;
    unit?: Unit;
    pyq?: QuestionGroup;
    kind?: "pyq" | "variant" | "new";
    text?: string;
}

const SECTION_DEFS = [
    { name: "Section A", marks: 2, label: "Short answer" },
    { name: "Section B", marks: 5, label: "Medium answer" },
    { name: "Section C", marks: 10, label: "Long answer" },
] as const;

/** Question counts per section for a paper of `total` marks (about 20% / 30% / 50% of the marks). */
function planSections(total: number): number[] {
    const a = Math.max(0, Math.round((total * 0.2) / 2));
    const b = Math.max(0, Math.round((total * 0.3) / 5));
    const rest = total - a * 2 - b * 5;
    const c = Math.max(rest >= 5 ? 1 : 0, Math.round(rest / 10));
    return [a, b, c];
}

const sourceLabel = (g: QuestionGroup) => {
    const a = g.appearances[0];
    return a ? `${a.paper.year} ${a.paper.examType}${a.label ? ` ${a.label}` : ""}` : undefined;
};

/** Pick the topic for each slot: weight by unit hours and past frequency, spread across topics and units. */
function assignTopics(slots: Slot[], analysis: SubjectAnalysis): void {
    const totalHours = analysis.units.reduce((s, u) => s + (u.hours ?? 0), 0);
    const unitWeight = (u: Unit) => (totalHours > 0 ? (u.hours ?? totalHours / analysis.units.length) : 1);
    const topicsInUnit = new Map<Unit, number>();
    for (const u of analysis.topicUnit.values()) topicsInUnit.set(u, (topicsInUnit.get(u) ?? 0) + 1);

    const usedTopic = new Map<string, number>();
    const usedUnit = new Map<Unit, number>();
    const freq = new Map(analysis.stats.map((s) => [s.topic, s.timesAsked]));

    for (const slot of slots) {
        let bestTopic: string | null = null;
        let bestScore = -1;
        for (const [topic, unit] of analysis.topicUnit) {
            const base = unitWeight(unit) / (topicsInUnit.get(unit) ?? 1);
            const boost = 1 + Math.min(5, freq.get(topic) ?? 0);
            const hasQuestions = (analysis.pool.get(topic)?.length ?? 0) > (usedTopic.get(topic) ?? 0) ? 1.3 : 1;
            const score =
                (base * boost * hasQuestions) /
                (1 + 3 * (usedTopic.get(topic) ?? 0)) /
                (1 + (usedUnit.get(unit) ?? 0));
            if (score > bestScore) {
                bestScore = score;
                bestTopic = topic;
            }
        }
        if (!bestTopic) continue;
        const unit = analysis.topicUnit.get(bestTopic)!;
        slot.topic = bestTopic;
        slot.unit = unit;
        usedTopic.set(bestTopic, (usedTopic.get(bestTopic) ?? 0) + 1);
        usedUnit.set(unit, (usedUnit.get(unit) ?? 0) + 1);
    }
}

/** Longest slots first, so big questions get first pick of the matching-marks pool. */
function assignPastQuestions(slots: Slot[], analysis: SubjectAnalysis): void {
    const taken = new Set<string>();
    const order = slots.map((s, i) => ({ s, i })).sort((a, b) => b.s.marks - a.s.marks || a.i - b.i);
    for (const { s } of order) {
        if (!s.topic) continue;
        const candidates = (analysis.pool.get(s.topic) ?? [])
            .filter((g) => !taken.has(g.id))
            .filter((g) => g.marks === null || (g.marks >= s.marks / 2 && g.marks <= s.marks * 2))
            .sort((a, b) => {
                const da = a.marks === null ? 1.5 : Math.abs(a.marks - s.marks);
                const db = b.marks === null ? 1.5 : Math.abs(b.marks - s.marks);
                return da - db || b.appearances.length - a.appearances.length || b.score - a.score;
            });
        const pick = candidates[0];
        if (pick) {
            taken.add(pick.id);
            s.pyq = pick;
        }
    }
}

async function writeWithAI(
    subjectName: string,
    items: { id: number; kind: "variant" | "new"; topic: string; unit: string; marks: number; original?: string }[],
): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (items.length === 0) return out;

    const prompt = `You are setting a university exam paper for "${subjectName}".
For each item write ONE exam question worth the stated marks, in the style of a typical university exam (use verbs like "Explain", "Write a program to", "Differentiate", "Derive", "Solve").
- kind "variant": rewrite the original question as a fresh variant on the same concept and difficulty (change numbers, scenario or data; keep it answerable). Do not copy it word for word.
- kind "new": write a new question on the given topic from the given unit.
Marks guide: 2 = one-line / definition, 5 = short explanation or small problem, 10 = long answer, derivation or program.
Do not include answers, marks or numbering in the text.

Items:
${JSON.stringify(items)}

Return JSON only: {"items":[{"id":0,"question":"..."}]}`;

    const result = await chatComplete([{ role: "user", content: prompt }]);
    if (!result) return out;
    const parsed = extractJSON<{ items?: unknown[] } | unknown[]>(result.content);
    const list = Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
    for (const it of list) {
        if (!it || typeof it !== "object") continue;
        const { id, question } = it as { id?: unknown; question?: unknown };
        if (typeof id !== "number" || typeof question !== "string") continue;
        const text = question.replace(/\s+/g, " ").trim();
        if (text.length >= 10) out.set(id, text.slice(0, MAX_QUESTION_CHARS));
    }
    return out;
}

export async function buildMockPaper(opts: {
    subjectId: string;
    totalMarks?: number | undefined;
    mode?: MockMode | undefined;
    topics?: string[] | undefined;
    title?: string | undefined;
}): Promise<{ paper: MockPaper; counts: { pyq: number; variant: number; new: number }; warnings: string[] } | { error: string }> {
    const total = Math.min(100, Math.max(10, Math.round(opts.totalMarks ?? 50)));
    const mode: MockMode = opts.mode ?? "mixed";
    const warnings: string[] = [];

    const analysis = await analyzeSubject(opts.subjectId, opts.topics);
    if ("error" in analysis) return analysis;

    const counts = planSections(total);
    const slots: Slot[] = [];
    counts.forEach((n, section) => {
        for (let i = 0; i < n; i++) slots.push({ section, marks: SECTION_DEFS[section]!.marks });
    });
    if (slots.length === 0) return { error: "Total marks too small to build a paper." };

    assignTopics(slots, analysis);
    assignPastQuestions(slots, analysis);

    if (analysis.questionsIndexed === 0) {
        warnings.push("No past papers are indexed for this subject yet, so every question is AI-written from the syllabus.");
    } else if (analysis.pool.size === 0) {
        warnings.push("No past questions could be matched to the syllabus topics, so questions are AI-written.");
    }

    // Decide how each slot is filled
    let pyqIndex = 0;
    for (const s of slots) {
        if (!s.topic) continue;
        if (!s.pyq) {
            s.kind = "new";
            continue;
        }
        const asVariant = mode === "variants" || (mode === "mixed" && pyqIndex % 2 === 1);
        s.kind = asVariant ? "variant" : "pyq";
        pyqIndex++;
    }

    // One batched model call for everything that needs writing
    const needWriting = slots
        .map((s, id) => ({ s, id }))
        .filter(({ s }) => s.kind === "variant" || s.kind === "new");
    const written = await writeWithAI(
        analysis.subject.name,
        needWriting.map(({ s, id }) => ({
            id,
            kind: s.kind as "variant" | "new",
            topic: s.topic!,
            unit: unitLabel(s.unit!),
            marks: s.marks,
            ...(s.kind === "variant" ? { original: s.pyq!.text.slice(0, MAX_QUESTION_CHARS) } : {}),
        })),
    );

    let fellBack = 0;
    let dropped = 0;
    slots.forEach((s, id) => {
        if (s.kind === "pyq") {
            s.text = s.pyq!.text.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
        } else {
            const text = written.get(id);
            if (text) s.text = text;
            else if (s.kind === "variant") {
                s.kind = "pyq"; // AI unavailable: keep the real question rather than lose it
                s.text = s.pyq!.text.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
                fellBack++;
            } else dropped++;
        }
    });
    if (fellBack > 0) warnings.push(`${fellBack} variant(s) could not be written, so the original past question is used.`);
    if (dropped > 0) warnings.push(`${dropped} question(s) could not be written and were left out.`);

    const sections: MockSection[] = SECTION_DEFS.map((def, si) => {
        const chosen = slots
            .filter((s) => s.section === si && s.text && s.unit)
            .sort((a, b) => a.unit!.unitNumber - b.unit!.unitNumber);
        return {
            name: `${def.name} — ${def.label} (${def.marks} marks each)`,
            instructions:
                si === 0
                    ? "Answer all questions."
                    : si === 1
                        ? "Answer all questions. Each carries 5 marks."
                        : "Answer all questions. Each carries 10 marks.",
            questions: chosen.map((s) => ({
                no: 0,
                text: s.text!,
                marks: s.marks,
                origin: s.kind!,
                unit: unitLabel(s.unit!),
                topic: s.topic!,
                ...(s.pyq && s.kind !== "new" ? { source: sourceLabel(s.pyq) ?? "" } : {}),
            })),
        };
    }).filter((sec) => sec.questions.length > 0);

    let n = 1;
    for (const sec of sections) for (const q of sec.questions) q.no = n++;

    const all = sections.flatMap((sec) => sec.questions);
    if (all.length === 0) return { error: "Could not build any questions. Please try again." };

    const byUnit = new Map<string, { questions: number; marks: number }>();
    for (const q of all) {
        const e = byUnit.get(q.unit) ?? { questions: 0, marks: 0 };
        e.questions++;
        e.marks += q.marks;
        byUnit.set(q.unit, e);
    }
    const uncovered = analysis.units.filter((u) => !byUnit.has(unitLabel(u)));
    if (uncovered.length > 0 && !opts.topics?.length) {
        warnings.push(`Not covered (paper too short): ${uncovered.map((u) => `Unit ${u.unitNumber}`).join(", ")}.`);
    }

    const actualTotal = all.reduce((s, q) => s + q.marks, 0);
    const paper: MockPaper = {
        title: opts.title?.trim() || `${analysis.subject.name} — Mock Paper`,
        subjectName: analysis.subject.name,
        subjectCode: analysis.subject.code,
        totalMarks: actualTotal,
        durationMinutes: Math.max(30, Math.round((actualTotal * 1.8) / 15) * 15),
        instructions: [
            "Answer all questions.",
            "Figures to the right indicate marks.",
            "Make suitable assumptions wherever necessary and state them clearly.",
        ],
        sections,
        coverage: [...byUnit.entries()].map(([unit, v]) => ({ unit, ...v })),
        generatedOn: new Date().toISOString().slice(0, 10),
    };

    return {
        paper,
        counts: {
            pyq: all.filter((q) => q.origin === "pyq").length,
            variant: all.filter((q) => q.origin === "variant").length,
            new: all.filter((q) => q.origin === "new").length,
        },
        warnings,
    };
}
