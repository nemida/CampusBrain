/**
 * Index the individual questions of past papers (powers the PYQ finder).
 *
 * Run from backend/:
 *   npx tsx scripts/backfillQuestions.ts --survey                 # download every paper and report which have readable text vs scans (no AI, writes nothing)
 *   npx tsx scripts/backfillQuestions.ts --preview <resourceId>   # extract + print the questions of ONE paper. Writes nothing.
 *   npx tsx scripts/backfillQuestions.ts --dry-run                # list the papers that would be processed
 *   npx tsx scripts/backfillQuestions.ts --subject <subjectId>    # only one subject
 *   npx tsx scripts/backfillQuestions.ts --limit 5                # only the first N papers
 *   npx tsx scripts/backfillQuestions.ts --force                  # also redo papers that already have questions
 *
 * By default only papers WITHOUT indexed questions are processed, so it is safe to re-run after a failure.
 *
 * Scanned papers (no text layer) are read with a Gemini vision model. Set GEMINI_VISION_MODEL in backend/.env to pin
 * a model, otherwise the best available Flash model is chosen automatically. A free-tier daily quota can stop a long
 * run early: re-run the same command and it resumes with the papers that are still missing.
 *
 * Prerequisites: the "PaperQuestion" table exists, GEMINI_API_KEY (vision + embeddings), and your LLM key (text papers).
 */
import { prisma } from "../src/lib/prisma.js";
import { fetchPdf, hasUsableText, usableTextLength } from "../src/lib/pdfText.js";
import { extractFromPdf, ingestPaperQuestions } from "../src/lib/questionIngestion.js";
import { embeddingModelName, embeddingsConfigured } from "../src/lib/embeddings.js";

const MAX_INLINE_MB = 18; // larger PDFs can't be sent to the vision model inline

const argv = process.argv.slice(2);
const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
};
const args = {
    preview: get("--preview"),
    survey: argv.includes("--survey"),
    subjectId: get("--subject"),
    limit: Number(get("--limit")) || null,
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
};

interface Target {
    id: string;
    title: string;
    year: number;
    fileUrl: string;
    subjectId: string;
    subjectCode: string;
}

async function findTargets(includeIndexed = false): Promise<Target[]> {
    const rows = await prisma.$queryRawUnsafe<Target[]>(
        `SELECT r."id", r."title", r."year", r."fileUrl", r."subjectId", s."code" AS "subjectCode"
     FROM "Resource" r JOIN "Subject" s ON s."id" = r."subjectId"
     WHERE r."type" = 'PAPER'
       ${args.subjectId ? `AND r."subjectId" = $1` : ""}
       ${args.force || includeIndexed ? "" : `AND NOT EXISTS (SELECT 1 FROM "PaperQuestion" q WHERE q."resourceId" = r."id")`}
     ORDER BY s."code", r."year" DESC`,
        ...(args.subjectId ? [args.subjectId] : []),
    );
    return args.limit ? rows.slice(0, args.limit) : rows;
}

/** Download every paper and classify it. No AI calls, nothing written. */
async function survey() {
    const targets = await findTargets(true);
    console.log(`\n🔎  Surveying ${targets.length} paper(s) (downloads only, no AI, nothing written)\n`);

    const withText: string[] = [];
    const scanned: string[] = [];
    const tooLarge: string[] = [];
    const failed: string[] = [];
    let totalMb = 0;

    for (const [i, t] of targets.entries()) {
        const name = `${t.subjectCode} ${t.year} (${t.id})`;
        process.stdout.write(`[${i + 1}/${targets.length}] ${t.subjectCode} ${t.year} … `);
        try {
            const pdf = await fetchPdf(t.fileUrl);
            const mb = pdf.buffer.length / 1048576;
            totalMb += mb;
            if (hasUsableText(pdf.text)) {
                withText.push(name);
                console.log(`text (${usableTextLength(pdf.text)} chars)`);
            } else if (mb > MAX_INLINE_MB) {
                tooLarge.push(`${name} ${mb.toFixed(1)} MB`);
                console.log(`scanned, ${mb.toFixed(1)} MB (too large for the vision model)`);
            } else {
                scanned.push(name);
                console.log(`scanned (${mb.toFixed(1)} MB)`);
            }
        } catch (e) {
            failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
            console.log("download failed");
        }
    }

    console.log(`\n📊  Survey of ${targets.length} papers (${totalMb.toFixed(0)} MB downloaded)`);
    console.log(`     with a text layer:        ${withText.length}`);
    console.log(`     scanned (need vision AI): ${scanned.length}`);
    if (tooLarge.length) console.log(`     scanned but > ${MAX_INLINE_MB} MB:      ${tooLarge.length}\n       - ${tooLarge.join("\n       - ")}`);
    if (failed.length) console.log(`     download failed:          ${failed.length}\n       - ${failed.join("\n       - ")}`);
    console.log(`\n     A full run makes about ${scanned.length} vision request(s) (one per scanned paper), plus a few text-LLM calls.`);
    console.log("     If your Gemini key is on a free tier, check its daily request limit; the run can simply be resumed.");
}

