import { Search, Sparkles, LogOut, Menu, X, Brain } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/lib/auth";

type Props = {
  isAdmin: boolean;
  userName?: string | undefined;
  query: string;
  onQueryChange: (v: string) => void;
  onLoginClick: () => void;
  onLogout: () => void;
  botUrl: string;
};

// Primary nav — always visible
const primaryLinks = [
  { to: "/dashboard" as const, label: "Papers" },
  { to: "/mcq" as const, label: "MCQ" },
  { to: "/flashcards" as const, label: "Flashcards" },
  { to: "/syllabus" as const, label: "Syllabus" },
  { to: "/agent" as const, label: "AI Coach" },
];

// Secondary nav — only when logged in
const secondaryLinks = [
  { to: "/student" as const, label: "My Dashboard" },
  { to: "/study" as const, label: "Study Plan" },
  { to: "/groups" as const, label: "Groups" },
  { to: "/pyq" as const, label: "PYQ Finder" },
];

// Shown last, after the admin link
const profileLink = { to: "/profile" as const, label: "Profile" };

// Admin-only nav link
const adminLink = { to: "/admin" as const, label: "Admin" };

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join("") || "U"
  );
}

export function Header({
  isAdmin,
  userName,
  query,
  onQueryChange,
  onLoginClick,
  onLogout,
  botUrl,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const submitSearch = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || !query.trim()) return;
    event.preventDefault();
    setMenuOpen(false);
    void navigate({ to: "/dashboard", search: { q: query.trim().slice(0, 200) } });
  };
  const [scrolled, setScrolled] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { user } = useAuthStore();
  const isLoggedIn = !!user;
  const displayName = userName || user?.name || user?.email || "You";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // "/" focuses search, like every good app
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === "/" && el && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const base =
    "rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
  const active =
    "relative px-3 py-1.5 text-sm font-semibold text-foreground after:absolute after:inset-x-3 after:-bottom-0.5 after:h-[3px] after:rounded-full after:bg-[var(--highlight)]";
  const subBase =
    "rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground";
  const subActive = "rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-primary";

  return (
    <header
      className={`sticky top-0 z-30 border-b bg-background/95 backdrop-blur transition-colors ${
        scrolled ? "border-border" : "border-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4">
        {/* Logo */}
        <Link to="/" className="group mr-2 flex shrink-0 items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-transform group-hover:-rotate-6">
            <Brain className="size-4" />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight text-foreground">
            CampusBrain
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {primaryLinks.map((l) => (
            <Link key={l.to} to={l.to} className={base} activeProps={{ className: active }}>
              {l.label}
            </Link>
          ))}
        </nav>

        {/* Search */}
        <div className="relative mx-2 hidden w-full max-w-xs lg:block">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={submitSearch}
            placeholder="Search subjects…"
            aria-label="Search"
            className="field field-sm !h-9 !pl-9 !pr-9"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-background px-1.5 text-[10px] font-medium text-muted-foreground">
            /
          </kbd>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <a
            href={botUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-sm"
          >
            <Sparkles className="size-3.5" />
            Ask AI
          </a>
          {isLoggedIn ? (
            <div className="hidden items-center gap-1.5 sm:flex">
              <Link
                to="/profile"
                className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card pl-1 pr-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
              >
                <span className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                  {initials(displayName)}
                </span>
                <span className="max-w-24 truncate">{displayName}</span>
                {isAdmin && (
                  <span className="rounded bg-primary/10 px-1 text-[10px] font-bold uppercase text-primary">
                    {user?.role === "ADMIN" ? "Admin" : "Faculty"}
                  </span>
                )}
              </Link>
              <button
                onClick={onLogout}
                aria-label="Sign out"
                title="Sign out"
                className="btn btn-ghost btn-icon !size-9"
              >
                <LogOut className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={onLoginClick}
              className="btn btn-outline btn-sm !hidden sm:!inline-flex"
            >
              Sign In
            </button>
          )}

          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="btn btn-outline btn-icon !size-9 md:!hidden"
            aria-label="Menu"
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      {isLoggedIn && (
        <div className="hidden border-t border-border/50 bg-accent/30 md:block">
          <div className="mx-auto flex h-9 max-w-7xl items-center gap-1 px-4">
            {secondaryLinks.map((l) => (
              <Link key={l.to} to={l.to} className={subBase} activeProps={{ className: subActive }}>
                {l.label}
              </Link>
            ))}
            {user?.role === "ADMIN" && (
              <Link to={adminLink.to} className={subBase} activeProps={{ className: subActive }}>
                {adminLink.label}
              </Link>
            )}
            <Link to={profileLink.to} className={subBase} activeProps={{ className: subActive }}>
              {profileLink.label}
            </Link>
          </div>
        </div>
      )}

      {menuOpen && (
        <div className="border-t border-border bg-background px-4 pb-4 pt-2 md:hidden">
          <div className="relative my-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={submitSearch}
              placeholder="Search subjects…"
              aria-label="Search"
              className="h-10 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </div>
          <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Browse
          </p>
          {primaryLinks.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              onClick={() => setMenuOpen(false)}
              className="block rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              activeProps={{
                className:
                  "block rounded-lg px-3 py-2.5 text-sm font-semibold bg-accent text-primary",
              }}
            >
              {l.label}
            </Link>
          ))}

          {isLoggedIn && (
            <>
              <p className="mb-1 mt-3 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                My Study
              </p>
              {secondaryLinks.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  activeProps={{
                    className:
                      "block rounded-lg px-3 py-2.5 text-sm font-semibold bg-accent text-primary",
                  }}
                >
                  {l.label}
                </Link>
              ))}
              {user?.role === "ADMIN" && (
                <Link
                  to={adminLink.to}
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  activeProps={{
                    className:
                      "block rounded-lg px-3 py-2.5 text-sm font-semibold bg-accent text-primary",
                  }}
                >
                  {adminLink.label}
                </Link>
              )}
              <Link
                to={profileLink.to}
                onClick={() => setMenuOpen(false)}
                className="block rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                activeProps={{
                  className:
                    "block rounded-lg px-3 py-2.5 text-sm font-semibold bg-accent text-primary",
                }}
              >
                {profileLink.label}
              </Link>
            </>
          )}

          <div className="mt-3 border-t border-border pt-3">
            {isLoggedIn ? (
              <button
                onClick={() => {
                  onLogout();
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <LogOut className="size-4" />
                Sign Out
              </button>
            ) : (
              <button
                onClick={() => {
                  onLoginClick();
                  setMenuOpen(false);
                }}
                className="flex w-full rounded-lg px-3 py-2.5 text-sm font-semibold text-primary hover:bg-accent"
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
