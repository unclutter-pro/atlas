/**
 * Trigger runner control socket and dedup lock paths.
 *
 * A running persistent session (trigger-runner) listens on a Unix socket per
 * (trigger, session key) and holds a PID lock file. Other processes use these
 * helpers to inject messages, interrupt a turn, or check whether a runner is
 * alive (web-ui chat run state).
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { createConnection } from "net";

/**
 * Control messages instead of an injected message:
 *   interrupt — stop the running turn;
 *   retire    — hand (trigger, key) over to the next runner at once (socket and
 *               lock are released), run `message` as the session's last turn
 *               (the /new farewell), then exit.
 */
export type SocketControl = "interrupt" | "retire";

/** Socket message protocol: newline-delimited JSON */
export type SocketMessage = {
  message: string;
  channel: string;
  sessionKey: string;
  control?: SocketControl;
};

export type SocketAck = {
  ok: boolean;
  error?: string;
};

function keyHash(triggerName: string, sessionKey: string): string {
  return createHash("sha256").update(`${triggerName}-${sessionKey}`).digest("hex").slice(0, 16);
}

/**
 * Filesystem-safe form of a session key. Replacing characters could make two
 * keys collide ("a-b" and "a_b" would share a runner socket and lock), so a
 * key that had to change gets a short hash of the original appended.
 */
function safeKey(triggerName: string, sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_]/g, "_");
  return safe === sessionKey ? safe : `${safe}.${keyHash(triggerName, sessionKey).slice(0, 8)}`;
}

/** Control socket of the runner for (trigger, key). */
export function getSocketPath(triggerName: string, sessionKey: string): string {
  const candidate = `/tmp/.trigger-${triggerName}-${safeKey(triggerName, sessionKey)}.sock`;
  // Unix domain sockets have a 108-char path limit; hash long keys to stay under
  if (candidate.length > 104) return `/tmp/.trigger-${triggerName}-${keyHash(triggerName, sessionKey)}.sock`;
  return candidate;
}

/** PID lock file the runner holds while it runs (trigger, key). */
export function getLockPath(triggerName: string, sessionKey: string): string {
  const candidate = `/tmp/.trigger-${triggerName}-${safeKey(triggerName, sessionKey)}.flock`;
  // Keep flock paths consistent with socket paths when keys are long
  if (candidate.length > 108) return `/tmp/.trigger-${triggerName}-${keyHash(triggerName, sessionKey)}.flock`;
  return candidate;
}

/**
 * PID file of a retiring runner (see SocketControl): it no longer holds the
 * lock, but the kill switch must still find it.
 */
export function getRetiringPath(triggerName: string, sessionKey: string): string {
  return `${getLockPath(triggerName, sessionKey)}.retiring`;
}

/** PID written to a lock file, or null when missing/unreadable. */
export function readLockPid(path: string): number | null {
  try {
    const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Signal 0: true when the process exists (EPERM means it exists but isn't ours). */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Try to inject a message into a running session via the custom Unix domain socket.
 * If control is set, sends a control message instead of injecting a message.
 * Returns true if the operation succeeded, false otherwise.
 */
export async function trySocketInject(
  socketPath: string,
  message: string,
  channel: string,
  sessionKey: string,
  control?: SocketControl,
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;

  return new Promise<boolean>((resolve) => {
    const client = createConnection(socketPath, () => {
      const payload: SocketMessage = control
        ? { message: control === "retire" ? message : "", channel, sessionKey, control }
        : { message, channel, sessionKey };
      client.write(JSON.stringify(payload) + "\n");
    });

    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      try {
        const ack = JSON.parse(buffer.slice(0, newlineIdx)) as SocketAck;
        resolve(ack.ok === true);
      } catch {
        resolve(false);
      }
    });

    client.on("error", () => resolve(false));
    client.setTimeout(5000, () => {
      client.destroy();
      resolve(false);
    });
  });
}
