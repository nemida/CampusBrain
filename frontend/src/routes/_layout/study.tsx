import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Calendar,
  CheckCircle2,
  Circle,
  Trash2,
  BookOpen,
  Loader2,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Upload,
  FileText,
  X,
  AlertCircle,
  RefreshCw,
  ListChecks,
  Plus,
  Check,
} from "lucide-react";

import { LoginModal } from "@/components/campus/LoginModal";
import { toneStyle } from "@/lib/tone";
import { useAuthStore } from "@/lib/auth";
import {
  fetchStudyPlans,
  generateStudyPlanSmart,
  parseTimetable,
  markDayComplete,
  markSessionDone,
  catchUpStudyPlan,
  deleteStudyPlan,
  fetchProfile,
  fetchSyllabi,
  ApiStudyPlan,
  ApiStudyPlanDay,
  ApiStudySession,
  ApiExtractedExam,
  ApiSyllabusItem,
  ApiError,
} from "@/lib/api";

export const Route = createFileRoute("/_layout/study")({
  head: () => ({ meta: [{ title: "Study Plan — CampusBrain" }] }),
  component: StudyPage,
});

const inputClass =
  "h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-primary";

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function daysUntil(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return "Past";
  if (diff === 0) return "Today!";
  return `${diff}d left`;
}

// ── Plan helpers ──────────────────────────────────────────────────────────────

