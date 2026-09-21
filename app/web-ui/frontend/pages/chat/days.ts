/** Sidebar grouping: Today / Yesterday / Earlier, by calendar day in the Atlas zone. */

import { parseTime, todayYMD, zoneOptions } from "../../components";
import type { ChatSessionSummary } from "../../../ui-api/chat/types";

export type DayBucket = "Today" | "Yesterday" | "Earlier";
export const DAY_BUCKETS: DayBucket[] = ["Today", "Yesterday", "Earlier"];

/** "YYYY-MM-DD" of an instant in the Atlas zone (browser zone until it is known). */
export function ymdInZone(value: string | null | undefined, timeZone = zoneOptions().timeZone): string | null {
  const d = parseTime(value);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Keeps the input order (lastActivityAt desc) inside each bucket; empty buckets are omitted. */
export function bucketSessions(
  sessions: ChatSessionSummary[],
  opts: { today?: string; yesterday?: string; ymd?: (iso: string) => string | null } = {},
): { label: DayBucket; sessions: ChatSessionSummary[] }[] {
  const today = opts.today ?? todayYMD();
  const yesterday = opts.yesterday ?? todayYMD(-1);
  const ymd = opts.ymd ?? ((iso: string) => ymdInZone(iso));
  const groups: Record<DayBucket, ChatSessionSummary[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const s of sessions) {
    const day = ymd(s.lastActivityAt);
    groups[day === today ? "Today" : day === yesterday ? "Yesterday" : "Earlier"].push(s);
  }
  return DAY_BUCKETS.filter((b) => groups[b].length).map((label) => ({ label, sessions: groups[label] }));
}

export function sessionTitle(s: Pick<ChatSessionSummary, "title" | "isDefault">): string {
  return s.title?.trim() || (s.isDefault ? "Default chat" : "New chat");
}
