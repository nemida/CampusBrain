import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { User, BookOpen, Plus, X, Loader2, Check } from "lucide-react";

import { LoginModal } from "@/components/campus/LoginModal";
import { useAuthStore } from "@/lib/auth";
import {
  fetchProfile,
  updateProfile,
  addProfileSubject,
  removeProfileSubject,
  fetchBranches,
  fetchSubjects,
  ApiUserProfile,
  ApiBranch,
  ApiSubject,
  ApiError,
} from "@/lib/api";

export const Route = createFileRoute("/_layout/profile")({
  head: () => ({ meta: [{ title: "My Profile — CampusBrain" }] }),
  component: ProfilePage,
});

const YEARS = [1, 2, 3, 4];
const SEMS_BY_YEAR: Record<number, number[]> = { 1: [1, 2], 2: [3, 4], 3: [5, 6], 4: [7, 8] };

function ProfilePage() {
  const { user } = useAuthStore();
  const [loginOpen, setLoginOpen] = useState(false);

  const [profile, setProfile] = useState<ApiUserProfile | null>(null);
  const [branches, setBranches] = useState<ApiBranch[]>([]);
  const [subjects, setSubjects] = useState<ApiSubject[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [year, setYear] = useState<number | null>(null);
  const [semester, setSemester] = useState<number | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);

  // Subject picker
  const [subjectSearch, setSubjectSearch] = useState("");
  const [addingSubject, setAddingSubject] = useState(false);

  useEffect(() => {
    if (!user) return;
    let current = true;
    setError(null);
    setLoading(true);
    Promise.all([fetchProfile(), fetchBranches()])
      .then(([p, b]) => {
        if (!current) return;
        setProfile(p);
        setBranches(b);
        setYear(p.year);
        setSemester(p.semester);
        setBranchId(p.branchId);
      })
      .catch((err) => {
        if (current) setError(err instanceof ApiError ? err.message : "Failed to load profile.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [user]);

  // Load subjects whenever branch+semester change
  useEffect(() => {
    if (!branchId || !semester) {
      setSubjects([]);
      return;
    }
    const controller = new AbortController();
    setSubjects([]);
    fetchSubjects({ branchId, semester }, controller.signal)
      .then(setSubjects)
      .catch(() => undefined);
    return () => controller.abort();
  }, [branchId, semester]);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateProfile({ year, semester, branchId });
      setProfile(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddSubject(subjectId: string) {
    setError(null);
    setAddingSubject(true);
    try {
      const updated = await addProfileSubject(subjectId);
      setProfile(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add subject.");
    } finally {
      setAddingSubject(false);
    }
  }

  async function handleRemoveSubject(subjectId: string) {
    setError(null);
    try {
      const updated = await removeProfileSubject(subjectId);
      setProfile(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove subject.");
    }
  }

  const enrolledIds = new Set(profile?.subjects.map((s) => s.subject.id) ?? []);
  const availableToAdd = subjects.filter(
    (s) => !enrolledIds.has(s.id) && s.name.toLowerCase().includes(subjectSearch.toLowerCase()),
  );

  if (!user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="card max-w-sm p-8 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
            <User className="size-6" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            Sign in to set up your profile
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Tell us your year and branch so we can personalise your study plan and dashboard.
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
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
      <div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">My Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set your year and branch so Study Plan and Dashboard know your subjects.
        </p>
      </div>

      {error && (
        <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading...
        </div>
      ) : (
        <>
          {/* Basic info */}
          <section className="card space-y-6 p-6">
            <h2 className="text-base font-semibold text-foreground">Academic details</h2>

            <div className="space-y-5">
              {/* Year */}
              <div className="space-y-2">
                <span className="field-label">Year</span>
                <div className="segmented" role="group" aria-label="Year">
                  {YEARS.map((y) => (
                    <button
                      key={y}
                      type="button"
                      aria-pressed={year === y}
                      onClick={() => {
                        setYear(y);
                        setSemester(SEMS_BY_YEAR[y]?.[0] ?? null);
                      }}
                    >
                      Year {y}
                    </button>
                  ))}
                </div>
              </div>

              {/* Semester */}
              <div className="space-y-2">
                <span className="field-label">Semester</span>
                {year ? (
                  <div className="segmented" role="group" aria-label="Semester">
                    {(SEMS_BY_YEAR[year] ?? []).map((s) => (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={semester === s}
                        onClick={() => setSemester(s)}
                      >
                        Sem {s}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Pick a year first.</p>
                )}
              </div>

              {/* Branch */}
              <div className="space-y-2">
                <label htmlFor="profile-branch" className="field-label">
                  Branch
                </label>
                <select
                  id="profile-branch"
                  className="field w-full"
                  value={branchId ?? ""}
                  onChange={(e) => setBranchId(e.target.value || null)}
                >
                  <option value="">Select branch</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button onClick={() => void handleSave()} disabled={saving} className="btn btn-primary">
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              {saving ? "Saving…" : "Save"}
            </button>
          </section>

          {/* Enrolled subjects */}
          <section className="card space-y-5 p-6">
            <h2 className="text-base font-semibold text-foreground">My Subjects</h2>

            {/* Current subjects */}
            {(profile?.subjects.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                No subjects added yet. Pick your year and branch above, then add subjects below.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {profile!.subjects.map((ps) => (
                  <li
                    key={ps.subject.id}
                    className="flex items-center justify-between border-l-[3px] border-border py-3 pl-3 first:pt-0 last:pb-0"
                  >
                    <div>
                      <span className="text-sm font-medium text-foreground">{ps.subject.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {ps.subject.code} · Sem {ps.subject.semester}
                      </span>
                    </div>
                    <button
                      onClick={() => void handleRemoveSubject(ps.subject.id)}
                      className="btn btn-ghost btn-icon btn-sm ml-3 hover:text-destructive"
                      aria-label="Remove subject"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Add subjects */}
            {subjects.length > 0 && (
              <div className="space-y-3 border-t border-border pt-5">
                <p className="field-label">Add from Sem {semester} subjects</p>
                <input
                  className="field field-sm w-full"
                  placeholder="Search subjects…"
                  value={subjectSearch}
                  onChange={(e) => setSubjectSearch(e.target.value)}
                />
                <ul className="max-h-56 divide-y divide-border overflow-y-auto">
                  {availableToAdd.map((s) => (
                    <li key={s.id} className="flex items-center justify-between py-2">
                      <span className="text-sm text-foreground">{s.name}</span>
                      <button
                        onClick={() => void handleAddSubject(s.id)}
                        disabled={addingSubject}
                        className="btn btn-outline btn-sm ml-2"
                      >
                        <Plus className="size-3" /> Add
                      </button>
                    </li>
                  ))}
                  {availableToAdd.length === 0 && (
                    <li className="py-2 text-center text-xs text-muted-foreground">
                      {subjects.length > 0 ? "All subjects already added." : "No subjects found."}
                    </li>
                  )}
                </ul>
              </div>
            )}

            {!semester && (
              <p className="text-xs text-muted-foreground">
                Select your year and branch above to see available subjects.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
