/**
 * Auth state — thin wrapper around the api.ts token helpers.
 *
 * Exposes a React hook `useAuthStore` (simple useState-based store) so the
 * Dashboard, LoginModal, and Header can share the same logged-in user object
 * without pulling in a heavy state library.
 *
 * We use a module-level store + subscriber list so that multiple components
 * calling `useAuthStore()` all see the same state and re-render together when
 * it changes.
 *
 * The session is restored from localStorage in an effect (not at module load)
 * so server-rendered HTML and the first client render always match.
 */

import { useState, useEffect } from "react";
import {
  type AuthUser,
  getAccessToken,
  getRefreshToken,
  getStoredUser,
  storeTokens,
  storeUser,
  clearTokens,
  setAuthLostHandler,
  apiLogin,
  apiLogout,
} from "./api";

// ── Module-level store ────────────────────────────────────────────────────────

type AuthState = {
  user: AuthUser | null;
  /** true while a login/logout request is in-flight */
  loading: boolean;
  /** last error message from login */
  error: string | null;
};

let state: AuthState = {
  user: null,
  loading: false,
  error: null,
};

type Listener = (s: AuthState) => void;
const listeners = new Set<Listener>();

function setState(partial: Partial<AuthState>) {
  state = { ...state, ...partial };
  listeners.forEach((l) => l(state));
}

// A failed token refresh means the session is over
setAuthLostHandler(() => setState({ user: null, loading: false, error: null }));

// Restore the session from localStorage (browser only, once)
let hydrated = false;

function ensureHydrated() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;

  const token = getAccessToken();
  const refreshToken = getRefreshToken();
  if (!token && !refreshToken) return;

  const stored = getStoredUser();
  if (stored) {
    setState({ user: stored });
    return;
  }

  // Fallback: decode the claims from the access token (verification happens
  // on the backend per-request).
  try {
    const payload = JSON.parse(atob((token ?? "").split(".")[1]!)) as {
      sub: string;
      email: string;
      role: AuthUser["role"];
      exp: number;
    };

    // Expired access token is fine as long as we can refresh it on the next request
    if (payload.exp * 1000 < Date.now() && !refreshToken) {
      clearTokens();
      return;
    }

    setState({ user: { id: payload.sub, email: payload.email, name: "", role: payload.role } });
  } catch {
    clearTokens();
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<void> {
  setState({ loading: true, error: null });
  try {
    const res = await apiLogin(email, password);
    storeTokens(res.accessToken, res.refreshToken);
    storeUser(res.user);
    setState({ user: res.user, loading: false, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed";
    setState({ loading: false, error: message });
    throw err; // re-throw so the modal can react
  }
}

export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  clearTokens();
  setState({ user: null, loading: false, error: null });
  if (refreshToken) {
    // Best-effort — don't block UI on this
    apiLogout(refreshToken).catch(() => undefined);
  }
}

export function isAdmin(): boolean {
  return state.user?.role === "ADMIN" || state.user?.role === "TEACHER";
}

// ── React hook ────────────────────────────────────────────────────────────────

export function useAuthStore(): AuthState & {
  login: typeof login;
  logout: typeof logout;
} {
  // Before the session has been restored (server render + first client render) start
  // logged-out so hydration matches; afterwards new components can read the live state.
  const [localState, setLocalState] = useState<AuthState>(() =>
    hydrated ? state : { user: null, loading: false, error: null },
  );

  useEffect(() => {
    const handler = (s: AuthState) => setLocalState(s);
    listeners.add(handler);
    ensureHydrated();
    // Sync with whatever the store holds right now (e.g. hydrated by another component)
    setLocalState(state);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return { ...localState, login, logout };
}
