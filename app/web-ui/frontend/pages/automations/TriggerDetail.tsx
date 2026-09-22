/** /automations/:name — one trigger: state, attention, configuration, prompt, run history. */

import { useEffect, useState, type ReactNode } from "react";
import { apiDelete, apiPost, useApi, useMutation, type ApiState } from "../../api";
import { Alert, Button, ButtonLink, Card, CodeBlock, ConfirmButton, DataTable, Duration, EmptyState, KeyValue, Loading, Money, NotFound, PageHeader, Pager, Section, Stat, StatGrid, TextArea, Time, Toggle, formatDuration, formatMoney, formatRelative, usePage, CopyButton } from "../../components";
import { links } from "../../links";
import { Link, Redirect, navigate, useQueryParam, withQuery, type Params } from "../../router";
import { useStatus } from "../../shell/status";
import type { RemindersResponse, RunSummary, RunsResponse, TriggerDetail } from "../../../ui-api/automations";
import { EditTriggerForm } from "./TriggerForm";
import { RemindersBody } from "./Reminders";
import { EnabledBadge, RunStatus, TYPE_LABEL, TypeTag, daysAgo, webhookUrl } from "./shared";

const PAGE_SIZE = 20;

export function TriggerDetailPage(props: { params: Params }) {
  const name = props.params.name!;
  const [edit, setEdit] = useQueryParam("edit");
  // Poll faster right after "Run now" so the new run shows up.
  const [fastPollUntil, setFastPollUntil] = useState(0);
  const fast = fastPollUntil > Date.now();
  const path = `/ui/api/automations/triggers/${encodeURIComponent(name)}`;
  const detail = useApi<TriggerDetail>(path, { poll: fast ? 2_000 : 15_000 });
  const [page] = usePage();
  const runs = useApi<RunsResponse>(withQuery(`${path}/runs`, { page, pageSize: PAGE_SIZE }), { poll: fast ? 2_000 : 15_000 });

  useEffect(() => {
    if (!fast) return;
    const id = setTimeout(() => setFastPollUntil(0), fastPollUntil - Date.now());
    return () => clearTimeout(id);
  }, [fast, fastPollUntil]);

  const refetchAll = () => {
    detail.refetch();
    runs.refetch();
  };

  if (!detail.data) {
    if (detail.error) {
      if (/^No trigger named|No such trigger/.test(detail.error)) {
        // /automations/new is a natural guess for the create form.
        if (name === "new") return <Redirect to="/automations?create=1" />;
        return <NotFound what={`Trigger "${name}"`} />;
      }
      return <Alert tone="error">Failed to load: {detail.error}</Alert>;
    }
    return <Loading />;
  }
  const t = detail.data;

  if (edit) {
    return (
      <>
        <PageHeader title={`Edit ${t.name}`} documentTitle={`Edit ${t.name}`} back={{ href: links.trigger(t.name), label: t.name }} badge={<TypeTag type={t.type} />} />
        <EditTriggerForm
          trigger={t}
          onSaved={(updated) => {
            detail.setData(updated);
            setEdit(null, { replace: false });
          }}
        />
      </>
    );
  }

  return (
    <>
      <Header t={t} onChanged={refetchAll} onFired={() => setFastPollUntil(Date.now() + 30_000)} />
      {detail.error && <Alert tone="error">Refresh failed: {detail.error}</Alert>}
      <Stats t={t} />
      <Attention t={t} />
      <div className="grid-2 automations-detail-grid">
        <Configuration t={t} />
        <PromptCard t={t} />
      </div>
      <RunHistory t={t} runs={runs} />
      {t.reminders.length > 0 && <TriggerReminders t={t} onChange={refetchAll} />}
    </>
  );
}

