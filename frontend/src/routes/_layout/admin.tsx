import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, BookOpen, GraduationCap, ShieldAlert, Layers } from "lucide-react";

import { LoginModal } from "@/components/campus/LoginModal";
import { useAuthStore } from "@/lib/auth";
import { toneStyle } from "@/lib/tone";
import {
  fetchBranches,
  createBranch,
  deleteBranch,
  fetchSubjects,
  createSubject,
  deleteSubject,
  ApiBranch,
  ApiSubject,
  ApiError,
} from "@/lib/api";

export const Route = createFileRoute("/_layout/admin")({
  head: () => ({ meta: [{ title: "Admin — CampusBrain" }] }),
  component: AdminPage,
});

/* ───────────────────────── shared bits ───────────────────────── */

const inputClass = "field";
const selectClass = "field";

const semesters = [1, 2, 3, 4, 5, 6, 7, 8];

/* ───────────────────────── page ───────────────────────── */

function AdminPage() {
  const { user } = useAuthStore();
  const isAdminUser = user?.role === "ADMIN";

  const [loginOpen, setLoginOpen] = useState(false);

  const [branches, setBranches] = useState<ApiBranch[]>([]);
  const [subjects, setSubjects] = useState<ApiSubject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subject filters
  const [filterBranchId, setFilterBranchId] = useState("");
  const [filterSem, setFilterSem] = useState("");

  async function loadBranches() {
    try {
      setBranches(await fetchBranches());
    } catch {
      /* ignore — branches list is best-effort */
    }
  }

  useEffect(() => {
    if (!isAdminUser) return;
    void loadBranches();
  }, [isAdminUser]);

  useEffect(() => {
    if (!isAdminUser) return;
    setLoading(true);
    setError(null);
    fetchSubjects({
      branch: filterBranchId
        ? branches.find((b) => b.id === filterBranchId)?.name
        : undefined,
      semester: filterSem ? Number(filterSem) : undefined,
    })
      .then(setSubjects)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load subjects."),
      )
      .finally(() => setLoading(false));
  }, [isAdminUser, filterBranchId, filterSem, branches]);

  /* ── Not logged in / not admin ── */

  if (!user) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-accent text-primary">
          <ShieldAlert className="size-5" />
        </div>
        <h1 className="mt-4 text-xl font-bold text-foreground">Admin access required</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Sign in with an admin account to manage branches and subjects.
        </p>
        <button
          onClick={() => setLoginOpen(true)}
          className="btn btn-primary mt-6"
        >
          Sign In
        </button>
        <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={() => setLoginOpen(false)} />
      </main>
    );
  }

  if (!isAdminUser) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-accent text-primary">
          <ShieldAlert className="size-5" />
        </div>
        <h1 className="mt-4 text-xl font-bold text-foreground">Admins only</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This page is restricted to admin accounts. Your role is{" "}
          <span className="font-semibold text-foreground">{user.role}</span>.
        </p>
      </main>
    );
  }

  /* ── Admin UI ── */

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-6 py-10">
      <div>

        <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">Admin Panel</h1>
        <p className="mt-2 text-muted-foreground">
          Manage branches and add subjects to any branch and semester.
        </p>
      </div>

      {/* Branches */}
      <BranchSection branches={branches} onChange={loadBranches} />

      {/* Subjects */}
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <GraduationCap className="size-4 text-primary" />
              Subjects
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a subject to a branch and semester so teachers can upload papers for it.
            </p>
          </div>
        </div>

        <SubjectAddForm
          branches={branches}
          onCreated={(s) => {
            setSubjects((prev) =>
              [...prev, s].sort(
                (a, b) => a.semester - b.semester || a.code.localeCompare(b.code),
              ),
            );
          }}
        />

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Filter by branch"
            className="field field-sm !w-auto"
            value={filterBranchId}
            onChange={(e) => setFilterBranchId(e.target.value)}
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label="Filter by semester">
            <button type="button" aria-pressed={filterSem === ""} onClick={() => setFilterSem("")}>
              All
            </button>
            {semesters.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={filterSem === String(n)}
                onClick={() => setFilterSem(String(n))}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading...
          </div>
        ) : error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </p>
        ) : subjects.length === 0 ? (
          <div className="card p-12 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
              <BookOpen className="size-5" />
            </div>
            <p className="mt-4 text-sm font-semibold text-foreground">No subjects found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a subject above using the form.
            </p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Branch</th>
                  <th className="px-4 py-3">Sem</th>
                  <th className="px-4 py-3 text-center">Papers</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {subjects.map((s) => (
                  <tr key={s.id} style={toneStyle(s.id)} className="transition-colors hover:bg-muted/30">
                    <td className="px-4 py-3"><span className="chip chip-tone font-mono">{s.code}</span></td>
                    <td className="px-4 py-3 font-medium text-foreground">{s.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.branch}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.semester}</td>
                    <td className="px-4 py-3 text-center"><span className="chip">{s.paperCount}</span></td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => void handleDeleteSubject(s, setSubjects)}
                        aria-label={`Delete ${s.name}`}
                        title={`Delete ${s.name}`}
                        className="btn btn-danger btn-sm btn-icon"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

/* ───────────────────────── branches ───────────────────────── */

function BranchSection({
  branches,
  onChange,
}: {
  branches: ApiBranch[];
  onChange: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", code: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await createBranch({
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
      });
      onChange();
      setShowAdd(false);
      setForm({ name: "", code: "" });
      toast.success("Branch created");
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Failed to create branch.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(b: ApiBranch) {
    if (!window.confirm(`Delete branch "${b.name}"? This only works when it has no subjects.`))
      return;
    try {
      await deleteBranch(b.id);
      onChange();
      toast.success("Branch deleted");
    } catch (e2) {
      toast.error(e2 instanceof ApiError ? e2.message : "Delete failed.");
    }
  }

  return (
    <section className="card space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Layers className="size-4 text-primary" />
            Branches
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a branch before adding subjects to it.
          </p>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="btn btn-primary btn-sm shrink-0"
        >
          <Plus className="size-4" />
          Add Branch
        </button>
      </div>

      {showAdd && (
        <form
          onSubmit={handleAdd}
          className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2"
        >
          <div className="space-y-1.5">
            <label className="field-label">Branch Name *</label>
            <input
              className={inputClass}
              placeholder="e.g. Computer Science"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="field-label">Branch Code *</label>
            <input
              className={inputClass}
              placeholder="e.g. CS"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              required
            />
          </div>
          {err && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive sm:col-span-2">
              {err}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="btn btn-primary btn-sm"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Create
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        {branches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No branches yet. Create one above.</p>
        ) : (
          branches.map((b) => (
            <div
              key={b.id}
              style={toneStyle(b.id)}
              className="tone-bg-soft flex items-center gap-2 rounded-full py-1 pl-3 pr-1"
            >
              <span className="tone-text text-sm font-medium">{b.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {b.code}
              </span>
              <button
                onClick={() => void handleDelete(b)}
                aria-label={`Delete ${b.name}`}
                className="btn btn-danger btn-icon size-6 !h-6 !w-6 rounded-full"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ───────────────────────── subject add form ───────────────────────── */

function SubjectAddForm({
  branches,
  onCreated,
}: {
  branches: ApiBranch[];
  onCreated: (s: ApiSubject) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    branchId: "",
    semester: "1",
    code: "",
    name: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setForm({ branchId: "", semester: "1", code: "", name: "" });
    setErr(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const subject = await createSubject({
        code: form.code.trim(),
        name: form.name.trim(),
        semester: Number(form.semester),
        branchId: form.branchId,
      });
      onCreated(subject);
      toast.success(`Added "${subject.name}" to ${subject.branch} · Sem ${subject.semester}`);
      reset();
      setOpen(false);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Failed to create subject.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn btn-outline btn-sm"
      >
        <Plus className="size-4" />
        Add Subject
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="card space-y-4 p-6"
    >
      <h3 className="text-sm font-semibold text-foreground">Add a subject</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="field-label">Branch *</label>
          <select
            className={selectClass}
            value={form.branchId}
            onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}
            required
          >
            <option value="">Select branch</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="field-label">Semester *</label>
          <select
            className={selectClass}
            value={form.semester}
            onChange={(e) => setForm((f) => ({ ...f, semester: e.target.value }))}
          >
            {semesters.map((n) => (
              <option key={n} value={n}>
                Semester {n}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="field-label">Subject Code *</label>
          <input
            className={inputClass}
            placeholder="e.g. ICT-101"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            required
          />
        </div>
        <div className="space-y-1.5">
          <label className="field-label">Subject Name *</label>
          <input
            className={inputClass}
            placeholder="e.g. Programming for Problem Solving"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
          />
        </div>
      </div>
      {err && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {err}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || !form.branchId}
          className="btn btn-primary btn-sm"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Add Subject
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="btn btn-ghost btn-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ───────────────────────── delete handler ───────────────────────── */

async function handleDeleteSubject(
  subject: ApiSubject,
  setSubjects: React.Dispatch<React.SetStateAction<ApiSubject[]>>,
) {
  if (
    !window.confirm(
      `Delete "${subject.name}" (${subject.code})?\n${
        subject.paperCount > 0
          ? `It has ${subject.paperCount} paper(s) attached — remove those first.`
          : "This cannot be undone."
      }`,
    )
  )
    return;
  try {
    await deleteSubject(subject.id);
    setSubjects((prev) => prev.filter((s) => s.id !== subject.id));
    toast.success("Subject deleted");
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : "Delete failed.");
  }
}
