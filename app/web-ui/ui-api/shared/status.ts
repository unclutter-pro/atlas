/**
 * System status snapshot behind GET /ui/api/status — the status strip on
 * every page polls it. Overview and Settings can call getStatus() directly.
 */

import { getControlStatus } from "../../../lib/kill-switch";
import { agentName, elapsedMs, getDb, home, toIso } from "./env";
import { getIntegrationHealth, getServiceHealth, type IntegrationHealth, type ServiceHealth } from "./integrations";

export interface RunningRun {
  /** trigger_runs.id — detail page /activity/:id */
  id: number;
  triggerName: string;
  sessionKey: string;
  sessionMode: string;
  sessionId: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
}

export interface StatusResponse {
  agentName: string;
  serverTime: string;
  control: { paused: boolean; pausedAt: string | null };
  running: RunningRun[];
  integrations: IntegrationHealth[];
  services: ServiceHealth[];
}

export function getRunningRuns(): RunningRun[] {
  const rows = getDb()
    .query(
      `SELECT id, trigger_name, session_key, session_mode, session_id, started_at
       FROM trigger_runs WHERE completed_at IS NULL ORDER BY started_at DESC`,
    )
    .all() as Array<{
    id: number;
    trigger_name: string;
    session_key: string;
    session_mode: string;
    session_id: string | null;
    started_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    triggerName: r.trigger_name,
    sessionKey: r.session_key,
    sessionMode: r.session_mode,
    sessionId: r.session_id,
    startedAt: toIso(r.started_at),
    elapsedMs: elapsedMs(r.started_at),
  }));
}

export function getStatus(): StatusResponse {
  const control = getControlStatus(getDb(), home());
  return {
    agentName: agentName(),
    serverTime: new Date().toISOString(),
    control: { paused: control.paused, pausedAt: toIso(control.paused_at) },
    running: getRunningRuns(),
    integrations: getIntegrationHealth(),
    services: getServiceHealth(),
  };
}
