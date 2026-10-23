/** Strips quoted string contents and heredoc bodies so command-advice.sh only matches real command text. */
export function stripQuoted(cmd: string): string {
  const lines = cmd.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    kept.push(line);
    const heredoc = line.match(/<<(-?)\s*(['"]?)(\w+)\2/);
    i++;
    if (!heredoc) continue;
    const stripTabs = heredoc[1] === "-";
    const terminator = heredoc[3];
    while (i < lines.length) {
      const body = stripTabs ? lines[i].replace(/^\t+/, "") : lines[i];
      i++;
      if (body === terminator) break;
    }
  }

  const joined = kept.join("\n");
  let out = "";
  let quote: string | null = null;
  for (let j = 0; j < joined.length; j++) {
    const c = joined[j];
    if (quote === null) {
      out += c;
      if (c === "'" || c === '"') quote = c;
      continue;
    }
    if (quote === '"' && c === "\\" && j + 1 < joined.length) {
      j++;
      continue;
    }
    if (c === quote) {
      out += c;
      quote = null;
    }
  }
  return out;
}

if (import.meta.main) process.stdout.write(stripQuoted(await Bun.stdin.text()));
