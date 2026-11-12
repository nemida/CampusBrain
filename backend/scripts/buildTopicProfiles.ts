import { prisma } from "../src/lib/prisma.js";
import { buildProfiles, getCachedProfile } from "../src/lib/topicProfile.js";
import { cleanTopic } from "../src/lib/pyqSearch.js";

const items = await prisma.syllabusItem.findMany({ include: { subject: true } });
const bySubject = new Map<string, Set<string>>();
for (const it of items) {
    const ctx = it.subject?.name ?? "";
    if (!ctx) continue; // topics without a subject have no context, so they are never expanded
    const set = bySubject.get(ctx) ?? new Set<string>();
    it.topics.map(cleanTopic).filter((t) => t.length >= 2).forEach((t) => set.add(t));
    bySubject.set(ctx, set);
}

for (const [ctx, set] of bySubject) {
    const topics = [...set];
    for (let i = 0; i < topics.length; i += 20) {
        const todo: string[] = [];
        for (const t of topics.slice(i, i + 20)) {
            if (!(await getCachedProfile(t, ctx))) todo.push(t);
        }
        if (todo.length === 0) continue;
        try {
            await buildProfiles(todo, ctx);
            console.log(ctx, "built", todo.length);
        } catch (e) {
            console.error(ctx, "failed:", e instanceof Error ? e.message : e, "(re-run later)");
        }
        await new Promise((r) => setTimeout(r, 8000)); // stay under free-tier rate limits
    }
}
process.exit(0);