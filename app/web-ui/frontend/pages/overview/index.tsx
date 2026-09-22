/**
 * Overview — "Is everything running, what is happening right now?"
 * State first, then what needs attention, what is running, what comes next,
 * and today's totals. Server side: ui-api/overview.ts.
 */

import { useEffect, useState } from "react";
import { useApi } from "../../api";
import {
  Alert,
  ApiView,
  Card,
  DataTable,
  EmptyState,
  Loading,
  PageHeader,
  Section,
  Stat,
  StatGrid,
  StatusBadge,
  Time,
  formatDuration,
  formatMoney,
  formatRelative,
  parseTime,
  zoneOptions,
} from "../../components";
import { links } from "../../links";
import { Link } from "../../router";
import { useStatus } from "../../shell/status";
import type { OverviewResponse, OverviewRun, UpcomingItem } from "../../../ui-api/overview";
import { attentionItems, previousDay, type AttentionItem } from "./attention";
import "./overview.css";

const POLL_MS = 5_000;

/** Re-render every `ms` so elapsed times tick between polls. */
function useTick(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export default function OverviewPage() {
  const overview = useApi<OverviewResponse>("/ui/api/overview", { poll: POLL_MS });
  const now = useTick(1000);

  return (
    <>
      <PageHeader title="Overview" />
      <ApiView state={overview} loading={<Loading />}>
        {(data) => {
          const attention = attentionItems(data, now);
          return (
            <>
              <Headline data={data} attentionCount={attention.length} now={now} />
              {attention.length > 0 && <NeedsAttention items={attention} data={data} now={now} />}
              <RunningNow runs={data.running} now={now} />
              <ComingUp data={data} now={now} />
              <Today data={data} />
            </>
          );
        }}
      </ApiView>
    </>
  );
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

function Headline(props: { data: OverviewResponse; attentionCount: number; now: number }) {
  const status = useStatus().data;
  // The shared status reflects Pause/Resume from the strip immediately.
  const paused = status?.control.paused ?? props.data.paused;
  const pausedAt = status?.control.pausedAt ?? null;
  const running = props.data.running.length;
  const next = props.data.upcoming[0];

  const tone = paused ? "paused" : props.attentionCount > 0 ? "attention" : "ok";
  const title = paused ? "Paused" : props.attentionCount > 0 ? "Running, with issues" : "All systems running";

  return (
    <div className={`overview-headline overview-headline-${tone}`}>
      <div className="overview-headline-main">
        <span className="overview-headline-dot" />
        <div>
          <div className="overview-headline-title">{title}</div>
          <div className="overview-headline-sub">
            {paused ? (
              <>
                New trigger runs and scheduled jobs are held{pausedAt ? <> since <Time value={pausedAt} /></> : null}.
              </>
            ) : props.attentionCount > 0 ? (
              <a href="#attention">
                {props.attentionCount} {props.attentionCount === 1 ? "item needs" : "items need"} attention
              </a>
            ) : (
              "Nothing needs attention."
            )}
          </div>
        </div>
      </div>
      <div className="overview-headline-facts">
        <HeadlineFact label="Running" href={running ? "#running" : undefined}>
          <span className={running ? "text-running" : "faint"}>{running}</span>
        </HeadlineFact>
        <HeadlineFact label="Next up" href={next ? upcomingHref(next) ?? undefined : undefined}>
          {next ? (
            <>
              <span className="strong">{next.triggerName ?? next.title}</span>{" "}
              <span className="muted">{formatRelative(next.at, props.now)}</span>
            </>
          ) : (
            <span className="faint">nothing scheduled</span>
          )}
        </HeadlineFact>
        <HeadlineFact label="Cost today" href={usageToday(props.data.today)}>
          {formatMoney(props.data.totals.costUsd)}
        </HeadlineFact>
      </div>
    </div>
  );
}

function HeadlineFact(props: { label: string; href?: string; children: React.ReactNode }) {
  const body = (
    <>
      <span className="overview-fact-label">{props.label}</span>
      <span className="overview-fact-value">{props.children}</span>
    </>
  );
  if (!props.href) return <div className="overview-fact">{body}</div>;
  return props.href.startsWith("#") ? (
    <a className="overview-fact" href={props.href}>
      {body}
    </a>
  ) : (
    <Link className="overview-fact" href={props.href}>
      {body}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

function NeedsAttention(props: { items: AttentionItem[]; data: OverviewResponse; now: number }) {
  const { failedRunsTotal, failedRuns } = props.data.attention;
  const today = props.data.today;
  const moreFailed = failedRunsTotal - failedRuns.length;
  return (
    <Section id="attention" title="Needs attention" count={props.items.length + Math.max(0, moreFailed)}>
      <Card flush tone={props.items.some((i) => i.tone === "error") ? "error" : "warn"}>
        <ul className="overview-attention">
          {props.items.map((item) => (
            <li key={item.key}>
              <AttentionRow item={item} />
            </li>
          ))}
        </ul>
        {failedRunsTotal > 0 && (
          <div className="overview-card-footer">
            <Link href={links.activity({ status: "failed", from: previousDay(today), to: today })}>
              {moreFailed > 0 ? `${moreFailed} more failed ${moreFailed === 1 ? "run" : "runs"} in the last 24h` : "All failed runs"} →
            </Link>
          </div>
        )}
      </Card>
    </Section>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const body = (
    <>
      <span className={`overview-attention-mark tone-${item.tone}`} />
      <span className="overview-attention-text">
        <span className="overview-attention-title">{item.title}</span>
        {item.detail && <span className="overview-attention-detail">{item.detail}</span>}
      </span>
      {item.at && <Time value={item.at} className="overview-attention-time" />}
    </>
  );
  return item.href ? (
    <Link href={item.href} className="overview-attention-row">
      {body}
    </Link>
  ) : (
    <div className="overview-attention-row">{body}</div>
  );
}

// ---------------------------------------------------------------------------
// Running now
// ---------------------------------------------------------------------------

function RunningNow(props: { runs: OverviewRun[]; now: number }) {
  return (
    <Section id="running" title="Running now" count={props.runs.length}>
      <Card flush>
        <DataTable
          rows={props.runs}
          rowKey={(r) => r.id}
          rowHref={(r) => links.run(r.id)}
          empty={<EmptyState compact title="Nothing running" />}
          columns={[
            {
              key: "trigger",
              header: "Trigger",
              render: (r) => (
                <>
                  <Link href={links.trigger(r.triggerName)} className="cell-primary">
                    {r.triggerName}
                  </Link>
                  {r.payloadPreview && <span className="cell-secondary truncate overview-preview">{r.payloadPreview}</span>}
                </>
              ),
            },
            {
              key: "cause",
              header: "Cause",
              render: (r) => (
                <span className="muted">
                  {r.triggerType ?? "unknown"}
                  {r.channel && r.channel !== "internal" ? ` · ${r.channel}` : ""}
                  {r.sessionKey && r.sessionKey !== "_default" && !r.sessionKey.startsWith("webhook-") && (
                    <span className="cell-secondary">{r.sessionKey}</span>
                  )}
                </span>
              ),
            },
            {
              key: "state",
              header: "State",
              render: (r) =>
                r.stuck ? (
                  <StatusBadge status="warn">Stuck</StatusBadge>
                ) : (
                  <StatusBadge status="running">{r.sessionId ? "Running" : "Starting"}</StatusBadge>
                ),
            },
            {
              key: "activity",
              header: "Last activity",
              render: (r) => (r.lastActivityAt ? <Time value={r.lastActivityAt} /> : <span className="faint">—</span>),
            },
            {
              key: "elapsed",
              header: "Elapsed",
              numeric: true,
              render: (r) => {
                const start = parseTime(r.startedAt);
                return <span className="strong">{formatDuration(start ? props.now - start.getTime() : r.elapsedMs)}</span>;
              },
            },
          ]}
        />
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Coming up
// ---------------------------------------------------------------------------

function upcomingHref(u: UpcomingItem): string | null {
  if (u.kind === "reminder") return links.reminders();
  return u.triggerName ? links.trigger(u.triggerName) : null;
}

function clockTime(iso: string, now: number): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...zoneOptions() });
  // en-CA formats as YYYY-MM-DD, a cheap zone-aware calendar-day comparison.
  const dDay = d.toLocaleDateString("en-CA", zoneOptions());
  const today = new Date(now).toLocaleDateString("en-CA", zoneOptions());
  const tomorrow = new Date(now + 86_400_000).toLocaleDateString("en-CA", zoneOptions());
  if (dDay === today) return time;
  if (dDay === tomorrow) return `tomorrow ${time}`;
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...zoneOptions() })} ${time}`;
}

function ComingUp(props: { data: OverviewResponse; now: number }) {
  const status = useStatus().data;
  const paused = status?.control.paused ?? props.data.paused;
  const { upcoming, waiting } = props.data;

  return (
    <Section
      title="Coming up"
      count={upcoming.length}
      actions={
        <>
          <Link href={links.automations()} className="small">
            Triggers
          </Link>
          <Link href={links.reminders()} className="small">
            Reminders
          </Link>
        </>
      }
    >
      {paused && upcoming.length > 0 && <Alert tone="warn">Paused: nothing below fires until Atlas is resumed.</Alert>}
      <Card flush>
        <DataTable
          rows={upcoming}
          rowKey={(u) => `${u.kind}-${u.reminderId ?? u.triggerName}`}
          rowHref={upcomingHref}
          empty={
            <EmptyState compact title="Nothing scheduled">
              Cron triggers and time-based reminders show up here with their next fire time.
            </EmptyState>
          }
          columns={[
            {
              key: "when",
              header: "When",
              width: 170,
              render: (u) => (
                <>
                  <span className="strong nowrap">{formatRelative(u.at, props.now)}</span>
                  <span className="cell-secondary nowrap">{clockTime(u.at, props.now)}</span>
                </>
              ),
            },
            {
              key: "what",
              header: "What",
              render: (u) => (
                <>
                  <span className="cell-primary">{u.kind === "cron" ? u.triggerName : u.title}</span>
                  <span className="cell-secondary">{u.kind === "cron" ? u.title : u.triggerName ? `via ${u.triggerName}` : "new session"}</span>
                </>
              ),
            },
            {
              key: "kind",
              header: "Kind",
              render: (u) => <span className="tag">{u.kind === "cron" ? "cron" : "reminder"}</span>,
            },
            {
              key: "schedule",
              header: "Repeats",
              render: (u) => (u.schedule ? <code>{u.schedule}</code> : <span className="faint">once</span>),
            },
          ]}
        />
        {waiting.length > 0 && (
          <div className="overview-card-footer">
            <Link href={links.reminders()}>
              {waiting.length} {waiting.length === 1 ? "reminder" : "reminders"} waiting for an event
            </Link>
            <span className="faint"> · {waiting.map((w) => w.title).slice(0, 3).join(", ")}{waiting.length > 3 ? ", …" : ""}</span>
          </div>
        )}
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function usageToday(today: string): string {
  return links.usage({ from: today, to: today });
}

function Today({ data }: { data: OverviewResponse }) {
  const t = data.totals;
  const day = { from: data.today, to: data.today };
  return (
    <Section title="Today" description={data.today}>
      <StatGrid>
        <Stat label="Runs" value={t.runs} href={links.activity(day)} />
        <Stat
          label="Failed"
          value={t.failed}
          tone={t.failed > 0 ? "error" : undefined}
          hint={t.runs > 0 ? `${Math.round((t.failed / t.runs) * 100)}% of runs` : undefined}
          href={links.activity({ ...day, status: "failed" })}
        />
        <Stat
          label="Cost"
          value={formatMoney(t.costUsd)}
          hint={`${formatMoney(t.costYesterdayUsd)} yesterday`}
          href={usageToday(data.today)}
        />
        <Stat label="Messages in" value={t.messages} href={links.activity(day)} />
      </StatGrid>
    </Section>
  );
}
