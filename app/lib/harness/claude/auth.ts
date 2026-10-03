/**
 * Claude Code login for the web UI. Runs the CLI's own login flows in a
 * pseudo-terminal and hands them the code from the sign-in page, so Atlas never
 * speaks OAuth itself. SDK-free: the web UI runs it (registered in stores.ts).
 *
 *
 *   token         `claude setup-token`: a 1-year OAuth token for the
 *                 subscription. Stored in TOKEN_FILE; the Claude adapter
 *                 exports it as CLAUDE_CODE_OAUTH_TOKEN (environment.ts).
 *   subscription  `claude auth login --claudeai`: the regular login in
 *                 ~/.claude/.credentials.json, renewed by the CLI itself.
 *
 * Claude Code's precedence: ANTHROPIC_API_KEY, then CLAUDE_CODE_OAUTH_TOKEN,
 * then the stored login. An env value set for the container therefore wins
 * over anything created here.
 *
 * `--ax-screen-reader` makes the CLI print flat lines instead of redrawing
 * the screen, so the URL, the token and error messages can be read from the
 * terminal output.
 */

import type { Subprocess } from "bun";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  AuthLoginError,
  authState,
  clearAuthFailure,
  readAuthFailure,
  type AuthCredential,
  type AuthStatus,
  type HarnessAuth,
  type HarnessAuthOptions,
  type LoginMethod,
  type PendingLogin,
} from "../auth.ts";
import { CLAUDE_BACKEND } from "../claude-store.ts";

/** Dashboard-created token. `.credentials` in the name keeps it out of the Storage browser. */
export const TOKEN_FILE = join(".claude", "atlas-token.credentials.json");
const CREDENTIALS_FILE = join(".claude", ".credentials.json");
const TOKEN_TTL_DAYS = 365;
const TOKEN_RE = /sk-ant-oat\d\d-[A-Za-z0-9_-]{20,}/;
const URL_RE = /https:\/\/\S+\/oauth\/authorize\?\S+/;
const ERROR_RE = /(?:OAuth error|Login failed|Error)[:\s]+([^\r\n]+)/i;
/** Codes from the sign-in page are printable ASCII without spaces (`<code>#<state>`). */
const CODE_RE = /^[\x21-\x7e]{8,2048}$/;
const URL_WAIT_MS = 30_000;
const EXCHANGE_WAIT_MS = 90_000;
const LOGIN_TTL_MS = 10 * 60_000;

const METHODS: LoginMethod[] = [
  {
    id: "token",
    label: "Long-lived token",
    description: "A token for your Claude subscription that is valid for one year (claude setup-token). Atlas shows when it runs out.",
    recommended: true,
  },
  {
    id: "subscription",
    label: "Subscription login",
    description: "The regular Claude login (claude auth login). It renews itself while in use, but has no known end date.",
    recommended: false,
  },
];

const COMMANDS: Record<string, string[]> = {
  token: ["setup-token"],
  subscription: ["auth", "login", "--claudeai"],
};

export interface StoredToken {
  token: string;
  createdAt: string;
  expiresAt: string;
}

/** The dashboard-created token, or null. */
export function readStoredToken(home: string): StoredToken | null {
  try {
    const data = JSON.parse(readFileSync(join(home, TOKEN_FILE), "utf8")) as StoredToken;
    return typeof data.token === "string" && data.token ? data : null;
  } catch {
    return null;
  }
}

function writeStoredToken(home: string, token: string, now = new Date()): void {
  const file = join(home, TOKEN_FILE);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const data: StoredToken = {
    token,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_DAYS * 86_400_000).toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function removeStoredToken(home: string): void {
  try {
    unlinkSync(join(home, TOKEN_FILE));
  } catch {}
}

function readJson(file: string): Record<string, any> | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Terminal output as plain text: no escape sequences, no hyperlink wrappers. */
export function plainText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[78=>cDEHM]/g, "");
}