function Header(props: { t: TriggerDetail; onChanged: () => void; onFired: () => void }) {
  const { t } = props;
  const status = useStatus();
  const paused = status.data?.control.paused ?? t.paused;
  const [runOpen, setRunOpen] = useState(false);
  const [payload, setPayload] = useState("");
  const [fired, setFired] = useState<string | null>(null);
  const base = `/ui/api/automations/triggers/${encodeURIComponent(t.name)}`;

  const toggle = useMutation((enabled: boolean) => apiPost(`${base}/toggle`, { enabled }), { onSuccess: props.onChanged });
  const del = useMutation(() => apiDelete(base, {}), { onSuccess: () => navigate(links.automations()) });
  const run = useMutation((p: string) => apiPost<{ firedAt: string }>(`${base}/run`, { payload: p }), {
    onSuccess: (r) => {
      setFired(r.firedAt);
      setRunOpen(false);
      props.onFired();
      status.refetch();
    },
  });

  const runBlocked = paused ? "Atlas is paused" : !t.enabled ? "Enable the trigger to run it" : null;
  // Cron triggers usually take no payload; webhook and manual ones often do.
  const wantsPayload = t.type !== "cron" || t.prompt.includes("{{payload}}");

  return (
    <>
      <PageHeader
        title={t.name}
        documentTitle={t.name}
        back={{ href: links.automations(), label: "Automations" }}
        badge={
          <span className="row automations-title-badges">
            <TypeTag type={t.type} />
            <EnabledBadge enabled={t.enabled} />
          </span>
        }
        subtitle={t.description || undefined}
        actions={
          <>
            <Toggle checked={t.enabled} disabled={toggle.pending} onChange={(v) => toggle.run(v)} label={t.enabled ? "Enabled" : "Disabled"} />
            <Button
              variant="primary"
              disabled={!!runBlocked}
              title={runBlocked ?? undefined}
              pending={run.pending}
              onClick={() => (wantsPayload ? setRunOpen((o) => !o) : run.run(""))}
            >
              Run now
            </Button>
            <ButtonLink href={withQuery(links.trigger(t.name), { edit: 1 })}>Edit</ButtonLink>
            <ConfirmButton
              prompt={`Delete ${t.name}? Run history stays in Activity.`}
              confirmLabel="Delete"
              pending={del.pending}
              onConfirm={() => del.run()}
            >
              Delete
            </ConfirmButton>
          </>
        }
      />
      {(toggle.error || del.error || run.error) && <Alert tone="error">{toggle.error ?? del.error ?? run.error}</Alert>}
      {fired && !run.error && (
        <Alert tone="ok">
          Fired <Time value={fired} />. The run appears under Run history once trigger.sh has started it.
        </Alert>
      )}
      {runOpen && (
        <Card title="Run now" className="automations-run-card">
          <div className="form">
            <TextArea
              label="Payload (optional)"
              value={payload}
              onChange={setPayload}
              rows={5}
              placeholder={t.type === "webhook" ? '{"event": "test"}' : "Text for {{payload}}"}
              hint={
                t.type === "webhook"
                  ? "Sent like a webhook delivery; each run gets its own session key."
                  : "Replaces {{payload}} in the prompt. Runs with the session key _manual."
              }
            />
            <div className="form-actions">
              <Button variant="primary" pending={run.pending} disabled={!!runBlocked} onClick={() => run.run(payload)}>
                Run {t.name}
              </Button>
              <Button variant="ghost" onClick={() => setRunOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

function Stats(props: { t: TriggerDetail }) {
  const { t } = props;
  const { d7, d30 } = t.stats;
  const failRate = d7.runs ? d7.failures / d7.runs : 0;
  return (
    <StatGrid>
      {t.type === "cron" && (
        <Stat
          label="Next run"
          value={t.nextRunAt ? formatRelative(t.nextRunAt) : t.enabled ? "—" : "Off"}
          hint={t.schedule?.text ?? t.schedule?.expr ?? "no schedule"}
          tone={t.nextRunAt ? "accent" : undefined}
        />
      )}
      <Stat
        label="Last run"
        value={t.lastRun ? formatRelative(t.lastRun.startedAt) : "Never"}
        hint={t.lastRun ? (t.lastRun.status === "running" ? "running" : t.lastRun.status === "failed" ? "failed" : "succeeded") : undefined}
        tone={t.lastRun?.status === "failed" ? "error" : t.lastRun?.status === "running" ? "running" : t.lastRun ? "ok" : undefined}
        href={t.lastRun ? links.run(t.lastRun.id) : undefined}
      />
      <Stat label="Runs, 7 days" value={d7.runs} hint={`${d30.runs} in 30 days · avg. ${formatDuration(d7.avgDurationMs)}`} href={links.activity({ trigger: t.name, from: daysAgo(6) })} />
      <Stat
        label="Failures, 7 days"
        value={d7.failures}
        hint={d7.runs ? `${Math.round(failRate * 100)}% of runs` : undefined}
        tone={d7.failures ? "error" : undefined}
        href={links.activity({ trigger: t.name, status: "failed", from: daysAgo(6) })}
      />
      <Stat
        label="Cost, 7 days"
        value={formatMoney(d7.costUsd)}
        hint={`${formatMoney(d30.costUsd)} in 30 days${d7.avgCostUsd != null ? ` · ${formatMoney(d7.avgCostUsd)} per run` : ""}`}
        href={links.usage({ range: "7d", trigger: t.name })}
      />
    </StatGrid>
  );
}

function Attention(props: { t: TriggerDetail }) {
  const { t } = props;
  const items: ReactNode[] = [];
  if (t.type === "cron" && t.schedule && !t.schedule.valid) {
    items.push(
      <Alert key="sched" tone="error">
        The schedule <code>{t.schedule.expr}</code> is invalid ({t.schedule.error}). The crontab skips it, so this trigger never fires on its own.
      </Alert>,
    );
  }
  if (t.type === "cron" && !t.schedule) items.push(<Alert key="nosched" tone="error">No schedule set, so this trigger never fires on its own.</Alert>);
  if (t.model.unknownKey && !t.model.isDefault) {
    items.push(
      <Alert key="model" tone="warn">
        Model key <code>{t.model.key}</code> is not in config.yml, so runs use the <code>{t.model.effectiveKey}</code> model ({t.model.model}).
      </Alert>,
    );
  }
  return (
    <>
      {items}
      {t.runningRuns.length > 0 && (
        <Section title="Running now" count={t.runningRuns.length}>
          <Card flush>
            <DataTable
              dense
              rows={t.runningRuns}
              rowKey={(r) => r.id}
              rowHref={(r) => links.run(r.id)}
              columns={[
                { key: "status", header: "", width: 100, render: () => <RunStatus status="running" /> },
                { key: "run", header: "Run", render: (r) => <Link href={links.run(r.id)}>#{r.id}</Link> },
                { key: "started", header: "Started", render: (r) => <Time value={r.startedAt} /> },
                { key: "elapsed", header: "Elapsed", numeric: true, render: (r) => <Duration ms={r.durationMs} /> },
                { key: "session", header: "Session key", render: (r) => <span className="muted">{r.sessionKey}</span> },
              ]}
            />
          </Card>
        </Section>
      )}
    </>
  );
}

function SecretValue(props: { t: TriggerDetail }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const fetchSecret = async () => (await apiPost<{ secret: string }>(`/ui/api/automations/triggers/${encodeURIComponent(props.t.name)}/secret`, {})).secret;
  const reveal = useMutation(fetchSecret, { onSuccess: setRevealed });
  const w = props.t.webhook!;
  if (!w.hasSecret) return <span className="text-warn">None (anyone with the URL can call it)</span>;
  return (
    <span className="row row-wrap">
      <code>{revealed ?? w.secretMasked}</code>
      <Button size="sm" variant="ghost" onClick={() => (revealed ? setRevealed(null) : reveal.run())} pending={reveal.pending}>
        {revealed ? "Hide" : "Reveal"}
      </Button>
      <CopyButton text={() => (revealed ? Promise.resolve(revealed) : fetchSecret())} />
      {reveal.error && <span className="text-error small">{reveal.error}</span>}
    </span>
  );
}

function Configuration(props: { t: TriggerDetail }) {
  const { t } = props;
  const url = t.webhook ? webhookUrl(t.webhook.path) : null;
  return (
    <Card title="Configuration">
      <KeyValue
        items={[
          ["Type", TYPE_LABEL[t.type]],
          t.type === "cron"
            ? [
                "Schedule",
                t.schedule ? (
                  <div>
                    <div className="strong">{t.schedule.text ?? "Custom schedule"}</div>
                    <div className="muted small">
                      <code>{t.schedule.expr}</code> · {t.timeZone}
                    </div>
                  </div>
                ) : null,
              ]
            : ["Schedule", undefined],
          t.type === "cron" && t.nextRuns.length > 0
            ? [
                "Upcoming",
                <div className="automations-upcoming">
                  {t.nextRuns.map((n) => (
                    <div key={n}>
                      <Time value={n} mode="absolute" /> <span className="faint">({formatRelative(n)})</span>
                    </div>
                  ))}
                </div>,
              ]
            : ["Upcoming", undefined],
          url
            ? [
                "Webhook URL",
                <div className="automations-url">
                  <code className="automations-url-code">POST {url}</code>
                  <CopyButton text={url} />
                </div>,
              ]
            : ["Webhook URL", undefined],
          t.webhook ? ["Secret", <SecretValue t={t} />] : ["Secret", undefined],
          t.webhook?.relayUrl
            ? [
                "Relay URL",
                <div className="automations-url">
                  <code className="automations-url-code">{t.webhook.relayUrl}</code>
                  <CopyButton text={t.webhook.relayUrl} />
                </div>,
              ]
            : ["Relay URL", undefined],
          ["Channel", t.channel],
          ["Session", t.sessionMode === "persistent" ? "Persistent (resumed per session key)" : "Ephemeral (fresh session every run)"],
          [
            "Model",
            <span>
              {t.model.model}{" "}
              <span className="muted">
                ({t.model.isDefault ? `default: ${t.model.key}` : t.model.unknownKey ? `${t.model.key}, unknown → ${t.model.effectiveKey}` : t.model.key})
              </span>{" "}
              <Link href={links.settings("configuration")} className="small">
                config
              </Link>
            </span>,
          ],
          ["Created", t.createdAt ? <Time value={t.createdAt} mode="date" /> : null],
        ]}
      />
    </Card>
  );
}

function PromptCard(props: { t: TriggerDetail }) {
  const { t } = props;
  const source = t.promptSource === "db" ? "database" : t.promptSource === "file" ? t.promptFile : "built-in fallback";
  return (
    <Card title="Prompt" actions={<span className="tag">{source}</span>}>
      {t.promptSource === "default" ? (
        <EmptyState compact title="No prompt set">
          Runs get the fallback text <code>{t.prompt}</code>. Add a prompt with Edit, or write <code>{t.promptFile}</code>.
        </EmptyState>
      ) : (
        <CodeBlock code={t.prompt} maxHeight={420} copy />
      )}
    </Card>
  );
}

function RunHistory(props: { t: TriggerDetail; runs: ApiState<RunsResponse> }) {
  const { t, runs } = props;
  const data = runs.data;
  return (
    <Section
      title="Run history"
      count={data?.total}
      actions={
        <Link href={links.activity({ trigger: t.name })} className="small">
          Open in Activity →
        </Link>
      }
    >
      {runs.error && !data && <Alert tone="error">Failed to load runs: {runs.error}</Alert>}
      {!data && !runs.error && <Loading />}
      {data && (
        <>
          <Card flush>
            <DataTable<RunSummary>
              rows={data.items}
              rowKey={(r) => r.id}
              rowHref={(r) => links.run(r.id)}
              empty={
                <EmptyState compact title="No runs yet">
                  {t.type === "cron" ? "Runs appear here once the schedule fires." : "Runs appear here when the trigger is called, or use Run now."}
                </EmptyState>
              }
              columns={[
                { key: "status", header: "Outcome", width: 110, render: (r) => <RunStatus status={r.status} /> },
                {
                  key: "started",
                  header: "Started",
                  render: (r) => (
                    <div>
                      <Time value={r.startedAt} className="cell-primary" />
                      <div className="cell-secondary">#{r.id}</div>
                    </div>
                  ),
                },
                { key: "duration", header: "Duration", numeric: true, render: (r) => <Duration ms={r.durationMs} /> },
                { key: "cost", header: "Cost", numeric: true, render: (r) => (r.costUsd != null ? <Money usd={r.costUsd} /> : <span className="faint">—</span>) },
                {
                  key: "cause",
                  header: "Session key / payload",
                  render: (r) => (
                    <div className="automations-cause">
                      <div className="muted truncate">{r.sessionKey}</div>
                      {r.payloadPreview && <div className="cell-secondary truncate">{r.payloadPreview}</div>}
                    </div>
                  ),
                },
              ]}
            />
          </Card>
          <Pager pageSize={PAGE_SIZE} total={data.total} itemLabel="runs" />
        </>
      )}
    </Section>
  );
}

function TriggerReminders(props: { t: TriggerDetail; onChange: () => void }) {
  const items = props.t.reminders;
  const data: RemindersResponse = {
    items,
    counts: {
      pending: items.filter((r) => r.status === "pending").length,
      fired: items.filter((r) => r.status === "fired").length,
      cancelled: items.filter((r) => r.status === "cancelled").length,
    },
  };
  return (
    <div className="automations-trigger-reminders">
      <h2 className="section-title automations-subhead">
        Reminders for this trigger <Link href={links.reminders()} className="small">all reminders →</Link>
      </h2>
      <RemindersBody data={data} refetch={props.onChange} />
    </div>
  );
}
