/**
 * Shared, polled system status (GET /ui/api/status) for the status strip and
 * any page: `const { data, refetch } = useStatus();`. One poll for the whole app.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { AuthBadge, StatusResponse } from "../../ui-api/shared/status";
import { useApi, type ApiState } from "../api";

export type { StatusResponse };

const POLL_MS = 5_000;
const StatusContext = createContext<ApiState<StatusResponse> | null>(null);

export function StatusProvider(props: { children: ReactNode }) {
  const status = useApi<StatusResponse>("/ui/api/status", { poll: POLL_MS });
  return <StatusContext.Provider value={status}>{props.children}</StatusContext.Provider>;
}

export function useStatus(): ApiState<StatusResponse> {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error("useStatus() outside <StatusProvider>");
  return ctx;
}

/** The agent cannot run until someone logs in again (expired, refused or no login). */
export function isLoginBroken(auth: AuthBadge | null | undefined): auth is AuthBadge {
  return !!auth && (auth.state === "failed" || auth.state === "expired" || auth.state === "missing");
}