interface LoginProcess {
  pending: PendingLogin;
  proc: Subprocess;
  output: string;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The login waiting for its code. Module state: the web UI is one process, and
 * every ClaudeAuth instance (one per request) must see the same login.
 */
let current: LoginProcess | null = null;

function stop(login: LoginProcess): void {
  clearTimeout(login.timer);
  try {
    login.proc.kill();
  } catch {}
  try {
    login.proc.terminal?.close();
  } catch {}
  if (current === login) current = null;
}

export class ClaudeAuth implements HarnessAuth {
  readonly backend = CLAUDE_BACKEND;
  private readonly home: string;
  private readonly command: string[];

  constructor(private readonly options: HarnessAuthOptions & { home: string }) {
    this.home = options.home;
    this.command = options.command ?? ["claude"];
  }

  status(now = Date.now()): AuthStatus {
    const env = process.env;
    const stored = readStoredToken(this.home);
    const credentialsFile = join(this.home, CREDENTIALS_FILE);
    const login = readJson(credentialsFile)?.claudeAiOauth as Record<string, unknown> | undefined;
    const hasLogin = typeof login?.refreshToken === "string" || typeof login?.accessToken === "string";

    let credential: AuthCredential | null = null;
    let expiresAt: string | null = null;
    /** When the credential in use was set up; older failures are stale. */
    let since: number | null = null;
    let override: string | null = null;
    if (env.ANTHROPIC_API_KEY) {
      credential = { kind: "api-key", source: "env", label: "API key (ANTHROPIC_API_KEY)" };
      override = "ANTHROPIC_API_KEY is set in the container environment. Claude Code uses it before any login made here.";
    } else if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      credential = { kind: "token", source: "env", label: "OAuth token (CLAUDE_CODE_OAUTH_TOKEN)" };
      override = "CLAUDE_CODE_OAUTH_TOKEN is set in the container environment. Claude Code uses it before any login made here.";
    } else if (stored) {
      credential = { kind: "token", source: "dashboard", label: "Long-lived token" };
      expiresAt = stored.expiresAt;
      since = Date.parse(stored.createdAt);
    } else if (hasLogin) {
      credential = { kind: "subscription", source: "login", label: "Subscription login" };
      since = mtime(credentialsFile);
    }

    const recorded = this.options.db ? readAuthFailure(this.options.db, this.backend) : null;
    const failure = recorded && (since === null || Date.parse(recorded.at) > since) ? recorded : null;
    const state = authState({ hasCredential: credential !== null, expiresAt, failure }, now);

    const account = readJson(join(this.home, ".claude.json"))?.oauthAccount as Record<string, unknown> | undefined;
    const plan = typeof login?.subscriptionType === "string" ? login.subscriptionType : null;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);

