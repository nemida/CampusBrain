import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BookOpen, ChevronDown, ChevronUp, Download, MessageSquare, Tag, Trash2, ArrowRight } from "lucide-react";

import { Header } from "@/components/campus/Header";
import { LoginModal } from "@/components/campus/LoginModal";
import { UploadCard } from "@/components/campus/UploadCard";

import {
  BRANCHES,
  YEARS,
  YEAR_TO_SEMESTERS,
  type ExamType,
  type Paper,
  type Subject,
} from "@/lib/campus-data";
import {
  fetchSubjects,
  fetchPapers,
  fetchSyllabi,
  deletePaper,
  fetchBotUrl,
  trackActivity,
  ApiError,
  type ApiSyllabus,
} from "@/lib/api";
import { useAuthStore, logout as authLogout } from "@/lib/auth";
import { toneStyle } from "@/lib/tone";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "CampusBrain Previous Year Papers & AI Study Assistant" },
      {
        name: "description",
        content:
          "Browse subjects by year, semester and branch, download previous year question papers, and chat with any paper using the CampusBrain AI assistant.",
      },
      { property: "og:title", content: "CampusBrain — Academic Portal for PYQs" },
      {
        property: "og:description",
        content:
          "A clean academic portal to find subjects, download previous year papers, and study with an AI assistant.",
      },
    ],
  }),
  component: Dashboard,
});

const selectClass = "field";

