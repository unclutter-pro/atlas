/** Code, JSON and markdown-ish text views. */

import type { ReactNode } from "react";
import { CopyButton } from "./Button";

/** Pretty-print JSON strings; anything else is returned unchanged. */
export function prettyJson(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  const t = value.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return value;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return value;
  }
}

export function CodeBlock(props: {
  code: string;
  /** Small header label, e.g. "Payload" or a file name. */
  label?: ReactNode;
  /** Show a Copy button in the header. */
  copy?: boolean;
  /** Wrap long lines (default true). */
  wrap?: boolean;
  maxHeight?: number | string;
}) {
  const showHeader = props.label || props.copy;
  return (
    <div className={`code-block${props.wrap === false ? " nowrap" : ""}`}>
      {showHeader && (
        <div className="code-block-label">
          {props.label}
          {props.copy && <CopyButton text={props.code} className="code-block-copy" />}
        </div>
      )}
      <pre style={props.maxHeight != null ? { maxHeight: props.maxHeight } : undefined}>{props.code}</pre>
    </div>
  );
}

/** Plain preformatted text (wrapped). */
export function TextView(props: { text: string; className?: string }) {
  return (
    <div className={`code-block ${props.className ?? ""}`}>
      <pre>{props.text}</pre>
    </div>
  );
}

// --- Markdown-ish renderer -------------------------------------------------
// Headings, lists, quotes, fences, hr, paragraphs; inline code, bold,
// italics, links. Enough for MEMORY.md / journals; React escapes all text.

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const safe = /^(https?:|mailto:|\/|#)/.test(href!) ? href : undefined;
      out.push(
        <a key={key} href={safe} target={safe?.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
          {label}
        </a>,
      );
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownView(props: { text: string; className?: string }) {
  const lines = props.text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${k++}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key}>{body.join("\n")}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const Tag = `h${h[1]!.length}` as "h1";
      blocks.push(<Tag key={key}>{inline(h[2]!, key)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
        // continuation lines (indented, non-list)
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) {
          items[items.length - 1] += " " + lines[i]!.trim();
          i++;
        }
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${key}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(quote.join(" "), key)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [lines[i++]!];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4}\s|>|\s*([-*+]|\d+\.)\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return <div className={`prose ${props.className ?? ""}`}>{blocks}</div>;
}
