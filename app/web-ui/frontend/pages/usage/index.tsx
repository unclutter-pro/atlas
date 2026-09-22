/**
 * Usage — "What does it cost?" Aggregates only; every number links into Activity.
 * Owned by the usage area. Server side: ui-api/usage.ts.
 */

import type { ReactNode } from "react";
import { useApi } from "../../api";
import {
  ApiView,
  buttonClass,
  Card,
  DataTable,
  EmptyState,
  formatMoney,
  formatNumber,
  formatPercent,
  Duration,
  Money,
  NotFound,
  Num,
  PageHeader,
  Section,
  Stat,
  StatGrid,
  type Column,
} from "../../components";
import { links, type ActivityFilter } from "../../links";
import { Link, Routes, useSearchParams, withQuery } from "../../router";
import type { UsageBreakdownRow, UsageResponse, UsageTotals, UsageType } from "../../../ui-api/usage";
import { BarChart } from "./BarChart";
import "./usage.css";

export default function UsagePage() {
  return <Routes routes={[{ path: "/usage", component: UsageHome }]} fallback={<NotFound />} />;
}

const RANGES = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "custom", label: "Custom" },
];

const TYPE_LABELS: Record<UsageType, string> = {
  cron: "Scheduled (cron)",
  webhook: "Webhook",
  manual: "Manual / messages",
  direct: "Direct sessions",
  other: "Deleted triggers",
};

const METRICS = {
  cost: { label: "Cost", value: (d: UsageResponse["series"][number]) => d.costUsd, format: (v: number) => formatMoney(v) },
  runs: { label: "Runs", value: (d: UsageResponse["series"][number]) => d.runs, format: (v: number) => formatNumber(v) },
  tokens: { label: "Tokens", value: (d: UsageResponse["series"][number]) => d.tokens, format: (v: number) => formatNumber(v, true) },
} as const;
type Metric = keyof typeof METRICS;

function UsageHome() {
  const [params, update] = useSearchParams();
  const range = params.get("range") || (params.get("from") || params.get("to") ? "custom" : "");
  const trigger = params.get("trigger") || "";
  const type = params.get("type") || "";
  const metric: Metric = (params.get("metric") as Metric) in METRICS ? (params.get("metric") as Metric) : "cost";
  const apiQuery = {
    range,
    from: range === "custom" ? params.get("from") : null,
    to: range === "custom" ? params.get("to") : null,
    trigger,
    type,
  };
  const usage = useApi<UsageResponse>(withQuery("/ui/api/usage", apiQuery));
  const data = usage.data;

  return (
    <>
      <PageHeader
        title="Usage"
        subtitle={data ? `${formatDay(data.range.from)} – ${formatDay(data.range.to)} (${data.timeZone})` : undefined}
        actions={
          <a className={buttonClass("secondary", "sm")} href={withQuery("/ui/api/usage/export.csv", { ...apiQuery, from: data?.range.from, to: data?.range.to, range: data ? "custom" : range })} download>
            Export CSV
          </a>
        }
      />

      <div className="toolbar usage-toolbar">
        <div className="usage-segmented" role="group" aria-label="Time range">
          {RANGES.map((r) => {
            const active = (data?.range.key ?? (range || "30d")) === r.key;
            return (
              <button
                key={r.key}
                type="button"
                className={active ? "is-active" : undefined}
                aria-pressed={active}
                onClick={() =>
                  r.key === "custom"
                    ? update({ range: "custom", from: data?.range.from, to: data?.range.to }, { replace: false })
                    : update({ range: r.key, from: null, to: null }, { replace: false })
                }
              >
                {r.label}
              </button>
            );
          })}
        </div>
        {range === "custom" && (
          <div className="row usage-dates">
            <input className="input" type="date" aria-label="From" value={params.get("from") ?? data?.range.from ?? ""} max={params.get("to") ?? undefined} onChange={(e) => update({ from: e.target.value })} />
            <span className="faint">to</span>
            <input className="input" type="date" aria-label="To" value={params.get("to") ?? data?.range.to ?? ""} min={params.get("from") ?? undefined} onChange={(e) => update({ to: e.target.value })} />
          </div>
        )}
        {trigger && <FilterChip label="Trigger" value={trigger} onClear={() => update({ trigger: null }, { replace: false })} />}
        {type && <FilterChip label="Type" value={TYPE_LABELS[type as UsageType] ?? type} onClear={() => update({ type: null }, { replace: false })} />}
      </div>

      <ApiView state={usage}>{(d) => <UsageBody data={d} metric={metric} onMetric={(m) => update({ metric: m === "cost" ? null : m })} />}</ApiView>
    </>
  );
}

