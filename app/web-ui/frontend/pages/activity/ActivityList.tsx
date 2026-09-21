/** /activity — the timeline: filters in the URL, grouped by day, load older by cursor. */

import { useEffect, useMemo, useState } from "react";
import { apiGet, errorMessage, useApi } from "../../api";
import { Alert, Button, EmptyState, Loading, Money, Duration, PageHeader, Select, TextField, formatAbsolute, formatMoney, parseTime, OutcomeBadge, todayYMD, zoneOptions } from "../../components";
import { Link, useSearchParams, withQuery } from "../../router";
import type { ActivityFiltersResponse, ActivityItem, ActivityListResponse } from "../../../ui-api/activity";
import { CauseTag, itemHref } from "./shared";

const PAGE_SIZE = 50;
const FILTER_KEYS = ["trigger", "status", "channel", "type", "from", "to", "q"] as const;

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
  { value: "ok", label: "OK" },
];

const TYPE_OPTIONS = [
  { value: "", label: "All causes" },
  { value: "cron", label: "Cron" },
  { value: "webhook", label: "Webhook" },
  { value: "manual", label: "Manual" },
  { value: "direct", label: "Direct sessions" },
  { value: "trigger", label: "Trigger activity only" },
];

function localDay(at: string | null): string {
  return formatAbsolute(at).slice(0, 10);
}

function dayLabel(day: string): string {
  const today = todayYMD();
  const yesterday = todayYMD(-1);
  const d = parseTime(day);
  const long = d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...zoneOptions() }) : day;
  if (day === today) return `Today · ${long}`;
  if (day === yesterday) return `Yesterday · ${long}`;
  return long;
}

function timeOfDay(at: string | null): string {
  return formatAbsolute(at).slice(11, 16);
}

