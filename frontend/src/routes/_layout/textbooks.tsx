import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  FileText,
  Loader2,
  Upload,
  RefreshCw,
  Trash2,
  ExternalLink,
  Sparkles,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/lib/auth";
import { LoginModal } from "@/components/campus/LoginModal";
import { TopicPyqPanel } from "@/components/campus/PyqResults";
import { textbookSubjects, textbookUnits } from "@/lib/textbookSelection";
import {
  fetchBranches,
  fetchSubjects,
  fetchSubject,
  fetchSyllabi,
  fetchTextbookUnit,
  uploadTextbook,
  retryTextbook,
  deleteTextbook,
  generateTextbookNotes,
  deleteTextbookNote,
  type ApiBranch,
  type ApiSubject,
  type ApiSyllabusItem,
  type TextbookUnitResponse,
  type TextbookNote,
  type TextbookMaterial,
} from "@/lib/api";

type NemidaTextbookSearch = {
  branchId?: string;
  semester?: number;
  unitId?: string;
  subjectId?: string;
};

function savedNoteTopicPreview(note: TextbookNote): string {
  const topics = note.content.sections.map((section) => section.topic);
  const preview = topics
    .slice(0, 2)
    .map((topic) => (topic.length > 45 ? `${topic.slice(0, 45)}…` : topic))
    .join(", ");
  return `${preview || "No topics"}${topics.length > 2 ? ` +${topics.length - 2}` : ""}`;
}

export const Route = createFileRoute("/_layout/textbooks")({
  validateSearch: (search: Record<string, unknown>): NemidaTextbookSearch => ({
    ...(typeof search["branchId"] === "string" && search["branchId"].length <= 100
      ? { branchId: search["branchId"] }
      : {}),
    ...((typeof search["semester"] === "string" || typeof search["semester"] === "number") &&
    Number.isInteger(Number(search["semester"])) &&
    Number(search["semester"]) >= 1 &&
    Number(search["semester"]) <= 8
      ? { semester: Number(search["semester"]) }
      : {}),
    ...(typeof search["unitId"] === "string" && search["unitId"].length <= 100
      ? { unitId: search["unitId"] }
      : {}),
    ...(typeof search["subjectId"] === "string" && search["subjectId"].length <= 100
      ? { subjectId: search["subjectId"] }
      : {}),
  }),
  head: () => ({ meta: [{ title: "Textbook Notes — CampusBrain" }] }),
  component: TextbooksPage,
});

