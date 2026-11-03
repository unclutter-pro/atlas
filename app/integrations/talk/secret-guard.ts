import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Apply to the complete body and thread title before persisting any outbound work. */
export function assertNoSecrets(text: string, password: string, home = process.env.HOME ?? ""): void {
  const values = new Set<string>();
  if (password) values.add(password);
  const dir = join(home, "secrets");
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 65_536) continue;
      const raw = readFileSync(path, "utf8").trim();
      if (raw.length >= 8) values.add(raw);
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") throw new Error("Cannot inspect configured secret files before sending");
  }
  for (const value of values) {
    if (text.includes(value)) throw new Error("Outgoing Talk content contains a stored credential; send rejected");
  }
}
