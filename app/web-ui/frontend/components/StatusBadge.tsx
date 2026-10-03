import type { ReactNode } from "react";
import type { AuthState } from "../../../lib/harness/auth";
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

/** Login state of the agent backend → badge status + label. */
export function authBadge(state: AuthState): { status: Status; label: string } {
  switch (state) {
    case "ok":
      return { status: "ok", label: "Logged in" };
    case "expiring":
      return { status: "warn", label: "Expiring" };
    case "expired":
      return { status: "error", label: "Expired" };
    case "failed":
      return { status: "error", label: "Rejected" };
    case "missing":
      return { status: "error", label: "Not logged in" };
  }
}

/** Small key glyph for login state; inherits the text color. */
export function KeyIcon(props: { title?: string }) {
  return (
    <svg className="key-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden={props.title ? undefined : true} role={props.title ? "img" : undefined}>
      {props.title && <title>{props.title}</title>}
      <circle cx="5" cy="11" r="3" />
      <path d="M7.2 8.8 14 2M11.5 4.5l2 2M9.8 6.2l1.5 1.5" strokeLinecap="round" />
    </svg>
  );
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
