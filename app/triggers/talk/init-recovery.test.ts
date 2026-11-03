import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("container boot leaves Talk receipt recovery to validated ingress and preserves other channel recovery", () => {
  const home = mkdtempSync(join(tmpdir(), "talk-init-"));
  try {
    mkdirSync(join(home, ".index"));
    const db = new Database(join(home, ".index/atlas.db"));
    db.exec(`CREATE TABLE triggers(name TEXT, channel TEXT);
      INSERT INTO triggers VALUES ('talk-worker','talk'),('github-worker','github'),('email-handler','email');
      CREATE TABLE trigger_delivery_receipts(trigger_name TEXT,session_key TEXT,state TEXT,event_id TEXT);
      INSERT INTO trigger_delivery_receipts VALUES ('github-worker','origin','accepted','talk:answer');`);
    db.close();
    const init = readFileSync(join(import.meta.dir, "../../init.sh"), "utf8");
    const source = init.match(/echo "\$INTERRUPTED" \| python3 -c "([\s\S]*?)" 2>\/dev\/null/)?.[1];
    expect(source).toBeTruthy();
    // Execute the actual recovery block with only process creation and log files stubbed.
    const driver = join(home, "boot.py");
    writeFileSync(driver, `import builtins, io, subprocess, json
original_open = builtins.open
builtins.open = lambda path, *args, **kwargs: io.StringIO() if str(path).startswith('/atlas/logs/') else original_open(path, *args, **kwargs)
subprocess.Popen = lambda args, **kwargs: print('SPAWN:' + json.dumps(args))
${source}`);
    const rows = ["talk-worker", "github-worker", "email-handler"].map((trigger_name, id) => ({ id, trigger_name, session_key: "origin", session_mode: "persistent", session_id: "native-session", payload: "stored event" }));
    const result = Bun.spawnSync(["python3", driver], { env: { ...process.env, HOME: home }, stdin: Buffer.from(JSON.stringify(rows)), stdout: "pipe", stderr: "pipe" });
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    const launches = result.stdout.toString().split("\n").filter(line => line.startsWith("SPAWN:")).map(line => JSON.parse(line.slice(6)));
    expect(launches).toHaveLength(1);
    expect(launches[0][1]).toBe("email-handler");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
