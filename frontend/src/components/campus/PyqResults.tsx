// frontend/src/components/campus/PyqResults.tsx
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlertCircle, CalendarDays, Copy, ExternalLink, FileText, Loader2 } from "lucide-react";
import {
  searchPyqQuestions,
  trackActivity,
  ApiError,
  type ApiPyqPaper,
  type ApiPyqQuestion,
  type ApiPyqSearchResponse,
  type ApiPyqTopicResult,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { toneStyle } from "@/lib/tone";

/** Study-plan topics look like "[Unit title] Topic": search for the topic only. */
export const cleanTopic = (t: string) => t.replace(/^\[[^\]]*\]\s*/, "").trim();

const paperLabel = (p: ApiPyqPaper) => `${p.year} ${p.examType}`;

/** Open the paper's PDF (at a given page when known) and record the view (feeds "continue where you left off"). */
export function openPaper(paper: ApiPyqPaper, page?: number | null) {
  const url =
    page && !paper.fileUrl.includes("#") ? `${paper.fileUrl}#page=${page}` : paper.fileUrl;
  window.open(url, "_blank", "noopener,noreferrer");
  trackActivity({ resourceId: paper.id, activityType: "VIEW" }).catch(() => undefined);
}

async function copyQuestion(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Question copied");
  } catch {
    toast.error("Couldn't copy automatically. Please select the text manually.");
  }
}

// ── One question ─────────────────────────────────────────────────────────────

function QuestionCard({ q, showSubject }: { q: ApiPyqQuestion; showSubject: boolean }) {
  const first = q.appearances[0];
  const repeats = q.appearances.length;

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {first?.label && <span className="chip font-semibold text-foreground">{first.label}</span>}
        {q.marks ? <span className="chip">{q.marks} marks</span> : null}
        <span
          className={cn(
            "chip",
            q.exactMatch &&
              "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
            !q.exactMatch &&
              q.termMatch > 0 &&
              "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
          )}
        >
          {q.exactMatch ? "Mentions the topic" : q.termMatch > 0 ? "Partly matches" : "Related"}
        </span>
        {q.source === "scan" && (
          <span
            title="Read from a scanned page by AI. Open the paper to double-check wording and symbols."
            className="chip border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
          >
            From scan
          </span>
        )}
        <button
          onClick={() => void copyQuestion(q.text)}
          aria-label="Copy question"
          title="Copy question"
          className="btn btn-ghost btn-icon btn-sm ml-auto"
        >
          <Copy className="size-3.5" />
        </button>
      </div>

      <p className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{q.text}</p>
      {q.source === "scan" && (
        <p className="mt-1 text-xs italic text-muted-foreground">
          Transcribed from a scanned page. Open the paper to double-check the wording and any
          symbols.
        </p>
      )}

      <div className="mt-3 space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {repeats > 1 ? `Asked in ${repeats} papers` : "From"}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {q.appearances.map((a) => (
            <li key={a.questionId}>
              <button
                onClick={() => openPaper(a.paper, a.pageNumber)}
                title={a.pageNumber ? `${a.paper.title}, page ${a.pageNumber}` : a.paper.title}
                className="chip transition-colors hover:border-primary hover:text-primary"
              >
                <FileText className="size-3 text-primary" />
                {showSubject && `${a.paper.subjectCode} · `}
                {paperLabel(a.paper)}
                {a.label ? ` · ${a.label}` : ""}
                {a.pageNumber ? ` · p.${a.pageNumber}` : ""}
                <ExternalLink className="size-3 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

// ── All results for one topic ────────────────────────────────────────────────

export function PyqTopicResults({
  result,
  showSubject = false,
}: {
  result: ApiPyqTopicResult;
  showSubject?: boolean;
}) {
  if (result.questions.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        No past-paper questions found for this topic. Try a broader term (for example “trees”
        instead of “AVL tree rotations”).
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <CalendarDays className="size-3.5" /> Appears in:
        </span>
        {result.papers.map((p) => (
          <button
            key={p.paper.id}
            onClick={() => openPaper(p.paper)}
            className="chip chip-tone transition-opacity hover:opacity-80"
            style={toneStyle(String(p.paper.year))}
          >
            {showSubject && `${p.paper.subjectCode} · `}
            {paperLabel(p.paper)}
            <span className="text-muted-foreground">
              · {p.questionCount} question{p.questionCount === 1 ? "" : "s"}
            </span>
          </button>
        ))}
      </div>
      <ul className="divide-y divide-border">
        {result.questions.map((q) => (
          <QuestionCard key={q.id} q={q} showSubject={showSubject} />
        ))}
      </ul>
    </div>
  );
}

// ── Inline panel for a single syllabus topic ─────────────────────────────────

export function TopicPyqPanel({
  topic,
  subjectId,
  context,
}: {
  topic: string;
  subjectId?: string | undefined;
  context?: string | undefined;
}) {
  const [data, setData] = useState<ApiPyqSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    searchPyqQuestions({ topics: [cleanTopic(topic)], subjectId, context, perTopic: 5 })
      .then((r) => !cancelled && setData(r))
      .catch(
        (e) =>
          !cancelled &&
          setError(e instanceof ApiError ? e.message : "Couldn't load past questions."),
      );
    return () => {
      cancelled = true;
    };
  }, [topic, subjectId, context]); // context added

  if (error) return <p className="py-2 text-xs text-destructive">{error}</p>;
  if (!data) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Searching past papers…
      </div>
    );
  }

  const result = data.results[0];
  const unread = data.coverage.totalPapers - data.coverage.papersIndexed;
  const search: { subjectId?: string; topics: string[] } = { topics: [cleanTopic(topic)] };
  if (subjectId) search.subjectId = subjectId;

  return (
    <div className="space-y-3 rounded-xl bg-muted/40 p-4">
      {result ? <PyqTopicResults result={result} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Searched {data.coverage.papersIndexed} of {data.coverage.totalPapers} paper
          {data.coverage.totalPapers === 1 ? "" : "s"}
          {unread > 0 && " (the rest couldn't be read, often scanned PDFs)"}.
        </span>
        <Link to="/pyq" search={search} className="font-medium text-primary hover:underline">
          Open in PYQ Finder
        </Link>
      </div>
    </div>
  );
}