async function preview(resourceId: string) {
    const r = await prisma.resource.findUnique({
        where: { id: resourceId },
        select: { title: true, year: true, fileUrl: true },
    });
    if (!r) throw new Error(`No resource with id ${resourceId}`);
    console.log(`\n📄  ${r.title} (${r.year})`);
    const pdf = await fetchPdf(r.fileUrl);
    const usable = hasUsableText(pdf.text);
    console.log(
        `     PDF: ${(pdf.buffer.length / 1048576).toFixed(1)} MB · ${usableTextLength(pdf.text)} readable characters · ${usable ? "has a text layer" : "SCANNED, will be read with the vision model"}`,
    );
    const ex = await extractFromPdf(pdf);
    console.log(
        `     method: ${ex.method} (${ex.source}) · ${ex.questions.length} question(s)${ex.unanchored ? ` · ${ex.unanchored} anchor(s) not found` : ""}\n`,
    );
    for (const q of ex.questions) {
        console.log(`  ── ${q.label ?? `#${q.index + 1}`}${q.marks ? ` [${q.marks} marks]` : ""}${q.page ? ` · page ${q.page}` : ""}`);
        console.log(`     ${q.text.replace(/\n/g, "\n     ")}\n`);
    }
    console.log("Nothing was written. Compare the questions above with the PDF before running the full backfill.");
}

async function main() {
    if (args.survey) return survey();
    if (args.preview) return preview(args.preview);

    const targets = await findTargets();
    console.log(`\n📚  ${targets.length} paper(s) to process${args.force ? " (forced)" : " (without indexed questions)"}`);
    if (args.dryRun) {
        for (const t of targets) console.log(`     • ${t.subjectCode} ${t.year} — ${t.title}`);
        return;
    }

    console.log(
        embeddingsConfigured()
            ? `     embeddings: ${embeddingModelName()}`
            : "     ⚠️  no embedding key: questions will be stored for keyword search only (re-run with --force once a key is set)",
    );

    let ok = 0;
    let scans = 0;
    let questionsTotal = 0;
    const noQuestions: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const [i, t] of targets.entries()) {
        process.stdout.write(`[${i + 1}/${targets.length}] ${t.subjectCode} ${t.year} … `);
        try {
            const pdf = await fetchPdf(t.fileUrl);
            const r = await ingestPaperQuestions(t.id, t.subjectId, pdf);
            if (r.status === "ok") {
                ok++;
                if (r.source === "scan") scans++;
                questionsTotal += r.count;
                console.log(`${r.count} questions (${r.method}, ${r.source})`);
            } else if (r.status === "no_questions") {
                noQuestions.push(`${t.subjectCode} ${t.year} (${t.id})`);
                console.log("no questions found");
            } else {
                failed.push({ id: t.id, error: r.error ?? "unknown error" });
                console.log("FAILED");
            }
        } catch (e) {
            failed.push({ id: t.id, error: e instanceof Error ? e.message : String(e) });
            console.log("FAILED");
        }
    }

    console.log(`\n🎉  Done: ${ok}/${targets.length} papers indexed (${scans} read from scans) · ${questionsTotal} questions`);
    if (noQuestions.length) {
        console.log(
            `\n     No questions detected: ${noQuestions.length}\n       - ${noQuestions.join("\n       - ")}\n     Tip: --preview <id> shows what the extractor sees. Blank, rotated or unreadable pages can produce nothing.`,
        );
    }
    if (failed.length) {
        console.error(`\n     Failed: ${failed.length}\n       - ${failed.map((f) => `${f.id}: ${f.error}`).join("\n       - ")}`);
        console.error("     Re-run the same command to retry just the ones that are still missing (a daily quota limit also shows up here).");
        process.exitCode = 1;
    }
}

main()
    .catch((e) => {
        console.error("❌  Fatal error:", e instanceof Error ? e.message : e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());