    return {
      backend: this.backend,
      state,
      summary: summarize(state, credential, expiresAt, now),
      credential,
      // ~/.claude.json describes the account of the regular login only.
      account: credential?.kind === "subscription" ? { email: str(account?.emailAddress), organization: str(account?.organizationName), plan } : null,
      expiresAt,
      failure: failure ? { at: failure.at, message: failure.message } : null,
      override,
      methods: METHODS,
      pending: current && current.proc.exitCode === null && current.proc.signalCode === null ? current.pending : null,
    };
  }

  async startLogin(method: string): Promise<PendingLogin> {
    const args = COMMANDS[method];
    if (!args) throw new AuthLoginError("rejected", `Unknown login method: ${method}`);
    if (current) stop(current);

    let proc: Subprocess;
    const login = { output: "", busy: false } as LoginProcess;
    try {
      proc = Bun.spawn([...this.command, "--ax-screen-reader", ...args], {
        cwd: this.home,
        env: { ...process.env, HOME: this.home, BROWSER: "true" },
        terminal: {
          cols: 4000,
          rows: 50,
          data: (_t, chunk) => {
            login.output += new TextDecoder().decode(chunk);
          },
        },
      });
    } catch (err) {
      throw new AuthLoginError("unavailable", `Could not start the Claude CLI: ${err instanceof Error ? err.message : String(err)}`);
    }
    login.proc = proc;

    const url = await waitFor(login, URL_WAIT_MS, (text) => text.match(URL_RE)?.[0] ?? null);
    if (!url) {
      const why = plainText(login.output).match(ERROR_RE)?.[1]?.trim();
      stop(login);
      throw new AuthLoginError("unavailable", why ? `The Claude CLI did not start a login: ${why}` : "The Claude CLI did not show a sign-in URL.");
    }

    const now = Date.now();
    login.pending = {
      id: randomUUID(),
      method,
      url,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LOGIN_TTL_MS).toISOString(),
    };
    login.timer = setTimeout(() => stop(login), LOGIN_TTL_MS);
    current = login;
    return login.pending;
  }

  async completeLogin(id: string, code: string): Promise<AuthStatus> {
    const login = current;
    if (!login || login.pending.id !== id) throw new AuthLoginError("not-found", "This login is no longer waiting. Start it again.");
    if (login.busy) throw new AuthLoginError("rejected", "The code is already being checked.");
    const trimmed = code.trim();
    if (!CODE_RE.test(trimmed)) throw new AuthLoginError("rejected", "That does not look like a code from the sign-in page.");

    login.busy = true;
    try {
      const mark = login.output.length;
      login.proc.terminal!.write(trimmed);
      await Bun.sleep(150);
      login.proc.terminal!.write("\r");

      const method = login.pending.method;
      const result = await waitFor<{ token?: string; error?: string }>(
        login,
        EXCHANGE_WAIT_MS,
        (text) => {
          const token = method === "token" ? text.match(TOKEN_RE)?.[0] : undefined;
          if (token) return { token };
          const error = text.match(ERROR_RE)?.[1]?.trim();
          return error ? { error } : null;
        },
        mark,
      );

      if (result?.token) {
        writeStoredToken(this.home, result.token);
      } else if (method === "subscription" && !result?.error && login.proc.exitCode === 0) {
        // A dashboard token would keep taking precedence over the new login.
        removeStoredToken(this.home);
      } else {
        const exited = login.proc.exitCode !== null || login.proc.signalCode !== null;
        const why = result?.error ?? (exited ? "the Claude CLI ended without finishing the login" : "no answer from the Claude CLI");
        throw new AuthLoginError("rejected", `Login failed: ${why.replace(/\s*Press Enter to retry\.?$/i, "")}`);
      }
      if (this.options.db) clearAuthFailure(this.options.db);
    } finally {
      stop(login);
    }
    return this.status();
  }

  cancelLogin(id: string): void {
    if (current?.pending.id === id) stop(current);
  }

  removeDashboardCredential(): void {
    removeStoredToken(this.home);
  }
}

/**
 * Poll the login's output (from `from`) until `match` finds something, the
 * process exits, or `ms` pass. Returns the match, or null.
 */
async function waitFor<T>(login: LoginProcess, ms: number, match: (text: string) => T | null, from = 0): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = match(plainText(login.output.slice(from)));
    if (found) return found;
    if (login.proc.exitCode !== null || login.proc.signalCode !== null) {
      // Output can arrive just after exit.
      await Bun.sleep(100);
      return match(plainText(login.output.slice(from)));
    }
    await Bun.sleep(100);
  }
  return null;
}

function summarize(state: AuthStatus["state"], credential: AuthCredential | null, expiresAt: string | null, now: number): string {
  const days = expiresAt ? Math.ceil((Date.parse(expiresAt) - now) / 86_400_000) : null;
  switch (state) {
    case "missing":
      return "Not logged in";
    case "expired":
      return "Login expired";
    case "failed":
      return "Login rejected";
    case "expiring":
      return `Login expires in ${days} ${days === 1 ? "day" : "days"}`;
    case "ok":
      if (days !== null) return `Logged in, ${days} days left`;
      return credential ? `Logged in (${credential.label})` : "Logged in";
  }
}
