/**
 * Capacity of the filesystems that matter in the container: the workspace
 * volume (HOME), /atlas/logs, /tmp and the container root. Filesystems
 * shared by more than one of those paths (common outside the container,
 * where everything lives on one disk) are merged into a single entry.
 *
 * Bun implements fs.statfs; a `df -kP` fallback covers the rare platform
 * where it throws. Paths that don't exist (e.g. /atlas/logs outside the
 * container) are skipped, not reported as errors.
 */

import { existsSync, statfsSync, statSync } from "fs";
import { home } from "../shared/env";

export interface VolumeRole {
  key: string;
  label: string;
  path: string;
}

export interface Volume {
  /** Every logical path (workspace/logs/tmp/root) that resolves to this filesystem. */
  roles: VolumeRole[];
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** 0..100 */
  usedPercent: number;
  status: "ok" | "warn" | "error";
}

export interface VolumesResponse {
  volumes: Volume[];
}

const WARN_PERCENT = 80;
const ERROR_PERCENT = 90;

function statusFor(usedPercent: number): Volume["status"] {
  if (usedPercent >= ERROR_PERCENT) return "error";
  if (usedPercent >= WARN_PERCENT) return "warn";
  return "ok";
}

interface RawStats {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

async function dfFallback(path: string): Promise<RawStats | null> {
  try {
    const proc = Bun.spawn(["df", "-kP", path], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = [await new Response(proc.stdout).text(), await proc.exited];
    if (code !== 0) return null;
    const lastLine = out.trim().split("\n").pop();
    const cols = lastLine?.trim().split(/\s+/);
    const totalKb = Number(cols?.[1]);
    const usedKb = Number(cols?.[2]);
    const availKb = Number(cols?.[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || !Number.isFinite(availKb)) return null;
    return { totalBytes: totalKb * 1024, usedBytes: usedKb * 1024, freeBytes: availKb * 1024 };
  } catch {
    return null;
  }
}

async function statFilesystem(path: string): Promise<RawStats | null> {
  try {
    const s = statfsSync(path);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize; // available to non-root, matches `df`
    const usedBytes = totalBytes - s.bfree * s.bsize;
    return { totalBytes, usedBytes, freeBytes };
  } catch {
    return dfFallback(path);
  }
}

const TARGET_ORDER = ["workspace", "logs", "tmp", "root"] as const;

function targets(): VolumeRole[] {
  return [
    { key: "workspace", label: "Workspace (HOME)", path: home() },
    { key: "logs", label: "Logs", path: "/atlas/logs" },
    { key: "tmp", label: "Temp", path: "/tmp" },
    { key: "root", label: "Container root", path: "/" },
  ];
}

export async function loadVolumes(): Promise<VolumesResponse> {
  // Group existing targets by device (fs.statSync().dev) so the same
  // filesystem mounted at several of our paths shows up once.
  const groups = new Map<number, { roles: VolumeRole[]; path: string }>();
  for (const t of targets()) {
    if (!existsSync(t.path)) continue;
    let dev: number;
    try {
      dev = statSync(t.path).dev;
    } catch {
      continue;
    }
    const g = groups.get(dev);
    if (g) g.roles.push(t);
    else groups.set(dev, { roles: [t], path: t.path });
  }

  const volumes: Volume[] = [];
  for (const g of groups.values()) {
    const stats = await statFilesystem(g.path);
    if (!stats || stats.totalBytes <= 0) continue;
    const usedPercent = (stats.usedBytes / stats.totalBytes) * 100;
    volumes.push({ roles: g.roles, ...stats, usedPercent, status: statusFor(usedPercent) });
  }

  volumes.sort((a, b) => {
    const rank = (v: Volume) => Math.min(...v.roles.map((r) => TARGET_ORDER.indexOf(r.key as (typeof TARGET_ORDER)[number])));
    return rank(a) - rank(b);
  });
  return { volumes };
}
