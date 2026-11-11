/**
 * Study-plan building blocks (pure functions, no DB access, easy to unit-test).
 *
 *  - matchExamDates*:  match timetable entries to enrolled subjects (token-based, one-to-one)
 *  - prioritizeTopics: pull high-yield (frequent in past papers) topics forward, keep syllabus order otherwise
 *  - buildSmartDays:   time-budgeted, multi-subject daily schedule that is aware of exam deadlines
 *  - planCatchUp:      re-plan the rest of a plan from today, skipping finished work
 *
 * All calendar logic uses IST (UTC+5:30, no DST) so "day N" lines up with the dashboard's IST day keys.
 */

export const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 19_800_000;

/** Midnight (00:00 IST) of the IST calendar day containing `d`, as a UTC instant. */
export function istMidnight(d: Date): Date {
    const k = new Date(d.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - IST_OFFSET_MS);
}

/** Whole IST calendar days from `from` to `to` (negative if `to` is earlier). */
export function istDayDiff(from: Date, to: Date): number {
    return Math.round((istMidnight(to).getTime() - istMidnight(from).getTime()) / DAY_MS);
}

const fmtDay = (d: Date) =>
    d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

// ── Exam matching ─────────────────────────────────────────────────────────────

export interface ExtractedExam {
    subjectName: string;
    date: string; // YYYY-MM-DD
}

const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8" };
const STOP = new Set(["and", "of", "the", "in", "to", "for", "a", "an"]);
/** Words that make two otherwise-similar names different papers ("Physics" ≠ "Physics Lab"). */
const QUALIFIERS = new Set(["lab", "laboratory", "practical", "workshop", "tutorial", "viva", "project"]);
/** Common abbreviations in Indian university timetables. */
const ALIASES: Record<string, string> = {
    maths: "mathematics",
    math: "mathematics",
    phy: "physics",
    chem: "chemistry",
    bio: "biology",
    engg: "engineering",
    eng: "engineering",
    comp: "computer",
    prog: "programming",
    elec: "electrical",
    mech: "mechanics",
    dsa: "data structures algorithms",
    oop: "object oriented programming",
    os: "operating systems",
    dbms: "database management systems",
    cn: "computer networks",
};

function tokens(s: string): string[] {
    return s
        .toLowerCase()
        .replace(/&/g, " and ")
        // "Sem 2", "Term II", "Year 1": a semester marker, not part of the paper's identity
        .replace(/\b(?:sem(?:ester)?|term|year)\s*[-:]?\s*(?:\d+|[ivx]+)\b/g, " ")
        // course codes such as CIC-305 / BS-112 would otherwise poison the numeral check
        .replace(/\b[a-z]{2,5}[-\s]?\d{3,4}\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter((t) => t && !STOP.has(t))
        .flatMap((t) => (ALIASES[t] ?? t).split(" "))
        .map((t) => ROMAN[t] ?? t);
}

const numeralsOf = (set: Set<string>) => [...set].filter((t) => /^\d+$/.test(t)).sort().join(",");

/**
 * Does the subject's code appear in the timetable line as a whole code?
 * Only codes that contain a digit count ("CIC-305", "BS112"). Slug codes like APPLIED_MATHEMATICS_I
 * say nothing the name doesn't, and are dangerous: "…_I" is a substring of "…_II".
 * "CIC-30" must not match "CIC-305" either, hence the boundaries.
 */
function codeMatches(code: string, examName: string): boolean {
    const parts = code.toLowerCase().match(/[a-z]+|\d+/g);
    if (!parts || !parts.some((p) => /^\d+$/.test(p))) return false;
    const re = new RegExp(`(?<![a-z0-9])${parts.join("[^a-z0-9]*")}(?![a-z0-9])`);
    return re.test(examName.toLowerCase());
}

/**
 * 0..1 similarity between a subject and a timetable line.
 *  - subject code appearing as a whole word → 1
 *  - numerals must agree when both sides have them ("Maths I" ≠ "Maths II")
 *  - Jaccard overlap of name tokens, plus a "one name is fully inside the other" score so that
 *    "Mathematics" still matches "Engineering Mathematics" (but not "Mathematics Lab").
 */
function similarity(subject: { name: string; code: string }, examName: string): number {
    if (codeMatches(subject.code, examName)) return 1;

    const a = new Set(tokens(subject.name));
    const b = new Set(tokens(examName));
    if (a.size === 0 || b.size === 0) return 0;

    const numsA = numeralsOf(a);
    const numsB = numeralsOf(b);
    if (numsA && numsB && numsA !== numsB) return 0;

    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const jaccard = inter / (a.size + b.size - inter);

    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let containment = 0;
    if (inter === small.size && numsA === numsB) {
        const extras = [...large].filter((t) => !small.has(t));
        if (!extras.some((t) => QUALIFIERS.has(t))) containment = 0.85;
    }
    return Math.max(jaccard, containment);
}

/**
 * Parse a timetable date to IST midnight. `YYYY-MM-DD` is parsed explicitly (server timezone never
 * matters) and impossible dates like 2026-02-31 are rejected. Anything else falls back to Date.parse.
 */
export function parseExamDate(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
    if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const utc = new Date(Date.UTC(y, mo - 1, d));
        if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
        return new Date(utc.getTime() - IST_OFFSET_MS);
    }
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : istMidnight(parsed);
}

