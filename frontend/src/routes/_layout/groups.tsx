import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Users,
  Plus,
  Copy,
  LogOut,
  Loader2,
  ChevronDown,
  ChevronUp,
  Link2,
  TrendingDown,
  BookOpen,
  Sparkles,
  AlertCircle,
  Crown,
  UserMinus,
  RefreshCw,
  Trash2,
  Trophy,
  Info,
  Check,
} from "lucide-react";

import { LoginModal } from "@/components/campus/LoginModal";
import { useAuthStore } from "@/lib/auth";
import {
  fetchGroups,
  createGroup,
  joinGroup,
  leaveGroup,
  deleteGroup,
  fetchGroupAnalytics,
  fetchGroupProgress,
  generateGroupPlan,
  fetchGroupPlanOptions,
  deleteGroupPlan,
  removeGroupMember,
  transferGroupOwnership,
  regenerateInviteCode,
  ApiError,
  type ApiStudyGroup,
  type ApiGroupAnalytics,
  type ApiGroupMemberProgress,
  type ApiGroupPlanOptions,
  type ApiGroupPlanResult,
} from "@/lib/api";
import { BRANCHES, SEMESTERS } from "@/lib/campus-data";
import { cn } from "@/lib/utils";
import { toneStyle } from "@/lib/tone";

export const Route = createFileRoute("/_layout/groups")({
  head: () => ({ meta: [{ title: "Study Groups — CampusBrain" }] }),
  // /groups?join=AB3X7K pre-fills the join box (this is what "Copy invite link" produces)
  validateSearch: (s: Record<string, unknown>): { join?: string } => {
    const out: { join?: string } = {};
    if (typeof s["join"] === "string" && s["join"]) out.join = s["join"].toUpperCase().slice(0, 12);
    return out;
  },
  component: GroupsPage,
});

const errMsg = (e: unknown, fallback = "Something went wrong.") =>
  e instanceof ApiError ? e.message : fallback;

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score);
  const colour = score < 40 ? "bg-destructive" : score < 60 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

function PanelTitle({ icon: Icon, children }: { icon: typeof Users; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      <Icon className="size-3.5" /> {children}
    </p>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")
  ).toUpperCase();
}

function Avatar({ id, name, size = "size-8" }: { id: string; name: string; size?: string }) {
  return (
    <span
      style={toneStyle(id)}
      aria-hidden="true"
      className={cn(
        "tone-bg-soft tone-text tone-border inline-flex shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
        size,
      )}
    >
      {initials(name)}
    </span>
  );
}

