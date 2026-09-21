/**
 * Knowledge — "What does Atlas know and remember?"
 * MEMORY.md first, then file tree + search; journal as a date view.
 * Owned by the knowledge area. Server side: ui-api/knowledge.ts.
 */

import { useEffect, useState } from "react";
import { ApiError, apiPut, useApi } from "../../api";
import { ApiView, Button, ButtonLink, Card, EmptyState, NotFound, PageHeader, Section, TextField, Time, formatNumber, formatBytes } from "../../components";
import { links } from "../../links";
import { Link, Routes, navigate, useQueryParam, withQuery } from "../../router";
import type { KnowledgeOverviewResponse, MemoryFileResponse, SaveFileRequest, SearchResponse } from "../../../ui-api/knowledge";
import { API, Highlight, KnowledgeNav, MemoryMarkdown, fileApi, longDate } from "./common";
import { FileTree } from "./FileTree";
import { FileView } from "./FileView";
import { JournalPage } from "./Journal";
import "./knowledge.css";

export default function KnowledgePage() {
  return (
    <Routes
      routes={[
        { path: "/knowledge", component: KnowledgeHome },
        { path: "/knowledge/file/*", component: FileView },
        { path: "/knowledge/journal", component: JournalPage },
        { path: "/knowledge/journal/:date", component: JournalPage },
      ]}
      fallback={<NotFound />}
    />
  );
}

