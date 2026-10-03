/**
 * Claude login handling against a fake CLI: a bash script that prints what
 * `claude --ax-screen-reader setup-token` / `auth login` print, reads the code
 * from the terminal and answers like the real one.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuthLoginError, authState, clearAuthFailure, readAuthFailure, recordAuthFailure } from "../auth.ts";
import { createHarnessAuth } from "../stores.ts";
import { ClaudeAuth, plainText, readStoredToken, TOKEN_FILE } from "./auth.ts";

const FAKE_CLI = `#!/bin/bash
shift # --ax-screen-reader
echo "Browser didn't open? Use the url below to sign in"
url="https://claude.com/cai/oauth/authorize?code=true&state=s1"
printf '\\e]8;;%s\\a%s\\e]8;;\\a\\r\\n' "$url" "$url"
printf "Paste code here if prompted > "
read -r code
if [ "$code" != "good-code#s1" ]; then
  echo "OAuth error: Request failed with status code 400"
  echo "Press Enter to retry."
  read -r
  exit 1
fi
if [ "$1" = "setup-token" ]; then
  echo "Your OAuth token (valid for 1 year):"
  echo "sk-ant-oat01-FAKE_token-0123456789abcdefghij"
  sleep 5
  exit 0
fi
mkdir -p "$HOME/.claude"
echo '{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","subscriptionType":"max"}}' > "$HOME/.claude/.credentials.json"
echo "Login successful."
`;

const ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};

let home: string;
let db: Database;
let auth: ClaudeAuth;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), "atlas-claude-auth-"));
  const cli = join(home, "fake-claude");
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  db = new Database(":memory:");
  db.run("CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)");
  auth = new ClaudeAuth({ home, db, command: [cli] });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function writeToken(expiresInDays: number, createdDaysAgo = 1) {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(home, TOKEN_FILE),
    JSON.stringify({
      token: "sk-ant-oat01-stored",
      createdAt: new Date(now - createdDaysAgo * 86_400_000).toISOString(),
      expiresAt: new Date(now + expiresInDays * 86_400_000).toISOString(),
    }),
  );
}

describe("status", () => {
  test("no credential is missing", () => {
    const s = auth.status();
    expect(s.state).toBe("missing");
    expect(s.credential).toBeNull();
    expect(s.methods.map((m) => m.id)).toEqual(["token", "subscription"]);
  });

  test("a dashboard token reports its end date; near the end it is expiring, after it expired", () => {
    writeToken(200);
    let s = auth.status();
    expect(s).toMatchObject({ state: "ok", credential: { kind: "token", source: "dashboard" } });
    expect(s.summary).toBe("Logged in, 200 days left");
    writeToken(10);
    s = auth.status();
    expect(s.state).toBe("expiring");
    expect(s.summary).toBe("Login expires in 10 days");
    writeToken(-1, 366);
    expect(auth.status().state).toBe("expired");
  });

  test("a failure after the credential was set up fails it; an older one is stale", () => {
    writeToken(200, 1);
    recordAuthFailure(db, "claude-code", "Invalid API key · Please run /login", new Date(Date.now() - 2 * 86_400_000));
    expect(auth.status().state).toBe("ok");
    recordAuthFailure(db, "claude-code", "OAuth token has expired");
    const s = auth.status();
    expect(s.state).toBe("failed");
    expect(s.failure?.message).toBe("OAuth token has expired");
    clearAuthFailure(db);
    expect(auth.status().state).toBe("ok");
  });

  test("failures of another backend are ignored", () => {
    writeToken(200);
    recordAuthFailure(db, "other", "nope");
    expect(readAuthFailure(db, "claude-code")).toBeNull();
    expect(auth.status().state).toBe("ok");
  });

  test("container env credentials take precedence and are reported as override", () => {
    writeToken(200);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-env";
    let s = auth.status();
    expect(s.credential).toMatchObject({ kind: "token", source: "env" });
    expect(s.expiresAt).toBeNull();
    expect(s.override).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    process.env.ANTHROPIC_API_KEY = "sk-ant-api";
    s = auth.status();
    expect(s.credential).toMatchObject({ kind: "api-key", source: "env" });
    expect(s.override).toContain("ANTHROPIC_API_KEY");
  });

  test("the subscription login shows the account", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshToken: "r", subscriptionType: "max" } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c", organizationName: "Org" } }));
    const s = auth.status();
    expect(s).toMatchObject({ state: "ok", credential: { kind: "subscription" }, expiresAt: null });
    expect(s.account).toEqual({ email: "a@b.c", organization: "Org", plan: "max" });
  });
});

describe("login", () => {
  test("token: start shows the URL, the code yields a stored 1-year token", async () => {
    const pending = await auth.startLogin("token");
    expect(pending.url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=s1");
    expect(auth.status().pending?.id).toBe(pending.id);

    const s = await auth.completeLogin(pending.id, "  good-code#s1\n");
    expect(s).toMatchObject({ state: "ok", credential: { kind: "token", source: "dashboard" }, pending: null });
    const stored = readStoredToken(home)!;
    expect(stored.token).toBe("sk-ant-oat01-FAKE_token-0123456789abcdefghij");
    expect(Math.round((Date.parse(stored.expiresAt) - Date.parse(stored.createdAt)) / 86_400_000)).toBe(365);
    expect(statSync(join(home, TOKEN_FILE)).mode & 0o777).toBe(0o600);
    // The status never carries the token itself.
    expect(JSON.stringify(s)).not.toContain("FAKE_token");
  });

  test("a rejected code reports the CLI's error and ends the login", async () => {
    const pending = await auth.startLogin("token");
    const err = await auth.completeLogin(pending.id, "bad-code#s1").catch((e) => e);
    expect(err).toBeInstanceOf(AuthLoginError);
    expect(err.kind).toBe("rejected");
    expect(err.message).toBe("Login failed: Request failed with status code 400");
    expect(auth.status().pending).toBeNull();
    expect(readStoredToken(home)).toBeNull();
    await expect(auth.completeLogin(pending.id, "good-code#s1")).rejects.toMatchObject({ kind: "not-found" });
  });

  test("subscription login replaces a dashboard token and clears a recorded failure", async () => {
    writeToken(200);
    recordAuthFailure(db, "claude-code", "OAuth token has expired");
    const pending = await auth.startLogin("subscription");
    const s = await auth.completeLogin(pending.id, "good-code#s1");
    expect(s).toMatchObject({ state: "ok", credential: { kind: "subscription" }, failure: null });
    expect(existsSync(join(home, TOKEN_FILE))).toBe(false);
    expect(readAuthFailure(db, "claude-code")).toBeNull();
  });

  test("starting again replaces the waiting login; cancel ends it", async () => {
    const first = await auth.startLogin("token");
    const second = await auth.startLogin("subscription");
    await expect(auth.completeLogin(first.id, "good-code#s1")).rejects.toMatchObject({ kind: "not-found" });
    auth.cancelLogin(second.id);
    expect(auth.status().pending).toBeNull();
  });

  test("input checks: unknown method, malformed code", async () => {
    await expect(auth.startLogin("password")).rejects.toMatchObject({ kind: "rejected" });
    const pending = await auth.startLogin("token");
    await expect(auth.completeLogin(pending.id, "has space")).rejects.toMatchObject({ kind: "rejected" });
    auth.cancelLogin(pending.id);
  });

  test("removeDashboardCredential deletes only the dashboard token", () => {
    writeToken(200);
    auth.removeDashboardCredential();
    expect(readStoredToken(home)).toBeNull();
  });
});

describe("helpers", () => {
  test("authState precedence: missing, expired, failed, expiring, ok", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const f = { backend: "x", at: "2026-01-01T00:00:00Z", message: "m" };
    expect(authState({ hasCredential: false, expiresAt: null, failure: f }, now)).toBe("missing");
    expect(authState({ hasCredential: true, expiresAt: "2025-12-31T00:00:00Z", failure: f }, now)).toBe("expired");
    expect(authState({ hasCredential: true, expiresAt: "2026-01-05T00:00:00Z", failure: f }, now)).toBe("failed");
    expect(authState({ hasCredential: true, expiresAt: "2026-01-05T00:00:00Z", failure: null }, now)).toBe("expiring");
    expect(authState({ hasCredential: true, expiresAt: null, failure: null }, now)).toBe("ok");
  });

  test("plainText drops escape sequences and hyperlink wrappers", () => {
    expect(plainText("\x1b7\x1b[?25hA\x1b]8;;https://x\x07https://x\x1b]8;;\x07 \x1b[30Gb")).toBe("Ahttps://x b");
  });

  test("createHarnessAuth: Claude by default, null for backends without login handling", () => {
    expect(createHarnessAuth({ home, backend: "claude-code" })?.backend).toBe("claude-code");
    expect(createHarnessAuth({ home, backend: "unknown" })).toBeNull();
  });
});
