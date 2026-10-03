/** /activity/session/:sessionId — a Claude session: its runs, per-invocation usage, transcript. */

import { useApi } from "../../api";
import { ApiView, ButtonLink, Card, DataTable, Duration, Money, NotFound, Num, PageHeader, Section, Stat, StatGrid, StatusBadge, Time, formatDuration, formatMoney } from "../../components";
import { links } from "../../links";
import { Link, type Params } from "../../router";
import type { Metrics, SessionDetailResponse } from "../../../ui-api/activity";
import { RunTable } from "./RunDetail";
import { TranscriptView } from "./Transcript";

export function SessionDetail(props: { params: Params }) {
  const id = props.params.sessionId!;
  const valid = /^[a-zA-Z0-9_-]+$/.test(id);
  const state = useApi<SessionDetailResponse>(valid ? `/ui/api/activity/sessions/${encodeURIComponent(id)}` : null);
  if (!valid || state.error?.includes("not found")) return <NotFound what="Session" />;
  return <ApiView state={state}>{(d) => <SessionView d={d} />}</ApiView>;
}

function SessionView(props: { d: SessionDetailResponse }) {
  const { d } = props;
  const failed = d.metrics.filter((m) => m.isError).length;
  const running = d.runs.filter((r) => r.outcome === "running").length;
  const direct = d.sessionType === "direct";
  return (
    <>
      <PageHeader
        title={direct ? "Direct session" : d.triggerName ? `${d.triggerName} session` : "Session"}
        documentTitle={`Session ${d.sessionId.slice(0, 8)}`}
        badge={running > 0 ? <StatusBadge status="running" /> : failed > 0 ? <StatusBadge status="error">{failed} failed</StatusBadge> : undefined}
        back={{ href: "/activity", label: "Activity" }}
        subtitle={<code className="activity-break">{d.sessionId}</code>}
        actions={
          <>
            {d.chatSessionKey != null && (
              <ButtonLink href={links.chat(d.chatSessionKey)}>
                Open in Chat
              </ButtonLink>
            )}
            {d.triggerName && d.triggerExists && <ButtonLink href={links.trigger(d.triggerName)}>Trigger settings</ButtonLink>}
          </>
        }
      />

      <StatGrid>
        <Stat label="Runs" value={d.totals.runs || d.metrics.length} hint={d.totals.runs ? undefined : "invocations"} />
        <Stat label="Total cost" value={formatMoney(d.totals.costUsd)} />
        <Stat label="Total duration" value={formatDuration(d.totals.durationMs)} />
        <Stat label="Failed" value={failed} tone={failed ? "error" : undefined} />
      </StatGrid>

      <div className="activity-detail-grid">
        <div className="activity-detail-main">
          <Section title="Transcript">
            <TranscriptView transcript={d.transcript} />
          </Section>
        </div>
        <aside className="activity-detail-side">
          {d.runs.length > 0 && (
            <Section title="Runs" count={d.runs.length}>
              <Card flush>
                <RunTable runs={d.runs} />
              </Card>
            </Section>
          )}
          {d.metrics.length > 0 && (
            <Section title="Usage per invocation" count={d.metrics.length}>
              <Card flush>
                <MetricsTable metrics={d.metrics} />
              </Card>
            </Section>
          )}
          {d.triggerName && (
            <Section title="Trigger">
              <Card>
                {d.triggerExists ? <Link href={links.trigger(d.triggerName)}>{d.triggerName}</Link> : <span>{d.triggerName} <span className="faint">(deleted)</span></span>}
                <span className="faint"> · </span>
                <Link href={links.activity({ trigger: d.triggerName })}>All activity</Link>
              </Card>
            </Section>
          )}
        </aside>
      </div>
    </>
  );
}

function MetricsTable(props: { metrics: Metrics[] }) {
  return (
    <DataTable
      dense
      rows={[...props.metrics].reverse()}
      rowKey={(_, i) => i}
      columns={[
        {
          key: "at",
          header: "Started",
          render: (m) => (
            <>
              <Time value={m.startedAt} />
              {m.isError && <span className="cell-secondary text-error">error</span>}
            </>
          ),
        },
        { key: "dur", header: "Time", numeric: true, render: (m) => <Duration ms={m.durationMs} /> },
        { key: "in", header: "In", numeric: true, render: (m) => <Num value={m.inputTokens} compact /> },
        { key: "out", header: "Out", numeric: true, render: (m) => <Num value={m.outputTokens} compact /> },
        { key: "cache", header: "Cache r/w", numeric: true, render: (m) => <span className="num"><Num value={m.cacheReadTokens} compact /> / <Num value={m.cacheCreationTokens} compact /></span> },
        { key: "cost", header: "Cost", numeric: true, render: (m) => <Money usd={m.costUsd} /> },
      ]}
    />
  );
}
