import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Layers, Plus, RotateCcw, BookOpen, Loader2, Trash2, Zap } from "lucide-react";

import { toneStyle } from "@/lib/tone";
import { LoginModal } from "@/components/campus/LoginModal";
import { useAuthStore } from "@/lib/auth";
import {
  fetchFlashcardSets,
  generateFlashcards,
  fetchFlashcardSet,
  fetchDueFlashcards,
  reviewFlashcard,
  deleteFlashcardSet,
  fetchSubjects,
  fetchProfile,
  ApiFlashcardSet,
  ApiFlashcard,
  ApiError,
} from "@/lib/api";

export const Route = createFileRoute("/_layout/flashcards")({
  validateSearch: (search: Record<string, unknown>): { topic?: string; subjectId?: string } => ({
    ...(typeof search["topic"] === "string" ? { topic: search["topic"].slice(0, 200) } : {}),
    ...(typeof search["subjectId"] === "string"
      ? { subjectId: search["subjectId"].slice(0, 100) }
      : {}),
  }),
  head: () => ({ meta: [{ title: "Flashcards — CampusBrain" }] }),
  component: FlashcardsPage,
});

function FlipCard({
  card,
  onRate,
  saving,
}: {
  card: ApiFlashcard;
  onRate: (q: number) => void;
  saving: boolean;
}) {
  const [flipped, setFlipped] = useState(false);

  return (
    <div className="space-y-4">
      {/* Card */}
      <div
        className="relative mx-auto h-64 w-full max-w-md cursor-pointer"
        style={{ perspective: "1000px" }}
        onClick={() => setFlipped((f) => !f)}
        role="button"
        aria-label={flipped ? "Show front" : "Reveal answer"}
      >
        <div
          className="relative h-full w-full transition-transform duration-500"
          style={{
            transformStyle: "preserve-3d",
            transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
          }}
        >
          {/* Front */}
          <div
            className="absolute inset-0 flex items-center justify-center card p-8 shadow-lg"
            style={{ backfaceVisibility: "hidden" }}
          >
            <p className="text-center text-xl font-semibold leading-snug text-foreground">
              {card.front}
            </p>
          </div>
          {/* Back */}
          <div
            className="absolute inset-0 flex items-center justify-center rounded-xl bg-accent p-8 shadow-lg ring-1 ring-primary/30"
            style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
          >
            <p className="text-center text-sm leading-relaxed text-foreground">{card.back}</p>
          </div>
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        {flipped ? "How well did you know this?" : "Click card to reveal answer"}
      </p>

      {flipped && (
        <div className="flex justify-center gap-3">
          {[
            {
              label: "Hard",
              q: 1,
              cls: "bg-destructive/10 text-destructive hover:bg-destructive/20",
            },
            {
              label: "Okay",
              q: 3,
              cls: "bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-400",
            },
            {
              label: "Easy",
              q: 5,
              cls: "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400",
            },
          ].map((btn) => (
            <button
              key={btn.q}
              disabled={saving}
              onClick={() => onRate(btn.q)}
              className={`btn px-6 ${btn.cls}`}
            >
              {btn.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FlashcardsPage() {
  const search = Route.useSearch();
  const { user } = useAuthStore();
  const [loginOpen, setLoginOpen] = useState(false);

  const [sets, setSets] = useState<ApiFlashcardSet[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generate form
  const [showGenerate, setShowGenerate] = useState(!!search.topic);
  const [genTopic, setGenTopic] = useState(search.topic ?? "");
  const [genSubjectId, setGenSubjectId] = useState(search.subjectId ?? "");
  const [genCount, setGenCount] = useState(10);
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<{ id: string; code: string; name: string }[]>([]);

  // Study mode
  const [studySet, setStudySet] = useState<(ApiFlashcardSet & { cards: ApiFlashcard[] }) | null>(
    null,
  );
  const [studyIdx, setStudyIdx] = useState(0);
  const [studyLoading, setStudyLoading] = useState(false);
  const ratingInFlight = useRef(false);
  const [ratingSaving, setRatingSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    loadSets();
    // Try profile subjects first, fall back to all
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
          return fetchSubjects({}).then((s) =>
            setSubjects(s.map((x) => ({ id: x.id, code: x.code, name: x.name }))),
          );
        }
      })
      .catch(() => {
        fetchSubjects({})
          .then((s) => setSubjects(s.map((x) => ({ id: x.id, code: x.code, name: x.name }))))
          .catch(() => undefined);
      });
  }, [user, search.subjectId]);

  function loadSets() {
    setError(null);
    setLoading(true);
    fetchFlashcardSets()
      .then(setSets)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load sets."))
      .finally(() => setLoading(false));
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!genTopic.trim()) return;
    setGenLoading(true);
    setGenError(null);
    try {
      await generateFlashcards({
        topic: genTopic.trim(),
        subjectId: genSubjectId || undefined,
        count: genCount,
      });
      setShowGenerate(false);
      setGenTopic("");
      setGenSubjectId("");
      loadSets();
    } catch (err) {
      setGenError(err instanceof ApiError ? err.message : "Failed to generate flashcards.");
    } finally {
      setGenLoading(false);
    }
  }

  async function handleStudy(setId: string) {
    setStudyLoading(true);
    try {
      let s = await fetchDueFlashcards(setId);
      if (s.cards.length === 0) {
        if (
          !window.confirm(
            "You're all caught up — no cards are due right now. Practise the whole set anyway?",
          )
        ) {
          return;
        }
        s = await fetchFlashcardSet(setId);
      }
      if (s.cards.length === 0) {
        toast.info("This set has no cards.");
        return;
      }
      setStudySet(s);
      setStudyIdx(0);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load cards.");
    } finally {
      setStudyLoading(false);
    }
  }

  async function handleRate(quality: number) {
    if (!studySet || ratingInFlight.current) return;
    const card = studySet.cards[studyIdx];
    if (!card) return;
    ratingInFlight.current = true;
    setRatingSaving(true);
    try {
      await reviewFlashcard(card.id, quality);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Review wasn't saved. Please try again.",
      );
      return;
    } finally {
      ratingInFlight.current = false;
      setRatingSaving(false);
    }
    // Next card or done
    if (studyIdx + 1 < studySet.cards.length) {
      setStudyIdx((i) => i + 1);
    } else {
      setStudySet(null);
      loadSets();
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this flashcard set?")) return;
    try {
      await deleteFlashcardSet(id);
      setSets((prev) => prev.filter((s) => s.id !== id));
      toast.success("Flashcard set deleted");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  if (!user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="card max-w-sm p-10 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
            <Layers className="size-6" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            Sign in to use Flashcards
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Generate AI flashcards from any topic and study with spaced repetition.
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

  // Study mode overlay
  if (studySet) {
    const card = studySet.cards[studyIdx];
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <div className="w-full max-w-lg space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{studySet.title}</h2>
            <button onClick={() => setStudySet(null)} className="btn btn-ghost btn-sm">
              Exit
            </button>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                Card {studyIdx + 1} of {studySet.cards.length}
              </span>
              <span>{studySet.cards.length - studyIdx - 1} remaining</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-1 rounded-full bg-primary transition-all"
                style={{ width: `${((studyIdx + 1) / studySet.cards.length) * 100}%` }}
              />
            </div>
          </div>
          {card ? (
            <FlipCard key={card.id} card={card} onRate={handleRate} saving={ratingSaving} />
          ) : (
            <p className="text-center text-sm text-muted-foreground">No cards to study.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <main className="mx-auto max-w-4xl space-y-8 px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">Flashcards</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              AI-generated flashcards with spaced repetition (SM-2).
            </p>
          </div>
          <button onClick={() => setShowGenerate((v) => !v)} className="btn btn-primary shrink-0">
            <Plus className="size-4" />
            Generate Set
          </button>
        </div>

        {/* Generate form */}
        {showGenerate && (
          <section className="card p-6">
            <h2 className="mb-2 text-base font-semibold text-foreground">Generate flashcards</h2>
            {subjects.length > 0 && (
              <p className="mb-4 text-xs text-muted-foreground">
                Subjects from your profile.{" "}
                <Link to="/profile" className="text-primary hover:underline">
                  Edit →
                </Link>
              </p>
            )}
            <form onSubmit={handleGenerate} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="field-label">Topic *</label>
                  <input
                    className="field"
                    placeholder="e.g. Binary Trees, SQL, Pointers"
                    value={genTopic}
                    onChange={(e) => setGenTopic(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <span className="field-label">Subject (optional)</span>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Subject">
                    <button
                      type="button"
                      aria-pressed={genSubjectId === ""}
                      onClick={() => setGenSubjectId("")}
                      className={`chip ${genSubjectId === "" ? "chip-active" : ""}`}
                    >
                      Any
                    </button>
                    {subjects.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={genSubjectId === s.id}
                        title={s.name}
                        onClick={() => setGenSubjectId(s.id)}
                        style={toneStyle(s.id)}
                        className={`chip ${genSubjectId === s.id ? "chip-active" : "chip-tone"}`}
                      >
                        {s.code}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <span className="field-label">Number of cards</span>
                <div className="segmented" role="group" aria-label="Number of cards">
                  {[10, 20, 30].map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={genCount === n}
                      onClick={() => setGenCount(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              {genError && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {genError}
                </p>
              )}
              <div className="flex gap-2">
                <button type="submit" disabled={genLoading} className="btn btn-primary">
                  {genLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  {genLoading ? "Generating…" : "Generate"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowGenerate(false)}
                  className="btn btn-outline"
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}

        {/* Sets list */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading sets...
          </div>
        ) : error ? (
          <p className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{error}</p>
        ) : sets.length === 0 ? (
          <div className="card p-12 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
              <Layers className="size-6" />
            </div>
            <p className="mt-4 text-base font-semibold text-foreground">No flashcard sets yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Hit "Generate Set" to create your first set from any topic.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sets.map((s) => (
              <div key={s.id} style={toneStyle(s.id)} className="card tone-accent-l space-y-4 p-5">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                  {s.topic && <p className="mt-0.5 text-xs text-muted-foreground">{s.topic}</p>}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{s.cardCount ?? s._count?.cards ?? 0} cards</span>
                  <span className={s.dueCount ? "chip chip-tone" : "chip"}>
                    {s.dueCount ?? 0} due
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void handleStudy(s.id)}
                    disabled={studyLoading}
                    className="btn btn-primary btn-sm flex-1"
                  >
                    {studyLoading ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <BookOpen className="size-3" />
                    )}
                    Study
                  </button>
                  <button
                    onClick={() => void handleDelete(s.id)}
                    aria-label="Delete set"
                    className="btn btn-ghost btn-icon btn-sm text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
