/**
 * DNS-rebinding guard. The UI is unauthenticated, so a page on
 * attacker.example that re-points its DNS to this machine would otherwise be
 * "same-origin" with it and could read and mutate everything. Such requests
 * carry the attacker's hostname in Host, so only hostnames an outside site
 * cannot own are served: localhost (*.localhost), IP literals, single-label
 * LAN/Docker names ("atlas", "nas") and mDNS *.local — plus
 * web_ui.allowed_hosts / ATLAS_WEB_UI_ALLOWED_HOSTS for real domains.
 */

import { resolveConfig } from "../../../lib/config";
import { home } from "./env";

const CACHE_MS = 30_000;
let cache: { at: number; hosts: string[] } | null = null;

function configuredHosts(): string[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.hosts;
  let hosts: string[] = [];
  try {
    hosts = (resolveConfig(home()).web_ui?.allowed_hosts ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  } catch {}
  cache = { at: Date.now(), hosts };
  return hosts;
}

/** Hostname part of a Host header, lowercased, without port or IPv6 brackets. */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  const colon = h.lastIndexOf(":");
  return colon > -1 && h.indexOf(":") === colon ? h.slice(0, colon) : h;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

export function isAllowedHost(host: string, allowed: string[] = configuredHosts()): boolean {
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || isIpLiteral(host)) return true;
  if (!host.includes(".") || host.endsWith(".local")) return true;
  return allowed.some((a) => a === "*" || a === host || (a.startsWith("*.") && host.endsWith(a.slice(1))));
}

/** Error message when the request's Host is not served, or null. */
export function hostRejection(req: Request): string | null {
  const header = req.headers.get("host") ?? new URL(req.url).host;
  const host = hostnameOf(header);
  if (isAllowedHost(host)) return null;
  return `Host "${host}" is not allowed. Add it to web_ui.allowed_hosts in config.yml or ATLAS_WEB_UI_ALLOWED_HOSTS.`;
}

/** For tests. */
export function resetHostCache(): void {
  cache = null;
}