function KnowledgeHome() {
  const [q, setQ] = useQueryParam("q");
  const [input, setInput] = useState(q);
  const data = useApi<KnowledgeOverviewResponse>(API);

  // Typing updates ?q= after a short pause; back/forward updates the field.
  useEffect(() => setInput(q), [q]);
  useEffect(() => {
    if (input.trim() === q) return;
    const t = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input, q, setQ]);

  const d = data.data;
  const subtitle = d ? `${d.files.length + (d.memory ? 1 : 0)} memory files · ${d.journal.count} journal days` : undefined;

  return (
    <>
      <PageHeader title="Knowledge" subtitle={subtitle} />
      <KnowledgeNav />
      <div className="knowledge-search">
        <TextField type="search" value={input} onChange={setInput} placeholder="Search memory and journal…" onEnter={() => setQ(input.trim())} />
      </div>

      {q ? (
        <SearchResults q={q} />
      ) : (
        <ApiView state={data}>
          {(d) => (
            <>
              <MemoryCard memory={d.memory} />
              <div className="knowledge-columns">
                <Section title="Files" count={d.files.length} actions={<NewFile />}>
                  <Card flush>
                    {d.files.length ? (
                      <FileTree files={d.files} />
                    ) : (
                      <EmptyState compact title="No other memory files.">
                        Atlas stores topic notes (people, projects, decisions) as markdown files under ~/memory.
                      </EmptyState>
                    )}
                  </Card>
                </Section>
                <Section title="Journal" count={d.journal.count} actions={d.journal.count > 0 && <Link href={links.journal()} className="small">Open journal</Link>}>
                  <Card flush>
                    {d.journal.recent.length ? (
                      <ul className="knowledge-daylist">
                        {d.journal.recent.map((day) => (
                          <li key={day.date}>
                            <Link href={links.journal(day.date)}>
                              <span className="knowledge-daylist-date">{longDate(day.date)}</span>
                              <span className="faint small">{formatBytes(day.size)}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <EmptyState compact title="No journal entries yet.">
                        Atlas writes a daily log to ~/memory/journal/YYYY-MM-DD.md.
                      </EmptyState>
                    )}
                  </Card>
                </Section>
              </div>
            </>
          )}
        </ApiView>
      )}
    </>
  );
}

function MemoryCard(props: { memory: KnowledgeOverviewResponse["memory"] }) {
  const m = props.memory;
  if (!m) {
    return (
      <Section title="MEMORY.md">
        <Card>
          <EmptyState
            compact
            title="No MEMORY.md yet."
            action={<CreateMemoryButton />}
          >
            MEMORY.md is the long-term memory Atlas reads at the start of every session. Atlas creates it on its own; you can also start it here.
          </EmptyState>
        </Card>
      </Section>
    );
  }
  return (
    <Section
      title="MEMORY.md"
      description={
        <>
          Updated <Time value={m.modifiedAt} /> · {formatBytes(m.size)}
          {m.legacyLocation && " · legacy location ~/MEMORY.md (read-only)"}
        </>
      }
      actions={m.editable && <ButtonLink size="sm" href={withQuery(links.memoryFile("MEMORY.md"), { edit: 1 })}>Edit</ButtonLink>}
    >
      <Card className="knowledge-memory">
        {m.content.trim() ? <MemoryMarkdown text={m.content} path="MEMORY.md" /> : <EmptyState compact title="MEMORY.md is empty." />}
      </Card>
    </Section>
  );
}

function CreateMemoryButton() {
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="primary"
      size="sm"
      pending={pending}
      onClick={async () => {
        setPending(true);
        try {
          await apiPut(fileApi("MEMORY.md"), { content: "# Memory\n", baseMtimeMs: null } satisfies SaveFileRequest);
        } catch (err) {
          // 409: it appeared meanwhile; open it either way.
          if (!(err instanceof ApiError && err.status === 409)) {
            setPending(false);
            return;
          }
        }
        navigate(withQuery(links.memoryFile("MEMORY.md"), { edit: 1 }));
      }}
    >
      Create MEMORY.md
    </Button>
  );
}

function NewFile() {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        New file
      </Button>
    );
  }

  const create = async () => {
    let p = path.trim().replace(/^\/+/, "");
    if (!p) return;
    if (!/\.(md|txt)$/i.test(p)) p += ".md";
    setPending(true);
    setError(null);
    try {
      const title = p.split("/").pop()!.replace(/\.(md|txt)$/i, "");
      const created = await apiPut<MemoryFileResponse>(fileApi(p), { content: `# ${title}\n\n`, baseMtimeMs: null } satisfies SaveFileRequest);
      navigate(withQuery(links.memoryFile(created.path), { edit: 1 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <div className="knowledge-newfile">
      <TextField value={path} onChange={setPath} placeholder="folder/name.md" autoFocus onEnter={create} error={error} />
      <Button size="sm" variant="primary" pending={pending} onClick={create} disabled={!path.trim()}>
        Create
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

function SearchResults(props: { q: string }) {
  const res = useApi<SearchResponse>(withQuery(`${API}/search`, { q: props.q }));
  return (
    <ApiView state={res}>
      {(r) => (
        <Section
          title={`Results for "${r.q}"`}
          count={r.hits.length}
          description={r.truncated ? "Showing the best matches only. Narrow the search for more." : `${formatNumber(r.scanned)} files searched`}
        >
          {r.hits.length === 0 ? (
            <Card>
              <EmptyState compact title={`Nothing in memory matches "${r.q}".`}>
                Search is a case-insensitive substring match over file names and the contents of markdown and text files.
              </EmptyState>
            </Card>
          ) : (
            <div className="stack">
              {r.hits.map((h) => {
                const href = h.date ? links.journal(h.date) : links.memoryFile(h.path);
                return (
                  <Card key={h.path} flush className="knowledge-hit">
                    <div className="knowledge-hit-head">
                      <Link href={href} className="knowledge-hit-path">
                        {h.pathMatch ? <Highlight text={h.path} ranges={pathRanges(h.path, r.q)} /> : h.path}
                      </Link>
                      {h.date && <span className="tag">journal · {h.date}</span>}
                      <span className="spacer" />
                      <span className="faint small">
                        {h.matchCount > 0 ? `${h.matchCount} ${h.matchCount === 1 ? "match" : "matches"}` : "name match"} · <Time value={h.modifiedAt} />
                      </span>
                    </div>
                    {h.lines.length > 0 && (
                      <ol className="knowledge-hit-lines">
                        {h.lines.map((l) => (
                          <li key={l.line}>
                            <span className="knowledge-hit-lineno">{l.line}</span>
                            <span className="knowledge-hit-text">
                              <Highlight text={l.text} ranges={l.ranges} />
                            </span>
                          </li>
                        ))}
                        {h.matchCount > shownMatches(h) && (
                          <li className="small">
                            <span className="knowledge-hit-lineno" />
                            <Link href={href}>{h.matchCount - shownMatches(h)} more in this file</Link>
                          </li>
                        )}
                      </ol>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </Section>
      )}
    </ApiView>
  );
}

const shownMatches = (h: SearchResponse["hits"][number]) => h.lines.reduce((n, l) => n + l.ranges.length, 0);

function pathRanges(path: string, q: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const hay = path.toLowerCase();
  const needle = q.toLowerCase();
  for (let i = hay.indexOf(needle); i !== -1 && needle; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  return out;
}
