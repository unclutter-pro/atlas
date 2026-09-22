/**
 * Automations — "What does Atlas do on its own?" Triggers and reminders.
 * Owned by the automations area. Server side: ui-api/automations.ts.
 *
 *   /automations                  triggers grouped by type
 *   /automations?view=reminders   reminders (pending first)
 *   /automations?create=1         new trigger form
 *   /automations/:name            trigger detail (?edit=1 = edit form)
 */

import { useState } from "react";
import { apiPost, useApi, useMutation } from "../../api";
import {
  Alert,
  ApiView,
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  Money,
  NotFound,
  PageHeader,
  Section,
  Stat,
  StatGrid,
  Tabs,
  Time,
  Toggle,
  formatMoney,
  formatRelative,
  type Column,
} from "../../components";
import { links } from "../../links";
import { Link, Routes, useQueryParam } from "../../router";
import type { AutomationsResponse, TriggerSummary, TriggerType } from "../../../ui-api/automations";
import { RemindersView } from "./Reminders";
import { TriggerDetailPage } from "./TriggerDetail";
import { CreateTriggerPage } from "./TriggerForm";
import { RunStatus, daysAgo } from "./shared";
import "./automations.css";

export default function AutomationsPage() {
  return (
    <Routes
      routes={[
        { path: "/automations", component: AutomationsRoot },
        { path: "/automations/:name", component: TriggerDetailPage },
      ]}
      fallback={<NotFound />}
    />
  );
}

function AutomationsRoot() {
  const [create] = useQueryParam("create");
  const [view] = useQueryParam("view");
  if (create) return <CreateTriggerPage />;
  return <AutomationsList view={view === "reminders" ? "reminders" : "triggers"} />;
}

function AutomationsList(props: { view: "triggers" | "reminders" }) {
  const state = useApi<AutomationsResponse>("/ui/api/automations", { poll: 15_000 });
  const d = state.data;
  return (
    <>
      <PageHeader
        title="Automations"
        documentTitle={props.view === "reminders" ? "Reminders" : "Triggers"}
        actions={
          <ButtonLink href="/automations?create=1" variant="primary">
            New trigger
          </ButtonLink>
        }
      />
      <Tabs
        items={[
          { label: "Triggers", href: "/automations", count: d?.triggers.length },
          { label: "Reminders", href: links.reminders(), count: d?.reminders.pending },
        ]}
      />
      {props.view === "reminders" ? <RemindersView onChange={state.refetch} /> : <ApiView state={state}>{(data) => <TriggersView data={data} refetch={state.refetch} />}</ApiView>}
    </>
  );
}

const GROUPS: Array<{ type: TriggerType; title: string }> = [
  { type: "cron", title: "Scheduled" },
  { type: "webhook", title: "Webhooks" },
  { type: "manual", title: "Manual" },
];

