import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  Check,
  FileText,
  Flame,
  RefreshCw,
  Target,
  TrendingDown,
  TrendingUp,
  Undo2,
} from "lucide-react";
import {
  catchUpStudyPlan,
  fetchDashboardData,
  markDayComplete,
  type ApiDashboardData,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { toneStyle } from "@/lib/tone";

export const Route = createFileRoute("/_layout/student")({
  component: StudentDashboard,
});

// ── Small helpers ────────────────────────────────────────────────────────────

const card = "card p-6";
const primaryBtn = "btn btn-primary btn-sm";
const ghostBtn = "btn btn-outline btn-sm";

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

function scoreColour(score: number): string {
  if (score < 40) return "bg-destructive";
  if (score < 60) return "bg-amber-500";
  return "bg-primary";
}

function practiceSearch(topic: string, subjectId: string | null) {
  const search: { topic?: string; subjectId?: string } = {};
  if (topic !== "General") search.topic = topic;
  if (subjectId) search.subjectId = subjectId;
  return search;
}

function SectionTitle({ icon: Icon, children }: { icon: typeof Flame; children: React.ReactNode }) {
  return (
    <h2 className="mb-4 flex items-center gap-2.5 text-base font-semibold text-foreground">
      <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-primary">
        <Icon className="size-4" />
      </span>
      {children}
    </h2>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function StudentDashboard() {
  const [data, setData] = useState<ApiDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return fetchDashboardData()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load dashboard"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-fetch when returning to the tab so deletions/quiz changes made elsewhere show up
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  const toggleDay = async () => {
    const today = data?.today;
    if (!today?.day) return;
    setBusy(true);
    try {
      await markDayComplete(today.plan.id, today.day.id, !today.day.isCompleted);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the day");
    } finally {
      setBusy(false);
    }
  };

  const catchUp = async () => {
    const today = data?.today;
    if (!today) return;
    setBusy(true);
    try {
      await catchUpStudyPlan(today.plan.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not re-plan");
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-sm text-destructive">{error}</p>
        <button className={cn(ghostBtn, "mt-3")} onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-10">
        <div className="h-8 w-56 animate-pulse rounded bg-muted" />
        <div className="h-44 animate-pulse rounded-xl bg-muted" />
        <div className="h-44 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const firstName = data.userName.split(" ")[0] ?? "";

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      {/* Header: greeting + streak */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">
            {firstName ? `Hi, ${firstName}` : "My Dashboard"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Here's what to focus on today.</p>
        </div>
        <div className="card flex items-center gap-4 px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <Flame
              className={cn(
                "size-4",
                data.streak.current > 0 ? "text-orange-500" : "text-muted-foreground",
              )}
            />
            <span className="font-display text-lg font-semibold text-foreground">
              {data.streak.current}d
            </span>
          </div>
          <div className="flex items-center gap-1.5" aria-label="Activity in the last 7 days">
            {data.streak.week.map((d) => (
              <div key={d.date} className="flex flex-col items-center gap-0.5">
                <span
                  className={cn(
                    "size-2.5 rounded-full",
                    d.active ? "bg-primary" : "bg-muted",
                    d.isToday && "ring-2 ring-primary/30",
                  )}
                />
                <span className="text-[9px] text-muted-foreground">{d.label}</span>
              </div>
            ))}
          </div>
        </div>
      </header>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data.needsOnboarding && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent p-5">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Pick your subjects to unlock your dashboard
            </p>
            <p className="text-xs text-muted-foreground">
              Readiness scores and study plans are built from the subjects you enrol in.
            </p>
          </div>
          <Link to="/profile" className={primaryBtn}>
            Set up profile <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}

      {/* Row 1: today's plan + exam countdown */}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className={cn(card, "lg:col-span-2")}>
          <SectionTitle icon={BookOpen}>Today's plan</SectionTitle>
          <TodayCard
            today={data.today}
            busy={busy}
            onToggle={() => void toggleDay()}
            onCatchUp={() => void catchUp()}
          />
        </section>

        <section className={card}>
          <SectionTitle icon={CalendarClock}>Exam countdown</SectionTitle>
          <ExamCard today={data.today} />
        </section>
      </div>

      {/* Row 2: practice + continue */}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className={cn(card, "lg:col-span-2")}>
          <SectionTitle icon={Target}>Practice these next</SectionTitle>
          <PracticeCard practice={data.practice} hasTakenQuiz={data.hasTakenQuiz} />
        </section>

        <section className={card}>
          <SectionTitle icon={FileText}>Continue where you left off</SectionTitle>
          {data.continueReading ? (
            <div>
              <p className="text-sm font-medium text-foreground">{data.continueReading.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {data.continueReading.subjectName} · {timeAgo(data.continueReading.viewedAt)}
              </p>
              <a
                href={data.continueReading.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(primaryBtn, "mt-3")}
              >
                Open paper <ArrowRight className="size-3.5" />
              </a>
            </div>
          ) : (
            <div>
              <p className="text-sm text-muted-foreground">You haven't opened any papers yet.</p>
              <Link to="/dashboard" className={cn(ghostBtn, "mt-3")}>
                Browse papers
              </Link>
            </div>
          )}
        </section>
      </div>

      {/* Row 3: readiness */}
      {data.readiness.length > 0 && (
        <section className={card}>
          <SectionTitle icon={Target}>Subject readiness</SectionTitle>
          <p className="-mt-2 mb-4 text-xs text-muted-foreground">
            Blends your recent quiz scores, plan progress and past papers opened. Weakest first.
          </p>
          <ul className="space-y-5">
            {data.readiness.map((s) => (
              <li key={s.subjectId} style={toneStyle(s.subjectId)} className="tone-accent-l pl-3">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">
                    {s.subjectName}
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      Sem {s.semester}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-display text-sm font-semibold text-foreground">
                      {s.score === null ? "Not started" : `${s.score}%`}
                    </span>
                    <Link
                      to="/mcq"
                      search={{ subjectId: s.subjectId }}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Quiz
                    </Link>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full rounded-full bg-muted">
                  <div
                    className={cn("h-1.5 rounded-full transition-all", scoreColour(s.score ?? 0))}
                    style={{ width: `${s.score ?? 0}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Quiz {s.quizAverage === null ? "–" : `${s.quizAverage}%`} · Plan{" "}
                  {s.planTotal > 0 ? `${s.planDone}/${s.planTotal} days` : "–"} · Papers{" "}
                  {s.viewedPapers}/{s.totalPapers}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────

function TodayCard({
  today,
  busy,
  onToggle,
  onCatchUp,
}: {
  today: ApiDashboardData["today"];
  busy: boolean;
  onToggle: () => void;
  onCatchUp: () => void;
}) {
  if (!today) {
    return (
      <div>
        <p className="text-sm text-muted-foreground">
          You don't have an active study plan. Generate one and today's tasks will show up here.
        </p>
        <Link to="/study" className={cn(primaryBtn, "mt-3")}>
          Create a plan <ArrowRight className="size-3.5" />
        </Link>
      </div>
    );
  }

  const { plan, day, kind } = today;
  const pct = plan.totalDays > 0 ? Math.round((plan.doneDays / plan.totalDays) * 100) : 0;

  const label =
    kind === "today"
      ? `Today · Day ${day?.dayNumber ?? ""}`
      : kind === "overdue"
        ? `Overdue · Day ${day?.dayNumber ?? ""}`
        : kind === "upcoming" && day?.date
          ? `Up next · ${shortDate(day.date)}`
          : "All caught up";

  const paceText =
    plan.pace.status === "behind"
      ? `${Math.abs(plan.pace.delta)} day${Math.abs(plan.pace.delta) === 1 ? "" : "s"} behind`
      : plan.pace.status === "ahead"
        ? `${plan.pace.delta} day${plan.pace.delta === 1 ? "" : "s"} ahead`
        : "On track";

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-medium",
            kind === "overdue"
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
              : "bg-accent text-primary",
          )}
        >
          {label}
        </span>
        <span className="truncate text-xs text-muted-foreground">{plan.title}</span>
      </div>

      {(kind === "overdue" || today.overdueCount > 0 || plan.pace.status === "behind") && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-3 py-2.5">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            You're behind. Re-plan from today and skip what you've finished.
          </p>
          <button
            onClick={onCatchUp}
            disabled={busy}
            className="btn btn-sm bg-amber-600 text-white hover:bg-amber-700"
          >
            <RefreshCw className="size-3" /> Catch up
          </button>
        </div>
      )}

      {day ? (
        <div className="mt-3">
          {/* On multi-subject days every line is prefixed with its subject, so the single-subject header would be misleading */}
          {day.subject &&
            !day.topics.some((t) => /^(Revision \(|Group focus: |[^[\]:]{1,20}: )/.test(t)) && (
              <p className="text-sm font-semibold text-foreground">{day.subject.name}</p>
            )}
          {day.topics.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {day.topics.map((t) => (
                <li key={t} className="flex items-start gap-2 text-sm text-foreground">
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      day.isCompleted ? "bg-primary" : "bg-muted-foreground/50",
                    )}
                  />
                  <span className={cn(day.isCompleted && "text-muted-foreground line-through")}>
                    {t}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              Free study day. Revise anything you like.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={onToggle}
              disabled={busy}
              className={day.isCompleted ? ghostBtn : primaryBtn}
            >
              {day.isCompleted ? (
                <>
                  <Undo2 className="size-3.5" /> Undo
                </>
              ) : (
                <>
                  <Check className="size-3.5" /> Mark done
                </>
              )}
            </button>
            <Link to="/study" className="text-xs font-medium text-primary hover:underline">
              Open plan
            </Link>
            {today.overdueCount > 0 && (
              <span className="text-xs text-amber-700 dark:text-amber-400">
                +{today.overdueCount} overdue day{today.overdueCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Nothing scheduled right now.</p>
      )}

      <div className="mt-5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {plan.doneDays}/{plan.totalDays} days · {pct}%
          </span>
          <span
            className={cn(
              plan.pace.status === "behind" && "text-amber-700 dark:text-amber-400",
              plan.pace.status === "ahead" && "text-primary",
            )}
          >
            {paceText}
          </span>
        </div>
        <div className="mt-2 h-2 w-full rounded-full bg-muted">
          <div
            className="h-2 rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function ExamCard({ today }: { today: ApiDashboardData["today"] }) {
  if (!today || today.plan.daysLeft === null) {
    return (
      <div>
        <p className="text-sm text-muted-foreground">
          No exam date yet. Upload your timetable when you generate a plan to see a countdown.
        </p>
      </div>
    );
  }

  const { daysLeft, examDate, pace } = today.plan;

  if (daysLeft < 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Your exam date has passed. Time for a new plan?
      </p>
    );
  }

  return (
    <div>
      <p className="font-display text-6xl font-bold text-primary">{daysLeft}</p>
      <p className="text-sm text-muted-foreground">
        {daysLeft === 0 ? "Exam is today" : daysLeft === 1 ? "day to go" : "days to go"}
        {examDate ? ` · ${shortDate(examDate)}` : ""}
      </p>
      <span
        className={cn(
          "mt-3 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium",
          pace.status === "behind"
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
            : "bg-accent text-primary",
        )}
      >
        {pace.status === "behind"
          ? "Behind plan"
          : pace.status === "ahead"
            ? "Ahead of plan"
            : "On track"}
      </span>
    </div>
  );
}

function PracticeCard({
  practice,
  hasTakenQuiz,
}: {
  practice: ApiDashboardData["practice"];
  hasTakenQuiz: boolean;
}) {
  if (practice.length === 0) {
    return (
      <div>
        <p className="text-sm text-muted-foreground">
          {hasTakenQuiz
            ? "No weak topics right now. Keep your edge with another quiz."
            : "Take a quick quiz and we'll point out the topics that need work."}
        </p>
        <Link to="/mcq" className={cn(primaryBtn, "mt-3")}>
          Start a quiz <ArrowRight className="size-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {practice.map((t) => (
        <li
          key={t.topic}
          className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{t.topic}</p>
            <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {t.averageScore}% avg · {t.attempts} attempt{t.attempts === 1 ? "" : "s"}
              </span>
              {t.trend !== null && t.trend !== 0 && (
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 font-medium",
                    t.trend > 0 ? "text-primary" : "text-destructive",
                  )}
                >
                  {t.trend > 0 ? (
                    <TrendingUp className="size-3" />
                  ) : (
                    <TrendingDown className="size-3" />
                  )}
                  {t.trend > 0 ? "+" : ""}
                  {t.trend}
                </span>
              )}
            </p>
          </div>
          <Link to="/mcq" search={practiceSearch(t.topic, t.subjectId)} className={primaryBtn}>
            Practice
          </Link>
        </li>
      ))}
    </ul>
  );
}
