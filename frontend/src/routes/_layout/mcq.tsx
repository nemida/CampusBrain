import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Brain,
  CheckCircle2,
  XCircle,
  Trophy,
  RotateCcw,
  Zap,
  Loader2,
  Trash2,
} from "lucide-react";

import { toneStyle } from "@/lib/tone";
import { LoginModal } from "@/components/campus/LoginModal";
import { useAuthStore } from "@/lib/auth";
import {
  generateMCQ,
  submitMCQAnswers,
  fetchMCQSessions,
  fetchMCQSession,
  deleteMCQSession,
  fetchSubjects,
  fetchProfile,
  ApiMCQQuestion,
  ApiMCQResult,
  ApiError,
} from "@/lib/api";

export const Route = createFileRoute("/_layout/mcq")({
  validateSearch: (s: Record<string, unknown>): { topic?: string; subjectId?: string } => {
    const out: { topic?: string; subjectId?: string } = {};
    if (typeof s["topic"] === "string" && s["topic"]) out.topic = s["topic"];
    if (typeof s["subjectId"] === "string" && s["subjectId"]) out.subjectId = s["subjectId"];
    return out;
  },
  component: MCQPage,
});

type Phase = "config" | "playing" | "results";

function scoreChip(score: number): string {
  if (score >= 70) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  if (score >= 40) return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  return "bg-destructive/10 text-destructive";
}

