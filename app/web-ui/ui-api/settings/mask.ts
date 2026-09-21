/**
 * Inline secrets in config.yml (telegram.bot_token, usage_reporting.webhook_secret, …)
 * never reach the browser: GET replaces their values with PLACEHOLDER, PUT puts
 * the original values back wherever the placeholder is still in place.
 *
 * Line-based on purpose, so the user's formatting and comments survive the
 * round trip. Keys are tracked by indentation into dot paths.
 */

import { HttpError } from "../shared/http";
import { SECRET_PLACEHOLDER } from "./placeholder";

export { SECRET_PLACEHOLDER };

const SECRET_KEY = /^(.*_)?(secret|token|password|api_key|apikey)$/i;
const KEY_LINE = /^(\s*)([A-Za-z0-9_.-]+):([ \t]*)(.*)$/;

interface SecretLine {
  index: number;
  path: string;
  /** Raw value text after "key: " (may include a trailing comment). */
  value: string;
}

function secretLines(lines: string[]): SecretLine[] {
  const out: SecretLine[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  lines.forEach((line, index) => {
    const m = line.match(KEY_LINE);
    if (!m || line.trimStart().startsWith("#")) return;
    const indent = m[1]!.length;
    const key = m[2]!;
    const value = m[4]!;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const path = [...stack.map((s) => s.key), key].join(".");
    const bare = value.replace(/\s+#.*$/, "").trim();
    if (!bare) {
      stack.push({ indent, key });
      return;
    }
    // Only literal scalars; *_file keys point at secret files and are not secrets themselves.
    if (SECRET_KEY.test(key) && !/^[|>]/.test(bare) && bare !== '""' && bare !== "''") out.push({ index, path, value });
  });
  return out;
}

export function maskSecrets(content: string): string {
  const lines = content.split("\n");
  for (const s of secretLines(lines)) {
    const m = lines[s.index]!.match(KEY_LINE)!;
    lines[s.index] = `${m[1]}${m[2]}:${m[3] || " "}${SECRET_PLACEHOLDER}`;
  }
  return lines.join("\n");
}

/** Restore original secret values where the edited text still has the placeholder. */
export function unmaskSecrets(edited: string, original: string): string {
  if (!edited.includes(SECRET_PLACEHOLDER)) return edited;
  const originals = new Map(secretLines(original.split("\n")).map((s) => [s.path, s.value]));
  const lines = edited.split("\n");
  for (const s of secretLines(lines)) {
    if (s.value.trim() !== SECRET_PLACEHOLDER) continue;
    const value = originals.get(s.path);
    if (value === undefined) throw new HttpError(400, `${s.path}: no stored secret to keep — enter a value`);
    const m = lines[s.index]!.match(KEY_LINE)!;
    lines[s.index] = `${m[1]}${m[2]}:${m[3] || " "}${value}`;
  }
  return lines.join("\n");
}
