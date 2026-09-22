/** Read-only file browser rooted at HOME: directory listing or file preview. */

import { useApi } from "../../api";
import { Alert, ApiView, buttonClass, Card, CodeBlock, DataTable, EmptyState, formatBytes, PageHeader, Time, type Column } from "../../components";
import { links } from "../../links";
import { Link, type Params } from "../../router";
import type { BetterView, BrowseDir, BrowseEntry, BrowseFile, BrowseResponse } from "../../../ui-api/storage";

const enc = encodeURIComponent;
const apiPathFor = (path: string) => (path ? `/ui/api/storage/browse/${path.split("/").map(enc).join("/")}` : "/ui/api/storage/browse");
const downloadPathFor = (path: string) => `/ui/api/storage/download/${path.split("/").map(enc).join("/")}`;

export function Browse(props: { params: Params }) {
  const path = (props.params["*"] ?? "").replace(/^\/+|\/+$/g, "");
  return <BrowseInner key={path} path={path} />;
}

function BrowseInner(props: { path: string }) {
  const data = useApi<BrowseResponse>(apiPathFor(props.path));
  const name = props.path ? props.path.split("/").pop()! : "HOME";

  return (
    <>
      <PageHeader title={<span className="storage-title">{name}</span>} back={{ href: links.storage(), label: "Storage" }} />
      <Breadcrumbs path={props.path} />
      {data.error && /no such/i.test(data.error) ? (
        <EmptyState title="Nothing here.">This file or directory does not exist (it may have been removed).</EmptyState>
      ) : (
        <ApiView state={data}>{(d) => (d.type === "dir" ? <Dir dir={d} /> : <File file={d} />)}</ApiView>
      )}
    </>
  );
}

function Breadcrumbs(props: { path: string }) {
  const segs = props.path ? props.path.split("/") : [];
  let acc = "";
  return (
    <nav className="storage-breadcrumbs small">
      <Link href={links.storageBrowse()}>HOME</Link>
      {segs.map((s) => {
        acc = acc ? `${acc}/${s}` : s;
        return (
          <span key={acc}>
            {" / "}
            <Link href={links.storageBrowse(acc)}>{s}</Link>
          </span>
        );
      })}
    </nav>
  );
}

function Dir(props: { dir: BrowseDir }) {
  const columns: Column<BrowseEntry>[] = [
    {
      key: "name",
      header: "Name",
      render: (e) => (
        <span className={e.hidden ? "faint" : undefined}>
          {e.name}
          {e.kind === "dir" && "/"}
          {e.secret && <span className="tag storage-secret-tag">secret</span>}
          {e.kind === "other" && <span className="tag">symlink</span>}
        </span>
      ),
    },
    { key: "size", header: "Size", numeric: true, width: 100, render: (e) => (e.kind === "file" ? formatBytes(e.sizeBytes) : <span className="faint">—</span>) },
    { key: "modified", header: "Modified", width: 130, render: (e) => (e.modifiedAt ? <Time value={e.modifiedAt} /> : <span className="faint">—</span>) },
  ];
  return (
    <Card flush>
      <DataTable
        rows={props.dir.entries}
        rowKey={(e) => e.path}
        rowHref={(e) => (e.kind === "other" ? null : links.storageBrowse(e.path))}
        columns={columns}
        empty={<EmptyState compact title="This directory is empty." />}
      />
    </Card>
  );
}

function File(props: { file: BrowseFile }) {
  const f = props.file;
  return (
    <>
      <div className="row row-wrap mb-4">
        <span className="muted">
          {formatBytes(f.sizeBytes)} · Modified <Time value={f.modifiedAt} />
        </span>
        <span className="spacer" />
        {!f.denied && (
          <a className={buttonClass("secondary", "sm")} href={downloadPathFor(f.path)} download>
            Download
          </a>
        )}
        <BetterViewLink view={f.betterView} />
      </div>

      {f.denied && <Alert tone="warn">Content and download are hidden for this file — it may contain secrets.</Alert>}
      {!f.denied && f.masked && <Alert tone="info">Secrets in this file are masked, the same way as Settings → Configuration.</Alert>}
      {!f.denied && f.tail && <Alert tone="info">This file is larger than the {formatBytes(256 * 1024)} preview limit — showing the tail.</Alert>}
      {!f.denied && f.binary && <Alert tone="info">This looks like a binary file — no preview available.</Alert>}
      {!f.denied && !f.binary && f.tooLarge && <Alert tone="info">This file is larger than the {formatBytes(256 * 1024)} preview limit — no preview available.</Alert>}

      {f.content != null && <CodeBlock code={f.content} label={f.path} copy />}
    </>
  );
}

function BetterViewLink(props: { view: BetterView | null }) {
  if (!props.view) return null;
  if (props.view.kind === "memory") {
    return <Link href={links.memoryFile(props.view.path)}>Open in Knowledge →</Link>;
  }
  return <Link href={links.session(props.view.sessionId)}>Open transcript in Activity →</Link>;
}
