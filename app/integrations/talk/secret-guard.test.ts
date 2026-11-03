import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoSecrets } from "./secret-guard.ts";

test("guard protects titles and secrets mounted through symlinks", () => {
  const home = mkdtempSync(join(tmpdir(), "talk-secret-test-"));
  try {
    mkdirSync(join(home, "secrets"));
    const mounted = join(home, "mounted-password"); writeFileSync(mounted, "fictional-mounted-credential\n");
    symlinkSync(mounted, join(home, "secrets/service-password"));
    expect(() => assertNoSecrets("Thread fictional-mounted-credential\nInnocent body", "another-test-password", home)).toThrow("stored credential");
    expect(() => assertNoSecrets("A harmless message", "another-test-password", home)).not.toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
