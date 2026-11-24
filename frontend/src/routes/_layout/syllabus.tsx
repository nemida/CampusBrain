// frontend/src/routes/_layout/syllabus.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  BookOpen,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Tag,
  Edit2,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";

import { TopicPyqPanel } from "@/components/campus/PyqResults";
import { useAuthStore } from "@/lib/auth";
import { toneStyle } from "@/lib/tone";
import {
  fetchSyllabi,
  createSyllabus,
  addSyllabusItem,
  updateSyllabusItem,
  deleteSyllabusItem,
  deleteSyllabus,
  parseSyllabusText,
  fetchSubjects,
  ApiSyllabus,
  ApiSyllabusItem,
  ApiError,
} from "@/lib/api";

export const Route = createFileRoute("/_layout/syllabus")({
  head: () => ({ meta: [{ title: "Syllabus — CampusBrain" }] }),
  component: SyllabusPage,
});

/* ───────────────────────── shared bits ───────────────────────── */

const inputClass = "field";
const selectClass = "field";
const textareaClass = "field";

type Branch = { id: string; name: string; code: string };
type SubjectLite = { id: string; code: string; name: string };
type ItemsUpdater = (fn: (items: ApiSyllabusItem[]) => ApiSyllabusItem[]) => void;

const semesters = [1, 2, 3, 4, 5, 6, 7, 8];

function sortItems(items: ApiSyllabusItem[]) {
  return [...items].sort((a, b) => a.unitNumber - b.unitNumber);
}

