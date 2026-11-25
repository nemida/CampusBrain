/**
 * Shared layout for all new feature pages.
 * Renders the Header + LoginModal once, then <Outlet /> for child routes.
 *
 * Routes that use this layout (TanStack Router path-based):
 *   /graph, /mcq, /flashcards, /syllabus, /student, /study, /groups, /register
 *
 * dashboard.tsx keeps its own Header so it isn't affected.
 */
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Header } from "@/components/campus/Header";
import { LoginModal } from "@/components/campus/LoginModal";
import { useAuthStore, logout as authLogout } from "@/lib/auth";
import { fetchBotUrl } from "@/lib/api";
import { isStudyPath, useStudyAccess } from "@/lib/studyAccess";

export const Route = createFileRoute("/_layout")({
  component: SharedLayout,
});

function SharedLayout() {
  const { user } = useAuthStore();
  const routeId = useRouterState({ select: (state) => state.matches.at(-1)?.routeId ?? "" });
  const studyRoute = isStudyPath(routeId.replace(/^\/_layout/, ""));
  const { allowed, checking, unavailable } = useStudyAccess();
  const isAdmin = user?.role === "ADMIN" || user?.role === "TEACHER";

  const [loginOpen, setLoginOpen] = useState(false);
  const [botUrl, setBotUrl] = useState("#");
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchBotUrl()
      .then(setBotUrl)
      .catch(() => undefined);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Header
        isAdmin={isAdmin}
        userName={user?.name}
        query={query}
        onQueryChange={setQuery}
        botUrl={botUrl}
        onLoginClick={() => setLoginOpen(true)}
        onLogout={() => {
          void authLogout();
        }}
      />
      {studyRoute && !allowed ? (
        <main className="mx-auto max-w-7xl px-6 py-10">
          {checking ? (
            <p role="status">Checking study tool access…</p>
          ) : unavailable ? (
            <p role="status">Could not check study tool access. Refresh to try again.</p>
          ) : user ? (
            <p>Study tools are currently restricted to admin accounts.</p>
          ) : (
            <button className="btn btn-primary" onClick={() => setLoginOpen(true)}>
              Sign in to access study tools
            </button>
          )}
        </main>
      ) : (
        <Outlet key={user?.id ?? "anonymous"} />
      )}
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={() => setLoginOpen(false)}
      />
    </div>
  );
}
