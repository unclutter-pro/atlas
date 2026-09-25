/**
 * Tests for /ui/api/settings/*. Files are written to a throwaway HOME created
 * here (paths resolve from $HOME per call), so even a run against a real HOME
 * never touches its config, personality files or secrets. The integrations
 * endpoint only reads the DB of the HOME the test run started with.
 */

import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDb } from "./shared/env";
import { routes, type ConfigurationResponse, type IntegrationsResponse, type PersonalityResponse, type SecretsResponse } from "./settings";
import { validateConfigYaml } from "./settings/validate";

let server: ReturnType<typeof Bun.serve>;
let H: string;
const originalHome = process.env.HOME;
// Host processes (this very agent's own runtime) may set the legacy
// ATLAS_AGENT_NAME alias AGENT_NAME. Left in place, it outranks config.yml
// in resolveConfig()'s env layer (lib/config.ts) and breaks the "file" source
// assertion below regardless of what CONFIG says. Isolate it like HOME.
const originalAgentName = process.env.AGENT_NAME;
const originalAtlasAgentName = process.env.ATLAS_AGENT_NAME;

const url = (p: string) => new URL(`/ui/api/settings${p}`, server.url);
const get = async <T>(p: string) => {
  const res = await fetch(url(p));
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};
const send = (method: string, p: string, body: unknown = {}) =>
  fetch(url(p), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const CONFIG = `agent:
  name: "Testy"
models:
  cron: sonnet
signal:
  number: "+491700000000"
`;

beforeAll(() => {
  getDb(); // open the run's DB before HOME moves (DB_PATH is fixed at import)
  H = mkdtempSync(join(tmpdir(), "atlas-settings-test-"));
  process.env.HOME = H;
  delete process.env.AGENT_NAME;
  delete process.env.ATLAS_AGENT_NAME;
  mkdirSync(join(H, "secrets"));
  writeFileSync(join(H, "config.yml"), CONFIG);
  writeFileSync(join(H, ".atlas-runtime-config.json"), JSON.stringify({ models: { cron: "haiku" } }));
  writeFileSync(join(H, "IDENTITY.md"), "# Identity\n");
  writeFileSync(join(H, "user-extensions.sh"), "#!/bin/bash\necho hi\n");
  writeFileSync(join(H, "secrets", "email-password"), "pw\n");
  server = Bun.serve({ port: 0, routes: routes as any, fetch: () => new Response("Not found", { status: 404 }) });
});

afterAll(() => {
  server.stop(true);
  process.env.HOME = originalHome;
  if (originalAgentName === undefined) delete process.env.AGENT_NAME;
  else process.env.AGENT_NAME = originalAgentName;
  if (originalAtlasAgentName === undefined) delete process.env.ATLAS_AGENT_NAME;
  else process.env.ATLAS_AGENT_NAME = originalAtlasAgentName;
  rmSync(H, { recursive: true, force: true });
});

describe("personality", () => {
  test("GET returns both files; a missing file is reported, not an error", async () => {
    const data = await get<PersonalityResponse>("/personality");
    expect(data.identity).toMatchObject({ path: "~/IDENTITY.md", exists: true, content: "# Identity\n" });
    expect(typeof data.identity.version).toBe("number");
    expect(data.soul).toMatchObject({ exists: false, content: "", version: null });
  });

  test("PUT saves with the loaded version and rejects stale versions", async () => {
    const { identity } = await get<PersonalityResponse>("/personality");
    const ok = await send("PUT", "/personality/identity", { content: "# New\n", version: identity.version });
    expect(ok.status).toBe(200);
    expect(readFileSync(join(H, "IDENTITY.md"), "utf-8")).toBe("# New\n");

    const stale = await send("PUT", "/personality/identity", { content: "# Other\n", version: identity.version! - 1000 });
    expect(stale.status).toBe(409);
    expect(readFileSync(join(H, "IDENTITY.md"), "utf-8")).toBe("# New\n");
  });

  test("PUT creates a missing file (version null)", async () => {
    expect((await send("PUT", "/personality/soul", { content: "be kind", version: null })).status).toBe(200);
    expect(readFileSync(join(H, "SOUL.md"), "utf-8")).toBe("be kind");
  });

  test("errors: unknown file, missing content, wrong content type", async () => {
    expect((await send("PUT", "/personality/passwd", { content: "x" })).status).toBe(400);
    expect((await send("PUT", "/personality/identity", {})).status).toBe(400);
    const form = await fetch(url("/personality/identity"), { method: "PUT", body: "content=x" });
    expect(form.status).toBe(415);
  });
});

describe("configuration", () => {
  test("GET resolves values with their source and flags runtime overrides", async () => {
    const data = await get<ConfigurationResponse>("/configuration");
    const byKey = new Map(data.entries.map((e) => [e.key, e]));
    expect(byKey.get("agent.name")).toMatchObject({ value: "Testy", source: "file" });
    expect(byKey.get("models.cron")).toMatchObject({ value: "haiku", source: "runtime", fileValue: "sonnet" });
    expect(byKey.get("models.main")).toMatchObject({ source: "default" });
    expect(byKey.get("email.password_file")?.value).toBe("***");
    expect(data.runtime).toMatchObject({ exists: true, keys: ["models.cron"], error: null });
    expect(data.validation).toEqual({ syntaxError: null, issues: [] });
    expect(data.file.content).toBe(CONFIG);
  });

  test("PUT rejects invalid YAML without touching the file", async () => {
    const res = await send("PUT", "/configuration", { content: "agent:\n  name: [oops\n" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; validation: { syntaxError: { line: number } } };
    expect(body.error).toContain("Invalid YAML");
    expect(body.validation.syntaxError.line).toBeGreaterThan(0);
    expect(readFileSync(join(H, "config.yml"), "utf-8")).toBe(CONFIG);
  });

  test("PUT with type errors needs force", async () => {
    const content = "signal:\n  number: +4917000\n";
    expect((await send("PUT", "/configuration", { content })).status).toBe(422);
    expect(readFileSync(join(H, "config.yml"), "utf-8")).toBe(CONFIG);
    const forced = await send("PUT", "/configuration", { content, force: true });
    expect(forced.status).toBe(200);
    expect(readFileSync(join(H, "config.yml"), "utf-8")).toBe(content);
  });

  test("PUT saves valid YAML; container side effects are skipped under test", async () => {
    const res = await send("PUT", "/configuration", { content: CONFIG });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: { harnessSettings: boolean; crontab: boolean } };
    expect(body.ok).toBe(true);
    expect(body.applied).toEqual({ harnessSettings: false, crontab: false });
    expect(readFileSync(join(H, "config.yml"), "utf-8")).toBe(CONFIG);
  });

  test("POST validate reports without saving", async () => {
    const res = await send("POST", "/configuration/validate", { content: "models: opus\nbogus: 1\n" });
    expect(res.status).toBe(200);
    const v = (await res.json()) as ReturnType<typeof validateConfigYaml>;
    expect(v.issues.map((i) => [i.path, i.severity])).toEqual([
      ["models", "error"],
      ["bogus", "warning"],
    ]);
  });
});

describe("validateConfigYaml", () => {
  test("accepts empty files and comment-only sections", () => {
    expect(validateConfigYaml("")).toEqual({ syntaxError: null, issues: [] });
    expect(validateConfigYaml("team:\n  # nothing\n").issues).toEqual([]);
  });

  test("rejects a non-mapping top level", () => {
    expect(validateConfigYaml("- a\n- b\n").syntaxError).not.toBeNull();
  });

  test("flags unquoted numbers in string lists and wrong plugin values", () => {
    const v = validateConfigYaml("signal:\n  whitelist: [+4917012345]\nplugins:\n  enabled:\n    foo@bar: yes-please\n");
    expect(v.issues.map((i) => i.path)).toEqual(["signal.whitelist", "plugins.enabled.foo@bar"]);
  });

  test("accepts a top-level `timezone` string like other scalar keys", () => {
    expect(validateConfigYaml("timezone: Europe/Berlin\n").issues).toEqual([]);
  });

  test("flags a non-string `timezone` instead of demanding a mapping", () => {
    const v = validateConfigYaml("timezone:\n  foo: bar\n");
    expect(v.issues).toEqual([{ path: "timezone", severity: "error", message: "Expected a string, got a mapping." }]);
  });
});

describe("secrets", () => {
  test("GET lists names and mtimes, never values", async () => {
    const res = await fetch(url("/secrets"));
    const text = await res.text();
    expect(text).not.toContain("pw");
    const data = JSON.parse(text) as SecretsResponse;
    expect(data.items.map((s) => s.name)).toEqual(["email-password"]);
    expect(data.items[0]!.usedBy).toEqual(["email.password_file"]);
  });

  test("PUT creates (201) then replaces (200) with mode 0600; response has no value", async () => {
    const created = await send("PUT", "/secrets/api-token", { value: "s3cret" });
    expect(created.status).toBe(201);
    const text = await created.text();
    expect(text).not.toContain("s3cret");
    const file = join(H, "secrets", "api-token");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const replaced = await send("PUT", "/secrets/api-token", { value: "n3w" });
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as { created: boolean }).created).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe("n3w");
  });

  test("rejects bad names and empty values", async () => {
    for (const name of ["..x", "a..b", ".env", "a%2F..%2Fb", "has%20space"]) {
      expect((await send("PUT", `/secrets/${name}`, { value: "x" })).status).toBe(400);
    }
    expect((await send("PUT", "/secrets/ok", { value: "" })).status).toBe(400);
    expect((await send("PUT", "/secrets/ok", {})).status).toBe(400);
    expect(existsSync(join(H, "secrets", "ok"))).toBe(false);
  });

  test("DELETE removes; unknown is 404; requires JSON", async () => {
    expect((await fetch(url("/secrets/api-token"), { method: "DELETE" })).status).toBe(415);
    expect((await send("DELETE", "/secrets/api-token")).status).toBe(200);
    expect(existsSync(join(H, "secrets", "api-token"))).toBe(false);
    expect((await send("DELETE", "/secrets/api-token")).status).toBe(404);
  });
});

