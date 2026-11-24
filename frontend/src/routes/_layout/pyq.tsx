import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Info, Loader2, Plus, Search, X } from "lucide-react";

import { toneStyle } from "@/lib/tone";
import { LoginModal } from "@/components/campus/LoginModal";
import { PyqTopicResults, cleanTopic } from "@/components/campus/PyqResults";
import { useAuthStore } from "@/lib/auth";
import {
  ApiError,
  fetchProfile,
  fetchSubjects,
  fetchSyllabi,
  searchPyqQuestions,
  type ApiPyqSearchResponse,
  type ApiSyllabus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_layout/pyq")({
  head: () => ({ meta: [{ title: "PYQ Finder — CampusBrain" }] }),
  // /pyq?subjectId=…&topics=[…]  (the inline "Open in PYQ Finder" link produces this)
  validateSearch: (s: Record<string, unknown>): { subjectId?: string; topics?: string[] } => {
    const out: { subjectId?: string; topics?: string[] } = {};
    if (typeof s["subjectId"] === "string" && s["subjectId"]) out.subjectId = s["subjectId"];
    if (Array.isArray(s["topics"])) {
      const t = s["topics"]
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .slice(0, 10);
      if (t.length > 0) out.topics = t;
    }
    return out;
  },
  component: PyqPage,
});

const MAX_TOPICS = 10;

type SubjectOption = { id: string; code: string; name: string };