export interface MatchResult {
    /** subjectId → exam date (IST midnight) */
    matched: Map<string, Date>;
    /** timetable lines that matched no enrolled subject */
    unmatched: ExtractedExam[];
}

/** One-to-one matching: best-scoring pairs first; a subject or exam line is never used twice. */
export function matchExamDatesDetailed(
    subjects: { id: string; name: string; code: string }[],
    exams: ExtractedExam[],
    threshold = 0.6,
): MatchResult {
    const pairs: { sid: string; ei: number; score: number; date: Date }[] = [];
    exams.forEach((e, ei) => {
        const date = parseExamDate(e.date);
        if (!date) return;
        for (const s of subjects) {
            const score = similarity(s, e.subjectName);
            if (score >= threshold) pairs.push({ sid: s.id, ei, score, date });
        }
    });
    pairs.sort((x, y) => y.score - x.score || x.date.getTime() - y.date.getTime());

    const matched = new Map<string, Date>();
    const usedExams = new Set<number>();
    for (const p of pairs) {
        if (matched.has(p.sid) || usedExams.has(p.ei)) continue;
        matched.set(p.sid, p.date);
        usedExams.add(p.ei);
    }
    return { matched, unmatched: exams.filter((_, i) => !usedExams.has(i)) };
}

/** Back-compat wrapper: just the subjectId → date map. */
export function matchExamDates(
    subjects: { id: string; name: string; code: string }[],
    exams: ExtractedExam[],
    threshold = 0.6,
): Map<string, Date> {
    return matchExamDatesDetailed(subjects, exams, threshold).matched;
}

// ── Topic prioritisation ──────────────────────────────────────────────────────

/**
 * Move the highest-scoring ~30% of topics to the front (best first); the rest keep syllabus order,
 * so prerequisites aren't scrambled. No-op if nothing scored.
 */
