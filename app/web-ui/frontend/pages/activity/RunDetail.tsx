/** /activity/:id — one trigger run: outcome, cause, transcript, metrics. */

import { useEffect, useState } from "react";
import { useApi } from "../../api";
import { ApiView, ButtonLink, Card, CodeBlock, DataTable, Duration, KeyValue, Money, NotFound, PageHeader, Section, Stat, StatGrid, Time, formatDuration, formatMoney, prettyJson, OutcomeBadge } from "../../components";
import { links } from "../../links";
import { Link, type Params } from "../../router";
import type { RunDetailResponse, RunSummary } from "../../../ui-api/activity";
import { CauseTag, MessageCard, MetricsList, causeLabel } from "./shared";
import { TranscriptView } from "./Transcript";

export function RunDetail(props: { params: Params }) {
  const id = props.params.id!;
  const valid = /^\d+$/.test(id);
  // Poll only while the run is live.
  const [live, setLive] = useState(true);
  const state = useApi<RunDetailResponse>(valid ? `/ui/api/activity/runs/${id}` : null, { poll: live ? 5_000 : undefined });
  useEffect(() => {
    if (state.data) setLive(state.data.run.outcome === "running");
  }, [state.data]);
  if (!valid || state.error?.includes("not found")) return <NotFound what={`Run #${id}`} />;
  return <ApiView state={state}>{(d) => <RunView d={d} />}</ApiView>;
}

function RunView(props: { d: RunDetailResponse }) {
  const { d } = props;
  const r = d.run;
  const tone = r.outcome === "failed" ? "error" : r.outcome === "running" ? "running" : "ok";
  return (
    <>
      <PageHeader
        title={`${r.triggerName} · run #${r.id}`}
        documentTitle={`Run #${r.id}`}
        badge={<OutcomeBadge outcome={r.outcome} />}
        back={{ href: "/activity", label: "Activity" }}
        subtitle={
          <>
            <CauseTag cause={d.cause} channel={d.message?.channel ?? d.trigger.channel} /> · started <Time value={r.startedAt} />
          </>
        }
        actions={
          <>
            {d.chatSessionKey != null && (
              <ButtonLink href={links.chat(d.chatSessionKey)}>
                Open in Chat
              </ButtonLink>
            )}
            {d.trigger.exists && <ButtonLink href={links.trigger(r.triggerName)}>Trigger settings</ButtonLink>}
          </>
        }
      />

      <StatGrid>
        <Stat label="Outcome" value={r.outcome === "running" ? "Running" : r.outcome === "failed" ? "Failed" : "OK"} tone={tone} />
        <Stat label={r.outcome === "running" ? "Elapsed" : "Duration"} value={formatDuration(r.durationMs)} />
        <Stat label="Cost" value={formatMoney(r.costUsd)} hint={r.outcome === "running" ? "Known when the run ends" : undefined} />
        <Stat label="Turns" value={d.metrics?.numTurns ?? "—"} />
      </StatGrid>

      {r.outcome === "failed" && (
        <Card tone="error" title="Why it failed">
          {d.error ? <div className="activity-pre">{d.error}</div> : <span className="muted">The session reported an error, but its transcript has no final message.</span>}
        </Card>
      )}

      <div className="activity-detail-grid">
        <div className="activity-detail-main">
          <Section title="Cause">
            <Cause d={d} />
          </Section>

          {d.injected.length > 0 && (
            <Section title="Messages during this run" count={d.injected.length}>
              <div className="stack">
                {d.injected.map((m) => (
                  <MessageCard key={m.id} message={m} linkToDetail />
                ))}
              </div>
            </Section>
          )}

          <Section title="Transcript">
            <TranscriptView
              transcript={d.transcript}
              emptyTitle={r.outcome === "running" && !r.sessionId ? "Session is starting." : "No transcript."}
              emptyBody={
                r.outcome === "running" && !r.sessionId
                  ? "The transcript appears once the session has an id."
                  : "The session file was not found under ~/.claude/projects. It may have been cleaned up."
              }
            />
          </Section>
        </div>

        <aside className="activity-detail-side">
          <Section title="Run">
            <Card>
              <KeyValue
                items={[
                  ["Trigger", d.trigger.exists ? <Link href={links.trigger(r.triggerName)}>{r.triggerName}</Link> : <span>{r.triggerName} <span className="faint">(deleted)</span></span>],
                  ["Type", d.trigger.type],
                  ["Channel", d.trigger.channel],
                  ["Started", <Time value={r.startedAt} mode="absolute" />],
                  ["Completed", r.completedAt ? <Time value={r.completedAt} mode="absolute" /> : null],
                  ["Session mode", r.sessionMode],
                  ["Session key", <code className="activity-break">{r.sessionKey}</code>],
                  ["Session", r.sessionId ? <Link href={links.session(r.sessionId)} className="activity-break">{r.sessionId}</Link> : null],
                  ["Model", d.transcript?.model ?? undefined],
                ]}
              />
            </Card>
          </Section>

          <Section title="Usage">
            <Card>{d.metrics ? <MetricsList metrics={d.metrics} /> : <span className="muted">{r.outcome === "running" ? "Recorded when the run ends." : "No metrics recorded for this run."}</span>}</Card>
          </Section>

          {d.sessionRuns.length > 0 && (
            <Section title="Same session" count={d.sessionRuns.length}>
              <Card flush>
                <RunTable runs={d.sessionRuns} />
              </Card>
            </Section>
          )}
        </aside>
      </div>
    </>
  );
}

function Cause(props: { d: RunDetailResponse }) {
  const { d } = props;
  const r = d.run;
  const payload = r.payload ? prettyJson(r.payload) : null;
  return (
    <div className="stack">
      {d.message && <MessageCard message={d.message} linkToDetail />}
      {!d.message && d.cause === "cron" && (
        <Card>
          <span className="strong">Scheduled run</span>
          {d.trigger.description && <span className="muted"> · {d.trigger.description}</span>}
        </Card>
      )}
      {!d.message && d.cause !== "cron" && !payload && (
        <Card>
          <span className="strong">{causeLabel(d.cause)} run</span>
          <span className="muted"> without payload</span>
        </Card>
      )}
      {payload && !d.message && <CodeBlock label="Payload" code={payload} copy maxHeight={320} />}
      {payload && d.message && payload.trim() !== d.message.content.trim() && (
        <details className="activity-raw">
          <summary>Raw payload</summary>
          <CodeBlock code={payload} copy maxHeight={320} />
        </details>
      )}
    </div>
  );
}

export function RunTable(props: { runs: RunSummary[]; showTrigger?: boolean }) {
  return (
    <DataTable
      dense
      rows={props.runs}
      rowKey={(r) => r.id}
      rowHref={(r) => links.run(r.id)}
      columns={[
        {
          key: "run",
          header: "Run",
          render: (r) => (
            <>
              <span className="cell-primary">{props.showTrigger ? r.triggerName : `#${r.id}`}</span>
              <span className="cell-secondary">
                <Time value={r.startedAt} />
              </span>
            </>
          ),
        },
        { key: "outcome", header: "Outcome", render: (r) => <OutcomeBadge outcome={r.outcome} /> },
        { key: "duration", header: "Duration", numeric: true, render: (r) => <Duration ms={r.durationMs} /> },
        { key: "cost", header: "Cost", numeric: true, render: (r) => <Money usd={r.costUsd} /> },
      ]}
    />
  );
}
