/**
 * RAG backfill: (re-)embeds PYQ papers and syllabus units into the vector store.
 *
 * Run from the backend/ folder:
 *   npx tsx scripts/backfill.ts --dry-run               # list targets, embed nothing (no API key needed)
 *   npx tsx scripts/backfill.ts --subject <subjectId>   # ONE subject's papers only
 *   npx tsx scripts/backfill.ts --branch <code-or-name> # all subjects/syllabi in one branch
 *   npx tsx scripts/backfill.ts --syllabus <syllabusId> # ONE syllabus's units only
 *   npx tsx scripts/backfill.ts --resources-only
 *   npx tsx scripts/backfill.ts --syllabus-only
 *   npx tsx scripts/backfill.ts --missing-only          # skip items that already have chunks (retry after a partial run)
 *   npx tsx scripts/backfill.ts --delay-ms 1000          # wait between embedding operations (default: 1000)
 *   npx tsx scripts/backfill.ts --limit 5               # cap subjects / syllabi processed
 *
 * IMPORTANT: after switching embedding models (e.g. text-embedding-004 -> gemini-embedding-001)
 * do ONE full run WITHOUT --missing-only. Vectors from different models are not comparable.
 *
 * Prerequisites:
 *   1. GEMINI_API_KEY (or HUGGINGFACE_API_KEY) in backend/.env
 *   2. pgvector enabled and the ResourceChunk / SyllabusChunk tables migrated
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import {
  backfillSubjectResources,
  backfillSyllabus,
  type BackfillSummary,
} from "../src/lib/ingestion.js";
import { embeddingModelName, embeddingsConfigured } from "../src/lib/embeddings.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

interface Args {
  subjectId: string | null;
  branch: string | null;
  syllabusId: string | null;
  resourcesOnly: boolean;
  syllabusOnly: boolean;
  missingOnly: boolean;
  dryRun: boolean;
  delayMs: number;
  limit: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
  };
  const limitRaw = get("--limit");
  const delayRaw = get("--delay-ms");
  const delayMs = delayRaw === null ? 1000 : Number(delayRaw);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative number");
  }
  return {
    subjectId: get("--subject"),
    branch: get("--branch"),
    syllabusId: get("--syllabus"),
    resourcesOnly: argv.includes("--resources-only"),
    syllabusOnly: argv.includes("--syllabus-only"),
    missingOnly: argv.includes("--missing-only"),
    dryRun: argv.includes("--dry-run"),
    delayMs,
    limit: limitRaw ? Number(limitRaw) || null : null,
  };
}

const emptySummary = (): BackfillSummary => ({ attempted: 0, ok: 0, noText: [], failed: [] });

function merge(into: BackfillSummary, from: BackfillSummary): void {
  into.attempted += from.attempted;
  into.ok += from.ok;
  into.noText.push(...from.noText);
  into.failed.push(...from.failed);
  if (from.aborted) into.aborted = from.aborted;
}

// ── Resource backfill ─────────────────────────────────────────────────────────

async function backfillResources(args: Args): Promise<BackfillSummary> {
  const resourceWhere: Prisma.ResourceWhereInput = args.missingOnly ? { chunks: { none: {} } } : {};
  const branchWhere: Prisma.BranchWhereInput | undefined = args.branch
    ? { OR: [{ code: args.branch }, { name: args.branch }] }
    : undefined;

  let subjects = await prisma.subject.findMany({
    where: {
      ...(args.subjectId ? { id: args.subjectId } : {}),
      ...(branchWhere ? { branch: branchWhere } : {}),
      resources: { some: resourceWhere },
    },
    select: {
      id: true,
      code: true,
      name: true,
      _count: { select: { resources: { where: resourceWhere } } },
    },
    orderBy: { name: "asc" },
  });
  if (args.limit && subjects.length > args.limit) subjects = subjects.slice(0, args.limit);

  const total = subjects.reduce((n, s) => n + s._count.resources, 0);
  console.log(`\n📚  ${subjects.length} subject(s) · ${total} paper(s) to process`);

  const summary = emptySummary();
  if (args.dryRun) {
    for (const s of subjects) console.log(`     • ${s.code} — ${s.name} (${s._count.resources})`);
    return summary;
  }

  for (const s of subjects) {
    console.log(`\n── ${s.code} — ${s.name} (${s._count.resources}) ──`);
    try {
      merge(
        summary,
        await backfillSubjectResources(s.id, {
          onlyMissing: args.missingOnly,
          delayMs: args.delayMs,
        }),
      );
    } catch (e) {
      summary.failed.push({ id: `subject:${s.code}`, error: e instanceof Error ? e.message : String(e) });
    }
    console.log(`✅  ${summary.ok}/${total} ok · ${summary.failed.length} failed · ${summary.noText.length} no text`);
    if (summary.aborted) break;
  }
  return summary;
}

// ── Syllabus backfill ─────────────────────────────────────────────────────────

async function backfillSyllabi(args: Args): Promise<BackfillSummary> {
  const itemWhere: Prisma.SyllabusItemWhereInput = args.missingOnly ? { chunks: { none: {} } } : {};
  const branchWhere: Prisma.BranchWhereInput | undefined = args.branch
    ? { OR: [{ code: args.branch }, { name: args.branch }] }
    : undefined;

  let syllabi = await prisma.syllabus.findMany({
    where: {
      ...(args.syllabusId ? { id: args.syllabusId } : {}),
      ...(branchWhere ? { branch: branchWhere } : {}),
      items: { some: itemWhere },
    },
    select: {
      id: true,
      semester: true,
      scheme: true,
      branch: { select: { name: true } },
      _count: { select: { items: { where: itemWhere } } },
    },
    orderBy: [{ semester: "asc" }],
  });
  if (args.limit && syllabi.length > args.limit) syllabi = syllabi.slice(0, args.limit);

  const total = syllabi.reduce((n, s) => n + s._count.items, 0);
  console.log(`\n📋  ${syllabi.length} syllabus entry(s) · ${total} unit(s) to process`);

  const summary = emptySummary();
  if (args.dryRun) {
    for (const s of syllabi) {
      console.log(`     • ${s.branch.name} Sem ${s.semester} (scheme ${s.scheme}) — ${s._count.items} units`);
    }
    return summary;
  }

  for (const s of syllabi) {
    console.log(`\n── ${s.branch.name} · Semester ${s.semester} (${s._count.items} units) ──`);
    try {
      merge(
        summary,
        await backfillSyllabus(s.id, {
          onlyMissing: args.missingOnly,
          delayMs: args.delayMs,
        }),
      );
    } catch (e) {
      summary.failed.push({ id: `syllabus:${s.id}`, error: e instanceof Error ? e.message : String(e) });
    }
    console.log(`✅  ${summary.ok}/${total} ok · ${summary.failed.length} failed`);
    if (summary.aborted) break;
  }
  return summary;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log("🚀  CampusBrain RAG backfill");
  console.log(`     dry-run: ${args.dryRun ? "yes (nothing is embedded)" : "no"}`);
  console.log(`     mode:    ${args.missingOnly ? "missing-only" : "re-embed everything"}`);
  console.log(`     delay:   ${args.delayMs} ms`);
  if (args.branch) console.log(`     branch:  ${args.branch}`);

  // A dry run never calls the embedding API, so it must not require a key.
  if (!args.dryRun) {
    if (!embeddingsConfigured()) {
      console.error(
        "\n❌  No GEMINI_API_KEY or HUGGINGFACE_API_KEY found in backend/.env.\n" +
        "    Set one and re-run (or use --dry-run to just list targets).",
      );
      process.exit(1);
    }
    console.log(`     model:   ${embeddingModelName()}`);
  }

  // --subject alone → papers only; --syllabus alone → syllabus only.
  const onlySubject = args.subjectId !== null && args.syllabusId === null;
  const onlySyllabus = args.syllabusId !== null && args.subjectId === null;
  const doResources = !args.syllabusOnly && !onlySyllabus;
  const doSyllabi = !args.resourcesOnly && !onlySubject;

  const res = doResources ? await backfillResources(args) : emptySummary();
  const syl = doSyllabi && !res.aborted ? await backfillSyllabi(args) : emptySummary();

  const all = emptySummary();
  merge(all, res);
  merge(all, syl);

  console.log("\n🎉  Backfill finished");
  if (args.dryRun) {
    console.log("     (dry-run, nothing was embedded)");
  } else {
    console.log(`     ok: ${all.ok}/${all.attempted}`);
    if (all.noText.length > 0) {
      console.log(`     no extractable text (likely scanned PDFs, need OCR): ${all.noText.length}`);
      for (const id of all.noText) console.log(`       - ${id}`);
    }
    if (all.failed.length > 0) {
      console.error(`\n     failed: ${all.failed.length}`);
      for (const f of all.failed) console.error(`       - ${f.id}: ${f.error}`);
      console.error("     Re-run with --missing-only to retry just the ones that failed.");
    }
    if (all.aborted) console.error("\n❌  Aborted: embeddings stopped being configured mid-run.");
  }

  if (all.failed.length > 0 || all.aborted) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("❌  Fatal error:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());