export function prioritizeTopics(topics: string[], scores: Map<string, number>, fraction = 0.3): string[] {
    const scored = topics.map((t, i) => ({ t, i, s: scores.get(t) ?? 0 }));
    if (!scored.some((x) => x.s > 0)) return topics;
    const k = Math.max(1, Math.ceil(topics.length * fraction));
    const top = [...scored].sort((a, b) => b.s - a.s || a.i - b.i).slice(0, k);
    const topIdx = new Set(top.map((x) => x.i));
    return [...top.map((x) => x.t), ...scored.filter((x) => !topIdx.has(x.i)).map((x) => x.t)];
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlanSubject {
    id: string;
    name: string;
    code: string;
    examDate: Date | null;
    /** Run prioritizeTopics() first. Order = priority: learned first, revised last (closest to the exam). */
    topics: string[];
    /** Topics already finished. Skipped when learning, still revised. Used by planCatchUp. */
    doneTopics?: string[];
    /** Relative effort per topic (default 1). A hard topic can be 2, a trivial one 0.5. */
    topicWeights?: Record<string, number>;
}

export interface PlanOptions {
    /** Study hours on a normal day (1–12). Default 4. */
    hoursPerDay?: number;
    /** Minutes to learn a topic of weight 1. Default 90. */
    minutesPerTopic?: number;
    /** Revision time per subject as a fraction of its learning time. Default 0.25. */
    revisionRatio?: number;
    /** Revision is spread over at most this many days before the exam. Default 3. */
    maxRevisionDays?: number;
    /** Different subjects on one day. Default 3. */
    maxSubjectsPerDay?: number;
    /** Target length of one block on one subject, in minutes. Default 90. */
    blockMinutes?: number;
    /** Length of a group-focus session in minutes. Default 60. */
    focusMinutes?: number;
    /** IST weekdays (0 = Sunday) with a lighter load, e.g. [0]. Default none. */
    lightWeekdays?: number[];
    /** Fraction of normal hours on a light weekday. Default 0.5. */
    lightFactor?: number;
}

export type SessionKind = "learn" | "revision" | "exam" | "focus" | "buffer";

export interface StudySession {
    subjectId: string | null;
    subjectName?: string | null;
    subjectCode?: string | null;
    kind: SessionKind;
    minutes: number;
    /** Plain topic strings (no subject prefix). */
    topics: string[];
    /** Student ticked this block off. Set by the API; the scheduler never sets it. */
    done?: boolean;
}

export interface PlannedDay {
    dayNumber: number;
    date: Date;
    /** Main subject of the day (most minutes). Kept for the existing DB column / UI badge. */
    subjectId: string | null;
    /** Flat, self-describing lines for the existing `topics String[]` column (prefixed with the subject on multi-subject days). */
    topics: string[];
    notes: string | null;
    /** Structured version of the day. Persist as JSON to power the richer UI and catch-up. */
    sessions: StudySession[];
    totalMinutes: number;
}

export interface SubjectStat {
    subjectId: string;
    name: string;
    learnMinutes: number;
    revisionMinutes: number;
    /** Learning time that did not fit before the deadline. >0 means the plan is too tight. */
    unscheduledMinutes: number;
    /** The topics that did not fit (lowest priority first to be dropped = last in this list). */
    unscheduledTopics: string[];
}

export interface PlanResult {
    days: PlannedDay[];
    warnings: string[];
    stats: SubjectStat[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Spread items over `n` days as evenly as possible (sizes differ by at most 1). */
export function splitEvenly<T>(items: T[], n: number): T[][] {
    if (n <= 0) return [];
    const base = Math.floor(items.length / n);
    const extra = items.length % n;
    const out: T[][] = [];
    let pos = 0;
    for (let i = 0; i < n; i++) {
        const size = base + (i < extra ? 1 : 0);
        out.push(items.slice(pos, pos + size));
        pos += size;
    }
    return out;
}

const MIN_CHUNK = 25; // never start a study block with less time than this (minutes)
const KIND_ORDER: Record<SessionKind, number> = { exam: 0, revision: 1, learn: 2, focus: 3, buffer: 4 };

const DEFAULTS: Required<PlanOptions> = {
    hoursPerDay: 4,
    minutesPerTopic: 90,
    revisionRatio: 0.25,
    maxRevisionDays: 3,
    maxSubjectsPerDay: 3,
    blockMinutes: 90,
    focusMinutes: 60,
    lightWeekdays: [],
    lightFactor: 0.5,
};

/** Short label for a subject on multi-subject days: the code if it's short, else a trimmed name. */
function subjectTag(code: string | null | undefined, name: string | null | undefined): string {
    if (code && code.length <= 10) return code;
    const n = name ?? code ?? "";
    return n.length > 18 ? `${n.slice(0, 17)}…` : n;
}

/**
 * Turn sessions into the flat string list the existing UI/DB expect.
 * On a day with several study sessions every line is prefixed so you can tell which subject it is;
 * revision lines contain the word "Revision" (the current UI uses that to show the 📝 badge).
 */
function flattenSessions(sessions: StudySession[]): string[] {
    const multi = sessions.filter((s) => s.kind === "learn" || s.kind === "revision" || s.kind === "focus").length > 1;
    const out: string[] = [];
    for (const s of sessions) {
        const tag = subjectTag(s.subjectCode, s.subjectName);
        switch (s.kind) {
            case "exam":
            case "buffer":
                out.push(...s.topics);
                break;
            case "learn":
                out.push(...s.topics.map((t) => (multi && tag ? `${tag}: ${t}` : t)));
                break;
            case "revision":
                if (!multi) out.push("Revision — priority topics first");
                out.push(...s.topics.map((t) => (multi ? `Revision (${tag}): ${t}` : t)));
                break;
            case "focus":
                out.push(...s.topics.map((t) => (multi ? `Group focus: ${t}` : t)));
                break;
        }
    }
    return out;
}

interface TopicLeft {
    name: string;
    total: number;
}

interface Work {
    s: PlanSubject;
    examIdx: number | null;
    /** exclusive: learning may only happen on days < deadline */
    deadline: number;
    queue: TopicLeft[];
    remaining: number;
    revisionPlanned: number;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Time-budgeted, deadline-aware schedule.
 *
 *  1. Every day has a minutes budget (hoursPerDay; lighter on `lightWeekdays`). Exam days have none.
 *  2. Each exam reserves revision time on the 1–3 days right before it (≈ revisionRatio × its learning
 *     time, at most 60% of a day). The highest-priority topics are revised last, closest to the exam.
 *     A subject is never *learned* on or after its first revision day.
 *  3. Group-focus sessions are spread over the remaining time.
 *  4. Learning is handed out day by day, a whole topic at a time (so "done" means done). Each block goes
 *     to the subject under the most time pressure (work left ÷ time left before its deadline), so
 *     subjects progress in proportion to what they need. At most `maxSubjectsPerDay` per day. A day
 *     may overshoot its budget by up to half a topic.
 *  5. Work that cannot fit is reported in `warnings` and `stats`, naming the topics left out.
 *  6. Days with nothing left are buffer / catch-up days.
 */
export function buildSmartDays(
    subjects: PlanSubject[],
    startDate: Date,
    totalDaysInput: number,
    focusDays: string[][] = [],
    options: PlanOptions = {},
): PlanResult {
    const o = { ...DEFAULTS, ...options };
    o.hoursPerDay = Math.min(12, Math.max(1, o.hoursPerDay));
    const totalDays = Math.max(0, Math.floor(totalDaysInput));
    const base = istMidnight(startDate);
    const dateOf = (i: number) => new Date(base.getTime() + i * DAY_MS);
    const istWeekday = (i: number) => new Date(base.getTime() + i * DAY_MS + IST_OFFSET_MS).getUTCDay();
    const warnings: string[] = [];

    const dayMinutes = Math.round(o.hoursPerDay * 60);
    /** minutes still unallocated on each day */
    const cap: number[] = Array.from({ length: totalDays }, (_, i) =>
        o.lightWeekdays.includes(istWeekday(i)) ? Math.round(dayMinutes * o.lightFactor) : dayMinutes,
    );
    /** sessions fixed in advance (exam, revision, focus) */
    const fixed: StudySession[][] = Array.from({ length: totalDays }, () => []);
    const notes: string[][] = Array.from({ length: totalDays }, () => []);

    const topicSize = (s: PlanSubject, t: string) =>
        Math.min(dayMinutes, Math.max(15, Math.round(o.minutesPerTopic * (s.topicWeights?.[t] ?? 1))));
    const sess = (s: PlanSubject, kind: SessionKind, minutes: number, topics: string[]): StudySession => ({
        subjectId: s.id,
        subjectName: s.name,
        subjectCode: s.code,
        kind,
        minutes,
        topics,
    });

    // ── Set up work items ─────────────────────────────────────────────────────
    const work: Work[] = [];
    const examDays = new Map<number, PlanSubject[]>();

    for (const s of subjects) {
        let examIdx: number | null = null;
        if (s.examDate) {
            const idx = istDayDiff(base, s.examDate);
            if (idx <= 0) {
                warnings.push(`${s.name}: its exam is today or has already passed, so no study time was scheduled for it.`);
                continue;
            }
            examIdx = idx;
            if (idx > totalDays) {
                warnings.push(`${s.name}: its exam is after the plan ends, so no revision was scheduled.`);
            } else if (idx < totalDays) {
                const list = examDays.get(idx) ?? [];
                list.push(s);
                examDays.set(idx, list);
            }
        }
        const names = s.topics.length > 0 ? s.topics : [s.name];
        const done = new Set(s.doneTopics ?? []);
        const queue: TopicLeft[] = names.filter((t) => !done.has(t)).map((t) => ({ name: t, total: topicSize(s, t) }));
        const remaining = queue.reduce((a, t) => a + t.total, 0);
        work.push({ s, examIdx, deadline: totalDays, queue, remaining, revisionPlanned: 0 });
    }

    // ── 1. Exam days ──────────────────────────────────────────────────────────
    for (const [idx, list] of examDays) {
        cap[idx] = 0;
        for (const s of list) fixed[idx]!.push(sess(s, "exam", 0, [`Exam day: ${s.name}`, "Only a light skim of formulas and key points"]));
        notes[idx]!.push(`Exam: ${fmtDay(dateOf(idx))}`);
    }

    // ── 2. Revision, earliest exam first ──────────────────────────────────────
    const withExam = work.filter((w) => w.examIdx !== null && w.examIdx <= totalDays);
    withExam.sort((a, b) => a.examIdx! - b.examIdx!);
    for (const w of withExam) {
        const allTopics = w.s.topics.length > 0 ? w.s.topics : [w.s.name];
        const totalAll = allTopics.reduce((a, t) => a + topicSize(w.s, t), 0);
        let need = Math.round(totalAll * o.revisionRatio);
        const plan: { day: number; minutes: number }[] = [];
        const earliest = Math.max(0, w.examIdx! - 1 - (o.maxRevisionDays + 2));
        for (let d = w.examIdx! - 1; d >= earliest && need > 0 && plan.length < o.maxRevisionDays; d--) {
            const take = Math.min(need, Math.floor(cap[d]! * 0.6));
            if (take < Math.min(MIN_CHUNK, need)) continue;
            cap[d]! -= take;
            need -= take;
            plan.unshift({ day: d, minutes: take });
        }
        if (plan.length === 0) {
            warnings.push(`${w.s.name}: no free time for revision before its exam.`);
            w.deadline = Math.min(w.examIdx!, totalDays);
            continue;
        }
        if (need > MIN_CHUNK) warnings.push(`${w.s.name}: only part of the planned revision time fits before its exam.`);
        w.deadline = plan[0]!.day;
        w.revisionPlanned = plan.reduce((a, p) => a + p.minutes, 0);

        // highest-priority topics (front of the list) are revised last, closest to the exam
        const chunks = splitEvenly(allTopics, plan.length).reverse();
        plan.forEach((p, k) => {
            const topics = [...chunks[k]!];
            if (k === plan.length - 1) topics.push("Practice past exam questions (timed)");
            fixed[p.day]!.push(sess(w.s, "revision", p.minutes, topics));
            notes[p.day]!.push(`${w.s.name} exam: ${fmtDay(w.s.examDate!)}`);
        });
    }

    // ── 3. Group-focus sessions, evenly spaced, nudged to the nearest day with room ─
    const nearestWithRoom = (target: number): number => {
        for (let d = 0; d < totalDays; d++) {
            for (const cand of [target + d, target - d]) {
                if (cand >= 0 && cand < totalDays && cap[cand]! >= o.focusMinutes + MIN_CHUNK) return cand;
            }
        }
        return -1;
    };
    const focusCount = Math.min(focusDays.length, Math.max(0, totalDays - 1));
    for (let j = 0; j < focusCount; j++) {
        const idx = nearestWithRoom(Math.floor(((j + 1) * totalDays) / (focusCount + 1)));
        if (idx === -1) {
            warnings.push("Group focus: no day had room for some focus sessions.");
            break;
        }
        cap[idx]! -= o.focusMinutes;
        fixed[idx]!.push({ subjectId: null, kind: "focus", minutes: o.focusMinutes, topics: focusDays[j]! });
        notes[idx]!.push("Group focus: topics the group struggles with");
    }

    // ── 4. Hand out learning time, day by day ─────────────────────────────────
    // prefix[i] = capacity on days [0, i) after reservations; measures time left before a deadline
    const prefix: number[] = [0];
    for (let i = 0; i < totalDays; i++) prefix.push(prefix[i]! + cap[i]!);

    /** Take whole topics from the subject's queue until the block target is reached or time runs out. */
    const takeTopics = (w: Work, want: number, capLeft: number): { names: string[]; minutes: number } => {
        const names: string[] = [];
        let got = 0;
        while (w.queue.length > 0) {
            if (names.length > 0 && got >= want) break;
            const t = w.queue[0]!;
            const room = capLeft - got;
            if (t.total > room && room < t.total * 0.5) break; // less than half of it would fit today
            names.push(t.name);
            got += t.total;
            w.queue.shift();
            w.remaining -= t.total;
        }
        return { names, minutes: got };
    };

    const learnTotals = new Map<Work, number>();
    const days: PlannedDay[] = [];

    for (let i = 0; i < totalDays; i++) {
        let capLeft = cap[i]!;
        const learn = new Map<Work, StudySession>();
        const blocked = new Set<Work>();

        while (capLeft >= MIN_CHUNK) {
            let cands = work.filter((w) => w.remaining > 0 && i < w.deadline && !blocked.has(w));
            if (learn.size >= o.maxSubjectsPerDay) cands = cands.filter((w) => learn.has(w));
            if (cands.length === 0) break;

            let best: Work | null = null;
            let bestPressure = -1;
            for (const w of cands) {
                const avail = capLeft + Math.max(0, prefix[w.deadline]! - prefix[i + 1]!);
                const pressure = w.remaining / avail;
                const better =
                    best === null ||
                    pressure > bestPressure + 1e-9 ||
                    (Math.abs(pressure - bestPressure) <= 1e-9 &&
                        (w.deadline < best.deadline || (w.deadline === best.deadline && w.s.name < best.s.name)));
                if (better) {
                    best = w;
                    bestPressure = pressure;
                }
            }
            const w = best!;
            const existing = learn.get(w);
            const got = takeTopics(w, existing ? capLeft : o.blockMinutes, capLeft);
            if (got.names.length === 0) {
                blocked.add(w);
                continue;
            }
            capLeft -= got.minutes;
            learnTotals.set(w, (learnTotals.get(w) ?? 0) + got.minutes);
            if (existing) {
                existing.minutes += got.minutes;
                existing.topics.push(...got.names);
            } else {
                learn.set(w, sess(w.s, "learn", got.minutes, got.names));
            }
        }

        const sessions: StudySession[] = [...fixed[i]!, ...learn.values()];
        if (sessions.length === 0) {
            sessions.push({
                subjectId: null,
                kind: "buffer",
                minutes: 0,
                topics: ["Catch-up / buffer day", "Redo anything you found hard or attempt a practice quiz"],
            });
        }
        sessions.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.minutes - a.minutes);

        const primary = sessions
            .filter((s) => s.subjectId !== null)
            .reduce<StudySession | null>((m, s) => (m === null || s.minutes > m.minutes ? s : m), null);

        days.push({
            dayNumber: i + 1,
            date: dateOf(i),
            subjectId: primary?.subjectId ?? null,
            topics: flattenSessions(sessions),
            notes: notes[i]!.length > 0 ? [...new Set(notes[i]!)].join("; ") : null,
            sessions,
            totalMinutes: sessions.reduce((a, s) => a + s.minutes, 0),
        });
    }

    // ── 5. Report what did not fit ────────────────────────────────────────────
    const stats: SubjectStat[] = work.map((w) => ({
        subjectId: w.s.id,
        name: w.s.name,
        learnMinutes: learnTotals.get(w) ?? 0,
        revisionMinutes: w.revisionPlanned,
        unscheduledMinutes: w.remaining,
        unscheduledTopics: w.queue.map((t) => t.name),
    }));
    for (const w of work) {
        if (w.remaining <= 0) continue;
        const hrs = Math.round((w.remaining / 60) * 10) / 10;
        const left = w.queue.slice(0, 3).map((t) => t.name).join("; ");
        warnings.push(
            `${w.s.name}: about ${hrs} h of topics do not fit${w.examIdx !== null ? " before its exam" : ""} ` +
            `(${w.queue.length} topic${w.queue.length === 1 ? "" : "s"} left out, e.g. ${left}). ` +
            `Add days, raise daily hours, or drop low-priority topics.`,
        );
    }

    return { days, warnings, stats };
}

/** Spread a flat topic list over `totalDays` days with no empty days (group plans without shared subjects). */
export function spreadTopics(
    topics: string[],
    totalDays: number,
    startDate: Date,
    minutesPerTopic = DEFAULTS.minutesPerTopic,
): PlannedDay[] {
    const origin = istMidnight(startDate).getTime();
    const list =
        topics.length > 0
            ? topics
            : ["Group revision — review all shared subjects", "Practice past questions together"];
    const perDay: string[][] =
        list.length >= totalDays
            ? splitEvenly(list, totalDays)
            : Array.from({ length: totalDays }, (_, i) => [list[i % list.length]!]);
    return perDay.map((t, i) => {
        const minutes = t.length * minutesPerTopic;
        return {
            dayNumber: i + 1,
            date: new Date(origin + i * DAY_MS),
            subjectId: null,
            topics: t,
            notes: null,
            sessions: [{ subjectId: null, kind: "learn" as const, minutes, topics: t }],
            totalMinutes: minutes,
        };
    });
}

// ── Stored config + catch-up ──────────────────────────────────────────────────

/** Everything needed to re-plan later. Store as JSON on StudyPlan.config. */
export interface PlanConfig {
    version: 1;
    startDate: string; // ISO instant (IST midnight)
    endDate: string; // ISO instant: start + totalDays
    options: PlanOptions;
    subjects: {
        id: string;
        name: string;
        code: string;
        examDate: string | null;
        topics: string[];
        topicWeights?: Record<string, number>;
    }[];
}

export function buildPlanConfig(
    subjects: PlanSubject[],
    startDate: Date,
    totalDays: number,
    options: PlanOptions = {},
): PlanConfig {
    const start = istMidnight(startDate);
    return {
        version: 1,
        startDate: start.toISOString(),
        endDate: new Date(start.getTime() + totalDays * DAY_MS).toISOString(),
        options,
        subjects: subjects.map((s) => ({
            id: s.id,
            name: s.name,
            code: s.code,
            examDate: s.examDate ? s.examDate.toISOString() : null,
            topics: s.topics,
            ...(s.topicWeights ? { topicWeights: s.topicWeights } : {}),
        })),
    };
}

/** A stored plan day as read back from the DB. */
export interface ProgressDay {
    id: string;
    dayNumber: number;
    date: Date | null;
    isCompleted: boolean;
    subjectId: string | null;
    topics: string[];
    sessions: StudySession[] | null;
}

/** subjectId → topics the student has finished (learn sessions ticked off, or on days marked done). */
export function doneTopicsFromDays(days: ProgressDay[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const d of days) {
        for (const s of d.sessions ?? []) {
            if (!d.isCompleted && !s.done) continue;
            if (s.kind !== "learn" || !s.subjectId) continue;
            const set = out.get(s.subjectId) ?? new Set<string>();
            for (const t of s.topics) set.add(t);
            out.set(s.subjectId, set);
        }
    }
    return out;
}

const MAX_CATCHUP_DAYS = 120;

export type CatchUpResult =
    | {
        ok: true;
        startDate: Date;
        /** Completed past days that stay; `newDayNumber` closes any gaps. */
        keep: { id: string; dayNumber: number; newDayNumber: number }[];
        /** Replacement days; dayNumber already continues after the kept days. */
        newDays: PlannedDay[];
        totalDays: number;
        warnings: string[];
        stats: SubjectStat[];
        config: PlanConfig;
    }
    | { ok: false; reason: string };

/**
 * "I'm behind": keep what the student actually completed, throw away the rest, and re-plan from today
 * (or tomorrow, if today's day is already done) up to the last remaining exam. Finished topics are not
 * scheduled again; missed ones come back, ahead of untouched ones within the same subject.
 */
export function planCatchUp(config: PlanConfig, days: ProgressDay[], now: Date = new Date()): CatchUpResult {
    const today = istMidnight(now);
    const doneToday = days.some((d) => d.isCompleted && d.date !== null && istDayDiff(today, d.date) === 0);
    const start = doneToday ? new Date(today.getTime() + DAY_MS) : today;

    const keepSrc = days
        .filter((d) => d.isCompleted && d.date !== null && istDayDiff(start, d.date) < 0)
        .sort((a, b) => a.date!.getTime() - b.date!.getTime() || a.dayNumber - b.dayNumber);
    const keep = keepSrc.map((d, i) => ({ id: d.id, dayNumber: d.dayNumber, newDayNumber: i + 1 }));

    const done = doneTopicsFromDays(days);
    const live: PlanSubject[] = [];
    for (const s of config.subjects) {
        const examDate = s.examDate ? new Date(s.examDate) : null;
        if (examDate && istDayDiff(start, examDate) <= 0) continue; // exam is over (or today)
        live.push({
            id: s.id,
            name: s.name,
            code: s.code,
            examDate,
            topics: s.topics,
            doneTopics: [...(done.get(s.id) ?? [])],
            ...(s.topicWeights ? { topicWeights: s.topicWeights } : {}),
        });
    }
    if (live.length === 0) return { ok: false, reason: "All exams in this plan are over, so there is nothing left to plan." };

    const examIdxs = live.filter((s) => s.examDate).map((s) => istDayDiff(start, s.examDate!));
    let remaining = examIdxs.length > 0 ? Math.max(...examIdxs) : istDayDiff(start, new Date(config.endDate));
    if (remaining <= 0) return { ok: false, reason: "The plan's end date has passed, so there is nothing left to plan." };
    const warnings: string[] = [];
    if (remaining > MAX_CATCHUP_DAYS) {
        warnings.push(`The last exam is ${remaining} days away; only the next ${MAX_CATCHUP_DAYS} days were planned.`);
        remaining = MAX_CATCHUP_DAYS;
    }

    const pendingFocus = days
        .filter((d) => !d.isCompleted)
        .flatMap((d) => (d.sessions ?? []).filter((s) => s.kind === "focus" && !s.done).map((s) => s.topics));

    const built = buildSmartDays(live, start, remaining, pendingFocus, config.options);
    const newDays = built.days.map((d) => ({ ...d, dayNumber: d.dayNumber + keep.length }));

    return {
        ok: true,
        startDate: start,
        keep,
        newDays,
        totalDays: keep.length + remaining,
        warnings: [...warnings, ...built.warnings],
        stats: built.stats,
        config: { ...config, endDate: new Date(start.getTime() + remaining * DAY_MS).toISOString() },
    };
}