/**
 * Login of the agent backend: what it authenticates with, whether that still
 * works, and renewing it from the web UI. The contract; implementations live
 * in the backend adapters and are registered in stores.ts.
 *
 * "Still works" has two sources: a known end date (long-lived tokens), and the
 * last request the provider rejected as unauthenticated. The trigger runner
 * records those rejections (recordAuthFailure) and clears them after the next
 * successful turn; a failure older than the current credential is ignored.
 */

import type { Database } from "bun:sqlite";

/**
 * ok: usable · expiring: ends within EXPIRING_DAYS · expired: past its end date ·
 * failed: the provider rejected it since it was set up · missing: no credential.
 */
export type AuthState = "ok" | "expiring" | "expired" | "failed" | "missing";

/** A credential ending within this many days is reported as expiring. */
export const EXPIRING_DAYS = 30;

export interface LoginMethod {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
}

export interface AuthCredential {
  kind: "api-key" | "token" | "subscription";
  /** env: container environment · dashboard: created in the web UI · login: the backend's own login. */
  source: "env" | "dashboard" | "login";
  label: string;
}

/** A login waiting for the code from the provider's sign-in page. */
export interface PendingLogin {
  id: string;
  method: string;
  /** Sign-in page to open in the browser. */
  url: string;
  startedAt: string;
  /** The waiting process is stopped after this. */
  expiresAt: string;
}

export interface AuthStatus {
  backend: string;
  state: AuthState;
  /** One line for badges and tooltips. */
  summary: string;
  /** What the backend authenticates with now (the highest-precedence credential). */
  credential: AuthCredential | null;
  account: { email: string | null; organization: string | null; plan: string | null } | null;
  /** Known end of the credential; null when it renews itself or the end is unknown. */
  expiresAt: string | null;
  /** Last authentication failure since the credential was set up. */
  failure: { at: string; message: string } | null;
  /** Set when an environment credential takes precedence over logins made here. */
  override: string | null;
  methods: LoginMethod[];
  pending: PendingLogin | null;
}

export type AuthErrorKind = "not-found" | "rejected" | "unavailable";

/** A login step that failed; `kind` maps to the HTTP status in the web UI. */
export class AuthLoginError extends Error {
  constructor(
    readonly kind: AuthErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface HarnessAuth {
  readonly backend: string;
  status(): AuthStatus;
  /** Start a login and return the sign-in URL. Replaces a login that is still waiting. */
  startLogin(method: string): Promise<PendingLogin>;
  /** Hand the code from the sign-in page to the waiting login. */
  completeLogin(id: string, code: string): Promise<AuthStatus>;
  cancelLogin(id: string): void;
  /** Forget the credential created in the dashboard (the backend's own login stays). */
  removeDashboardCredential(): void;
}

export interface HarnessAuthOptions {
  backend?: string;
  home?: string;
  /** For failure tracking; without it failures are not reported. */
  db?: Database;
  /** Backend CLI to run for logins (tests substitute a fake). */
  command?: string[];
}

// ---------------------------------------------------------------------------
// Authentication failures (system_state)
// ---------------------------------------------------------------------------

const FAILURE_KEY = "harness_auth_failure";

export interface AuthFailure {
  backend: string;
  /** ISO time the provider rejected the request. */
  at: string;
  message: string;
}

export function recordAuthFailure(db: Database, backend: string, message: string, at = new Date()): void {
  const value: AuthFailure = { backend, at: at.toISOString(), message: message.slice(0, 500) };
  db.run(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [FAILURE_KEY, JSON.stringify(value)],
  );
}

export function clearAuthFailure(db: Database): void {
  db.run("DELETE FROM system_state WHERE key = ?", [FAILURE_KEY]);
}

export function readAuthFailure(db: Database, backend: string): AuthFailure | null {
  try {
    const row = db.query("SELECT value FROM system_state WHERE key = ?").get(FAILURE_KEY) as { value: string } | null;
    const f = row ? (JSON.parse(row.value) as AuthFailure) : null;
    return f && f.backend === backend && typeof f.at === "string" ? f : null;
  } catch {
    return null;
  }
}

/** State of a credential from its end date and the failures since it was set up. */
export function authState(
  opts: { hasCredential: boolean; expiresAt: string | null; failure: AuthFailure | null },
  now = Date.now(),
): AuthState {
  if (!opts.hasCredential) return "missing";
  const end = opts.expiresAt ? Date.parse(opts.expiresAt) : NaN;
  if (end <= now) return "expired";
  if (opts.failure) return "failed";
  if (end - now <= EXPIRING_DAYS * 86_400_000) return "expiring";
  return "ok";
}
