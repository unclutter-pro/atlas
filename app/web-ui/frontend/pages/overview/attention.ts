/** Flattens the overview's attention data into one list, most severe first. */

import { formatBytes, formatDuration, formatRelative } from "../../components";
import { links } from "../../links";
import type { OverviewResponse } from "../../../ui-api/overview";

export interface AttentionItem {
  key: string;
  tone: "error" | "warn";
  title: string;
  detail: string | null;
  /** When it happened (ISO); shown relative. */
  at: string | null;
  href: string | null;
}

/** YYYY-MM-DD of the day before `date` (calendar arithmetic, no time zone). */
export function previousDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return prev.toISOString().slice(0, 10);
}

export function attentionItems(o: OverviewResponse, now = Date.now()): AttentionItem[] {
  const a = o.attention;
  const items: AttentionItem[] = [];

  for (const v of a.volumesFull) {
    items.push({
      key: `volume-${v.path}`,
      tone: v.status,
      title: `${v.label} is ${Math.round(v.usedPercent)}% full`,
      detail: `${formatBytes(v.freeBytes)} free on ${v.path}`,
      at: null,
      href: links.storage(),
    });
  }

  for (const i of a.integrationsDown) {
    items.push({
      key: `integration-${i.key}`,
      tone: i.state === "stopped" ? "error" : "warn",
      title: `${i.label} is ${i.state === "stopped" ? "down" : "degraded"}`,
      detail: i.detail,
      at: null,
      href: links.settings("integrations"),
    });
  }

  for (const r of a.stuckRuns) {
    const silentSince = r.lastActivityAt ?? r.startedAt;
    const silentMs = silentSince ? now - Date.parse(silentSince) : null;
    items.push({
      key: `stuck-${r.id}`,
      tone: "warn",
      title: `${r.triggerName} looks stuck`,
      detail: `No activity for ${formatDuration(silentMs)}${r.sessionId ? "" : ", no session started"}`,
      at: r.startedAt,
      href: links.run(r.id),
    });
  }

  for (const r of a.failedRuns) {
    items.push({
      key: `failed-${r.id}`,
      tone: "error",
      title: `${r.triggerName} failed`,
      detail: r.summary,
      at: r.startedAt,
      href: links.run(r.id),
    });
  }

  for (const r of a.overdueReminders) {
    items.push({
      key: `overdue-${r.id}`,
      tone: "warn",
      title: `Reminder overdue: ${r.title}`,
      detail: `Was due ${formatRelative(r.fireAt, now)}; the reminder check may not be running`,
      at: r.fireAt,
      href: links.reminders(),
    });
  }

  for (const s of a.invalidSchedules) {
    items.push({
      key: `schedule-${s.triggerName}`,
      tone: "warn",
      title: `${s.triggerName} never runs`,
      detail: s.schedule ? `Unsupported schedule "${s.schedule}"` : "Cron trigger without a schedule",
      at: null,
      href: links.trigger(s.triggerName),
    });
  }

  for (const w of a.webhookFailures) {
    const host = w.url.replace(/^https?:\/\//, "").split("/")[0];
    items.push({
      key: `webhook-${w.id}`,
      tone: w.gaveUp ? "error" : "warn",
      title: w.gaveUp ? `Usage webhook to ${host} gave up` : `Usage webhook to ${host} is failing`,
      detail: [
        `${w.attempts} ${w.attempts === 1 ? "attempt" : "attempts"}`,
        w.lastError,
        !w.gaveUp && w.nextRetryAt ? `next retry ${formatRelative(w.nextRetryAt, now)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      at: w.createdAt,
      href: links.settings("configuration"),
    });
  }

  return items;
}