function FilterChip(props: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="usage-chip">
      <span className="faint">{props.label}:</span> <span className="strong">{props.value}</span>
      <button type="button" aria-label={`Clear ${props.label.toLowerCase()} filter`} onClick={props.onClear}>
        ×
      </button>
    </span>
  );
}

function UsageBody({ data, metric, onMetric }: { data: UsageResponse; metric: Metric; onMetric: (m: Metric) => void }) {
  const { totals: t, previousTotals: p, range } = data;
  // Activity filter matching the current usage view.
  const base: ActivityFilter = {
    from: range.from,
    to: range.to,
    trigger: data.filter.trigger ?? undefined,
    type: data.filter.type && data.filter.type !== "other" ? data.filter.type : undefined,
  };
  const prevLabel = `previous ${range.days} ${range.days === 1 ? "day" : "days"}`;

  if (t.runs === 0 && p.runs === 0) {
    return (
      <EmptyState title="No sessions in this period.">
        {data.firstDate
          ? `Usage is recorded per Claude session. The earliest recorded session is from ${formatDay(data.firstDate)}.`
          : "Usage is recorded per Claude session once a trigger or direct session finishes. Nothing has been recorded yet."}
      </EmptyState>
    );
  }

  const m = METRICS[metric];
  const points = data.series.map((d) => ({
    key: d.date,
    value: m.value(d),
    label: shortDay(d.date),
    href: links.activity({ ...base, from: d.date, to: d.date }),
    tooltip: (
      <>
        <div className="strong">{formatDay(d.date)}</div>
        <div>
          {formatMoney(d.costUsd)} · {formatNumber(d.runs)} {d.runs === 1 ? "run" : "runs"}
        </div>
        {d.errors > 0 && <div className="text-error">{d.errors} failed</div>}
        <div className="faint">{formatNumber(d.tokens, true)} tokens</div>
      </>
    ),
  }));

  return (
    <>
      <StatGrid>
        <Stat label="Total cost" value={<Money usd={t.costUsd} />} tone="accent" href={links.activity(base)} hint={<Delta cur={t.costUsd} prev={p.costUsd} upIsBad label={prevLabel} />} />
        <Stat label="Runs" value={<Num value={t.runs} />} href={links.activity(base)} hint={<Delta cur={t.runs} prev={p.runs} label={prevLabel} />} />
        <Stat label="Avg cost / run" value={<Money usd={t.avgCostUsd} />} href={links.activity(base)} hint={<Delta cur={t.avgCostUsd} prev={p.avgCostUsd} upIsBad label={prevLabel} />} />
        <Stat
          label="Error rate"
          value={formatPercent(t.errorRate, 1)}
          tone={t.errors > 0 ? "error" : "ok"}
          href={links.activity({ ...base, status: "failed" })}
          hint={
            <>
              {formatNumber(t.errors)} failed{p.errorRate != null && <> · <PointsDelta cur={t.errorRate} prev={p.errorRate} /></>}
            </>
          }
        />
        <Stat label="Tokens" value={<Num value={t.tokens} compact />} href={links.activity(base)} hint={<TokenHint t={t} />} />
      </StatGrid>

      <Section
        title={`${m.label} per day`}
        actions={
          <div className="usage-segmented usage-segmented-sm" role="group" aria-label="Chart metric">
            {(Object.keys(METRICS) as Metric[]).map((k) => (
              <button key={k} type="button" className={k === metric ? "is-active" : undefined} aria-pressed={k === metric} onClick={() => onMetric(k)}>
                {METRICS[k].label}
              </button>
            ))}
          </div>
        }
      >
        <Card>
          <BarChart points={points} formatValue={m.format} ariaLabel={`${m.label} per day, ${range.from} to ${range.to}`} />
        </Card>
      </Section>

      <Section title="By trigger" count={data.byTrigger.length}>
        <Card flush>
          <DataTable
            rows={data.byTrigger}
            rowKey={(r) => `${r.trigger ?? ""}:${r.type}`}
            rowHref={(r) => links.activity(r.trigger ? { ...base, trigger: r.trigger, ...(r.type === "direct" ? { type: "direct" } : {}) } : { ...base, type: "direct" })}
            empty={<EmptyState compact title="No runs in this period." />}
            columns={[
              {
                key: "trigger",
                header: "Trigger",
                render: (r) =>
                  r.trigger ? (
                    <>
                      {/* Direct sessions can carry a trigger_name (e.g. the validator) without a trigger existing. */}
                      {r.type === "direct" ? (
                        <span className="cell-primary">{r.trigger}</span>
                      ) : (
                        <Link href={links.trigger(r.trigger)} className="cell-primary">
                          {r.trigger}
                        </Link>
                      )}
                      <span className="cell-secondary">{TYPE_LABELS[r.type]}</span>
                    </>
                  ) : (
                    <>
                      <span className="cell-primary">Direct sessions</span>
                      <span className="cell-secondary">No trigger</span>
                    </>
                  ),
              },
              ...breakdownColumns<UsageResponse["byTrigger"][number]>((r) => (r.trigger ? { ...base, trigger: r.trigger } : { ...base, type: "direct" })),
            ]}
          />
        </Card>
      </Section>

      <Section title="By type" count={data.byType.length}>
        <Card flush>
          <DataTable
            rows={data.byType}
            rowKey={(r) => r.type}
            rowHref={(r) => (r.type === "other" ? null : links.activity({ ...base, type: r.type }))}
            empty={<EmptyState compact title="No runs in this period." />}
            columns={[
              { key: "type", header: "Type", render: (r) => <span className="cell-primary">{TYPE_LABELS[r.type] ?? r.type}</span> },
              ...breakdownColumns<UsageResponse["byType"][number]>((r) => (r.type === "other" ? null : { ...base, type: r.type })),
            ]}
          />
        </Card>
      </Section>
    </>
  );
}