function MCQPage() {
  const search = Route.useSearch();

  const { user } = useAuthStore();
  const [loginOpen, setLoginOpen] = useState(false);

  // Subjects for the dropdown
  const [subjects, setSubjects] = useState<{ id: string; code: string; name: string }[]>([]);

  // Config form
  const [subjectId, setSubjectId] = useState(search.subjectId ?? "");
  const [topic, setTopic] = useState(search.topic ?? "");
  const [count, setCount] = useState(10);

  // Session
  const [phase, setPhase] = useState<Phase>("config");
  const [sessionId, setSessionId] = useState("");
  const [questions, setQuestions] = useState<ApiMCQQuestion[]>([]);
  const [current, setCurrent] = useState(0);
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [result, setResult] = useState<ApiMCQResult | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Existing quiz sessions (incl. ones the AI agent created)
  const [sessions, setSessions] = useState<
    {
      id: string;
      topic: string | null;
      score: number;
      totalQ: number;
      answeredCount: number;
      createdAt: string;
    }[]
  >([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  useEffect(() => {
    // Try profile subjects first, fall back to all subjects
    fetchProfile()
      .then((profile) => {
        const profileSubjects = profile.subjects.map((ps) => ({
          id: ps.subject.id,
          code: ps.subject.code,
          name: ps.subject.name,
        }));
        if (
          profileSubjects.length > 0 &&
          (!search.subjectId || profileSubjects.some((subject) => subject.id === search.subjectId))
        ) {
          setSubjects(profileSubjects);
          return undefined;
        } else {
          // No profile subjects — load all
          return fetchSubjects({}).then((s) =>
            setSubjects(s.map((x) => ({ id: x.id, code: x.code, name: x.name }))),
          );
        }
      })
      .catch(() => {
        // Not logged in or no profile — load all subjects
        fetchSubjects({})
          .then((s) => setSubjects(s.map((x) => ({ id: x.id, code: x.code, name: x.name }))))
          .catch(() => undefined);
      });
  }, [search.subjectId]);

  // Fetch existing quiz sessions so the student can resume agent-created quizzes
  useEffect(() => {
    if (!user) return;
    setSessionsLoading(true);
    fetchMCQSessions()
      .then(setSessions)
      .catch(() => undefined)
      .finally(() => setSessionsLoading(false));
  }, [user]);

  function loadSessions() {
    fetchMCQSessions()
      .then(setSessions)
      .catch(() => undefined);
  }

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await generateMCQ({
        subjectId: subjectId || undefined,
        topic: topic.trim() || undefined,
        count,
      });
      setSessionId(res.sessionId);
      setQuestions(res.questions);
      setChosen({});
      setCurrent(0);
      setResult(null);
      setPhase("playing");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to generate questions.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      const answers = Object.entries(chosen).map(([questionId, chosenIndex]) => ({
        questionId,
        chosenIndex,
      }));
      const res = await submitMCQAnswers(sessionId, answers);
      setResult(res);
      setPhase("results");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to submit answers.");
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setPhase("config");
    setQuestions([]);
    setChosen({});
    setResult(null);
    setError(null);
    // Refresh so quizzes completed this session show up with their score
    loadSessions();
  }

  async function handleDeleteSession(id: string) {
    setDeletingId(id);
    try {
      await deleteMCQSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      setError("Failed to delete quiz.");
    } finally {
      setDeletingId(null);
    }
  }

  async function startExistingSession(id: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMCQSession(id);
      setSessionId(res.sessionId);
      setQuestions(res.questions);
      setChosen({});
      setCurrent(0);
      setResult(null);
      setPhase("playing");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load quiz.");
    } finally {
      setLoading(false);
    }
  }

  if (!user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="card max-w-sm p-10 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
            <Brain className="size-6" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">Sign in to play MCQ</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Test your knowledge with AI-generated questions from your subjects.
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

  return (
    <>
      <main className="mx-auto max-w-2xl space-y-8 px-6 py-10">
        <div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">MCQ Game</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            AI-generated multiple choice questions from your subjects.
          </p>
        </div>

        {error && (
          <p className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{error}</p>
        )}

        {/* ── Existing quizzes ── */}
        {phase === "config" && (
          <>
            {sessionsLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!sessionsLoading && sessions.length > 0 && (
              <section className="card p-6">
                <h2 className="mb-2 text-sm font-semibold text-foreground">Your quizzes</h2>
                <div className="divide-y divide-border">
                  {sessions.map((s) => {
                    const completed = s.answeredCount > 0;
                    return (
                      <div
                        key={s.id}
                        style={toneStyle(s.topic || "General")}
                        className="flex items-center justify-between py-3"
                      >
                        <span className="tone-dot mr-3 size-2 shrink-0 rounded-full" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {s.topic || "General"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {s.totalQ} questions ·{" "}
                            {new Date(s.createdAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                        </div>
                        {completed ? (
                          <span
                            className={`chip ml-3 shrink-0 border-transparent font-semibold ${scoreChip(s.score)}`}
                          >
                            {Math.round(s.score)}%
                          </span>
                        ) : (
                          <button
                            onClick={() => void startExistingSession(s.id)}
                            disabled={loading}
                            className="btn btn-primary btn-sm ml-3 shrink-0"
                          >
                            Start
                          </button>
                        )}
                        <button
                          onClick={() => {
                            if (window.confirm("Delete this quiz? This also updates your stats.")) {
                              void handleDeleteSession(s.id);
                            }
                          }}
                          disabled={deletingId === s.id}
                          aria-label={`Delete ${s.topic || "General"} quiz`}
                          className="btn btn-ghost btn-icon btn-sm ml-1 shrink-0 text-destructive"
                        >
                          {deletingId === s.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Config ── */}
            <section className="card p-6">
              <h2 className="mb-2 text-base font-semibold text-foreground">Configure your quiz</h2>
              {subjects.length > 0 && (
                <p className="mb-4 text-xs text-muted-foreground">
                  Showing subjects from your profile.{" "}
                  <Link to="/profile" className="text-primary hover:underline">
                    Edit subjects →
                  </Link>
                </p>
              )}
              <form onSubmit={handleStart} className="space-y-5">
                <div className="space-y-2">
                  <span className="field-label">Subject (optional)</span>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Subject">
                    <button
                      type="button"
                      aria-pressed={subjectId === ""}
                      onClick={() => setSubjectId("")}
                      className={`chip ${subjectId === "" ? "chip-active" : ""}`}
                    >
                      General / Any
                    </button>
                    {subjects.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={subjectId === s.id}
                        title={s.name}
                        onClick={() => setSubjectId(s.id)}
                        style={toneStyle(s.id)}
                        className={`chip ${subjectId === s.id ? "chip-active" : "chip-tone"}`}
                      >
                        {s.code} — {s.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="field-label">Topic (optional)</label>
                  <input
                    className="field"
                    placeholder="e.g. Pointers, Binary Trees, SQL Joins"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <span className="field-label">Number of questions</span>
                  <div className="segmented" role="group" aria-label="Number of questions">
                    {[5, 10, 15, 20].map((n) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={count === n}
                        onClick={() => setCount(n)}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <button type="submit" disabled={loading} className="btn btn-primary w-full">
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Zap className="size-4" />
                  )}
                  {loading ? "Generating…" : "Start Quiz"}
                </button>
              </form>
            </section>
          </>
        )}

        {/* ── Playing ── */}
        {phase === "playing" && questions.length > 0 && (
          <section className="space-y-6">
            {/* Progress */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Question {current + 1} of {questions.length}
                </span>
                <span>{Object.keys(chosen).length} answered</span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-1 rounded-full bg-primary transition-all"
                  style={{ width: `${((current + 1) / questions.length) * 100}%` }}
                />
              </div>
            </div>

            {/* Question card */}
            {(() => {
              const q = questions[current]!;
              const picked = chosen[q.id];
              return (
                <div className="card space-y-6 p-6 sm:p-8">
                  {q.topic && (
                    <span className="chip chip-tone" style={toneStyle(q.topic)}>
                      {q.topic}
                    </span>
                  )}
                  <p className="text-xl font-semibold leading-relaxed text-foreground">
                    {q.question}
                  </p>
                  <div className="space-y-2.5">
                    {q.options.map((opt, idx) => (
                      <button
                        key={idx}
                        onClick={() => setChosen((c) => ({ ...c, [q.id]: idx }))}
                        aria-pressed={picked === idx}
                        className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                          picked === idx
                            ? "bg-primary/10 font-medium text-foreground ring-2 ring-primary"
                            : "bg-muted/60 text-foreground hover:bg-muted"
                        }`}
                      >
                        <span
                          className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                            picked === idx
                              ? "bg-primary text-primary-foreground"
                              : "bg-background text-muted-foreground"
                          }`}
                        >
                          {["A", "B", "C", "D"][idx]}
                        </span>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Navigation */}
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => setCurrent((c) => Math.max(0, c - 1))}
                disabled={current === 0}
                className="btn btn-outline"
              >
                Previous
              </button>

              {current < questions.length - 1 ? (
                <button onClick={() => setCurrent((c) => c + 1)} className="btn btn-primary">
                  Next
                </button>
              ) : (
                <button
                  onClick={() => void handleSubmit()}
                  disabled={loading || Object.keys(chosen).length === 0}
                  className="btn btn-primary"
                >
                  {loading && <Loader2 className="size-3.5 animate-spin" />}
                  Submit Answers
                </button>
              )}
            </div>
          </section>
        )}

        {/* ── Results ── */}
        {phase === "results" && result && (
          <section className="space-y-6">
            {/* Score card */}
            <div className="card p-10 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent text-primary">
                <Trophy className="size-7" />
              </div>
              <p className="font-display mt-4 text-6xl font-bold text-foreground">
                {Math.round(result.score)}%
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {result.correctQ} correct out of {result.totalQ} questions
              </p>
            </div>

            {/* Per-question breakdown */}
            <div className="card divide-y divide-border px-6">
              {questions.map((q, idx) => {
                const r = result.results.find((x) => x.questionId === q.id);
                if (!r) return null;
                return (
                  <div key={q.id} className="py-4">
                    <div className="flex items-start gap-2.5">
                      {r.correct ? (
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          Q{idx + 1}. {q.question}
                        </p>
                        {!r.correct && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Correct answer:{" "}
                            <span className="font-medium text-foreground">
                              {q.options[r.correctIndex]}
                            </span>
                          </p>
                        )}
                        {r.explanation && (
                          <p className="mt-1 text-xs text-muted-foreground">{r.explanation}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <button onClick={handleReset} className="btn btn-outline w-full">
              <RotateCcw className="size-4" />
              Play Again
            </button>
          </section>
        )}
      </main>
    </>
  );
}
