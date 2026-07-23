/**
 * Auth context for the web app (docs/api-contract.md, "Auth & profile").
 *
 * On mount it loads GET /api/me (existing session, or auto-login in local
 * mode) and GET /api/auth/methods (public — drives the sign-in/up pages).
 * A 401 from /api/me in password mode means "signed out", not an error.
 */
import type { User, Workspace } from '@jarvis/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LoadingPane } from '../components/ui.js';
import { api } from './api.js';

export type AuthMode = 'local' | 'password';
export type OauthLoginProvider = 'google' | 'facebook' | 'apple';

/** The API never returns `passwordHash`; it carries `hasPassword` instead. */
export type AuthUser = Omit<User, 'passwordHash'> & { hasPassword?: boolean };

export interface AuthMethods {
  authMode: AuthMode;
  signupEnabled: boolean;
  oauthProviders: OauthLoginProvider[];
}

interface MeResponse {
  user: AuthUser;
  workspace: Workspace;
  authMode: AuthMode;
}

export interface AuthContextValue {
  user: AuthUser | null;
  workspace: Workspace | null;
  authMode: AuthMode | null;
  methods: AuthMethods | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * Build a URL for full-page browser navigations to the API (OAuth start
 * routes). The XHR client (lib/api.ts) uses relative paths; those work for
 * navigations too because the Vite dev server proxies `/api` to the API
 * origin (see vite.config.ts) and in production the server serves the SPA
 * itself, so the API is always same-origin from the browser's perspective.
 */
export function apiUrl(path: string): string {
  return path;
}

/**
 * Validate a `returnTo` query value: in-app absolute paths only. Rejects
 * absolute URLs and protocol-relative forms (`//…`, `/\…`) to avoid open
 * redirects.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const [meRes, methodsRes] = await Promise.all([
      // 401 (signed out in password mode) and any transient failure both
      // resolve to "no user" — the UI routes to /signin, never an error pane.
      api.get<MeResponse>('/api/me').catch(() => null),
      api.get<AuthMethods>('/api/auth/methods').catch(() => null),
    ]);
    setMe(meRes);
    setMethods(methodsRes);
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  const authMode: AuthMode | null = methods?.authMode ?? me?.authMode ?? null;

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // Even if the server call fails, drop local state and move on.
    }
    if (authMode === 'password') {
      setMe(null);
      navigate('/signin');
    } else {
      // Local mode: /api/me signs the default user straight back in.
      await load();
    }
  }, [authMode, load, navigate]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: me?.user ?? null,
      workspace: me?.workspace ?? null,
      authMode,
      methods,
      loading,
      refresh,
      logout,
    }),
    [me, methods, authMode, loading, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/**
 * Route guard for everything behind the app shell. In password mode an
 * unauthenticated visit redirects to /signin with the attempted path as
 * `returnTo`; local mode never redirects (auto-login via /api/me).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, authMode, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingPane />;
  if (!user && authMode === 'password') {
    const returnTo = location.pathname + location.search;
    return <Navigate to={`/signin?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <>{children}</>;
}