/** Cost with share bar, runs, failures (linked), avg duration. */
function breakdownColumns<T extends UsageBreakdownRow>(filter: (r: T) => ActivityFilter | null): Column<T>[] {
  return [
    {
      key: "cost",
      header: "Cost",
      numeric: true,
      width: 110,
      render: (r) => <Money usd={r.costUsd} className="strong" />,
    },
    {
      key: "share",
      header: "Share",
      width: 170,
      render: (r) => (
        <div className="usage-share" title={formatPercent(r.share, 1)}>
          <div className="usage-share-track">
            <div className="usage-share-fill" style={{ width: `${Math.max(r.share * 100, r.share > 0 ? 1 : 0)}%` }} />
          </div>
          <span className="num muted">{formatPercent(r.share)}</span>
        </div>
      ),
    },
    { key: "runs", header: "Runs", numeric: true, render: (r) => <Num value={r.runs} /> },
    {
      key: "errors",
      header: "Failed",
      numeric: true,
      render: (r) => {
        const f = filter(r);
        if (!r.errors) return <span className="faint">0</span>;
        return f ? (
          <Link href={links.activity({ ...f, status: "failed" })} className="text-error">
            {r.errors}
          </Link>
        ) : (
          <span className="text-error">{r.errors}</span>
        );
      },
    },
    { key: "avg", header: "Avg duration", numeric: true, render: (r) => <Duration ms={r.avgDurationMs} className="muted" /> },
  ];
}

/** "+12% vs previous 7 days", colored when the direction is good/bad. */
function Delta(props: { cur: number | null; prev: number | null; label: string; upIsBad?: boolean }) {
  const { cur, prev } = props;
  if (cur == null || prev == null || prev === 0) return <span>{cur === prev ? "No change vs" : "Nothing in"} {props.label}</span>;
  const ratio = (cur - prev) / prev;
  if (Math.abs(ratio) < 0.005) return <span>No change vs {props.label}</span>;
  const cls = props.upIsBad ? (ratio > 0 ? "text-warn" : "text-ok") : undefined;
  return (
    <span>
      <span className={cls}>
        {ratio > 0 ? "+" : "−"}
        {formatPercent(Math.abs(ratio))}
      </span>{" "}
      vs {props.label}
    </span>
  );
}

/** Error-rate change in percentage points. */
function PointsDelta(props: { cur: number | null; prev: number | null }) {
  if (props.cur == null || props.prev == null) return null;
  const diff = (props.cur - props.prev) * 100;
  if (Math.abs(diff) < 0.05) return <span>no change</span>;
  return (
    <span className={diff > 0 ? "text-warn" : "text-ok"}>
      {diff > 0 ? "+" : "−"}
      {Math.abs(diff).toFixed(1)} pts
    </span>
  );
}

function TokenHint({ t }: { t: UsageTotals }): ReactNode {
  return (
    <span title={`Input ${formatNumber(t.inputTokens)} · output ${formatNumber(t.outputTokens)} · cache read ${formatNumber(t.cacheReadTokens)} · cache write ${formatNumber(t.cacheCreationTokens)}`}>
      {formatNumber(t.inputTokens, true)} in · {formatNumber(t.outputTokens, true)} out · {formatNumber(t.cacheReadTokens, true)} cached
    </span>
  );
}

const dayDate = (d: string) => new Date(`${d}T00:00:00Z`);
const formatDay = (d: string) => dayDate(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDay = (d: string) => dayDate(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
