import type { ReactNode } from "react";
import type { HealthState } from "../../ui-api/shared/integrations";

export type Status = "ok" | "warn" | "error" | "idle" | "running";

const DEFAULT_LABEL: Record<Status, string> = {
  ok: "OK",
  warn: "Warning",
  error: "Failed",
  idle: "Idle",
  running: "Running",
};

/** Colored pill with a dot. `running` pulses. */
export function StatusBadge(props: { status: Status; children?: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${props.status}`} title={props.title}>
      <span className="badge-dot" />
      {props.children ?? DEFAULT_LABEL[props.status]}
    </span>
  );
}

/** Integration/service health (GET /ui/api/status) → badge status + label. */
export function healthBadge(state: HealthState): { status: Status; label: string } {
  switch (state) {
    case "running":
      return { status: "ok", label: "Running" };
    case "degraded":
      return { status: "warn", label: "Degraded" };
    case "stopped":
      return { status: "error", label: "Stopped" };
    case "unknown":
      return { status: "idle", label: "Unknown" };
    case "not_configured":
      return { status: "idle", label: "Not configured" };
  }
}

/**
 * Outcome of a trigger run or activity event. `injected` = a message folded
 * into an already running session; `unhandled` = a message no run picked up.
 */
export type Outcome = "running" | "ok" | "failed" | "injected" | "unhandled";

const OUTCOME: Record<Outcome, { status: Status; label: string }> = {
  running: { status: "running", label: "Running" },
  ok: { status: "ok", label: "OK" },
  failed: { status: "error", label: "Failed" },
  injected: { status: "idle", label: "Injected" },
  unhandled: { status: "warn", label: "No run" },
};

export function OutcomeBadge(props: { outcome: Outcome; title?: string }) {
  const o = OUTCOME[props.outcome];
  return (
    <StatusBadge status={o.status} title={props.title}>
      {o.label}
    </StatusBadge>
  );
}