/** YYYY-MM-DD of the IST calendar day containing `d`. */
const istKey = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function fmtMins(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** Blocks the student actually has to do (exam and buffer days have nothing to tick). */
const isActionable = (s: ApiStudySession) =>
  s.kind === "learn" || s.kind === "revision" || s.kind === "focus";

const KIND_LABEL: Record<ApiStudySession["kind"], string> = {
  learn: "Learn",
  revision: "📝 Revision",
  exam: "🎯 Exam day",
  focus: "👥 Group focus",
  buffer: "Buffer day",
};

/** Optimistic version of what the server does when one block is ticked. */
function applySessionDone(day: ApiStudyPlanDay, index: number, done: boolean): ApiStudyPlanDay {
  const sessions = (day.sessions ?? []).map((s, i) => (i === index ? { ...s, done } : s));
  const actionable = sessions.filter(isActionable);
  const isCompleted =
    actionable.length > 0 ? actionable.every((s) => s.done === true) : day.isCompleted;
  return { ...day, sessions, isCompleted };
}

/** Today's day if it's still to do, otherwise the next one coming up. Never an overdue day. */
function pickToday(plan: ApiStudyPlan): { day: ApiStudyPlanDay; kind: "today" | "next" } | null {
  if (plan.status !== "ACTIVE") return null;
  const key = istKey(new Date());
  const todays = plan.days.find((d) => d.date && istKey(d.date) === key);
  if (todays && !todays.isCompleted) return { day: todays, kind: "today" };
  const next = plan.days.find((d) => !d.isCompleted && d.date && istKey(d.date) > key);
  return next ? { day: next, kind: "next" } : null;
}

function overdueCount(plan: ApiStudyPlan): number {
  if (plan.status !== "ACTIVE") return 0;
  const key = istKey(new Date());
  return plan.days.filter((d) => !d.isCompleted && d.date && istKey(d.date) < key).length;
}

/** One subject block inside a day, with its own checkbox. */
function SessionRow({
  session,
  subjectKey,
  onToggle,
}: {
  session: ApiStudySession;
  subjectKey: string;
  onToggle: () => void;
}) {
  const actionable = isActionable(session);
  const done = session.done === true;
  return (
    <li className="flex items-start gap-2" style={toneStyle(subjectKey)}>
      {actionable ? (
        <button onClick={onToggle} className="mt-0.5 shrink-0" aria-label="Mark this block done">
          {done ? (
            <CheckCircle2 className="size-3.5 text-primary" />
          ) : (
            <Circle className="size-3.5 text-muted-foreground" />
          )}
        </button>
      ) : (
        <span className="mt-0.5 size-3.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">{KIND_LABEL[session.kind]}</span>
          {session.subjectCode && <span className="chip chip-tone">{session.subjectCode}</span>}
          {session.minutes > 0 && (
            <span className="text-[11px] text-muted-foreground">{fmtMins(session.minutes)}</span>
          )}
        </div>
        <p
          className={`mt-0.5 text-xs ${done ? "text-muted-foreground line-through" : "text-muted-foreground"}`}
        >
          {session.topics.join(" · ")}
        </p>
      </div>
    </li>
  );
}

function StudyPage() {
  const { user } = useAuthStore();
  const [loginOpen, setLoginOpen] = useState(false);
  const [plans, setPlans] = useState<ApiStudyPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [catchingUp, setCatchingUp] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Wizard state
  const [step, setStep] = useState<
    "idle" | "upload" | "review" | "configure" | "units" | "generating"
  >("idle");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [extractedExams, setExtractedExams] = useState<ApiExtractedExam[]>([]);
  const [editedExams, setEditedExams] = useState<ApiExtractedExam[]>([]);
  const [planTitle, setPlanTitle] = useState("");
  // Empty = automatic: plan until the last exam (30 days if there are no exams)
  const [planDays, setPlanDays] = useState("");
  const [planHours, setPlanHours] = useState("4");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Unit selection state
  const [unitItems, setUnitItems] = useState<(ApiSyllabusItem & { subjectName: string })[]>([]);
  const [excludedUnitIds, setExcludedUnitIds] = useState<Set<string>>(new Set());
  const [loadingUnits, setLoadingUnits] = useState(false);

  // Enrolled subjects for the exam date dropdown
  const [enrolledSubjects, setEnrolledSubjects] = useState<
    { id: string; name: string; code: string }[]
  >([]);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    fetchStudyPlans()
      .then(setPlans)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load plans."))
      .finally(() => setLoading(false));
  }, [user]);

  // Load enrolled subjects once when the wizard opens so the exam dropdown is ready
  useEffect(() => {
    if (step !== "upload" || enrolledSubjects.length > 0) return;
    fetchProfile()
      .then((p) => setEnrolledSubjects(p.subjects.map((s) => s.subject)))
      .catch(() => {
        /* silently ignore — dropdown just won't appear */
      });
  }, [step, enrolledSubjects.length]);

  async function handleFileChange(file: File) {
    setPdfFile(file);
    setParsing(true);
    setParseError(null);
    setStep("upload");
    try {
      const exams = await parseTimetable(file);
      setExtractedExams(exams);
      setEditedExams(exams);
      setStep("review");
    } catch (e) {
      setParseError(
        e instanceof ApiError
          ? e.message
          : "Could not parse PDF. You can still generate a plan without exam dates.",
      );
      setExtractedExams([]);
      setEditedExams([]);
      setStep("review");
    } finally {
      setParsing(false);
    }
  }

  async function handleLoadUnits() {
    setLoadingUnits(true);
    try {
      const profile = await fetchProfile();
      const enrolledSubjectIds = new Set(profile.subjects.map((s) => s.subject.id));
      const subjectById = new Map(profile.subjects.map((s) => [s.subject.id, s.subject]));

      // Only show units for subjects the user actually assigned exam dates to.
      // Fall back to all enrolled subjects when no exams were specified.
      const validExams = editedExams.filter((e) => e.subjectName.trim() && e.date);
      const examSubjectNames =
        validExams.length > 0
          ? new Set(validExams.map((e) => e.subjectName.trim().toLowerCase()))
          : null; // null = no filter, include all enrolled

      const syllabi = await fetchSyllabi({
        ...(profile.branchId ? { branchId: profile.branchId } : {}),
        ...(profile.semester ? { semester: profile.semester } : {}),
      });
      const items: (ApiSyllabusItem & { subjectName: string })[] = [];
      for (const syl of syllabi) {
        for (const item of syl.items) {
          if (!item.subjectId || !enrolledSubjectIds.has(item.subjectId)) continue;
          const subject = subjectById.get(item.subjectId);
          const name = subject?.name ?? item.subjectName ?? syl.branchName;
          // If the user gave exam dates, only include subjects that matched
          if (examSubjectNames && !examSubjectNames.has(name.trim().toLowerCase())) continue;
          items.push({ ...item, subjectName: name });
        }
      }
      setUnitItems(items);
      setExcludedUnitIds(new Set());
    } catch {
      setUnitItems([]);
    } finally {
      setLoadingUnits(false);
      setStep("units");
    }
  }

  async function handleGenerate() {
    setStep("generating");
    try {
      const days = Number(planDays);
      const hours = Math.min(12, Math.max(1, Number(planHours) || 4));
      const res = await generateStudyPlanSmart({
        title: planTitle.trim() || "My Exam Study Plan",
        // no startDate: the server uses today in IST (toISOString() would give the UTC date)
        ...(planDays.trim() && days > 0 ? { totalDays: days } : {}),
        hoursPerDay: hours,
        exams:
          editedExams.filter((e) => e.subjectName.trim() && e.date).length > 0
            ? editedExams.filter((e) => e.subjectName.trim() && e.date)
            : undefined,
        ...(excludedUnitIds.size > 0 ? { excludedUnitIds: [...excludedUnitIds] } : {}),
      });
      setPlans((p) => [res.plan, ...p]);
      setExpandedId(res.plan.id);
      setStep("idle");
      setPdfFile(null);
      setExtractedExams([]);
      setEditedExams([]);
      setPlanTitle("");
      setUnitItems([]);
      setExcludedUnitIds(new Set());
      setNotices(res.warnings);

      if (res.subjectsUsed === 0) {
        setError(
          "Plan generated but no subjects found in your profile. Add subjects in Profile for better results.",
        );
      } else {
        setError(null);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Generation failed.");
      setStep("idle");
    }
  }

  async function handleToggleDay(plan: ApiStudyPlan, dayId: string, current: boolean) {
    setPlans((prev) =>
      prev.map((p) =>
        p.id !== plan.id
          ? p
          : {
              ...p,
              days: p.days.map((d) =>
                d.id === dayId
                  ? {
                      ...d,
                      isCompleted: !current,
                      sessions: d.sessions
                        ? d.sessions.map((s) => ({ ...s, done: !current }) as typeof s)
                        : (d.sessions ?? null),
                    }
                  : d,
              ),
            },
      ),
    );
    try {
      await markDayComplete(plan.id, dayId, !current);
      const updated = await fetchStudyPlans();
      setPlans(updated);
    } catch {
      setPlans((prev) =>
        prev.map((p) =>
          p.id !== plan.id
            ? p
            : {
                ...p,
                days: p.days.map((d) => (d.id === dayId ? { ...d, isCompleted: current } : d)),
              },
        ),
      );
    }
  }

  /** Tick / un-tick one subject block of a day. The day completes when all its blocks are done. */
  async function handleToggleSession(
    plan: ApiStudyPlan,
    day: ApiStudyPlanDay,
    index: number,
    done: boolean,
  ) {
    const before = plan.days;
    setPlans((prev) =>
      prev.map((p) =>
        p.id !== plan.id
          ? p
          : {
              ...p,
              days: p.days.map((d) => (d.id === day.id ? applySessionDone(d, index, done) : d)),
            },
      ),
    );
    try {
      await markSessionDone(plan.id, day.id, index, done);
      setPlans(await fetchStudyPlans());
    } catch {
      setPlans((prev) => prev.map((p) => (p.id !== plan.id ? p : { ...p, days: before })));
      toast.error("Could not update that block. Try again.");
    }
  }

  /** Keep what's done, re-plan everything else from today. */
  async function handleCatchUp(plan: ApiStudyPlan) {
    setCatchingUp(plan.id);
    try {
      const res = await catchUpStudyPlan(plan.id);
      const updated = res.plan;
      if (updated) setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setNotices(res.warnings);
      toast.success("Re-planned from today. Finished topics were skipped.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Catch-up failed.");
    } finally {
      setCatchingUp(null);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this plan?")) return;
    try {
      await deleteStudyPlan(id);
      setPlans((p) => p.filter((x) => x.id !== id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Delete failed.");
    }
  }

  if (!user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="card max-w-sm p-8 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
            <BookOpen className="size-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            Sign in to use Study Plans
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Upload your exam timetable and get a day-by-day study schedule.
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
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">Study Plan</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload your exam timetable — we generate a day-by-day study schedule with specific
            topics per subject.
          </p>
        </div>
        {step === "idle" && (
          <button onClick={() => setStep("upload")} className="btn btn-primary shrink-0">
            <Sparkles className="size-4" />
            New Plan
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            {error}
            {error.includes("Profile") && (
              <Link to="/profile" className="ml-1 font-medium underline">
                Set up Profile →
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Heads-ups from the planner: unmatched exams, topics that don't fit, etc. */}
      {notices.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-foreground">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">Heads up</p>
            <button
              onClick={() => setNotices([])}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
            {notices.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Wizard ── */}
      {step !== "idle" && (
        <section className="card overflow-hidden">
          <ol className="flex items-center gap-2 border-b border-border bg-muted/30 px-6 py-3 text-xs font-medium">
            {(
              [
                ["Timetable", ["upload"]],
                ["Exams", ["review"]],
                ["Configure", ["configure"]],
                ["Units", ["units", "generating"]],
              ] as [string, string[]][]
            ).map(([label, keys], i, arr) => {
              const cur = arr.findIndex(([, k]) => k.includes(step));
              const active = i === cur;
              const complete = i < cur;
              return (
                <li key={label} className="flex items-center gap-2">
                  <span
                    className={`flex size-5 items-center justify-center rounded-full text-[10px] font-semibold ${active || complete ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                  >
                    {complete ? <Check className="size-3" /> : i + 1}
                  </span>
                  <span className={active ? "text-foreground" : "text-muted-foreground"}>
                    {label}
                  </span>
                  {i < arr.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
                </li>
              );
            })}
          </ol>
          {/* Step 1: Upload */}
          {(step === "upload" || step === "review") && (
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">
                  {step === "upload" ? "Upload exam timetable" : "Review extracted exams"}
                </h2>
                <button
                  onClick={() => {
                    setStep("idle");
                    setPdfFile(null);
                    setExtractedExams([]);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              {step === "upload" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Upload your university exam schedule PDF. We'll extract subject names and exam
                    dates automatically. Or skip straight to configure if you don't have one.
                  </p>
                  <div
                    className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border p-10 text-center transition hover:border-primary/50 hover:bg-accent/40"
                    onClick={() => fileInputRef.current?.click()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files[0];
                      if (f) void handleFileChange(f);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                  >
                    {parsing ? (
                      <>
                        <Loader2 className="mx-auto size-8 animate-spin text-primary" />
                        <p className="mt-2 text-sm text-muted-foreground">Parsing PDF with AI…</p>
                      </>
                    ) : pdfFile ? (
                      <>
                        <FileText className="mx-auto size-8 text-primary" />
                        <p className="mt-2 text-sm font-medium text-foreground">{pdfFile.name}</p>
                      </>
                    ) : (
                      <>
                        <Upload className="mx-auto size-8 text-muted-foreground/50" />
                        <p className="mt-2 text-sm font-medium text-foreground">
                          Drop PDF here or click to browse
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Exam timetable PDF, max 10 MB
                        </p>
                      </>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleFileChange(f);
                    }}
                  />
                  <div className="flex justify-end">
                    <button onClick={() => setStep("review")} className="btn btn-outline">
                      Skip — no PDF
                    </button>
                  </div>
                </>
              )}

              {step === "review" && (
                <>
                  {parseError && (
                    <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      {parseError}
                    </p>
                  )}

                  {editedExams.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Found {editedExams.length} exam{editedExams.length !== 1 ? "s" : ""}. Edit
                      anything that looks wrong, or add missing ones below.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No exam dates extracted. Add them manually below, or continue without — the
                      plan will still use your syllabus topics.
                    </p>
                  )}

                  <div className="max-h-72 divide-y divide-border overflow-y-auto">
                    {editedExams.map((exam, i) => (
                      <div key={i} className="flex items-center gap-2 py-2">
                        {enrolledSubjects.length > 0 ? (
                          <select
                            className="field field-sm flex-1"
                            value={exam.subjectName}
                            onChange={(e) =>
                              setEditedExams((prev) =>
                                prev.map((x, j) =>
                                  j === i ? { ...x, subjectName: e.target.value } : x,
                                ),
                              )
                            }
                          >
                            <option value="" disabled>
                              Select subject…
                            </option>
                            {enrolledSubjects.map((s) => (
                              <option key={s.id} value={s.name}>
                                {s.code} — {s.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className="field field-sm flex-1"
                            placeholder="Subject name"
                            value={exam.subjectName}
                            onChange={(e) =>
                              setEditedExams((prev) =>
                                prev.map((x, j) =>
                                  j === i ? { ...x, subjectName: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        )}
                        <input
                          type="date"
                          className="field field-sm w-auto"
                          value={exam.date}
                          onChange={(e) =>
                            setEditedExams((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)),
                            )
                          }
                        />
                        <button
                          onClick={() => setEditedExams((prev) => prev.filter((_, j) => j !== i))}
                          className="btn btn-ghost btn-icon btn-sm hover:text-destructive"
                          aria-label="Remove exam"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() =>
                      setEditedExams((prev) => [...prev, { subjectName: "", date: "" }])
                    }
                    className="btn btn-ghost btn-sm text-primary"
                  >
                    <Plus className="size-3.5" />
                    Add exam date
                  </button>

                  <div className="flex justify-between pt-2">
                    <button onClick={() => setStep("upload")} className="btn btn-outline">
                      ← Back
                    </button>
                    <button onClick={() => setStep("configure")} className="btn btn-primary">
                      Continue →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 3: Configure */}
          {step === "configure" && (
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Configure your plan</h2>
                <button
                  onClick={() => setStep("idle")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5 sm:col-span-3">
                  <label className="field-label">Plan name</label>
                  <input
                    className={inputClass}
                    placeholder="e.g. Sem 5 Exam Prep"
                    value={planTitle}
                    onChange={(e) => setPlanTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="field-label">Study hours per day</label>
                  <input
                    type="number"
                    min="1"
                    max="12"
                    step="0.5"
                    className={inputClass}
                    value={planHours}
                    onChange={(e) => setPlanHours(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="field-label">Study days</label>
                  <input
                    type="number"
                    min="7"
                    max="90"
                    className={inputClass}
                    placeholder="Auto"
                    value={planDays}
                    onChange={(e) => setPlanDays(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="field-label">Exams matched</label>
                  <div className="flex h-10 items-center rounded-lg bg-accent px-3 text-sm text-primary">
                    {editedExams.length} exam{editedExams.length !== 1 ? "s" : ""} from timetable
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave "Study days" empty to plan up to your last exam (30 days if you have no exam
                dates). Topics come from the syllabus units in your{" "}
                <Link to="/profile" className="text-primary hover:underline">
                  Profile subjects
                </Link>
                . Each day mixes subjects, with the most urgent exams getting time first, and the
                days before each exam are kept for revision.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => void handleLoadUnits()}
                  disabled={loadingUnits}
                  className="btn btn-primary disabled:opacity-60"
                >
                  {loadingUnits ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ListChecks className="size-3.5" />
                  )}
                  Select Units →
                </button>
                <button onClick={() => setStep("review")} className="btn btn-outline">
                  ← Back
                </button>
              </div>
            </div>
          )}

          {step === "units" && (
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Select units to study</h2>
                <button
                  onClick={() => setStep("idle")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              {unitItems.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No syllabus units found for your enrolled subjects. The plan will use all
                  available topics.
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      Uncheck any units you've already covered or want to skip.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setExcludedUnitIds(new Set())}
                        className="text-xs text-primary hover:underline"
                      >
                        Select all
                      </button>
                      <span className="text-xs text-muted-foreground">·</span>
                      <button
                        onClick={() => setExcludedUnitIds(new Set(unitItems.map((u) => u.id)))}
                        className="text-xs text-primary hover:underline"
                      >
                        Deselect all
                      </button>
                    </div>
                  </div>

                  {/* Group items by subjectName */}
                  <div className="card-flat divide-y divide-border overflow-hidden">
                    {(() => {
                      const groups = new Map<string, typeof unitItems>();
                      for (const item of unitItems) {
                        const key = item.subjectName;
                        if (!groups.has(key)) groups.set(key, []);
                        groups.get(key)!.push(item);
                      }
                      return [...groups.entries()].map(([subjectName, items]) => {
                        const allChecked = items.every((i) => !excludedUnitIds.has(i.id));
                        const someChecked = items.some((i) => !excludedUnitIds.has(i.id));
                        return (
                          <div
                            key={subjectName}
                            style={toneStyle(items[0]?.subjectId ?? subjectName)}
                          >
                            {/* Subject header with toggle-all */}
                            <div
                              className="tone-bg-soft tone-accent-l flex cursor-pointer select-none items-center gap-2 border-l-2 px-3 py-2"
                              onClick={() => {
                                setExcludedUnitIds((prev) => {
                                  const next = new Set(prev);
                                  if (allChecked) {
                                    items.forEach((i) => next.add(i.id));
                                  } else {
                                    items.forEach((i) => next.delete(i.id));
                                  }
                                  return next;
                                });
                              }}
                            >
                              <div
                                className={`size-4 rounded border flex items-center justify-center shrink-0 ${allChecked ? "bg-primary border-primary" : someChecked ? "bg-primary/30 border-primary/60" : "border-border"}`}
                              >
                                {(allChecked || someChecked) && (
                                  <svg
                                    className="size-2.5 text-white"
                                    viewBox="0 0 10 10"
                                    fill="none"
                                  >
                                    {allChecked ? (
                                      <path
                                        d="M2 5l2.5 2.5L8 3"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    ) : (
                                      <path
                                        d="M2 5h6"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                      />
                                    )}
                                  </svg>
                                )}
                              </div>
                              <span className="tone-text text-xs font-semibold">{subjectName}</span>
                              <span className="ml-auto text-[11px] text-muted-foreground">
                                {items.filter((i) => !excludedUnitIds.has(i.id)).length}/
                                {items.length} units
                              </span>
                            </div>

                            {/* Unit rows */}
                            <div className="divide-y divide-border">
                              {items.map((item) => {
                                const checked = !excludedUnitIds.has(item.id);
                                return (
                                  <label
                                    key={item.id}
                                    className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-muted/30"
                                  >
                                    <div
                                      className={`mt-0.5 size-4 rounded border flex items-center justify-center shrink-0 transition-colors ${checked ? "bg-primary border-primary" : "border-border"}`}
                                      onClick={() => {
                                        setExcludedUnitIds((prev) => {
                                          const next = new Set(prev);
                                          if (checked) next.add(item.id);
                                          else next.delete(item.id);
                                          return next;
                                        });
                                      }}
                                    >
                                      {checked && (
                                        <svg
                                          className="size-2.5 text-white"
                                          viewBox="0 0 10 10"
                                          fill="none"
                                        >
                                          <path
                                            d="M2 5l2.5 2.5L8 3"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                          />
                                        </svg>
                                      )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <p
                                        className={`text-xs font-medium ${checked ? "text-foreground" : "text-muted-foreground line-through"}`}
                                      >
                                        Unit {item.unitNumber}:{" "}
                                        {item.title.replace(/^Unit \d+:?\s*/i, "")}
                                      </p>
                                      <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
                                        {item.topics.slice(0, 4).join(" · ")}
                                        {item.topics.length > 4 &&
                                          ` +${item.topics.length - 4} more`}
                                      </p>
                                    </div>
                                    {item.hours && (
                                      <span className="chip chip-tone shrink-0">{item.hours}h</span>
                                    )}
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </>
              )}

              <div className="flex gap-2 pt-1">
                <button onClick={() => void handleGenerate()} className="btn btn-primary">
                  <Sparkles className="size-3.5" />
                  Generate Plan
                  {excludedUnitIds.size > 0 && (
                    <span className="ml-1 rounded bg-primary-foreground/20 px-1.5 text-[11px]">
                      {unitItems.length - excludedUnitIds.size} units
                    </span>
                  )}
                </button>
                <button onClick={() => setStep("configure")} className="btn btn-outline">
                  ← Back
                </button>
              </div>
            </div>
          )}

          {step === "generating" && (
            <div className="flex flex-col items-center gap-3 p-10 text-center">
              <Loader2 className="size-8 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">Building your study plan…</p>
              <p className="text-xs text-muted-foreground">
                Matching subjects to exam dates and fitting your syllabus topics into{" "}
                {planHours || "4"} h a day.
              </p>
            </div>
          )}
        </section>
      )}

      {/* Plans list */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : plans.length === 0 && step === "idle" ? (
        <div className="card space-y-3 p-12 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
            <Calendar className="size-5" />
          </div>
          <p className="text-sm font-medium text-foreground">No study plans yet</p>
          <p className="text-xs text-muted-foreground">
            Hit "New Plan" above. First make sure your{" "}
            <Link to="/profile" className="text-primary hover:underline">
              Profile
            </Link>{" "}
            has your subjects set — the plan uses those syllabus topics.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {plans.map((plan) => {
            const done = plan.days.filter((d) => d.isCompleted).length;
            const pct = plan.totalDays > 0 ? Math.round((done / plan.totalDays) * 100) : 0;
            const expanded = expandedId === plan.id;
            const countdown = daysUntil(plan.examDate);

            // Today's day (or the next one), never an overdue day
            const picked = pickToday(plan);
            const behind = overdueCount(plan);

            return (
              <div key={plan.id} className="card">
                <div className="flex items-start gap-3 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{plan.title}</h3>
                      <span
                        className={`chip ${
                          plan.status === "PAUSED"
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "chip-active"
                        }`}
                      >
                        {plan.status.charAt(0) + plan.status.slice(1).toLowerCase()}
                      </span>
                      {countdown && (
                        <span
                          className={`chip ${
                            countdown === "Today!"
                              ? "border-destructive/40 bg-destructive/10 text-destructive"
                              : ""
                          }`}
                        >
                          {countdown}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Calendar className="size-3" /> First exam: {fmt(plan.examDate)}
                      </span>
                      <span>
                        {done}/{plan.totalDays} days done · {pct}%
                      </span>
                    </div>
                    <div className="mt-3 h-2 w-full rounded-full bg-muted">
                      <div
                        className="h-2 rounded-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    {/* Behind schedule → one-tap re-plan */}
                    {behind > 0 && (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                          You're {behind} day{behind === 1 ? "" : "s"} behind. Re-plan from today
                          and skip what you've finished.
                        </p>
                        <button
                          onClick={() => void handleCatchUp(plan)}
                          disabled={catchingUp === plan.id}
                          className="btn btn-sm bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-60"
                        >
                          {catchingUp === plan.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3" />
                          )}
                          Catch up
                        </button>
                      </div>
                    )}

                    {/* Today's task preview */}
                    {picked && !expanded && (
                      <div className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                        <p className="text-xs font-medium text-foreground">
                          {picked.kind === "today"
                            ? `Today — Day ${picked.day.dayNumber}`
                            : `Up next — Day ${picked.day.dayNumber}${picked.day.date ? ` · ${fmt(picked.day.date)}` : ""}`}
                        </p>
                        {picked.day.topics.length > 0 && (
                          <p className="mt-0.5 text-xs text-muted-foreground truncate">
                            {picked.day.topics.slice(0, 3).join(" · ")}
                            {picked.day.topics.length > 3
                              ? ` +${picked.day.topics.length - 3} more`
                              : ""}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => setExpandedId(expanded ? null : plan.id)}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      {expanded ? (
                        <>
                          <ChevronUp className="size-3.5" />
                          Hide
                        </>
                      ) : (
                        <>
                          <ChevronDown className="size-3.5" />
                          All days
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => void handleDelete(plan.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="border-t border-border px-4 pb-3 max-h-[500px] overflow-y-auto">
                    <ul className="divide-y divide-border">
                      {plan.days.map((day) => {
                        const hasSessions = (day.sessions?.length ?? 0) > 0;

                        const isRevision = day.topics.some((t) =>
                          t.toLowerCase().includes("revision"),
                        );
                        const minutes = (day.sessions ?? []).reduce((a, s) => a + s.minutes, 0);
                        return (
                          <li
                            key={day.id}
                            style={day.subject ? toneStyle(day.subject.id) : undefined}
                            className={`flex items-start gap-3 border-l-2 py-2.5 pl-3 ${day.subject ? "tone-accent-l" : "border-transparent"} ${day.isCompleted ? "opacity-70" : ""}`}
                          >
                            <button
                              onClick={() => void handleToggleDay(plan, day.id, day.isCompleted)}
                              className="mt-0.5 shrink-0"
                            >
                              {day.isCompleted ? (
                                <CheckCircle2 className="size-4 text-primary" />
                              ) : (
                                <Circle className="size-4 text-muted-foreground" />
                              )}
                            </button>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className={`text-xs font-medium ${day.isCompleted ? "text-muted-foreground line-through" : "text-foreground"}`}
                                >
                                  Day {day.dayNumber}
                                </span>
                                {day.date && (
                                  <span className="text-xs text-muted-foreground">
                                    {fmt(day.date)}
                                  </span>
                                )}
                                {!hasSessions && day.subject && (
                                  <span className="chip chip-tone">
                                    {isRevision ? "📝 " : ""}
                                    {day.subject.code}
                                  </span>
                                )}
                                {minutes > 0 && (
                                  <span className="text-xs text-muted-foreground">
                                    · {fmtMins(minutes)}
                                  </span>
                                )}
                                {day.notes && (
                                  <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                                    {day.notes}
                                  </span>
                                )}
                              </div>
                              {!day.isCompleted &&
                                (hasSessions ? (
                                  <ul className="mt-1.5 space-y-2">
                                    {day.sessions!.map((s, i) => (
                                      <SessionRow
                                        key={i}
                                        session={s}
                                        subjectKey={s.subjectId ?? s.subjectCode ?? ""}
                                        onToggle={() =>
                                          void handleToggleSession(plan, day, i, s.done !== true)
                                        }
                                      />
                                    ))}
                                  </ul>
                                ) : (
                                  day.topics.length > 0 && (
                                    <p className="mt-0.5 text-xs text-muted-foreground">
                                      {day.topics.join(" · ")}
                                    </p>
                                  )
                                ))}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
