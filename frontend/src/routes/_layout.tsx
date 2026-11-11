/**
 * Shared layout for all new feature pages.
 * Renders the Header + LoginModal once, then <Outlet /> for child routes.
 *
 * Routes that use this layout (TanStack Router path-based):
 *   /graph, /mcq, /flashcards, /syllabus, /student, /study, /groups, /register
 *
 * dashboard.tsx keeps its own Header so it isn't affected.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Header } from "@/components/campus/Header";
import { LoginModal } from "@/components/campus/LoginModal";
import { useAuthStore, logout as authLogout } from "@/lib/auth";
import { fetchBotUrl } from "@/lib/api";

export const Route = createFileRoute("/_layout")({
  component: SharedLayout,
});

function SharedLayout() {
  const { user } = useAuthStore();
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
        onLoginClick={() => setLoginOpen(true)}
        onLogout={() => {
          void authLogout();
        }}
        botUrl={botUrl}
      />
      <Outlet />
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={() => setLoginOpen(false)}
      />
    </div>
  );
}
