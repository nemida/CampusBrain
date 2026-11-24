import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Brain, Eye, EyeOff, Loader2 } from "lucide-react";
import { login } from "@/lib/auth";
import { ApiError } from "@/lib/api";

export const Route = createFileRoute("/_layout/register")({
  head: () => ({ meta: [{ title: "Create Account — CampusBrain" }] }),
  component: RegisterPage,
});

const BASE = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "http://localhost:4000";

async function registerStudent(name: string, email: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/register-student`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
}

const inputClass = "field w-full";

function RegisterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await registerStudent(name.trim(), email.trim().toLowerCase(), password);
      await login(email.trim().toLowerCase(), password);
      void navigate({ to: "/student" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-background px-4 pb-10 pt-8 sm:pt-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary shadow-sm">
            <Brain className="size-6 text-primary-foreground" />
          </div>

          <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Already have one?{" "}
            <Link to="/dashboard" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </div>

        <div className="card p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="reg-name" className="field-label">
                Full Name
              </label>
              <input
                id="reg-name"
                className={inputClass}
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="reg-email" className="field-label">
                Email
              </label>
              <input
                id="reg-email"
                type="email"
                className={inputClass}
                placeholder="you@college.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="reg-password" className="field-label">
                Password
              </label>
              <div className="relative">
                <input
                  id="reg-password"
                  type={showPw ? "text" : "password"}
                  className="field w-full pr-9"
                  placeholder="Min. 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="btn btn-primary w-full">
              {loading && <Loader2 className="size-4 animate-spin" />}
              {loading ? "Creating account…" : "Create Account"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          By signing up you agree to use this portal for academic purposes only.
        </p>
      </div>
    </div>
  );
}