function TriggersView(props: { data: AutomationsResponse; refetch: () => Promise<void> }) {
  const { triggers } = props.data;
  const enabled = triggers.filter((t) => t.enabled);
  const next = enabled
    .filter((t) => t.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
  const running = triggers.reduce((n, t) => n + t.running, 0);
  const failures7d = triggers.reduce((n, t) => n + t.last7d.failures, 0);
  const cost7d = triggers.reduce((n, t) => n + t.last7d.costUsd, 0);
  const failing = triggers.filter((t) => t.lastRun?.status === "failed");

  if (triggers.length === 0) {
    return (
      <EmptyState
        title="No triggers yet"
        action={
          <ButtonLink href="/automations?create=1" variant="primary">
            New trigger
          </ButtonLink>
        }
      >
        A trigger starts a Claude session on its own: on a cron schedule, when a webhook is called, or when an integration (Signal, email, web chat)
        hands it a message. Each trigger has a prompt that tells Atlas what to do.
      </EmptyState>
    );
  }

  return (
    <>
      {props.data.paused && <Alert tone="warn">Atlas is paused. Scheduled and webhook triggers do not run until it is resumed.</Alert>}

      <StatGrid>
        <Stat label="Enabled" value={`${enabled.length} / ${triggers.length}`} hint={triggers.length > enabled.length ? `${triggers.length - enabled.length} disabled` : "all enabled"} />
        <Stat
          label="Next scheduled run"
          value={next ? formatRelative(next.nextRunAt) : "—"}
          hint={next ? next.name : "no enabled schedules"}
          href={next ? links.trigger(next.name) : undefined}
          tone="accent"
        />
        <Stat label="Running now" value={running} tone={running ? "running" : undefined} href={links.activity({ status: "running" })} />
        <Stat label="Failed runs, 7 days" value={failures7d} tone={failures7d ? "error" : "ok"} href={links.activity({ status: "failed", from: daysAgo(6) })} />
        <Stat label="Cost, 7 days" value={formatMoney(cost7d)} href={links.usage({ range: "7d" })} />
      </StatGrid>

      {failing.length > 0 && (
        <Section title="Last run failed" count={failing.length}>
          <Card tone="error" flush>
            <DataTable
              dense
              rows={failing}
              rowKey={(t) => t.name}
              rowHref={(t) => links.run(t.lastRun!.id)}
              columns={[
                { key: "name", header: "Trigger", render: (t) => <Link href={links.trigger(t.name)} className="cell-primary">{t.name}</Link> },
                { key: "when", header: "Failed", render: (t) => <Time value={t.lastRun!.startedAt} /> },
                { key: "fail7", header: "Failures, 7 days", numeric: true, render: (t) => t.last7d.failures },
                { key: "open", header: "", align: "right", render: (t) => <Link href={links.run(t.lastRun!.id)}>Open run #{t.lastRun!.id}</Link> },
              ]}
            />
          </Card>
        </Section>
      )}

      {GROUPS.map((g) => {
        const rows = triggers.filter((t) => t.type === g.type);
        if (rows.length === 0) return null;
        return (
          <Section key={g.type} title={g.title} count={rows.length}>
            <Card flush>
              <DataTable rows={rows} rowKey={(t) => t.name} rowHref={(t) => links.trigger(t.name)} columns={columnsFor(g.type, props.refetch)} />
            </Card>
          </Section>
        );
      })}
    </>
  );
}

function EnabledToggle(props: { trigger: TriggerSummary; onDone: () => void }) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const toggle = useMutation((enabled: boolean) => apiPost(`/ui/api/automations/triggers/${encodeURIComponent(props.trigger.name)}/toggle`, { enabled }), {
    onSuccess: () => props.onDone(),
    onError: () => setOptimistic(null),
  });
  const checked = optimistic ?? props.trigger.enabled;
  return (
    <span title={toggle.error ?? (checked ? "Enabled — click to disable" : "Disabled — click to enable")}>
      <Toggle
        checked={checked}
        disabled={toggle.pending}
        onChange={async (v) => {
          setOptimistic(v);
          await toggle.run(v);
          setOptimistic(null);
        }}
      />
    </span>
  );
}

function columnsFor(type: TriggerType, refetch: () => Promise<void>): Column<TriggerSummary>[] {
  const cols: Column<TriggerSummary>[] = [
    { key: "enabled", header: "", width: 50, render: (t) => <EnabledToggle trigger={t} onDone={refetch} /> },
    {
      key: "name",
      header: "Trigger",
      render: (t) => (
        <div className={t.enabled ? undefined : "automations-disabled"}>
          <div className="cell-primary">{t.name}</div>
          {t.description && <div className="cell-secondary truncate automations-desc">{t.description}</div>}
        </div>
      ),
    },
  ];
  if (type === "cron") {
    cols.push(
      {
        key: "schedule",
        header: "Schedule",
        render: (t) =>
          t.schedule?.valid ? (
            <div>
              <div>{t.schedule.text ?? <code>{t.schedule.expr}</code>}</div>
              {t.schedule.text && <div className="cell-secondary"><code>{t.schedule.expr}</code></div>}
            </div>
          ) : (
            <span className="text-error" title={t.schedule?.error ?? "No schedule"}>
              Invalid: <code>{t.schedule?.expr ?? "none"}</code>
            </span>
          ),
      },
      { key: "next", header: "Next run", render: (t) => (t.nextRunAt ? <Time value={t.nextRunAt} /> : <span className="faint">{t.enabled ? "—" : "Off"}</span>) },
    );
  } else if (type === "webhook") {
    cols.push({ key: "endpoint", header: "Endpoint", render: (t) => <code className="small">POST {t.webhookPath}</code> });
  } else {
    cols.push({ key: "channel", header: "Channel", render: (t) => <span className="muted">{t.channel}</span> });
  }
  cols.push(
    {
      key: "last",
      header: "Last run",
      render: (t) => (
        <div className="row">
          <RunStatus status={t.lastRun?.status} />
          {t.lastRun && <Time value={t.lastRun.startedAt} className="muted small" />}
        </div>
      ),
    },
    {
      key: "runs",
      header: "Runs",
      numeric: true,
      render: (t) => (
        <div>
          <div>{t.runCount.toLocaleString("en-US")}</div>
          <div className="cell-secondary">{t.last7d.runs} in 7d</div>
        </div>
      ),
    },
    { key: "cost", header: "Cost, 7d", numeric: true, render: (t) => (t.last7d.costUsd ? <Money usd={t.last7d.costUsd} /> : <span className="faint">—</span>) },
  );
  return cols;
}
