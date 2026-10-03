import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Exercise DB lookup, CLI defaults, overrides and the model passed to the SDK.
// Only the SDK query is replaced, so these never start a live agent.
const cases: Array<{
  name: string;
  type?: string;
  modelKey?: string | null;
  cron?: string;
  models?: Record<string, string>;
  expected: string;
}> = [
  { name: "DB cron uses models.cron without ATLAS_CRON", type: "cron", expected: "cron-model" },
  { name: "DB webhook keeps models.trigger", type: "webhook", expected: "trigger-model" },
  { name: "DB manual keeps models.trigger", type: "manual", expected: "trigger-model" },
  { name: "empty model_key falls back to the cron model", type: "cron", modelKey: "", expected: "cron-model" },
  { name: "blank model_key falls back to the cron model", type: "cron", modelKey: "  ", expected: "cron-model" },
  { name: "custom model_key overrides the cron model", type: "cron", modelKey: " custom ", expected: "custom-model" },
  { name: "dreaming keeps its explicit model", type: "cron", modelKey: "dreaming", expected: "dreaming-model" },
  { name: "explicit model_key overrides ATLAS_CRON", type: "cron", modelKey: "trigger", cron: "1", expected: "trigger-model" },
  { name: "direct defaults to models.trigger", expected: "trigger-model" },
  { name: "legacy direct cron uses models.cron", cron: "1", expected: "cron-model" },
  { name: "ATLAS_CRON=0 does not select the cron model", cron: "0", expected: "trigger-model" },
  { name: "direct --model-key overrides ATLAS_CRON", cron: "1", modelKey: "custom", expected: "custom-model" },
  { name: "DB cron with an empty model uses models.trigger", type: "cron", models: { cron: "" }, expected: "trigger-model" },
  { name: "direct cron with a whitespace model uses models.trigger", cron: "1", models: { cron: " \t" }, expected: "trigger-model" },
];

for (const scenario of cases) {
  test(scenario.name, () => {
    const home = mkdtempSync(join(tmpdir(), "atlas-model-"));
    try {
      writeFileSync(join(home, "config.yml"), JSON.stringify({
        models: { trigger: "trigger-model", cron: "cron-model", custom: "custom-model", dreaming: "dreaming-model", ...scenario.models },
      }));
      const driver = join(home, "driver.ts");
      writeFileSync(driver, `
import { getDb } from ${JSON.stringify(join(import.meta.dir, "../../lib/atlas-db.ts"))};
import { main, runnerDeps } from ${JSON.stringify(join(import.meta.dir, "../trigger-runner.ts"))};
import { ClaudeCodeBackend } from ${JSON.stringify(join(import.meta.dir, "claude/backend.ts"))};
const scenario = ${JSON.stringify(scenario)};
const db = getDb();
if (scenario.type) {
  db.prepare("INSERT INTO triggers (name, type, prompt, model_key) VALUES ('model-check', ?, '{{payload}}', ?)")
    .run(scenario.type, scenario.modelKey ?? null);
}
const models: string[] = [];
const query = ((request) => {
  models.push(request.options.model);
  async function* events() {
    await request.prompt[Symbol.asyncIterator]().next();
    yield {type: "system", subtype: "init", session_id: "model-session"};
    yield {type: "result", subtype: "success", session_id: "model-session", num_turns: 1, result: "done"};
  }
  return Object.assign(events(), {close() {}, async interrupt() {}});
}) as any;
runnerDeps.createBackend = () => new ClaudeCodeBackend({ query });
const args = scenario.type ? ["model-check", "hello"] : ["--direct", "hello"];
if (!scenario.type && scenario.modelKey) args.push("--model-key", scenario.modelKey);
process.argv = [process.argv[0], "trigger-runner.ts", ...args];
await main();
console.log("MODELS=" + JSON.stringify(models));
process.exit(0);
`);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      // Config/environment changes stay inside the child process.
      for (const key of Object.keys(env)) {
        if (key.startsWith("ATLAS_")) delete env[key];
      }
      if (scenario.cron !== undefined) env.ATLAS_CRON = scenario.cron;
      const result = Bun.spawnSync([process.execPath, driver], {
        env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
      expect(result.stdout.toString()).toContain(`MODELS=${JSON.stringify([scenario.expected])}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
}
