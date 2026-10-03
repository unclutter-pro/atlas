/**
 * /ui/api/overview — "Is everything running, what is happening right now?"
 * Backs frontend/pages/overview/. Query logic lives in ui-api/overview/.
 *
 * Control state and integration health for the status strip still come from
 * GET /ui/api/status; this endpoint adds what only the Overview needs.
 */

import { handler, intParam, json, query, type ApiRoutes } from "./shared/http";
import { getOverview, type FullVolume } from "./overview/queries";
import { loadVolumes } from "./storage/volumes";

export type {
  OverviewResponse,
  OverviewRun,
  FailedRun,
  WebhookFailure,
  UpcomingItem,
  WaitingReminder,
  TodayTotals,
} from "./overview/queries";

export const routes: ApiRoutes = {
  // ?upcoming=<n> (1-50, default 8) caps the "coming up" list.
  "/ui/api/overview": {
    GET: handler(async (req) => {
      const q = query(req);
      return json(getOverview(new Date(), { upcomingLimit: intParam(q.get("upcoming"), 8, 1, 50), volumesFull: await fullVolumes() }));
    }),
  },
};

async function fullVolumes(): Promise<FullVolume[]> {
  try {
    const { volumes } = await loadVolumes();
    return volumes.flatMap((v) =>
      v.status === "ok"
        ? []
        : [{ label: v.roles.map((r) => r.label).join(" / "), path: v.roles[0]!.path, usedPercent: v.usedPercent, freeBytes: v.freeBytes, status: v.status }],
    );
  } catch {
    return [];
  }
}