function Dashboard() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === "ADMIN" || user?.role === "TEACHER";

  const [loginOpen, setLoginOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Filters
  const [year, setYear] = useState<string>("2nd Year");
  const [semester, setSemester] = useState<number>(3);
  const [branch, setBranch] = useState<string>("Computer Science");
  const [activeSubject, setActiveSubject] = useState<string | null>(null); // subject code

  // Data from API
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectsLoading, setSubjectsLoading] = useState(false);
  const [subjectsError, setSubjectsError] = useState<string | null>(null);

  const [papers, setPapers] = useState<Paper[]>([]);
  const [papersLoading, setPapersLoading] = useState(false);
  const [papersError, setPapersError] = useState<string | null>(null);

  // Syllabus for the currently selected subject
  const [syllabi, setSyllabi] = useState<ApiSyllabus[]>([]);
  const [syllabusOpen, setSyllabusOpen] = useState(true);

  // Bot URL — fetched once on mount from /api/bot/url (no resourceId)
  const [baseBotUrl, setBaseBotUrl] = useState("#");

  // Per-paper bot URLs: resourceId → url (fetched lazily on first open)
  const paperBotUrls = useRef<Map<string, string>>(new Map());

  // Fetch bot base URL once
  useEffect(() => {
    fetchBotUrl()
      .then(setBaseBotUrl)
      .catch(() => undefined);
  }, []);

  // Fetch subjects whenever branch / semester / search changes
  useEffect(() => {
    let cancelled = false;
    setSubjectsLoading(true);
    setSubjectsError(null);

    fetchSubjects({ branch, semester, search: query.trim() || undefined })
      .then((data) => {
        if (!cancelled) {
          setSubjects(
            data.map((s) => ({
              id: s.id,
              code: s.code,
              name: s.name,
              semester: s.semester,
              branch: s.branch,
              paperCount: s.paperCount,
            })),
          );
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSubjectsError(err instanceof ApiError ? err.message : "Failed to load subjects.");
        }
      })
      .finally(() => {
        if (!cancelled) setSubjectsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [branch, semester, query]);

  // Fetch papers whenever branch / semester / activeSubject changes
  useEffect(() => {
    let cancelled = false;
    setPapersLoading(true);
    setPapersError(null);

    fetchPapers({
      branch,
      semester,
      subjectCode: activeSubject ?? undefined,
    })
      .then((data) => {
        if (!cancelled) {
          setPapers(
            data.map((p) => ({
              id: p.id,
              subjectCode: p.subjectCode,
              title: p.title,
              year: p.year,
              examType: p.examType as ExamType,
              size: p.size,
              pdfUrl: p.pdfUrl,
            })),
          );
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPapersError(err instanceof ApiError ? err.message : "Failed to load papers.");
        }
      })
      .finally(() => {
        if (!cancelled) setPapersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [branch, semester, activeSubject]);

  // Fetch syllabi whenever a subject is selected (filtered by branch+semester)
  useEffect(() => {
    if (!activeSubject) {
      setSyllabi([]);
      return;
    }
    const sub = subjects.find((s) => s.code === activeSubject);
    if (!sub) return;
    fetchSyllabi({ semester: sub.semester })
      .then(setSyllabi)
      .catch(() => setSyllabi([]));
  }, [activeSubject, subjects]);

  const selectedSubject = useMemo(
    () => subjects.find((s) => s.code === activeSubject) ?? null,
    [subjects, activeSubject],
  );

  const visiblePapers = useMemo(() => {
    const activeCodes = new Set(
      activeSubject
        ? subjects.filter((s) => s.code === activeSubject).map((s) => s.code)
        : subjects.map((s) => s.code),
    );
    return papers
      .filter((p) => activeCodes.has(p.subjectCode))
      .sort((a, b) => b.year - a.year || a.examType.localeCompare(b.examType));
  }, [papers, subjects, activeSubject]);

  const countFor = (code: string) => papers.filter((p) => p.subjectCode === code).length;

  // Handlers
  function handleYearChange(nextYear: string) {
    setYear(nextYear);
    const sems = YEAR_TO_SEMESTERS[nextYear] ?? [1];
    setSemester(sems[0]!);
    setActiveSubject(null);
    setSyllabi([]);
  }

  async function handleDelete(paper: Paper) {
    if (!window.confirm(`Delete "${paper.title}"? This cannot be undone.`)) return;
    try {
      await deletePaper(paper.id);
      setPapers((prev) => prev.filter((p) => p.id !== paper.id));
      toast.success("Paper deleted");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  // Fetch and open bot URL for a specific paper
  const handleChatWithPaper = useCallback(
    async (paper: Paper) => {
      let url = paperBotUrls.current.get(paper.id);
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      // Open the tab synchronously so popup blockers don't block it after the await
      const win = window.open("about:blank", "_blank");
      if (win) win.opener = null;
      try {
        url = await fetchBotUrl(paper.id);
        paperBotUrls.current.set(paper.id, url);
      } catch {
        url = baseBotUrl;
      }
      if (win) win.location.href = url;
      else window.location.assign(url);
    },
    [baseBotUrl],
  );

  function handleNewPaper(paper: Paper) {
    setPapers((prev) => [paper, ...prev]);
    // Update the paper count on the subject card immediately
    setSubjects((prev) =>
      prev.map((s) =>
        s.code === paper.subjectCode ? { ...s, paperCount: (s.paperCount ?? 0) + 1 } : s,
      ),
    );
    // Navigate filters to the newly uploaded paper's subject
    const subj = subjects.find((s) => s.code === paper.subjectCode);
    if (subj) {
      setBranch(subj.branch);
      setSemester(subj.semester);
      const owningYear = Object.keys(YEAR_TO_SEMESTERS).find((y) =>
        YEAR_TO_SEMESTERS[y]!.includes(subj.semester),
      );
      if (owningYear) setYear(owningYear);
      setActiveSubject(subj.code);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header
        isAdmin={isAdmin}
        userName={user?.name}
        query={query}
        onQueryChange={setQuery}
        onLoginClick={() => setLoginOpen(true)}
        onLogout={() => {
          void authLogout();
        }}
        botUrl={baseBotUrl}
      />

      <main className="mx-auto max-w-7xl space-y-8 px-6 py-10">
        <div>

          <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">
            Previous year question papers
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            {isAdmin
              ? "Admin workspace \u2014 upload, organise and remove papers."
              : "Pick your year, semester and branch to find papers. No login required."}
          </p>
        </div>

        {isAdmin && <UploadCard onAdd={handleNewPaper} />}

        <section className="card p-5">
          <h2 className="sr-only">Filter subjects</h2>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-[auto_auto_1fr] lg:items-end">
            <div>
              <span className="field-label">Year</span>
              <div className="segmented" role="group" aria-label="Select year">
                {YEARS.map((y) => (
                  <button key={y} type="button" aria-pressed={y === year} onClick={() => handleYearChange(y)}>
                    {y}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="field-label">Semester</span>
              <div className="segmented" role="group" aria-label="Select semester">
                {(YEAR_TO_SEMESTERS[year] ?? []).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={s === semester}
                    onClick={() => {
                      setSemester(s);
                      setActiveSubject(null);
                      setSyllabi([]);
                    }}
                  >
                    Sem {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="f-branch" className="field-label !mb-0">
                Branch
              </label>
              <select
                id="f-branch"
                className={selectClass}
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setActiveSubject(null);
                  setSyllabi([]);
                }}
              >
                {BRANCHES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">
              Subjects &middot; {branch} &middot; Semester {semester}
            </h2>
            {activeSubject && (
              <button
                onClick={() => { setActiveSubject(null); setSyllabi([]); }}
                className="text-xs font-medium text-primary hover:underline"
              >
                Clear subject filter
              </button>
            )}
          </div>

          {subjectsLoading ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card p-5">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="mt-3 h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="mt-6 h-3 w-24 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : subjectsError ? (
            <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
              {subjectsError}
            </p>
          ) : subjects.length === 0 ? (
            <div className="card p-12 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
                <BookOpen className="size-5" />
              </div>
              <p className="mt-4 text-lg font-semibold text-foreground">
                Nothing here yet
              </p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                {query.trim()
                  ? `No subjects match "${query.trim()}" in this semester.`
                  : "No subjects are listed for this branch and semester. Try another semester or branch."}
              </p>
              {query.trim() && (
                <button
                  onClick={() => setQuery("")}
                  className="btn btn-outline btn-sm mt-4"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {subjects.map((s) => {
                const active = s.code === activeSubject;
                return (
                  <article
                    key={s.code}
                    style={toneStyle(s.id ?? s.code)}
                    className={`card tone-accent-l p-5 transition-shadow hover:shadow-md ${active ? "ring-2 ring-primary" : ""}`}
                  >
                    <p className="chip chip-tone font-mono text-[11px] uppercase tracking-wider">
                      {s.code.length > 14 ? `Sem ${s.semester}` : s.code}
                    </p>
                    <h3 className="mt-2 text-base font-semibold leading-snug text-foreground">
                      {s.name}
                    </h3>
                    <div className="mt-4 flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">
                        {s.paperCount ?? countFor(s.code)}{" "}
                        {(s.paperCount ?? countFor(s.code)) === 1 ? "paper" : "papers"}
                      </span>
                      <button
                        onClick={() => { setActiveSubject(s.code); setSyllabusOpen(true); }}
                        aria-pressed={active}
                        className={`btn btn-sm ${active ? "btn-primary" : "btn-outline"}`}
                      >
                        {active ? "Selected" : "Select Subject"}
                        <ArrowRight className="size-3.5" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* Syllabus panel — shown when a subject is selected and has syllabus data */}
        {activeSubject && selectedSubject && (() => {
          const subjectUnits = syllabi.flatMap((s) =>
            s.items.filter((i) => i.subjectId === selectedSubject.id),
          );
          if (subjectUnits.length === 0) return null;
          return (
            <section className="card">
              <button
                onClick={() => setSyllabusOpen((o) => !o)}
                className="flex w-full items-center justify-between px-5 py-4 text-left"
                aria-expanded={syllabusOpen}
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <BookOpen className="size-4 text-primary" />
                  Syllabus &middot; {selectedSubject.name}
                </span>
                {syllabusOpen ? (
                  <ChevronUp className="size-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-4 text-muted-foreground" />
                )}
              </button>

              {syllabusOpen && (
                <div className="divide-y divide-border border-t border-border px-5 pb-2">
                  {subjectUnits
                    .sort((a, b) => a.unitNumber - b.unitNumber)
                    .map((unit) => (
                      <div key={unit.id} className="py-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                              Unit {unit.unitNumber}
                              {unit.hours ? ` · ${unit.hours}h` : ""}
                            </span>
                            <p className="mt-0.5 text-sm font-medium text-foreground">
                              {unit.title}
                            </p>
                          </div>
                        </div>
                        {unit.topics.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {unit.topics.map((t) => (
                              <span
                                key={t}
                                className="chip"
                              >
                                <Tag className="size-2.5" />
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </section>
          );
        })()}

        <section className="space-y-4">
          <h2 className="text-base font-semibold text-foreground">
            {selectedSubject
              ? `Papers \u00B7 ${selectedSubject.code} - ${selectedSubject.name}`
              : "All papers for this selection"}
          </h2>

          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-5 py-3 text-xs font-semibold text-muted-foreground">
                    Paper Title & Year
                  </th>
                  <th className="px-5 py-3 text-xs font-semibold text-muted-foreground">
                    Exam Type
                  </th>
                  <th className="px-5 py-3 text-xs font-semibold text-muted-foreground">
                    File Size
                  </th>
                  <th className="px-5 py-3 text-xs font-semibold text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {papersLoading ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-6" aria-busy="true">
                      <div className="space-y-3">
                        {Array.from({ length: 3 }).map((_, i) => (
                          <div key={i} className="h-8 animate-pulse rounded bg-muted" />
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : papersError ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-destructive">
                      {papersError}
                    </td>
                  </tr>
                ) : visiblePapers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-12 text-center">
                      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-accent text-primary">
                        <Download className="size-5" />
                      </div>
                      <p className="text-base font-semibold text-foreground">
                        No papers uploaded yet
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {isAdmin
                          ? "Use the upload form above to add the first one."
                          : "Check back soon, or try another subject or semester."}
                      </p>
                    </td>
                  </tr>
                ) : (
                  visiblePapers.map((p) => {
                    const subject = subjects.find((s) => s.code === p.subjectCode);
                    return (
                      <tr key={p.id} style={toneStyle(subject?.id ?? p.subjectCode ?? "")} className="border-b border-border last:border-0 hover:bg-muted/30">
                        <td className="px-5 py-4">
                          <div className="font-medium text-foreground">{p.title}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {p.subjectCode}
                            {subject ? ` - ${subject.name}` : ""}
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <span className="chip chip-tone">
                            {p.examType}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-muted-foreground">PDF &middot; {p.size}</td>
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <a
                              href={p.pdfUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => {
                                e.preventDefault();
                                window.open(p.pdfUrl, "_blank", "noopener,noreferrer");
                                // Track download for personalised dashboard
                                if (user)
                                  trackActivity({
                                    resourceId: p.id,
                                    activityType: "DOWNLOAD",
                                  }).catch(() => undefined);
                              }}
                              className="btn btn-primary btn-sm"
                            >
                              <Download className="size-3.5" />
                              Download File
                            </a>
                            <button
                              onClick={() => {
                                if (user)
                                  trackActivity({ resourceId: p.id, activityType: "VIEW" }).catch(
                                    () => undefined,
                                  );
                                void handleChatWithPaper(p);
                              }}
                              className="btn btn-outline btn-sm"
                            >
                              <MessageSquare className="size-3.5" />
                              Chat with Paper
                            </button>
                            {isAdmin && (
                              <button
                                onClick={() => void handleDelete(p)}
                                aria-label={`Delete ${p.title}`}
                                className="btn btn-danger btn-sm"
                              >
                                <Trash2 className="size-3.5" />
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-6 text-xs text-muted-foreground">
          CampusBrain - Academic paper repository and AI study assistant.
        </div>
      </footer>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={() => setLoginOpen(false)}
      />
    </div>
  );
}