function parseTopics(raw: string) {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function apiFetchBranches(): Promise<Branch[]> {
  const BASE = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "http://localhost:4000";
  const res = await fetch(`${BASE}/api/branches`);
  if (!res.ok) return [];
  const data = (await res.json()) as { branches: Branch[] };
  return data.branches ?? [];
}

/* ───────────────────────── page ───────────────────────── */

function SyllabusPage() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === "ADMIN";
  const isEditor = isAdmin || user?.role === "TEACHER";

  const [branches, setBranches] = useState<Branch[]>([]);
  const [syllabi, setSyllabi] = useState<ApiSyllabus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filterBranchId, setFilterBranchId] = useState("");
  const [filterSem, setFilterSem] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [csForm, setCsForm] = useState({
    branchId: "",
    semester: "1",
    scheme: "2021",
    description: "",
  });
  const [csLoading, setCsLoading] = useState(false);
  const [csError, setCsError] = useState<string | null>(null);

  useEffect(() => {
    apiFetchBranches()
      .then(setBranches)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchSyllabi({
      branchId: filterBranchId || undefined,
      semester: filterSem ? Number(filterSem) : undefined,
    })
      .then(setSyllabi)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load syllabi."))
      .finally(() => setLoading(false));
  }, [filterBranchId, filterSem]);

  function patchItems(syllabusId: string, fn: (items: ApiSyllabusItem[]) => ApiSyllabusItem[]) {
    setSyllabi((prev) => prev.map((s) => (s.id === syllabusId ? { ...s, items: fn(s.items) } : s)));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCsLoading(true);
    setCsError(null);
    try {
      const s = await createSyllabus({
        branchId: csForm.branchId,
        semester: Number(csForm.semester),
        scheme: csForm.scheme.trim() || "2021",
        description: csForm.description.trim() || undefined,
      });
      setSyllabi((prev) => [s, ...prev]);
      setShowCreate(false);
      setCsForm({ branchId: "", semester: "1", scheme: "2021", description: "" });
    } catch (err) {
      setCsError(err instanceof ApiError ? err.message : "Failed to create syllabus.");
    } finally {
      setCsLoading(false);
    }
  }

  async function handleDeleteSyllabus(id: string) {
    if (!window.confirm("Delete this entire syllabus? This cannot be undone.")) return;
    try {
      await deleteSyllabus(id);
      setSyllabi((prev) => prev.filter((s) => s.id !== id));
      toast.success("Syllabus deleted");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  return (
    <>
      <main className="mx-auto max-w-4xl space-y-6 px-6 py-10">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">Syllabus</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Every unit and topic for your branch. Tap a topic to see the past exam questions on
              it.
              {isEditor && " As faculty you can add units to each subject."}
            </p>
          </div>
          {isEditor && (
            <button onClick={() => setShowCreate((v) => !v)} className="btn btn-primary shrink-0">
              <Plus className="size-4" />
              Add Semester
            </button>
          )}
        </div>

        {/* Create semester form */}
        {isEditor && showCreate && (
          <section className="card p-6">
            <h2 className="mb-4 text-base font-semibold text-foreground">New semester</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Branch *</label>
                  <select
                    className={selectClass}
                    value={csForm.branchId}
                    onChange={(e) => setCsForm((f) => ({ ...f, branchId: e.target.value }))}
                    required
                  >
                    <option value="">Select branch</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Semester *</label>
                  <select
                    className={selectClass}
                    value={csForm.semester}
                    onChange={(e) => setCsForm((f) => ({ ...f, semester: e.target.value }))}
                  >
                    {semesters.map((n) => (
                      <option key={n} value={n}>
                        Semester {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Scheme Year</label>
                  <input
                    className={inputClass}
                    placeholder="2021"
                    value={csForm.scheme}
                    onChange={(e) => setCsForm((f) => ({ ...f, scheme: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Description</label>
                  <input
                    className={inputClass}
                    placeholder="Optional note"
                    value={csForm.description}
                    onChange={(e) => setCsForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </div>
              </div>
              {csError && (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {csError}
                </p>
              )}
              <div className="flex gap-2">
                <button type="submit" disabled={csLoading} className="btn btn-primary">
                  {csLoading && <Loader2 className="size-3.5 animate-spin" />}
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="btn btn-outline"
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          {branches.length > 1 && (
            <select
              className="field field-sm w-auto min-w-44"
              value={filterBranchId}
              onChange={(e) => setFilterBranchId(e.target.value)}
              aria-label="Branch"
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <div className="segmented" role="group" aria-label="Semester">
            {["", ...semesters.map(String)].map((v) => (
              <button
                key={v || "all"}
                aria-pressed={filterSem === v}
                onClick={() => setFilterSem(v)}
              >
                {v === "" ? "All" : `Sem ${v}`}
              </button>
            ))}
          </div>
        </div>

        {/* Semester list */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading...
          </div>
        ) : error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </p>
        ) : syllabi.length === 0 ? (
          <div className="card p-12 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
              <BookOpen className="size-5" />
            </span>
            <p className="mt-3 text-sm font-medium text-foreground">No syllabi found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isEditor
                ? 'Use the "Add Semester" button to create one.'
                : "No syllabus has been added yet for this filter."}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {syllabi.map((s) => (
              <SemesterCard
                key={s.id}
                syllabus={s}
                branchName={branches.find((b) => b.id === s.branchId)?.name ?? s.branchName}
                isEditor={isEditor}
                isAdmin={isAdmin}
                onDelete={() => void handleDeleteSyllabus(s.id)}
                onItemsChange={(fn) => patchItems(s.id, fn)}
              />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

/* ───────────────────────── semester ───────────────────────── */

function SemesterCard({
  syllabus: s,
  branchName,
  isEditor,
  isAdmin,
  onDelete,
  onItemsChange,
}: {
  syllabus: ApiSyllabus;
  branchName: string;
  isEditor: boolean;
  isAdmin: boolean;
  onDelete: () => void;
  onItemsChange: ItemsUpdater;
}) {
  const [open, setOpen] = useState(false);
  const [subjects, setSubjects] = useState<SubjectLite[]>([]);
  const [subjectsLoaded, setSubjectsLoaded] = useState(false);
  const [subjectsLoading, setSubjectsLoading] = useState(false);

  function loadSubjects() {
    setSubjectsLoading(true);
    fetchSubjects({ branch: branchName, semester: s.semester })
      .then((list) => {
        setSubjects(list.map((x) => ({ id: x.id, code: x.code, name: x.name })));
        setSubjectsLoaded(true);
      })
      .catch(() => setSubjects([]))
      .finally(() => setSubjectsLoading(false));
  }

  function toggle() {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && !subjectsLoaded) loadSubjects();
  }

  const subjectNames = new Set(subjects.map((x) => x.name));
  // Units saved without a subject (or with one that isn't in this list)
  const looseItems = s.items.filter((i) => !i.subjectName || !subjectNames.has(i.subjectName));

  return (
    <section className="card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 p-5">
        <span className="flex size-11 shrink-0 flex-col items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <span className="text-[9px] font-semibold uppercase leading-none tracking-wider opacity-80">
            Sem
          </span>
          <span className="font-display text-lg font-semibold leading-none">{s.semester}</span>
        </span>
        <button
          onClick={toggle}
          className="min-w-0 flex-1 text-left"
          aria-expanded={open}
          aria-label={open ? "Collapse semester" : "Expand semester"}
        >
          <h3 className="truncate text-base font-semibold text-foreground">{branchName}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Scheme {s.scheme} · {s.items.length} unit{s.items.length !== 1 ? "s" : ""}
            {s.description ? ` · ${s.description}` : ""}
          </p>
        </button>
        {isAdmin && (
          <button
            onClick={onDelete}
            aria-label="Delete semester"
            className="btn btn-ghost btn-danger btn-sm btn-icon"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
        <button
          onClick={toggle}
          aria-label={open ? "Collapse" : "Expand"}
          className="btn btn-ghost btn-sm btn-icon"
        >
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>

      {/* Subjects */}
      {open && (
        <div className="divide-y divide-border">
          {subjectsLoading ? (
            <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading subjects...
            </div>
          ) : (
            <>
              {subjects.length === 0 && looseItems.length === 0 && (
                <p className="p-5 text-sm text-muted-foreground">
                  No subjects found for this branch and semester.
                </p>
              )}

              {subjects.map((sub, idx) => (
                <SubjectSection
                  key={sub.id}
                  index={idx}
                  syllabusId={s.id}
                  subject={sub}
                  items={s.items.filter((i) => i.subjectName === sub.name)}
                  isEditor={isEditor}
                  onItemsChange={onItemsChange}
                />
              ))}
              {looseItems.length > 0 && (
                <div className="p-5">
                  <h4 className="mb-3 text-sm font-semibold text-foreground">
                    Units without a subject
                  </h4>
                  <div className="space-y-4">
                    {sortItems(looseItems).map((item) => (
                      <UnitRow
                        key={item.id}
                        syllabusId={s.id}
                        item={item}
                        isEditor={isEditor}
                        onItemsChange={onItemsChange}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────── subject ─────────────────────────────────────────────────────────── */

function SubjectSection({
  syllabusId,
  subject,
  items,
  isEditor,
  onItemsChange,
  index,
}: {
  syllabusId: string;
  subject: SubjectLite;
  items: ApiSyllabusItem[];
  isEditor: boolean;
  onItemsChange: ItemsUpdater;
  index: number;
}) {
  const [open, setOpen] = useState(false);

  // Manual add
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ unitNumber: "1", title: "", topics: "", hours: "" });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // AI paste
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  const nextUnitNumber = items.reduce((max, i) => Math.max(max, i.unitNumber), 0) + 1;

  function openAdd() {
    setForm({ unitNumber: String(nextUnitNumber), title: "", topics: "", hours: "" });
    setAddError(null);
    setShowPaste(false);
    setShowAdd(true);
  }

  function openPaste() {
    setPasteText("");
    setPasteError(null);
    setShowAdd(false);
    setShowPaste(true);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      const item = await addSyllabusItem(syllabusId, {
        unitNumber: Number(form.unitNumber),
        title: form.title.trim(),
        topics: parseTopics(form.topics),
        hours: form.hours ? Number(form.hours) : undefined,
        subjectId: subject.id,
      });
      onItemsChange((prev) => sortItems([...prev, item]));
      setShowAdd(false);
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Failed to add unit.");
    } finally {
      setAdding(false);
    }
  }

  async function handleParse() {
    setParsing(true);
    setPasteError(null);
    try {
      const res = await parseSyllabusText(syllabusId, pasteText, subject.id);
      onItemsChange((prev) => sortItems([...prev, ...res.items]));
      setShowPaste(false);
      setPasteText("");
    } catch (err) {
      setPasteError(
        err instanceof ApiError ? err.message : "AI parse failed. Try adding units manually.",
      );
    } finally {
      setParsing(false);
    }
  }

  return (
    <div style={toneStyle(index)}>
      {/* Subject header */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tone-accent-l flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/50"
      >
        <span className="chip chip-tone shrink-0 font-mono text-[11px]">{subject.code}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {subject.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {items.length} unit{items.length !== 1 ? "s" : ""}
        </span>
        {open ? (
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-5 px-5 pb-5 pt-1">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No units yet.</p>
          ) : (
            <div className="space-y-5">
              {sortItems(items).map((item) => (
                <UnitRow
                  key={item.id}
                  syllabusId={syllabusId}
                  item={item}
                  subjectId={subject.id}
                  isEditor={isEditor}
                  onItemsChange={onItemsChange}
                />
              ))}
            </div>
          )}

          {/* Manual add form */}
          {isEditor && showAdd && (
            <form onSubmit={(e) => void handleAdd(e)} className="rounded-xl bg-muted/50 p-4">
              <h4 className="mb-3 text-sm font-semibold text-foreground">Add unit</h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Unit No. *</label>
                  <input
                    type="number"
                    min="1"
                    className={inputClass}
                    value={form.unitNumber}
                    onChange={(e) => setForm((f) => ({ ...f, unitNumber: e.target.value }))}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Hours</label>
                  <input
                    type="number"
                    min="1"
                    className={inputClass}
                    placeholder="Optional"
                    value={form.hours}
                    onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-xs font-medium text-foreground">Title *</label>
                  <input
                    className={inputClass}
                    placeholder="e.g. Introduction to C"
                    value={form.title}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                    required
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-xs font-medium text-foreground">
                    Topics (comma-separated) *
                  </label>
                  <textarea
                    className={textareaClass}
                    rows={2}
                    placeholder="Variables, Data Types, Operators"
                    value={form.topics}
                    onChange={(e) => setForm((f) => ({ ...f, topics: e.target.value }))}
                    required
                  />
                </div>
              </div>
              {addError && <p className="mt-2 text-xs text-destructive">{addError}</p>}
              <div className="mt-3 flex gap-2">
                <button type="submit" disabled={adding} className="btn btn-primary btn-sm">
                  {adding && <Loader2 className="size-3 animate-spin" />}
                  Add unit
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="btn btn-outline btn-sm"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* AI paste form */}
          {isEditor && showPaste && (
            <div className="rounded-xl bg-accent/60 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">
                  Paste syllabus text for {subject.name}
                </h4>
                <button
                  onClick={() => setShowPaste(false)}
                  aria-label="Close"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                AI will split the text into units and topics and add them to this subject.
              </p>
              <textarea
                className={textareaClass}
                rows={8}
                placeholder={
                  "Unit 1\nIntroduction to C, Variables, Data Types, Operators\n\nUnit 2\nControl Structures, if-else, loops, switch\n\nUnit 3\nArrays, Strings, Functions"
                }
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
              />
              {pasteError && <p className="mt-2 text-xs text-destructive">{pasteError}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => void handleParse()}
                  disabled={parsing || pasteText.trim().length < 10}
                  className="btn btn-primary btn-sm"
                >
                  {parsing ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Sparkles className="size-3" />
                  )}
                  {parsing ? "Parsing with AI…" : "Parse & Create Units"}
                </button>
                <button onClick={() => setShowPaste(false)} className="btn btn-outline btn-sm">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Actions */}
          {isEditor && !showAdd && !showPaste && (
            <div className="flex flex-wrap gap-2">
              <button onClick={openAdd} className="btn btn-outline btn-sm">
                <Plus className="size-3.5" />
                Add unit
              </button>
              <button onClick={openPaste} className="btn btn-outline btn-sm text-primary">
                <Sparkles className="size-3.5" />
                Paste & auto-generate
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── unit ───────────────────────── */

function UnitRow({
  syllabusId,
  item,
  subjectId,
  isEditor,
  onItemsChange,
}: {
  syllabusId: string;
  item: ApiSyllabusItem;
  subjectId?: string;
  isEditor: boolean;
  onItemsChange: ItemsUpdater;
}) {
  const { user } = useAuthStore();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: "", topics: "", hours: "" });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Which topic's past questions are showing (the panel itself loads and displays them)
  const [activeTopic, setActiveTopic] = useState<string | null>(null);

  function startEdit() {
    setForm({
      title: item.title,
      topics: item.topics.join(", "),
      hours: item.hours ? String(item.hours) : "",
    });
    setEditError(null);
    setEditing(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setEditError(null);
    try {
      const updated = await updateSyllabusItem(syllabusId, item.id, {
        title: form.title.trim(),
        topics: parseTopics(form.topics),
        hours: form.hours ? Number(form.hours) : undefined,
      });
      onItemsChange((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      setEditing(false);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this unit?")) return;
    try {
      await deleteSyllabusItem(syllabusId, item.id);
      onItemsChange((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  return (
    <div className="flex items-start gap-3.5">
      <span className="tone-bg-soft tone-text mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
        {item.unitNumber}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <p className="text-sm font-semibold text-foreground">
            {item.title.replace(/^Unit \d+:?\s*/i, "")}
          </p>
          {item.hours ? <span className="chip">{item.hours} hrs</span> : null}
          {isEditor && !editing && (
            <span className="ml-auto flex items-center gap-0.5">
              <button
                onClick={startEdit}
                aria-label="Edit unit"
                className="btn btn-ghost btn-sm btn-icon"
              >
                <Edit2 className="size-3" />
              </button>
              <button
                onClick={() => void handleDelete()}
                aria-label="Delete unit"
                className="btn btn-ghost btn-danger btn-sm btn-icon"
              >
                <Trash2 className="size-3" />
              </button>
            </span>
          )}
        </div>

        {!editing && (
          <>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.topics.map((t) => (
                <button
                  key={t}
                  onClick={() => setActiveTopic((cur) => (cur === t ? null : t))}
                  aria-pressed={activeTopic === t}
                  title="See past exam questions on this topic"
                  className={`chip ${activeTopic === t ? "chip-active" : "chip-tone"}`}
                >
                  {t}
                </button>
              ))}
            </div>

            {activeTopic && (
              <div className="mt-3 space-y-2 rounded-xl bg-muted/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">
                    Past questions on <span className="text-primary">{activeTopic}</span>
                  </p>
                  <button
                    onClick={() => setActiveTopic(null)}
                    aria-label="Close"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {user ? (
                  <TopicPyqPanel
                    topic={activeTopic}
                    subjectId={subjectId ?? item.subjectId ?? undefined}
                    context={item.subjectName ?? undefined}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Sign in to see the exact past-paper questions for this topic.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {editing && (
          <form
            onSubmit={(e) => void handleSave(e)}
            className="mt-2 space-y-3 rounded-xl bg-muted/50 p-4"
          >
            <div>
              <label className="field-label">Title</label>
              <input
                className={inputClass}
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="field-label">Topics (comma-separated)</label>
              <textarea
                className={textareaClass}
                rows={2}
                value={form.topics}
                onChange={(e) => setForm((f) => ({ ...f, topics: e.target.value }))}
              />
            </div>
            <div>
              <label className="field-label">Hours</label>
              <input
                type="number"
                className={inputClass}
                value={form.hours}
                onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
              />
            </div>
            {editError && <p className="text-xs text-destructive">{editError}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={saving} className="btn btn-primary btn-sm">
                {saving && <Loader2 className="size-3 animate-spin" />}
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="btn btn-outline btn-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