describe("extensions", () => {
  test("GET returns the script", async () => {
    const data = await get<{ file: { content: string; path: string } }>("/extensions");
    expect(data.file).toMatchObject({ path: "~/user-extensions.sh", content: "#!/bin/bash\necho hi\n" });
  });

  test("PUT runs a bash syntax check; force saves anyway", async () => {
    const broken = "if true; then\necho x\n";
    const res = await send("PUT", "/extensions", { content: broken });
    if (res.status === 200) return; // bash unavailable: check skipped
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { line?: number }[] };
    expect(body.issues.length).toBeGreaterThan(0);
    expect((await send("PUT", "/extensions", { content: broken, force: true })).status).toBe(200);
    expect(readFileSync(join(H, "user-extensions.sh"), "utf-8")).toBe(broken);
  });

  test("PUT keeps the file mode", async () => {
    const file = join(H, "user-extensions.sh");
    Bun.spawnSync(["chmod", "755", file]);
    expect((await send("PUT", "/extensions", { content: "echo ok\n" })).status).toBe(200);
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });
});

describe("integrations", () => {
  test("GET lists every integration with its config keys and sources", async () => {
    const data = await get<IntegrationsResponse>("/integrations");
    expect(data.integrations.map((i) => i.key)).toEqual(["signal", "email", "whatsapp", "telegram", "web"]);
    const signal = data.integrations.find((i) => i.key === "signal")!;
    expect(signal.configured).toBe(true);
    expect(signal.settings.find((s) => s.key === "signal.number")).toMatchObject({ value: "+491700000000", source: "file" });
    const email = data.integrations.find((i) => i.key === "email")!;
    expect(email).toMatchObject({ configured: false, state: "not_configured" });
    // password_file is reported as set/not set, never as a path
    expect(email.settings.find((s) => s.key === "email.password_file")).toMatchObject({ secret: true });
    expect(data.services.length).toBeGreaterThan(0);
  });
});
