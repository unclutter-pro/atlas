import { useState } from "react";
import { useApi } from "../../api";
import { ApiView, ButtonLink, Button, Card, DataTable, EmptyState, formatBytes, formatNumber, KeyValue, PageHeader, Section, Time, type Column } from "../../components";
import { links } from "../../links";
import { withQuery } from "../../router";
import type { Volume, VolumesResponse, WorkspaceEntry, WorkspaceLargestFile, WorkspaceResponse } from "../../../ui-api/storage";

export function StorageHome() {
  const volumes = useApi<VolumesResponse>("/ui/api/storage/volumes", { poll: 60_000 });
  const [nonce, setNonce] = useState(0);
  const workspacePath = nonce === 0 ? "/ui/api/storage/workspace" : withQuery("/ui/api/storage/workspace", { refresh: 1, _r: nonce });
  const workspace = useApi<WorkspaceResponse>(workspacePath);

  return (
    <>
      <PageHeader
        title="Storage"
        subtitle="What is on disk, and how full is it?"
        actions={
          <ButtonLink href={links.storageBrowse()} variant="secondary">
            Browse files
          </ButtonLink>
        }
      />

      <Section title="Volumes">
        <ApiView state={volumes}>{(d) => <Volumes volumes={d.volumes} />}</ApiView>
      </Section>

      <Section
        title="Workspace breakdown"
        description={
          workspace.data ? (
            <>
              Computed <Time value={workspace.data.computedAt} />
              {workspace.data.truncated && " · scan stopped early (workspace is large); numbers may be a lower bound"}
            </>
          ) : undefined
        }
        actions={
          <Button size="sm" variant="ghost" pending={workspace.loading} onClick={() => setNonce((n) => n + 1)}>
            Refresh
          </Button>
        }
      >
        <ApiView state={workspace}>{(d) => <Workspace data={d} />}</ApiView>
      </Section>
    </>
  );
}

function Volumes(props: { volumes: Volume[] }) {
  if (!props.volumes.length) return <EmptyState compact title="No volume information available here." />;
  return (
    <div className="storage-volumes">
      {props.volumes.map((v) => (
        <Card key={v.roles.map((r) => r.key).join("+")} className={`storage-vol tone-${v.status}`}>
          <div className="storage-vol-head">
            <span className="strong">{v.roles.map((r) => r.label).join(" · ")}</span>
            <span className="storage-vol-pct num">{v.usedPercent.toFixed(1)}%</span>
          </div>
          <div className="storage-vol-track">
            <div className="storage-vol-fill" style={{ width: `${Math.min(100, Math.max(v.usedPercent, v.usedPercent > 0 ? 1 : 0))}%` }} />
          </div>
          <div className="storage-vol-foot small muted">
            {formatBytes(v.usedBytes)} used of {formatBytes(v.totalBytes)} · {formatBytes(v.freeBytes)} free
          </div>
          <div className="storage-vol-paths faint small">{v.roles.map((r) => r.path).join(" · ")}</div>
        </Card>
      ))}
    </div>
  );
}

function Workspace(props: { data: WorkspaceResponse }) {
  const { data } = props;
  const columns: Column<WorkspaceEntry>[] = [
    {
      key: "key",
      header: "Entry",
      render: (e) => (
        <>
          <span className="cell-primary">{e.key}</span>
          {e.label && <span className="cell-secondary">{e.label}</span>}
        </>
      ),
    },
    { key: "size", header: "Size", numeric: true, width: 100, render: (e) => formatBytes(e.sizeBytes) },
    { key: "files", header: "Files", numeric: true, width: 90, render: (e) => formatNumber(e.fileCount) },
    {
      key: "share",
      header: "Share",
      width: 170,
      render: (e) => {
        const share = data.totalSizeBytes > 0 ? e.sizeBytes / data.totalSizeBytes : 0;
        return (
          <div className="usage-share" title={`${(share * 100).toFixed(1)}%`}>
            <div className="usage-share-track">
              <div className="usage-share-fill" style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }} />
            </div>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <Card flush>
        <DataTable
          rows={data.entries}
          rowKey={(e) => e.key}
          rowHref={(e) => links.storageBrowse(e.key)}
          columns={columns}
          empty={<EmptyState compact title="HOME is empty." />}
        />
      </Card>

      <div className="grid-2 mt-4">
        <div>
          <div className="section-title mb-2">Largest files</div>
          <Card flush>
            <LargestFiles files={data.largestFiles} />
          </Card>
        </div>
        <div>
          <div className="section-title mb-2">Database</div>
          <Card>
            <Database database={data.database} />
          </Card>
        </div>
      </div>
    </>
  );
}

function LargestFiles(props: { files: WorkspaceLargestFile[] }) {
  const columns: Column<WorkspaceLargestFile>[] = [
    { key: "path", header: "File", render: (f) => <span className="mono-path">{f.path}</span> },
    { key: "size", header: "Size", numeric: true, width: 90, render: (f) => formatBytes(f.sizeBytes) },
    { key: "modified", header: "Modified", width: 130, render: (f) => <Time value={f.modifiedAt} /> },
  ];
  return (
    <DataTable
      rows={props.files}
      rowKey={(f) => f.path}
      rowHref={(f) => links.storageBrowse(f.path)}
      columns={columns}
      dense
      empty={<EmptyState compact title="No files yet." />}
    />
  );
}

function Database(props: { database: WorkspaceResponse["database"] }) {
  const db = props.database;
  if (!db) return <EmptyState compact title="No database yet." />;
  return (
    <KeyValue
      items={[
        { label: "Path", value: db.path },
        { label: "atlas.db", value: formatBytes(db.sizeBytes) },
        { label: "-wal", value: formatBytes(db.walSizeBytes) },
        { label: "-shm", value: formatBytes(db.shmSizeBytes) },
        { label: "Total", value: <span className="strong">{formatBytes(db.totalSizeBytes)}</span> },
      ]}
    />
  );
}
