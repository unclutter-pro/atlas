/** Small building blocks shared by the automations pages. */

import { OutcomeBadge, StatusBadge, formatDuration, todayYMD } from "../../components";
import type { RunOutcome, TriggerType } from "../../../ui-api/automations";

export const TYPE_LABEL: Record<TriggerType, string> = {
  cron: "Scheduled",
  webhook: "Webhook",
  manual: "Manual",
};

export function TypeTag(props: { type: TriggerType }) {
  return <span className={`tag automations-type automations-type-${props.type}`}>{props.type}</span>;
}

export function RunStatus(props: { status: RunOutcome | null | undefined }) {
  if (!props.status) return <span className="faint">Never run</span>;
  return <OutcomeBadge outcome={props.status} />;
}

export function EnabledBadge(props: { enabled: boolean }) {
  return props.enabled ? <StatusBadge status="ok">Enabled</StatusBadge> : <StatusBadge status="idle">Disabled</StatusBadge>;
}

/** Absolute webhook URL on this server (matches POST /api/webhook/:name in index.ts). */
export function webhookUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

/** Calendar day ("YYYY-MM-DD") n days ago, in the Atlas zone; Activity/Usage date filters use that zone. */
export function daysAgo(n: number): string {
  return todayYMD(-n);
}

export function formatInterval(seconds: number): string {
  return `every ${formatDuration(seconds * 1000).replace(/ 00[sm]$/, "")}`;
}
