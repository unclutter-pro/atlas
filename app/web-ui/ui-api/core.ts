/**
 * Cross-cutting endpoints used by the app shell: meta, status strip, kill switch.
 * Control endpoints take a JSON body (readJson) so cross-site form posts can't reach them.
 */

import { pauseAtlas, resumeAtlas, stopAllSessions } from "../../lib/kill-switch";
import { resolveTimezone, type TimezoneSource } from "../../lib/timezone";
import { notifyAllChats } from "./chat/hub";
import { agentName, getDb, home } from "./shared/env";
import { badRequest, handler, json, readJson, type ApiRoutes } from "./shared/http";
import { getStatus, type StatusResponse } from "./shared/status";

export interface MetaResponse {
  agentName: string;
  /** IANA zone Atlas uses for day boundaries, cron scheduling and agent sessions (lib/timezone.ts's resolveTimezone). */
  timeZone: string;
  /** Where `timeZone` came from; "config"/"env" mean an explicit `timezone:`/ATLAS_TIMEZONE, "runtime" the container's own zone, "default" is the UTC fallback. */
  timeZoneSource: TimezoneSource;
}

export interface StopResponse extends StatusResponse {
  /** Sessions whose process was actually signalled. */
  killed: number;
  /** Runs marked completed (includes runs without a live process). */
  closed: number;
}

export const routes: ApiRoutes = {
  "/ui/api/meta": {
    GET: handler(() => {
      const tz = resolveTimezone(home());
      return json({ agentName: agentName(), timeZone: tz.timeZone, timeZoneSource: tz.source } satisfies MetaResponse);
    }),
  },

  "/ui/api/status": {
    GET: handler(() => json(getStatus())),
  },

  "/ui/api/control/pause": {
    POST: handler(async (req) => {
      await readJson(req);
      pauseAtlas(getDb(), home());
      return json(getStatus());
    }),
  },

  "/ui/api/control/resume": {
    POST: handler(async (req) => {
      await readJson(req);
      resumeAtlas(getDb(), home());
      return json(getStatus());
    }),
  },

  // Kills every running session and pauses. Requires {"confirm": true}.
  "/ui/api/control/stop": {
    POST: handler(async (req) => {
      const body = await readJson<{ confirm?: boolean }>(req);
      if (body.confirm !== true) badRequest('Stop requires {"confirm": true}');
      const { killed, closed } = stopAllSessions(getDb(), home());
      notifyAllChats();
      return json({ ...getStatus(), killed, closed } satisfies StopResponse);
    }),
  },
};
