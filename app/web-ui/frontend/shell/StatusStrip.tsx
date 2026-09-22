import { useState } from "react";
import { apiPost, useMutation } from "../api";
import type { StopResponse } from "../../ui-api/core";
import { Button, ConfirmButton, StatusBadge, formatDuration } from "../components";
import { links } from "../links";
import { Link } from "../router";
import { useStatus, type StatusResponse } from "./status";

/** Persistent strip above every page: state, running runs, trouble, kill switch. */
export function StatusStrip() {
  const status = useStatus();
  const s = status.data;
  const [stopResult, setStopResult] = useState<string | null>(null);
  const control = useMutation((action: "pause" | "resume" | "stop") =>
    apiPost<StatusResponse | StopResponse>(`/ui/api/control/${action}`, action === "stop" ? { confirm: true } : {}),
  {
    onSuccess: (data) => {
      status.setData(data);
      setStopResult("killed" in data ? describeStop(data) : null);
    },
  });

  if (!s) {
    return (
      <div className="status-strip">
        <span className="status-strip-item">{status.error ? `Status unavailable: ${status.error}` : "Loading status…"}</span>
      </div>
    );
  }

  const paused = s.control.paused;
  const running = s.running.length;
  // Pause stops the scheduler on purpose — don't report it as down.
  const troubled = [...s.integrations, ...s.services.filter((svc) => !(paused && svc.name === "supercronic"))].filter(
    (i) => i.state === "stopped" || i.state === "degraded",
  );
  const longest = running ? Math.max(...s.running.map((r) => r.elapsedMs ?? 0)) : 0;

  return (
    <div className={`status-strip${paused ? " is-paused" : ""}`} role="status">
      <span className="status-strip-state">
        {paused ? <StatusBadge status="warn">Paused</StatusBadge> : <StatusBadge status="ok">Active</StatusBadge>}
      </span>

      <span className="status-strip-sep" />
      <span className="status-strip-item">
        {running > 0 ? (
          <Link href={links.activity({ status: "running" })} title={`Longest running: ${formatDuration(longest)}`}>
            <StatusBadge status="running">
              {running} {running === 1 ? "run" : "runs"} running
            </StatusBadge>
          </Link>
        ) : (
          <span className="faint">No runs in progress</span>
        )}
      </span>

      {troubled.length > 0 && (
        <>
          <span className="status-strip-sep" />
          <span className="status-strip-item">
            <Link href={links.settings("integrations")} title={troubled.map((t) => `${t.label}: ${t.detail}`).join("\n")}>
              <StatusBadge status="error">
                {troubled.length === 1 ? `${troubled[0]!.label} down` : `${troubled.length} services down`}
              </StatusBadge>
            </Link>
          </span>
        </>
      )}

      {control.error && <span className="status-strip-item text-error">{control.error}</span>}
      {stopResult && <span className="status-strip-item faint">{stopResult}</span>}

      <span className="status-strip-actions">
        {paused ? (
          <Button size="sm" variant="primary" pending={control.pending} onClick={() => control.run("resume")} title="Re-enable triggers and the scheduler">
            Resume
          </Button>
        ) : (
          <Button size="sm" pending={control.pending} onClick={() => control.run("pause")} title="Stop new trigger runs; running sessions continue">
            Pause
          </Button>
        )}
        <ConfirmButton
          size="sm"
          pending={control.pending}
          onConfirm={() => control.run("stop")}
          prompt={running ? `Kill ${running} running ${running === 1 ? "session" : "sessions"} and pause?` : "Pause and kill any session?"}
          confirmLabel="Stop"
          title="Kill all running sessions and pause"
        >
          Stop
        </ConfirmButton>
      </span>
    </div>
  );
}

/** Report what Stop actually did — runs without a live process are only closed. */
function describeStop(r: StopResponse): string {
  const stale = r.closed - r.killed;
  const parts = [`Stopped ${r.killed} ${r.killed === 1 ? "session" : "sessions"}`];
  if (stale > 0) parts.push(`closed ${stale} without a live process`);
  return parts.join(", ");
}
