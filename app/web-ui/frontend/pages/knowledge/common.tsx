/** Small building blocks shared by the Knowledge pages. */

import type { MouseEvent, ReactNode } from "react";
import { MarkdownView } from "../../components";
import { links } from "../../links";
import { Link, navigate, usePathname } from "../../router";

export const API = "/ui/api/knowledge";

/** API URL for a file under ~/memory (segments encoded, slashes kept). */
export const fileApi = (path: string) => `${API}/file/${path.split("/").map(encodeURIComponent).join("/")}`;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local YYYY-MM-DD. Journals are named by the agent's local day. */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Monday, September 21, 2026" for a YYYY-MM-DD string. */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** Resolve a relative markdown link target against the directory of `fromPath`. */
function resolveRelative(fromPath: string, target: string): string | null {
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

/**
 * The shared MarkdownView drops relative hrefs. Memory files link to each
 * other with relative paths (`[jonas](entities/jonas.md)`), so rewrite those
 * into Knowledge URLs and route the clicks client-side.
 */
export function MemoryMarkdown(props: { text: string; path: string }) {
  const text = props.text.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return whole;
    const [file] = target.split("#");
    const resolved = resolveRelative(props.path, file!);
    if (!resolved) return whole;
    const date = resolved.match(/^(?:journal\/)?(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
    return `](${date ? links.journal(date) : links.memoryFile(resolved)})`;
  });

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!href || !href.startsWith("/") || a!.target || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };

  return (
    <div onClick={onClick}>
      <MarkdownView text={text} />
    </div>
  );
}

/** Text with [start, end) ranges wrapped in <mark>. */
export function Highlight(props: { text: string; ranges: Array<[number, number]> }) {
  const out: ReactNode[] = [];
  let last = 0;
  props.ranges.forEach(([s, e], i) => {
    if (s < last) return;
    if (s > last) out.push(props.text.slice(last, s));
    out.push(<mark key={i}>{props.text.slice(s, e)}</mark>);
    last = e;
  });
  if (last < props.text.length) out.push(props.text.slice(last));
  return <>{out}</>;
}

/** Memory | Journal switch shown on the Knowledge landing pages. */
export function KnowledgeNav() {
  const pathname = usePathname();
  const journal = pathname.startsWith("/knowledge/journal");
  return (
    <nav className="tabs">
      <Link href={links.knowledge()} className={`tab${journal ? "" : " active"}`}>
        Memory
      </Link>
      <Link href={links.journal()} className={`tab${journal ? " active" : ""}`}>
        Journal
      </Link>
    </nav>
  );
}