function TextbooksPage() {
  const { user } = useAuthStore();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [loginOpen, setLoginOpen] = useState(false);
  const [branches, setBranches] = useState<ApiBranch[]>([]);
  const [subjects, setSubjects] = useState<ApiSubject[]>([]);
  const [units, setUnits] = useState<ApiSyllabusItem[]>([]);
  const branchId = search.branchId ?? "";
  const semester = search.semester;
  const selectedBranch = branches.find((branch) => branch.id === branchId);
  const [subjectsLoading, setSubjectsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visibleSubjects = textbookSubjects(subjects, selectedBranch?.code, semester);
  const selectedSubject = visibleSubjects.find((subject) => subject.id === search.subjectId);
  const visibleUnits = selectedSubject
    ? units.filter((unit) => unit.subjectId === selectedSubject.id)
    : [];
  const selectedUnit = visibleUnits.find((unit) => unit.id === search.unitId);

  useEffect(() => {
    fetchBranches()
      .then(setBranches)
      .catch(() => setError("Couldn't load branches. Please reload."));
  }, []);
  useEffect(() => {
    // Syllabus links can contain only subject/unit IDs. Resolve their course before
    // fetching options so entering through a deep link never loads all subjects.
    if (
      !user ||
      !branches.length ||
      (!search.subjectId && !search.unitId) ||
      (branchId && semester)
    )
      return;
    const controller = new AbortController();
    setError(null);
    void (async () => {
      const subjectId =
        search.subjectId ??
        (await fetchTextbookUnit(search.unitId!, controller.signal)).unit.subject?.id;
      if (!subjectId) throw new Error("Assign this unit to a subject on the syllabus page first.");
      const subject = await fetchSubject(subjectId, controller.signal);
      const branch = branches.find((item) => item.code === subject.branchCode);
      if (!branch) throw new Error("The subject's branch could not be found.");
      if (!controller.signal.aborted)
        await navigate({
          to: "/textbooks",
          search: {
            branchId: branch.id,
            semester: subject.semester,
            subjectId,
            ...(search.unitId ? { unitId: search.unitId } : {}),
          },
          replace: true,
        });
    })().catch((failure) => {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : "Couldn't resolve the subject's course.",
        );
    });
    return () => controller.abort();
  }, [user, branches, branchId, semester, search.subjectId, search.unitId, navigate]);
  useEffect(() => {
    const controller = new AbortController();
    setSubjects([]);
    if (!user || !selectedBranch || !semester) {
      setSubjectsLoading(false);
      return;
    }
    setSubjectsLoading(true);
    setError(null);
    fetchSubjects({ branchId, semester }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSubjects(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Couldn't load subjects. Please reload.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setSubjectsLoading(false);
      });
    return () => controller.abort();
  }, [user, branchId, selectedBranch, semester]);
  useEffect(() => {
    const controller = new AbortController();
    setUnits([]);
    if (!selectedSubject || !branchId || !semester) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetchSyllabi({ branchId, semester, subjectId: selectedSubject.id }, controller.signal)
      .then((syllabi) => {
        if (!controller.signal.aborted)
          setUnits(textbookUnits(syllabi, selectedSubject.id, branchId, semester));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Couldn't load syllabus units. Please try selecting the subject again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [selectedSubject, branchId, semester]);

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-accent p-3 text-primary">
          <BookOpen className="size-6" />
        </span>
        <div>
          <h1 className="font-display text-2xl font-semibold sm:text-3xl">Textbook notes</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Learn your syllabus from unit-wise textbook PDFs, check the source pages, and practise
            with real past questions.
          </p>
        </div>
      </div>
      {!user ? (
        <div className="card space-y-3 p-6">
          <h2 className="font-semibold">Your course material, connected</h2>
          <p className="text-sm text-muted-foreground">
            Sign in to read textbook notes, explore related PYQs, and save your revision material.
            Teachers and admins can add unit PDFs.
          </p>
          <button className="btn btn-primary" onClick={() => setLoginOpen(true)}>
            Sign in
          </button>
        </div>
      ) : (
        <>
          <div className="card grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-sm">
              <span className="field-label">Branch</span>
              <select
                className="field"
                value={branchId}
                onChange={(event) => {
                  void navigate({
                    to: "/textbooks",
                    search: {
                      ...(event.target.value ? { branchId: event.target.value } : {}),
                      ...(semester ? { semester } : {}),
                    },
                  });
                }}
              >
                <option value="">Select branch</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="field-label">Semester</span>
              <select
                className="field"
                value={semester ?? ""}
                onChange={(event) => {
                  void navigate({
                    to: "/textbooks",
                    search: {
                      ...(branchId ? { branchId } : {}),
                      ...(event.target.value ? { semester: Number(event.target.value) } : {}),
                    },
                  });
                }}
              >
                <option value="">Select semester</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((number) => (
                  <option key={number} value={number}>
                    Semester {number}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="field-label">Subject</span>
              <select
                className="field"
                value={selectedSubject?.id ?? ""}
                disabled={!selectedBranch || !semester || subjectsLoading}
                onChange={(event) =>
                  void navigate({
                    to: "/textbooks",
                    search: {
                      ...(branchId ? { branchId } : {}),
                      ...(semester ? { semester } : {}),
                      ...(event.target.value ? { subjectId: event.target.value } : {}),
                    },
                  })
                }
              >
                <option value="">
                  {!selectedBranch || !semester
                    ? "Choose branch and semester first"
                    : subjectsLoading
                      ? "Loading subjects…"
                      : visibleSubjects.length
                        ? "Select subject"
                        : "No subjects for this branch and semester"}
                </option>
                {visibleSubjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.code} · {subject.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="field-label">Syllabus unit</span>
              <select
                className="field"
                value={selectedUnit?.id ?? ""}
                disabled={!selectedSubject || loading || subjectsLoading}
                onChange={(event) =>
                  void navigate({
                    to: "/textbooks",
                    search: {
                      ...(branchId ? { branchId } : {}),
                      ...(semester ? { semester } : {}),
                      ...(search["subjectId"] ? { subjectId: search["subjectId"] } : {}),
                      ...(event.target.value ? { unitId: event.target.value } : {}),
                    },
                  })
                }
              >
                <option value="">
                  {!selectedSubject
                    ? "Choose a subject first"
                    : loading
                      ? "Loading units…"
                      : visibleUnits.length
                        ? "Select unit"
                        : "No units for this subject"}
                </option>
                {visibleUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    Unit {unit.unitNumber}: {unit.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {selectedUnit ? (
            <UnitWorkspace key={`${user.id}:${selectedUnit.id}`} unitId={selectedUnit.id} />
          ) : (
            <div className="card p-8 text-center">
              <BookOpen className="mx-auto mb-3 size-8 text-muted-foreground" />
              <h2 className="font-semibold">Start with a syllabus unit</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Choose a branch, semester, subject and unit above, or open Textbook notes from a
                unit on the syllabus page.
              </p>
              {selectedSubject && !loading && !visibleUnits.length && (
                <p className="mt-2 text-sm text-muted-foreground">
                  No syllabus units yet. A teacher or admin can add them on the{" "}
                  <Link className="text-primary underline" to="/syllabus">
                    syllabus page
                  </Link>
                  .
                </p>
              )}
            </div>
          )}
        </>
      )}
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={() => setLoginOpen(false)}
      />
    </main>
  );
}

function UnitWorkspace({ unitId }: { unitId: string }) {
  const { user } = useAuthStore();
  const editor = user?.role === "ADMIN" || user?.role === "TEACHER";
  const [data, setData] = useState<TextbookUnitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedMaterials, setSelectedMaterials] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [activeTopic, setActiveTopic] = useState("");
  const [selectedNoteId, setSelectedNoteId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadTitle, setUploadTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  const mounted = useRef(true);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let poll: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await fetchTextbookUnit(unitId, controller.signal);
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
        const ready = result.materials
          .filter((material) => material.status === "READY")
          .map((material) => material.id);
        if (!initialized.current) {
          initialized.current = true;
          setSelectedMaterials(ready.slice(0, 10));
          setSelectedTopics(result.unit.topics.slice(0, 8));
          setActiveTopic(result.unit.topics[0] ?? "");
        } else setSelectedMaterials((selected) => selected.filter((id) => ready.includes(id)));
        if (
          result.materials.some((material) =>
            ["PENDING", "PROCESSING", "DELETING"].includes(material.status),
          )
        )
          poll = setTimeout(() => void load(), 5000);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "Couldn't load this unit.");
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(poll);
    };
  }, [unitId, revision]);

  async function handleUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (file.type !== "application/pdf" || file.size === 0 || file.size > 25 * 1024 * 1024) {
      toast.error("Choose a non-empty PDF up to 25 MB.");
      return;
    }
    setUploading(true);
    try {
      await uploadTextbook(unitId, uploadTitle.trim(), file);
      if (!mounted.current) return;
      setFile(null);
      setUploadTitle("");
      setShowUpload(false);
      if (inputRef.current) inputRef.current.value = "";
      toast.success("Textbook PDF queued. Scanned pages may take several minutes.");
      refresh();
    } catch (failure) {
      if (mounted.current)
        toast.error(failure instanceof Error ? failure.message : "Upload failed.");
    } finally {
      if (mounted.current) setUploading(false);
    }
  }

  async function materialAction(material: TextbookMaterial, action: "retry" | "delete") {
    if (busyId) return;
    if (
      action === "delete" &&
      !window.confirm(`Delete “${material.title}”? Saved notes using it will be marked outdated.`)
    )
      return;
    setBusyId(material.id);
    try {
      if (action === "retry") await retryTextbook(material.id);
      else await deleteTextbook(material.id);
      if (mounted.current) refresh();
    } catch (failure) {
      if (mounted.current)
        toast.error(failure instanceof Error ? failure.message : "Couldn't update the PDF.");
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  async function generate() {
    if (generating) return;
    setGenerating(true);
    try {
      const note = await generateTextbookNotes(unitId, selectedMaterials, selectedTopics);
      if (!mounted.current) return;
      setSelectedNoteId(note.id);
      setActiveTopic(selectedTopics[0] ?? "");
      refresh();
      toast.success("Notes saved with source references.");
    } catch (failure) {
      if (mounted.current)
        toast.error(failure instanceof Error ? failure.message : "Couldn't generate notes.");
    } finally {
      if (mounted.current) setGenerating(false);
    }
  }

  if (!data)
    return (
      <div className="card p-6" role="status">
        {error ? (
          <>
            <p className="text-destructive">{error}</p>
            <button className="btn btn-outline mt-3" onClick={refresh}>
              Try again
            </button>
          </>
        ) : (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading unit…
          </span>
        )}
      </div>
    );
  const selectedNote = data.notes.find((note) => note.id === selectedNoteId) ?? data.notes[0];
  const section = selectedNote?.content.sections.find((item) => item.topic === activeTopic);
  const readyCount = data.materials.filter((material) => material.status === "READY").length;
  const subjectId = data.unit.subject?.id;

  return (
    <section className="space-y-5">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {data.unit.subject?.name ?? "Unassigned subject"} · Unit {data.unit.unitNumber}
        </p>
        <h2 className="mt-1 font-display text-xl font-semibold">{data.unit.title}</h2>
      </div>
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {error}
          <button className="underline" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-5">
          <div className="card space-y-4 p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">1. Textbook sources</h3>
              <span className="chip">{readyCount} ready</span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Select the PDFs to use for notes. Each file belongs to this unit; multiple chapter
              extracts are welcome.
            </p>
            {!data.materials.length && (
              <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                No textbook PDFs yet.{" "}
                {editor
                  ? "Upload your unit PDF to get started."
                  : "A teacher or admin can add the textbook pages for this unit."}
              </div>
            )}
            <ul className="space-y-3">
              {data.materials.map((material) => {
                const canManage =
                  editor && (user?.role === "ADMIN" || material.uploadedById === user?.id);
                const working = ["PENDING", "PROCESSING", "DELETING"].includes(material.status);
                return (
                  <li key={material.id} className="space-y-2 rounded-xl border border-border p-3">
                    <label className="flex items-start gap-2 text-sm font-medium">
                      <input
                        className="mt-1 accent-primary"
                        type="checkbox"
                        checked={selectedMaterials.includes(material.id)}
                        disabled={
                          material.status !== "READY" ||
                          (!selectedMaterials.includes(material.id) &&
                            selectedMaterials.length >= 10)
                        }
                        onChange={(event) =>
                          setSelectedMaterials((previous) =>
                            event.target.checked
                              ? [...previous, material.id]
                              : previous.filter((id) => id !== material.id),
                          )
                        }
                      />
                      <span className="min-w-0 break-words">{material.title}</span>
                    </label>
                    <p
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                      aria-live="polite"
                    >
                      {working && <Loader2 className="size-3 animate-spin" />}
                      {material.status === "READY"
                        ? `${material.pageCount} pages · Ready`
                        : material.status === "PROCESSING"
                          ? `Reading page ${material.processedPages} of ${material.pageCount}…`
                          : material.status === "PENDING"
                            ? "Queued for reading"
                            : material.status === "DELETING"
                              ? "Removing…"
                              : "Processing failed"}
                    </p>
                    {material.error && <p className="text-xs text-destructive">{material.error}</p>}
                    {!!material.unreadablePages.length && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        Pages {material.unreadablePages.join(", ")} had no usable text. Notes may
                        have gaps.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <a
                        href={material.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        Open PDF <ExternalLink className="size-3" />
                      </a>
                      {canManage && !working && (
                        <>
                          <button
                            disabled={!!busyId}
                            onClick={() => void materialAction(material, "retry")}
                            className="inline-flex items-center gap-1 hover:text-primary"
                          >
                            <RefreshCw className="size-3" />
                            {material.status === "READY" ? "Reprocess" : "Retry"}
                          </button>
                          <button
                            aria-label={`Delete ${material.title}`}
                            disabled={!!busyId}
                            onClick={() => void materialAction(material, "delete")}
                            className="ml-auto text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {editor && (
              <>
                <button
                  className="btn btn-outline w-full"
                  onClick={() => setShowUpload((value) => !value)}
                  aria-expanded={showUpload}
                >
                  <Upload className="size-4" />
                  {showUpload ? "Close upload" : "Add unit PDF"}
                </button>
                {showUpload && (
                  <form
                    className="space-y-3 border-t pt-3"
                    onSubmit={(event) => void handleUpload(event)}
                  >
                    <label className="block space-y-1">
                      <span className="field-label">Book / chapter title</span>
                      <input
                        className="field"
                        required
                        maxLength={160}
                        value={uploadTitle}
                        onChange={(event) => setUploadTitle(event.target.value)}
                        placeholder="e.g. Data Structures — Trees"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="field-label">Textbook PDF</span>
                      <input
                        ref={inputRef}
                        className="block w-full min-w-0 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2"
                        type="file"
                        accept="application/pdf,.pdf"
                        required
                        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                      />
                    </label>
                    <p className="text-xs text-muted-foreground">
                      PDF only · 25 MB · up to 60 pages per file. Scanned PDFs are supported. Add
                      more files for longer units.
                    </p>
                    <button
                      disabled={uploading || !file || !uploadTitle.trim()}
                      className="btn btn-primary w-full"
                    >
                      {uploading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Upload className="size-4" />
                      )}
                      {uploading ? "Uploading…" : "Upload and read PDF"}
                    </button>
                  </form>
                )}
              </>
            )}
          </div>
          {!!data.notes.length && (
            <div className="card space-y-3 p-5">
              <h3 className="font-semibold">Your saved notes</h3>
              <select
                aria-label="Saved notes"
                className="field"
                value={selectedNote?.id ?? ""}
                onChange={(event) => {
                  setSelectedNoteId(event.target.value);
                  const note = data.notes.find((entry) => entry.id === event.target.value);
                  if (note) setActiveTopic(note.content.sections[0]?.topic ?? "");
                }}
              >
                {data.notes.map((note) => (
                  <option
                    key={note.id}
                    value={note.id}
                    title={note.content.sections.map((section) => section.topic).join(", ")}
                  >
                    {savedNoteTopicPreview(note)} · {new Date(note.createdAt).toLocaleString()}
                    {note.stale ? " · Outdated" : ""}
                  </option>
                ))}
              </select>
              {selectedNote && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-foreground">Topics in this set</p>
                  <ul
                    className="flex flex-wrap gap-1.5"
                    aria-label="Topics in selected saved notes"
                  >
                    {selectedNote.content.sections.map((section) => (
                      <li key={section.topic} className="min-w-0 max-w-full">
                        <button
                          type="button"
                          onClick={() => setActiveTopic(section.topic)}
                          aria-pressed={activeTopic === section.topic}
                          className={`chip max-w-full whitespace-normal break-words text-left ${activeTopic === section.topic ? "chip-active" : ""}`}
                        >
                          {section.topic}
                          {section.status === "insufficient" ? " · Insufficient sources" : ""}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Saved to your account. The latest 20 sets are shown.
              </p>
              {selectedNote && (
                <button
                  className="btn btn-ghost btn-sm text-destructive"
                  disabled={!!busyId}
                  onClick={() => {
                    if (!window.confirm("Delete this saved set of notes?")) return;
                    setBusyId(selectedNote.id);
                    void deleteTextbookNote(selectedNote.id)
                      .then(() => {
                        if (mounted.current) refresh();
                      })
                      .catch((failure: unknown) =>
                        toast.error(
                          failure instanceof Error ? failure.message : "Couldn't delete notes.",
                        ),
                      )
                      .finally(() => {
                        if (mounted.current) setBusyId(null);
                      });
                  }}
                >
                  <Trash2 className="size-3" />
                  Delete saved notes
                </button>
              )}
            </div>
          )}
        </aside>
        <div className="min-w-0 space-y-5">
          <div className="card space-y-4 p-5 sm:p-6">
            <h3 className="font-semibold">2. Learn your syllabus topics</h3>
            <p className="text-sm text-muted-foreground">
              Choose up to 8 topics per set. Notes use only the selected textbook passages and flag
              topics without enough evidence.
            </p>
            <div className="flex flex-wrap gap-2">
              {data.unit.topics.map((topic, index) => (
                <label
                  key={`${topic}:${index}`}
                  className={`chip cursor-pointer focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 ${selectedTopics.includes(topic) ? "chip-active" : ""}`}
                >
                  <input
                    className="sr-only"
                    type="checkbox"
                    checked={selectedTopics.includes(topic)}
                    disabled={!selectedTopics.includes(topic) && selectedTopics.length >= 8}
                    onChange={(event) =>
                      setSelectedTopics((previous) =>
                        event.target.checked
                          ? [...previous, topic]
                          : previous.filter((item) => item !== topic),
                      )
                    }
                  />
                  <span>{topic}</span>
                </label>
              ))}
            </div>
            {!data.unit.topics.length && (
              <p className="text-sm text-muted-foreground">
                Add topics to this syllabus unit before generating notes.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="btn btn-primary"
                disabled={generating || !selectedTopics.length || !selectedMaterials.length}
                onClick={() => void generate()}
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {generating ? "Writing cited notes…" : "Generate and save notes"}
              </button>
              <span className="text-xs text-muted-foreground">
                {selectedMaterials.length} PDFs · {selectedTopics.length}/8 topics
              </span>
            </div>
            {generating && (
              <p role="status" className="text-xs text-muted-foreground">
                This can take a few minutes. Keep this page open while your notes are generated.
              </p>
            )}
          </div>
          <div className="card space-y-5 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-semibold">
                <FileText className="size-4 text-primary" />
                Topic workspace
              </h3>
              {selectedNote && (
                <span className="text-xs text-muted-foreground">
                  Saved {new Date(selectedNote.createdAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <label className="block space-y-1">
              <span className="field-label">Topic to study</span>
              <select
                className="field"
                value={activeTopic}
                onChange={(event) => setActiveTopic(event.target.value)}
              >
                <option value="">Select topic</option>
                {[
                  ...new Set([
                    ...data.unit.topics,
                    ...(selectedNote?.content.sections.map((item) => item.topic) ?? []),
                  ]),
                ].map((topic) => (
                  <option key={topic} value={topic}>
                    {topic}
                  </option>
                ))}
              </select>
            </label>
            {selectedNote?.stale && (
              <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                The syllabus or source PDFs have changed. These saved notes may be outdated;
                generate a fresh set.
              </p>
            )}
            {activeTopic && (
              <>
                <h4 className="font-display text-lg font-semibold">{activeTopic}</h4>
                {section ? (
                  <NoteBody note={selectedNote!} topic={activeTopic} />
                ) : (
                  <div className="rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
                    No saved notes for this topic yet. Select a ready textbook PDF and this topic
                    above, then generate notes. You can still explore its PYQs below.
                  </div>
                )}
                <div className="border-t pt-5">
                  <h4 className="mb-3 font-semibold">3. See what was asked & practise</h4>
                  <div className="mb-4 flex flex-wrap gap-2">
                    <Link
                      className="btn btn-outline btn-sm"
                      to="/mcq"
                      search={{ topic: activeTopic, ...(subjectId ? { subjectId } : {}) }}
                    >
                      Practise MCQs
                    </Link>
                    <Link
                      className="btn btn-outline btn-sm"
                      to="/flashcards"
                      search={{ topic: activeTopic, ...(subjectId ? { subjectId } : {}) }}
                    >
                      Revise with flashcards
                    </Link>
                  </div>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Practice opens with this subject and topic selected. PYQs below are original
                    exam questions, separate from textbook notes.
                  </p>
                  {subjectId ? (
                    <TopicPyqPanel
                      topic={activeTopic}
                      subjectId={subjectId}
                      context={data.unit.subject?.name}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Assign this unit to a subject to see related past papers.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function NoteBody({ note, topic }: { note: TextbookNote; topic: string }) {
  const section = note.content.sections.find((entry) => entry.topic === topic);
  if (!section || section.status === "insufficient")
    return (
      <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 p-4 text-sm">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <p>
          Insufficient source material for this topic. Add clearer or more relevant textbook pages,
          then generate again.
        </p>
      </div>
    );
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        AI-written explanations from retrieved textbook passages. References use PDF page numbers,
        which may differ from printed book pages. Check formulas and scanned text against the
        original.
      </p>
      {section.blocks.map((block, index) => (
        <div key={index} className="space-y-2">
          <p className="whitespace-pre-wrap break-words text-sm leading-7">{block.text}</p>
          <div className="space-y-2">
            {block.citations.map((citation, citationIndex) => (
              <details
                key={citationIndex}
                className="rounded-lg border border-border px-3 py-2 text-xs"
              >
                <summary className="cursor-pointer text-primary">
                  {citation.title} · PDF p. {citation.pageNumber}
                  {citation.source === "scan" ? " · scanned text" : ""}
                </summary>
                <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-primary/30 pl-3 leading-relaxed text-muted-foreground">
                  {citation.quote}
                </blockquote>
                <a
                  className="mt-2 inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  href={`${citation.fileUrl.split("#")[0]}#page=${citation.pageNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Check source page <ExternalLink className="size-3" />
                </a>
              </details>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