function PyqPage() {
  const { user } = useAuthStore();
  const search = Route.useSearch();
  const [loginOpen, setLoginOpen] = useState(false);

  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [subjectId, setSubjectId] = useState(search.subjectId ?? "");
  const [topics, setTopics] = useState<string[]>(search.topics ?? []);
  const [input, setInput] = useState("");
  const [syllabi, setSyllabi] = useState<ApiSyllabus[]>([]);

  const [data, setData] = useState<ApiPyqSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoRan = useRef(false);
  const activeSearch = useRef<AbortController | null>(null);

  // Subjects: the user's enrolled ones if they have any, otherwise everything
  useEffect(() => {
    if (!user) return;
    const toOptions = (list: { id: string; code: string; name: string }[]): SubjectOption[] =>
      list.map((s) => ({ id: s.id, code: s.code, name: s.name }));
    fetchProfile()
      .then((p) => toOptions(p.subjects.map((ps) => ps.subject)))
      .then((mine) => (mine.length > 0 ? mine : fetchSubjects({}).then(toOptions)))
      .catch(() => fetchSubjects({}).then(toOptions))
      .then(setSubjects)
      .catch(() => undefined);
  }, [user]);

  // Syllabus (public) → one-click topic suggestions for the chosen subject
  useEffect(() => {
    let current = true;
    setSyllabi([]);
    if (!subjectId) return;
    fetchSyllabi({ subjectId })
      .then((syllabi) => {
        if (current) setSyllabi(syllabi);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [subjectId]);

  useEffect(() => {
    activeSearch.current?.abort();
    setData(null);
    setError(null);
    setLoading(false);
    return () => activeSearch.current?.abort();
  }, [subjectId, user?.id]);

  const units = useMemo(
    () =>
      subjectId
        ? syllabi.flatMap((s) =>
            s.items
              .filter((i) => i.subjectId === subjectId)
              .map((i) => ({ key: i.id, title: i.title, topics: i.topics })),
          )
        : [],
    [syllabi, subjectId],
  );

  /** Merge raw text (one topic per line, or separated by ;) into a topic list, de-duplicated and capped. */
  const mergeTopics = useCallback((base: string[], raw: string): string[] => {
    const next = [...base];
    for (const part of raw.split(/[\n;]+/)) {
      const t = cleanTopic(part);
      if (
        t.length >= 2 &&
        next.length < MAX_TOPICS &&
        !next.some((x) => x.toLowerCase() === t.toLowerCase())
      ) {
        next.push(t);
      }
    }
    return next;
  }, []);

  const runSearch = useCallback(async (list: string[], subject: string) => {
    if (list.length === 0) return;
    activeSearch.current?.abort();
    const controller = new AbortController();
    activeSearch.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await searchPyqQuestions(
        { topics: list, subjectId: subject || undefined, perTopic: 8 },
        controller.signal,
      );
      if (!controller.signal.aborted) setData(result);
    } catch (e) {
      if (controller.signal.aborted) return;
      setData(null);
      setError(e instanceof ApiError ? e.message : "Search failed. Please try again.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  // Deep link from the syllabus page: search immediately
  useEffect(() => {
    if (user && !autoRan.current && (search.topics?.length ?? 0) > 0) {
      autoRan.current = true;
      void runSearch(search.topics ?? [], search.subjectId ?? "");
    }
  }, [user, search.topics, search.subjectId, runSearch]);

  function submit() {
    const list = mergeTopics(topics, input);
    setTopics(list);
    setInput("");
    void runSearch(list, subjectId);
  }

  function toggleSuggestion(topic: string) {
    setTopics((prev) =>
      prev.some((x) => x.toLowerCase() === topic.toLowerCase())
        ? prev.filter((x) => x.toLowerCase() !== topic.toLowerCase())
        : mergeTopics(prev, topic),
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="card max-w-sm p-10 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
            <Search className="size-6" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            Sign in to use the PYQ Finder
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Find the exact questions asked in past papers for any topic, and see which papers they
            came from.
          </p>
          <button onClick={() => setLoginOpen(true)} className="btn btn-primary mt-5 w-full">
            Sign In
          </button>
        </div>
        <LoginModal
          open={loginOpen}
          onClose={() => setLoginOpen(false)}
          onSuccess={() => setLoginOpen(false)}
        />
      </div>
    );
  }

  const unread = data ? data.coverage.totalPapers - data.coverage.papersIndexed : 0;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">PYQ Finder</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Search one or more topics and see the exact questions asked in past papers, and which
          paper each one is from.
        </p>
      </div>

      <section className="card space-y-5 p-6">
        <div className="space-y-2">
          <span id="pyq-subject" className="field-label">
            Subject
          </span>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="pyq-subject">
            <button
              type="button"
              aria-pressed={subjectId === ""}
              onClick={() => setSubjectId("")}
              className={cn("chip", subjectId === "" && "chip-active")}
            >
              All subjects
            </button>
            {subjects.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={subjectId === s.id}
                title={s.name}
                onClick={() => setSubjectId(s.id)}
                style={toneStyle(s.id)}
                className={cn("chip", subjectId === s.id ? "chip-active" : "chip-tone")}
              >
                {s.code} — {s.name}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="pyq-topic" className="field-label">
            Topics <span className="font-normal text-muted-foreground">(up to {MAX_TOPICS})</span>
          </label>
          <div className="flex gap-2">
            <input
              id="pyq-topic"
              className="field"
              placeholder="e.g. Binary Trees, then press Enter"
              value={input}
              maxLength={200}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (input.trim()) {
                  setTopics((p) => mergeTopics(p, input));
                  setInput("");
                } else if (topics.length > 0) {
                  submit();
                }
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text");
                if (/[\n;]/.test(text)) {
                  e.preventDefault();
                  setTopics((p) => mergeTopics(p, text));
                }
              }}
            />
            <button
              type="button"
              aria-label="Add topic"
              onClick={() => {
                setTopics((p) => mergeTopics(p, input));
                setInput("");
              }}
              disabled={!input.trim() || topics.length >= MAX_TOPICS}
              className="btn btn-outline btn-icon shrink-0"
            >
              <Plus className="size-4" />
            </button>
          </div>

          {topics.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 pt-1">
              {topics.map((t) => (
                <li key={t} style={toneStyle(t)} className="chip chip-tone gap-1 pr-1">
                  {t}
                  <button
                    onClick={() => setTopics((p) => p.filter((x) => x !== t))}
                    aria-label={`Remove ${t}`}
                    className="inline-flex size-5 items-center justify-center rounded-full hover:bg-foreground/10"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Syllabus suggestions */}
        {subjectId && units.length > 0 && (
          <details className="rounded-xl bg-muted/40 p-4">
            <summary className="cursor-pointer text-xs font-medium text-foreground">
              Pick from the syllabus ({units.length} unit{units.length === 1 ? "" : "s"})
            </summary>
            <div className="mt-3 space-y-3">
              {units.map((u) => (
                <div key={u.key} className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">{u.title}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {u.topics.map((t) => {
                      const on = topics.some((x) => x.toLowerCase() === t.toLowerCase());
                      return (
                        <button
                          key={t}
                          onClick={() => toggleSuggestion(t)}
                          aria-pressed={on}
                          className={cn("chip", on && "chip-active")}
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
        {!subjectId && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5" /> Choose a subject for more precise results and syllabus
            suggestions.
          </p>
        )}

        <button
          onClick={submit}
          disabled={loading || (topics.length === 0 && !input.trim())}
          className="btn btn-primary"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Find questions
        </button>
      </section>

      {error && (
        <p className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{error}</p>
      )}

      {data && (
        <>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p>
              Searched {data.coverage.papersIndexed} of {data.coverage.totalPapers} paper
              {data.coverage.totalPapers === 1 ? "" : "s"} ({data.coverage.questionsIndexed}{" "}
              questions indexed). Questions from text PDFs are copied as printed; questions from
              scanned papers are read by AI and marked &ldquo;From scan&rdquo;, so check the paper
              for anything that looks off.
            </p>
            {unread > 0 && (
              <p className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {unread} paper{unread === 1 ? "" : "s"} couldn't be read (often scanned PDFs) or{" "}
                {unread === 1 ? "hasn't" : "haven't"} been indexed yet, so matches there are
                missing.
              </p>
            )}
            {(!data.ragEnabled || data.semanticUnavailable) && (
              <p className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                Smart (meaning-based) search is unavailable right now, so only questions containing
                your words are shown.
              </p>
            )}
          </div>

          <div className="space-y-8">
            {data.results.map((r) => (
              <section
                key={r.topic}
                style={toneStyle(r.topic)}
                className="card tone-accent-l space-y-4 p-6"
              >
                <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-foreground">
                  {r.topic}
                  <span className="text-xs font-normal text-muted-foreground">
                    {r.questions.length} question{r.questions.length === 1 ? "" : "s"}
                    {r.years.length > 0 && " · asked in"}
                  </span>
                  {r.years.map((y) => (
                    <span key={String(y)} className="chip chip-tone">
                      {String(y)}
                    </span>
                  ))}
                </h2>
                <PyqTopicResults result={r} showSubject={!subjectId} />
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