export function ActivityList() {
  const [params, update] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ""])) as Record<(typeof FILTER_KEYS)[number], string>;
  const active = FILTER_KEYS.some((k) => filters[k]);

  // from/to are UTC days (like Usage and Overview), so no tz is sent.
  const path = withQuery("/ui/api/activity", { ...filters, limit: PAGE_SIZE });

  // Older pages loaded with "Load older"; reset whenever the filters change.
  const [older, setOlder] = useState<{ path: string; items: ActivityItem[]; cursor: string | null } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const extra = older?.path === path ? older : null;

  // Only poll the first page while no older pages hang below it (they would drift apart).
  const first = useApi<ActivityListResponse>(path, { poll: extra ? undefined : 10_000 });
  const options = useApi<ActivityFiltersResponse>("/ui/api/activity/filters");

  const items = useMemo(() => {
    const seen = new Set<string>();
    return [...(first.data?.items ?? []), ...(extra?.items ?? [])].filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  }, [first.data, extra]);
  const nextCursor = extra ? extra.cursor : (first.data?.nextCursor ?? null);

  const loadOlder = async () => {
    if (!nextCursor) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const res = await apiGet<ActivityListResponse>(withQuery(path, { cursor: nextCursor }));
      setOlder({ path, items: [...(extra?.items ?? []), ...res.items], cursor: res.nextCursor });
    } catch (err) {
      setOlderError(errorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const groups = useMemo(() => {
    const out: Array<{ day: string; items: ActivityItem[]; cost: number }> = [];
    for (const item of items) {
      const day = localDay(item.at);
      let g = out.at(-1);
      if (!g || g.day !== day) out.push((g = { day, items: [], cost: 0 }));
      g.items.push(item);
      g.cost += item.costUsd ?? 0;
    }
    return out;
  }, [items]);

  const triggerOptions = [{ value: "", label: "All triggers" }, ...(options.data?.triggers ?? []).map((t) => ({ value: t.name, label: t.name }))];
  if (filters.trigger && !triggerOptions.some((o) => o.value === filters.trigger)) triggerOptions.push({ value: filters.trigger, label: filters.trigger });
  const channelOptions = [{ value: "", label: "All channels" }, ...(options.data?.channels ?? []).map((c) => ({ value: c, label: c }))];
  if (filters.channel && !channelOptions.some((o) => o.value === filters.channel)) channelOptions.push({ value: filters.channel, label: filters.channel });

  return (
    <>
      <PageHeader title="Activity" />

      <div className="activity-status-tabs" role="tablist">
        {STATUS_TABS.map((t) => (
          <Link
            key={t.value}
            href={withQuery("/activity", { ...filters, status: t.value })}
            replace
            className={`activity-status-tab${filters.status === t.value ? " active" : ""}${t.value ? ` is-${t.value}` : ""}`}
            role="tab"
            aria-selected={filters.status === t.value}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <div className="toolbar activity-filters">
        <SearchBox value={filters.q} onChange={(q) => update({ q })} />
        <Select value={filters.type} onChange={(type) => update({ type })} options={TYPE_OPTIONS} />
        <Select value={filters.trigger} onChange={(trigger) => update({ trigger })} options={triggerOptions} />
        <Select value={filters.channel} onChange={(channel) => update({ channel })} options={channelOptions} />
        <div className="activity-dates">
          <TextField type="date" value={filters.from} onChange={(from) => update({ from })} />
          <span className="faint">–</span>
          <TextField type="date" value={filters.to} onChange={(to) => update({ to })} />
        </div>
        {active && (
          <Button size="sm" variant="ghost" onClick={() => update(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))}>
            Clear filters
          </Button>
        )}
      </div>

      {first.error && <Alert tone="error">{first.data ? `Refresh failed: ${first.error}` : `Failed to load: ${first.error}`}</Alert>}
      {!first.data && !first.error && <Loading />}

      {first.data && items.length === 0 && (
        <EmptyState title={active ? "Nothing matches these filters." : "No activity yet."}>
          {active
            ? "Try a wider date range or clear the filters."
            : "Runs appear here when a trigger fires: a cron schedule, a webhook, an inbound message or a manual run."}
        </EmptyState>
      )}

      {groups.map((g) => (
        <section key={g.day} className="activity-day">
          <header className="activity-day-header">
            <span className="activity-day-label">{dayLabel(g.day)}</span>
            <span className="faint">
              {g.items.length} event{g.items.length === 1 ? "" : "s"}
              {g.cost > 0 && ` · ${formatMoney(g.cost)}`}
            </span>
          </header>
          <div className="activity-rows">
            {g.items.map((item) => (
              <Row key={item.key} item={item} />
            ))}
          </div>
        </section>
      ))}

      {olderError && <Alert tone="error">Could not load older events: {olderError}</Alert>}
      {first.data && nextCursor && (
        <div className="activity-more-row">
          <Button onClick={loadOlder} pending={loadingOlder}>
            Load older
          </Button>
        </div>
      )}
    </>
  );
}

function Row(props: { item: ActivityItem }) {
  const i = props.item;
  const href = itemHref(i);
  const who = i.kind === "session" ? (i.trigger ?? (i.sessionId ? `session ${i.sessionId.slice(0, 8)}` : null)) : i.trigger;
  const secondary = [who, i.sender, i.kind === "message" && i.outcome === "injected" && i.relatedRunId != null ? `into run #${i.relatedRunId}` : null].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="activity-row-time num">{timeOfDay(i.at)}</span>
      <span className="activity-row-cause">
        <CauseTag cause={i.cause} channel={i.channel} />
      </span>
      <span className="activity-row-main">
        <span className="activity-row-summary">{i.summary || <span className="faint">{i.kind === "run" ? `Run #${i.runId}` : "—"}</span>}</span>
        <span className="activity-row-sub">
          {secondary}
          {i.error && <span className="activity-row-error"> — {i.error}</span>}
        </span>
      </span>
      <span className="activity-row-outcome">
        <OutcomeBadge outcome={i.outcome} />
      </span>
      <span className="activity-row-num">{i.durationMs != null ? <Duration ms={i.durationMs} /> : <span className="faint">—</span>}</span>
      <span className="activity-row-num">{i.costUsd != null ? <Money usd={i.costUsd} /> : <span className="faint">—</span>}</span>
    </>
  );
  const cls = `activity-row is-${i.outcome}`;
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Text filter: typing updates the URL after a short pause. */
function SearchBox(props: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  useEffect(() => {
    if (text === props.value) return;
    const id = setTimeout(() => props.onChange(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="activity-search">
      <TextField type="search" value={text} onChange={setText} placeholder="Search messages, payloads, sessions…" onEnter={() => props.onChange(text.trim())} />
    </div>
  );
}
