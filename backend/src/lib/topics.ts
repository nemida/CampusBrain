/**
 * Quiz-topic helpers shared by the dashboard and the study-group analytics.
 */

export const WEAK_TOPIC_THRESHOLD = 60;
export const RECENT_ATTEMPTS = 5; // only the latest N attempts per topic (per member) count

/** Junk topics ("1", "", "ab") are bucketed under "General". */
export function normalizeTopic(raw: string | null | undefined): string {
    const t = (raw ?? "").trim().replace(/\s+/g, " ");
    if (t.length < 3 || /^\d+$/.test(t)) return "General";
    return t;
}

export interface QuizSessionRow {
    userId: string;
    topic: string | null;
    score: number; // 0-100
}

export interface GroupWeakTopic {
    topic: string;
    avgScore: number; // mean of each member's recent average (one prolific member can't dominate)
    memberCount: number; // members who attempted the topic
    strugglingCount: number; // members whose own recent average is below the threshold
}

/**
 * Group-level weak topics from quiz sessions (MUST be ordered newest first).
 * A topic is reported if the group average is below the threshold, or at least two members struggle with it.
 * The "General" bucket is skipped: it isn't something a group can study.
 */
export function aggregateGroupWeakTopics(
    sessions: QuizSessionRow[],
    threshold = WEAK_TOPIC_THRESHOLD,
    limit = 10,
): GroupWeakTopic[] {
    // topicKey -> { label, userId -> latest scores }
    const topics = new Map<string, { label: string; byUser: Map<string, number[]> }>();
    for (const s of sessions) {
        const label = normalizeTopic(s.topic);
        if (label === "General") continue;
        const key = label.toLowerCase();
        const entry = topics.get(key) ?? { label, byUser: new Map<string, number[]>() };
        const scores = entry.byUser.get(s.userId) ?? [];
        if (scores.length < RECENT_ATTEMPTS) scores.push(s.score);
        entry.byUser.set(s.userId, scores);
        topics.set(key, entry);
    }

    const out: GroupWeakTopic[] = [];
    for (const { label, byUser } of topics.values()) {
        const memberAvgs = [...byUser.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
        const avg = memberAvgs.reduce((a, b) => a + b, 0) / memberAvgs.length;
        const struggling = memberAvgs.filter((m) => m < threshold).length;
        if (avg < threshold || struggling >= 2) {
            out.push({
                topic: label,
                avgScore: Math.round(avg * 10) / 10,
                memberCount: memberAvgs.length,
                strugglingCount: struggling,
            });
        }
    }
    return out
        .sort((a, b) => b.strugglingCount - a.strugglingCount || a.avgScore - b.avgScore)
        .slice(0, limit);
}