async function copyText(text: string, okMessage: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMessage);
  } catch {
    toast.error("Couldn't copy automatically. Please select and copy it manually.");
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

function GroupsPage() {
  const { user } = useAuthStore();
  const { join } = Route.useSearch();
  const [loginOpen, setLoginOpen] = useState(false);

  const [groups, setGroups] = useState<ApiStudyGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null); // newly created / joined group opens itself

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cBranch, setCBranch] = useState("");
  const [cSem, setCSem] = useState("");
  const [cLoading, setCLoading] = useState(false);
  const [cError, setCError] = useState<string | null>(null);

  // Join form (pre-filled from ?join=CODE)
  const [joinCode, setJoinCode] = useState(join ?? "");
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    return fetchGroups()
      .then(setGroups)
      .catch((e) => setError(errMsg(e, "Failed to load groups.")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const replaceGroup = (g: ApiStudyGroup) =>
    setGroups((p) => p.map((x) => (x.id === g.id ? g : x)));
  const removeGroup = (id: string) => setGroups((p) => p.filter((g) => g.id !== id));

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCLoading(true);
    setCError(null);
    try {
      const g = await createGroup({
        name: cName.trim(),
        description: cDesc.trim() || undefined,
        branch: cBranch || undefined,
        semester: cSem ? Number(cSem) : undefined,
      });
      setGroups((p) => [g, ...p]);
      setFocusId(g.id);
      setShowCreate(false);
      setCName("");
      setCDesc("");
      setCBranch("");
      setCSem("");
      toast.success("Group created", {
        description: "Share the invite code or link with your friends.",
      });
    } catch (err) {
      setCError(errMsg(err, "Failed."));
    } finally {
      setCLoading(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setJoinLoading(true);
    setJoinError(null);
    try {
      const g = await joinGroup(joinCode.trim().toUpperCase());
      setGroups((p) => (p.some((x) => x.id === g.id) ? p : [g, ...p]));
      setFocusId(g.id);
      setJoinCode("");
      toast.success(`Joined ${g.name}`);
    } catch (err) {
      setJoinError(errMsg(err, "Failed — check the code."));
    } finally {
      setJoinLoading(false);
    }
  }

  if (!user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="card max-w-sm p-10 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
            <Users className="size-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            Sign in to use Study Groups
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {join
              ? `You've been invited to a group (code ${join}). Sign in to join it.`
              : "See your group's weak topics, compare subject coverage, and generate a shared study plan."}
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
    <main className="mx-auto max-w-4xl space-y-8 px-4 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">Study Groups</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            See what topics your group struggles with, track progress together, and generate a
            shared plan.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          aria-expanded={showCreate}
          className={cn("btn shrink-0", showCreate ? "btn-outline" : "btn-primary")}
        >
          <Plus className="size-4" /> New Group
        </button>
      </div>

      <div className={cn("grid gap-4", showCreate && "lg:grid-cols-5")}>
        {/* Create form */}
        {showCreate && (
          <section className="card p-6 lg:col-span-3">
            <h2 className="text-sm font-semibold text-foreground">Create group</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Invite friends with a 6-character code.
            </p>
            <form onSubmit={handleCreate} className="mt-4 space-y-4">
              <div>
                <label htmlFor="g-name" className="field-label">
                  Name *
                </label>
                <input
                  id="g-name"
                  className="field"
                  placeholder="e.g. CSE Sem 5 Gang"
                  value={cName}
                  maxLength={100}
                  onChange={(e) => setCName(e.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="g-desc" className="field-label">
                  Description
                </label>
                <input
                  id="g-desc"
                  className="field"
                  placeholder="What are you studying?"
                  value={cDesc}
                  maxLength={500}
                  onChange={(e) => setCDesc(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="g-branch" className="field-label">
                  Branch
                </label>
                <select
                  id="g-branch"
                  className="field"
                  value={cBranch}
                  onChange={(e) => setCBranch(e.target.value)}
                >
                  <option value="">Any</option>
                  {BRANCHES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span id="g-sem-label" className="field-label">
                  Semester
                </span>
                <div className="segmented" role="group" aria-labelledby="g-sem-label">
                  <button type="button" aria-pressed={cSem === ""} onClick={() => setCSem("")}>
                    Any
                  </button>
                  {SEMESTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={cSem === String(s)}
                      onClick={() => setCSem(String(s))}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              {cError && <p className="text-xs text-destructive">{cError}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={cLoading} className="btn btn-primary">
                  {cLoading && <Loader2 className="size-3.5 animate-spin" />} Create
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

        {/* Join */}
        <section
          className={cn(
            "card p-6",
            showCreate && "lg:col-span-2",
            join && "border-primary/40 bg-accent/40",
          )}
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Link2 className="size-4 text-primary" /> Join with invite code
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Got a code from a friend? Enter it here.
          </p>
          {join && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5" /> You opened an invite link. Check the code and press
              Join.
            </p>
          )}
          <form onSubmit={handleJoin} className="mt-4 flex gap-2">
            <input
              aria-label="Invite code"
              className="field flex-1 font-mono font-bold uppercase tracking-widest"
              placeholder="AB3X7K"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={6}
              required
            />
            <button type="submit" disabled={joinLoading} className="btn btn-primary">
              {joinLoading && <Loader2 className="size-3.5 animate-spin" />} Join
            </button>
          </form>
          {joinError && <p className="mt-2 text-xs text-destructive">{joinError}</p>}
        </section>
      </div>

      {/* Groups */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading...
        </div>
      ) : error ? (
        <div className="card border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
          <button onClick={() => void load()} className="ml-3 underline">
            Retry
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-primary">
            <Users className="size-5" />
          </div>
          <p className="mt-4 text-sm font-semibold text-foreground">No groups yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one, or join with a 6-character code from a friend.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <GroupCard
              key={g.id}
              group={g}
              userId={user.id}
              defaultOpen={g.id === focusId}
              onUpdate={replaceGroup}
              onGone={removeGroup}
              onRefresh={() => load(true)}
            />
          ))}
        </div>
      )}
    </main>
  );
}

// ── One group ────────────────────────────────────────────────────────────────

function GroupCard({
  group,
  userId,
  defaultOpen,
  onUpdate,
  onGone,
  onRefresh,
}: {
  group: ApiStudyGroup;
  userId: string;
  defaultOpen: boolean;
  onUpdate: (g: ApiStudyGroup) => void;
  onGone: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const isOwner =
    group.myRole === "OWNER" || !!group.members?.some((m) => m.id === userId && m.role === "OWNER");

  const [open, setOpen] = useState(defaultOpen);
  const [analytics, setAnalytics] = useState<ApiGroupAnalytics | null>(null);
  const [progress, setProgress] = useState<ApiGroupMemberProgress[] | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const loaded = useRef(false);
  const [busy, setBusy] = useState(false);

  // plan form
  const [planOpen, setPlanOpen] = useState(false);
  const [title, setTitle] = useState("");

  const [genWarnings, setGenWarnings] = useState<string[]>([]);

  const loadInsights = useCallback(async () => {
    setInsightsLoading(true);
    const [a, p] = await Promise.allSettled([
      fetchGroupAnalytics(group.id),
      fetchGroupProgress(group.id),
    ]);
    setAnalytics(a.status === "fulfilled" ? a.value : null);
    setProgress(p.status === "fulfilled" ? p.value : null);
    setInsightsLoading(false);
  }, [group.id]);

  useEffect(() => {
    if (open && !loaded.current) {
      loaded.current = true;
      void loadInsights();
    }
  }, [open, loadInsights]);

  const activePlan = progress?.some((p) => p.status === "ACTIVE") ?? false;
  const planRows = progress?.filter((p) => p.hasPlan) ?? [];
  const shared = analytics?.sharedSubjects ?? [];

  // ── actions ──
  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      toast.error(errMsg(e, fallback));
    } finally {
      setBusy(false);
    }
  }

  const handleLeave = () => {
    if (isOwner && group.memberCount > 1) {
      toast.error("You're the owner", {
        description: "Use “Make owner” on another member first, or delete the group.",
      });
      return;
    }
    if (
      !window.confirm(
        isOwner
          ? "You're the only member. Leaving deletes this group. Continue?"
          : "Leave this group?",
      )
    )
      return;
    void run(async () => {
      await leaveGroup(group.id);
      onGone(group.id);
    }, "Couldn't leave the group.");
  };

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete “${group.name}” for everyone? Members keep their own copy of any plan, but the group is gone.`,
      )
    )
      return;
    void run(async () => {
      await deleteGroup(group.id);
      onGone(group.id);
      toast.success("Group deleted");
    }, "Couldn't delete the group.");
  };

  const handleTransfer = (id: string, name: string) => {
    if (!window.confirm(`Make ${name} the owner? You'll become a regular member.`)) return;
    void run(async () => {
      onUpdate(await transferGroupOwnership(group.id, id));
      toast.success(`${name} is now the owner`);
    }, "Couldn't transfer ownership.");
  };

  const handleRemove = (id: string, name: string) => {
    if (!window.confirm(`Remove ${name} from the group?`)) return;
    void run(async () => {
      await removeGroupMember(group.id, id);
      await onRefresh();
      await loadInsights();
      toast.success(`${name} was removed`);
    }, "Couldn't remove that member.");
  };

  const handleRegenerate = () => {
    if (!window.confirm("Replace the invite code? The old code and link will stop working."))
      return;
    void run(async () => {
      const code = await regenerateInviteCode(group.id);
      onUpdate({ ...group, inviteCode: code });
      toast.success("New invite code created");
    }, "Couldn't create a new code.");
  };

  const handleDeletePlan = () => {
    if (
      !window.confirm("Delete the group plan for ALL members? Their progress on it will be lost.")
    )
      return;
    void run(async () => {
      await deleteGroupPlan(group.id);
      setGenWarnings([]);
      await loadInsights();
      toast.success("Group plan deleted");
    }, "Couldn't delete the plan.");
  };

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
        <div style={toneStyle(group.id)} className="shrink-0">
          <div className="tone-bg-soft tone-text tone-border flex size-11 items-center justify-center rounded-xl border">
            <Users className="size-5" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">{group.name}</h3>
            {isOwner && (
              <span className="chip border-primary/30 bg-primary/10 text-primary">
                <Crown className="size-3" /> Owner
              </span>
            )}
          </div>
          {group.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {group.branch && <span className="chip">{group.branch}</span>}
            {group.semester && <span className="chip">Sem {group.semester}</span>}
            <span className="chip">
              <Users className="size-3" /> {group.memberCount} member
              {group.memberCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => void copyText(group.inviteCode, "Invite code copied")}
            aria-label={`Copy invite code ${group.inviteCode}`}
            className="btn btn-outline btn-sm font-mono font-bold tracking-widest"
          >
            <Copy className="size-3" /> {group.inviteCode}
          </button>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Collapse group" : "Expand group"}
            className="btn btn-ghost btn-sm btn-icon"
          >
            {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          <button
            onClick={handleLeave}
            disabled={busy}
            aria-label="Leave group"
            title="Leave group"
            className="btn btn-danger btn-sm btn-icon"
          >
            <LogOut className="size-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="divide-y divide-border border-t border-border">
          {insightsLoading && !analytics && !progress ? (
            <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading group insights…
            </div>
          ) : (
            <>
              <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                {/* Members */}
                <div className="space-y-4 p-5">
                  <PanelTitle icon={Users}>Members</PanelTitle>
                  {group.members && group.members.length > 0 ? (
                    <ul className="space-y-4">
                      {group.members.map((m) => {
                        const subs =
                          analytics?.memberSubjects.find((ms) => ms.userId === m.id)?.subjects ??
                          [];
                        const canManage = isOwner && m.id !== userId;
                        return (
                          <li key={m.id} className="flex items-start gap-3">
                            <Avatar id={m.id} name={m.name} />
                            <div className="min-w-0 flex-1 space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <p className="truncate text-sm font-medium text-foreground">
                                  {m.name}
                                  {m.id === userId && (
                                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                                      (you)
                                    </span>
                                  )}
                                </p>
                                <span
                                  className={cn(
                                    "chip shrink-0",
                                    m.role === "OWNER" &&
                                      "border-primary/30 bg-primary/10 text-primary",
                                  )}
                                >
                                  {m.role}
                                </span>
                              </div>
                              {subs.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {subs.map((s) => (
                                    <span
                                      key={s.id}
                                      style={toneStyle(s.id)}
                                      className="chip chip-tone"
                                    >
                                      {s.code}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {canManage && (
                                <div className="flex gap-3">
                                  <button
                                    onClick={() => handleTransfer(m.id, m.name)}
                                    disabled={busy}
                                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                                  >
                                    <Crown className="size-3" /> Make owner
                                  </button>
                                  <button
                                    onClick={() => handleRemove(m.id, m.name)}
                                    disabled={busy}
                                    className="inline-flex items-center gap-1 text-xs text-destructive hover:underline disabled:opacity-50"
                                  >
                                    <UserMinus className="size-3" /> Remove
                                  </button>
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">No member info.</p>
                  )}

                  {/* Invite tools */}
                  <div className="flex flex-wrap items-center gap-1 pt-1">
                    <button
                      onClick={() =>
                        void copyText(
                          `${window.location.origin}/groups?join=${group.inviteCode}`,
                          "Invite link copied",
                        )
                      }
                      className="btn btn-outline btn-sm"
                    >
                      <Link2 className="size-3.5" /> Copy invite link
                    </button>
                    {isOwner && (
                      <>
                        <button
                          onClick={handleRegenerate}
                          disabled={busy}
                          className="btn btn-ghost btn-sm"
                        >
                          <RefreshCw className="size-3.5" /> New code
                        </button>
                        <button
                          onClick={handleDelete}
                          disabled={busy}
                          className="btn btn-danger btn-sm"
                        >
                          <Trash2 className="size-3.5" /> Delete group
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Weak topics */}
                <div className="space-y-4 p-5">
                  <PanelTitle icon={TrendingDown}>Group weak topics</PanelTitle>
                  {analytics && analytics.weakTopics.length > 0 ? (
                    <ul className="space-y-4">
                      {analytics.weakTopics.map((t) => (
                        <li key={t.topic} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="max-w-[55%] truncate font-medium text-foreground">
                              {t.topic}
                            </span>
                            <span className="shrink-0 text-amber-700 dark:text-amber-400">
                              {t.strugglingCount} of {t.memberCount} struggling
                            </span>
                          </div>
                          <ScoreBar score={t.avgScore} />
                          <Link
                            to="/mcq"
                            search={{ topic: t.topic }}
                            className="text-xs font-medium text-primary hover:underline"
                          >
                            Practice this
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="flex items-start gap-2 text-xs text-muted-foreground">
                      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                      {analytics
                        ? "No weak topics yet. Members need to take MCQ quizzes first (last 4 months are counted)."
                        : "Couldn't load group insights."}
                    </div>
                  )}
                </div>
              </div>

              {/* Plan progress */}
              {planRows.length > 0 && (
                <div className="space-y-4 p-5">
                  <div>
                    <PanelTitle icon={Trophy}>Group plan progress</PanelTitle>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {planRows[0]?.planTitle}
                    </p>
                  </div>
                  <ul className="space-y-3">
                    {planRows.map((p, i) => (
                      <li key={p.userId} className="flex items-center gap-3">
                        <span
                          className={cn(
                            "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                            i === 0
                              ? "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                              : "bg-muted text-muted-foreground",
                          )}
                          aria-hidden="true"
                        >
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span
                              className={cn(
                                "truncate font-medium",
                                p.isMe ? "text-primary" : "text-foreground",
                              )}
                            >
                              {p.name}
                              {p.isMe && " (you)"}
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {p.doneDays}/{p.totalDays} days · {p.percentage}%
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                p.isMe ? "bg-primary" : "bg-primary/60",
                              )}
                              style={{ width: `${p.percentage}%` }}
                            />
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {genWarnings.length > 0 && (
                <div className="bg-amber-500/10 p-5 text-xs text-amber-800 dark:text-amber-300">
                  <p className="mb-1 font-medium">Heads up about the new plan:</p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {genWarnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  <button onClick={() => setGenWarnings([])} className="mt-1.5 underline">
                    Dismiss
                  </button>
                </div>
              )}

              {/* Plan generation (owner) */}
              {isOwner && (
                <div className="bg-muted/30 p-5">
                  {activePlan ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">
                        This group has an active plan. Delete it to generate a new one.
                      </p>
                      <button
                        onClick={handleDeletePlan}
                        disabled={busy}
                        className="btn btn-danger btn-sm"
                      >
                        <Trash2 className="size-3.5" /> Delete group plan
                      </button>
                    </div>
                  ) : planOpen ? (
                    <GroupPlanWizard
                      groupId={group.id}
                      defaultTitle={title}
                      onCancel={() => setPlanOpen(false)}
                      onCreated={async (r) => {
                        setPlanOpen(false);
                        setGenWarnings(r.warnings);
                        toast.success("Group plan created", {
                          description: `Covers ${r.subjectsUsed} shared subject${r.subjectsUsed === 1 ? "" : "s"} and ${r.weakTopicsUsed} weak topic${r.weakTopicsUsed === 1 ? "" : "s"}. Every member has a copy under Study Plan.`,
                        });
                        await loadInsights();
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => {
                        setPlanOpen(true);
                        setTitle(`${group.name} — Exam Prep`);
                      }}
                      className="btn btn-primary btn-sm"
                    >
                      <Sparkles className="size-3.5" /> Generate group study plan
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type PlanOptionSubject = ApiGroupPlanOptions["subjects"][number];

/** Same flow as the personal Study Plan wizard: exam dates → configure → pick units → generate. */
function GroupPlanWizard({
  groupId,
  defaultTitle,
  onCancel,
  onCreated,
}: {
  groupId: string;
  defaultTitle: string;
  onCancel: () => void;
  onCreated: (r: ApiGroupPlanResult) => Promise<void>;
}) {
  const [step, setStep] = useState<"exams" | "configure" | "units">("exams");
  const [subjects, setSubjects] = useState<PlanOptionSubject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [examDates, setExamDates] = useState<Record<string, string>>({});
  const [title, setTitle] = useState(defaultTitle);
  const [hours, setHours] = useState("4");
  const [days, setDays] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGroupPlanOptions(groupId)
      .then((o) => {
        if (!cancelled) setSubjects(o.subjects);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errMsg(e, "Couldn't load the group's subjects."));
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const today = new Date().toISOString().slice(0, 10);
  const datedSubjects = (subjects ?? []).filter((s) => examDates[s.id]);
  // Once any exam date is set, only those subjects are scheduled (same as Study Plan)
  const unitSubjects = datedSubjects.length > 0 ? datedSubjects : (subjects ?? []);
  const allUnitIds = unitSubjects.flatMap((s) => s.units.map((u) => u.id));

  async function handleGenerate() {
    const n = days.trim() ? Number(days) : undefined;
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 60)) {
      setError("Study days must be between 1 and 60, or left empty for automatic.");
      setStep("configure");
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const r = await generateGroupPlan(groupId, {
        title: title.trim() || "Group Study Plan",
        ...(n !== undefined ? { totalDays: n } : {}),
        hoursPerDay: Math.min(12, Math.max(1, Number(hours) || 4)),
        ...(datedSubjects.length > 0
          ? {
              subjectExams: datedSubjects.map((s) => ({ subjectId: s.id, date: examDates[s.id]! })),
            }
          : {}),
        ...(excluded.size > 0 ? { excludedUnitIds: [...excluded] } : {}),
      });
      await onCreated(r);
    } catch (e) {
      setError(errMsg(e, "Failed."));
    } finally {
      setGenerating(false);
    }
  }

  const backBtn = "btn btn-outline btn-sm";
  const primaryBtn = "btn btn-primary btn-sm";

  if (loadError) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-destructive">{loadError}</p>
        <button onClick={onCancel} className={backBtn}>
          Close
        </button>
      </div>
    );
  }
  if (!subjects) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  const STEPS = [
    { key: "exams", label: "Exam dates" },
    { key: "configure", label: "Configure" },
    { key: "units", label: "Units" },
  ] as const;
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="space-y-5">
      <ol className="flex items-center gap-2" aria-label="Plan steps">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className="flex items-center gap-2"
            aria-current={i === stepIndex ? "step" : undefined}
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full text-[11px] font-semibold",
                i <= stepIndex
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {i < stepIndex ? <Check className="size-3" /> : i + 1}
            </span>
            <span
              className={cn(
                "text-xs font-medium",
                i === stepIndex ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
          </li>
        ))}
      </ol>

      {step === "exams" && (
        <>
          <p className="text-sm font-semibold text-foreground">Step 1 — Exam dates</p>
          {subjects.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Set an exam date for each shared subject you want in the plan. Leave all empty to
              include every shared subject without dates. The plan also adds focus days for the
              group's weak topics.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No subjects are shared by 2+ members yet, so the plan will be built from weak topics
              only. Members can add subjects in their profile.
            </p>
          )}
          <div className="card divide-y divide-border">
            {subjects.map((s) => (
              <div
                key={s.id}
                style={toneStyle(s.id)}
                className="tone-accent-l flex items-center gap-3 px-4 py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  <span className="chip chip-tone mr-2">{s.code}</span>
                  {s.name}
                </span>
                <input
                  type="date"
                  aria-label={`Exam date for ${s.code}`}
                  min={today}
                  className="field field-sm w-auto"
                  value={examDates[s.id] ?? ""}
                  onChange={(e) => setExamDates((prev) => ({ ...prev, [s.id]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setStep("configure")} className={primaryBtn}>
              Continue →
            </button>
            <button onClick={onCancel} className={backBtn}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === "configure" && (
        <>
          <p className="text-sm font-semibold text-foreground">Step 2 — Configure the plan</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor={`t-${groupId}`} className="field-label">
                Plan title
              </label>
              <input
                id={`t-${groupId}`}
                className="field"
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`h-${groupId}`} className="field-label">
                Study hours per day
              </label>
              <input
                id={`h-${groupId}`}
                type="number"
                min={1}
                max={12}
                step={0.5}
                className="field"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`d-${groupId}`} className="field-label">
                Study days (1–60)
              </label>
              <input
                id={`d-${groupId}`}
                type="number"
                min={1}
                max={60}
                placeholder="Auto"
                className="field"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave "Study days" empty to plan up to the last exam (30 days if there are no exam
            dates).
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => {
                setError(null);
                setStep("units");
              }}
              className={primaryBtn}
            >
              Select Units →
            </button>
            <button onClick={() => setStep("exams")} className={backBtn}>
              ← Back
            </button>
          </div>
        </>
      )}

      {step === "units" && (
        <>
          <p className="text-sm font-semibold text-foreground">Step 3 — Select units to study</p>
          {allUnitIds.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No syllabus units found for these subjects. The plan will use all available topics.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Uncheck any units the group has covered or wants to skip.
                </p>
                <div className="flex gap-2 text-xs">
                  <button
                    onClick={() => setExcluded(new Set())}
                    className="text-primary hover:underline"
                  >
                    Select all
                  </button>
                  <span className="text-muted-foreground">·</span>
                  <button
                    onClick={() => setExcluded(new Set(allUnitIds))}
                    className="text-primary hover:underline"
                  >
                    Deselect all
                  </button>
                </div>
              </div>
              <div className="max-h-96 space-y-3 overflow-y-auto">
                {unitSubjects
                  .filter((s) => s.units.length > 0)
                  .map((s) => {
                    const allChecked = s.units.every((u) => !excluded.has(u.id));
                    return (
                      <div key={s.id} style={toneStyle(s.id)} className="card overflow-hidden">
                        <label className="tone-bg-soft flex cursor-pointer items-center gap-2 px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={allChecked}
                            onChange={() =>
                              setExcluded((prev) => {
                                const next = new Set(prev);
                                for (const u of s.units) {
                                  if (allChecked) next.add(u.id);
                                  else next.delete(u.id);
                                }
                                return next;
                              })
                            }
                          />
                          <span className="tone-text text-xs font-semibold">{s.name}</span>
                          <span className="tone-text ml-auto text-[11px]">
                            {s.units.filter((u) => !excluded.has(u.id)).length}/{s.units.length}{" "}
                            units
                          </span>
                        </label>
                        <div className="divide-y divide-border">
                          {s.units.map((u) => {
                            const checked = !excluded.has(u.id);
                            return (
                              <label
                                key={u.id}
                                className="flex cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-muted/40"
                              >
                                <input
                                  type="checkbox"
                                  className="mt-0.5"
                                  checked={checked}
                                  onChange={() =>
                                    setExcluded((prev) => {
                                      const next = new Set(prev);
                                      if (checked) next.add(u.id);
                                      else next.delete(u.id);
                                      return next;
                                    })
                                  }
                                />
                                <div className="min-w-0 flex-1">
                                  <p
                                    className={cn(
                                      "text-xs font-medium",
                                      checked
                                        ? "text-foreground"
                                        : "text-muted-foreground line-through",
                                    )}
                                  >
                                    Unit {u.unitNumber}: {u.title.replace(/^Unit \d+:?\s*/i, "")}
                                  </p>
                                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                    {u.topics.slice(0, 4).join(" · ")}
                                    {u.topics.length > 4 && ` +${u.topics.length - 4} more`}
                                  </p>
                                </div>
                                {u.hours ? <span className="chip shrink-0">{u.hours}h</span> : null}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => void handleGenerate()}
              disabled={generating}
              className={primaryBtn}
            >
              {generating ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              Generate Plan
            </button>
            <button onClick={() => setStep("configure")} disabled={generating} className={backBtn}>
              ← Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}
