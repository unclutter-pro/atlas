/**
 * Helpers for /ui/api/* route handlers (native Bun.serve, no Hono).
 *
 * Handlers return plain Responses. Wrap them in `handler()` so a thrown
 * HttpError becomes a JSON error response and anything else a logged 500:
 *
 *   "/ui/api/foo/:id": {
 *     GET: handler((req) => json(loadFoo(req.params.id) ?? notFound("No such foo"))),
 *     POST: handler(async (req) => { const body = await readJson<{ name: string }>(req); ... }),
 *   }
 */

import type { BunRequest } from "bun";
import { UI_CLIENT_HEADER, UI_CLIENT_HEADER_VALUE } from "../chat/types";
import { hostRejection } from "./host";

export type Handler = (req: BunRequest) => Response | Promise<Response>;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** One area's routes: path pattern (`:param`, trailing `*`) → per-method handlers. */
export type ApiRoutes = Record<string, Partial<Record<Method, Handler>>>;

/** Error with an HTTP status; `handler()` turns it into `{ error }` JSON. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** JSON error body the frontend's ApiError understands: `{ error: string }`. */
export function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

export function notFound(message = "Not found"): never {
  throw new HttpError(404, message);
}

/**
 * Wrap a route handler: same-origin + JSON guard on mutations, HttpError → JSON.
 * With `multipart: true`, multipart/form-data bodies are allowed too when
 * same-origin AND carrying the UI_CLIENT_HEADER. Multipart is a
 * CORS-safelisted type, so that custom header (which forces a preflight the
 * server never answers) is what keeps cross-site forms out.
 */
export function handler(fn: Handler, opts?: { multipart?: boolean }): Handler {
  return async (req) => {
    try {
      const badHost = hostRejection(req);
      if (badHost) throw new HttpError(421, badHost);
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (opts?.multipart && isMultipart(req)) assertUiMultipart(req);
        else assertSameOrigin(req);
      }
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.message);
      console.error(`[ui-api] ${req.method} ${new URL(req.url).pathname}:`, err);
      return errorResponse(500, err instanceof Error ? err.message : String(err));
    }
  };
}

/**
 * Parse a JSON request body. Mutations must be sent as application/json —
 * plain HTML forms from other origins cannot do that without a CORS
 * preflight, which keeps the unauthenticated UI API out of reach of
 * cross-site form posts.
 */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  assertJsonContentType(req);
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/**
 * Why a mutation must be rejected as cross-site, or null if it may pass.
 * The UI API (and the keyless /chat endpoints) are unauthenticated, so every
 * mutation must come from the UI itself: not cross-site, and — with
 * `requireJson` — JSON only (exact media type: "text/plain; application/json"
 * is a CORS-safelisted type and would skip the preflight).
 * Non-browser clients send neither Sec-Fetch-Site nor Origin and pass.
 */
export function crossSiteRejection(req: Request, opts: { requireJson: boolean }): { status: number; message: string } | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return { status: 403, message: "Cross-site request rejected" };
  const origin = req.headers.get("origin");
  if (origin && hostname(origin) !== hostname(`http://${req.headers.get("host") ?? new URL(req.url).host}`)) {
    return { status: 403, message: "Cross-origin request rejected" };
  }
  if (opts.requireJson && !isJsonContentType(req)) return { status: 415, message: "Expected Content-Type: application/json" };
  return null;
}

function assertSameOrigin(req: Request): void {
  const rejection = crossSiteRejection(req, { requireJson: true });
  if (rejection) throw new HttpError(rejection.status, rejection.message);
}

function assertUiMultipart(req: Request): void {
  const rejection = crossSiteRejection(req, { requireJson: false });
  if (rejection) throw new HttpError(rejection.status, rejection.message);
  if (req.headers.get(UI_CLIENT_HEADER) !== UI_CLIENT_HEADER_VALUE) throw new HttpError(403, `Missing ${UI_CLIENT_HEADER} header`);
}

export function isMultipart(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "multipart/form-data";
}

/** Hostname without port: nginx forwards `Host $host`, which drops the public port. */
function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isJsonContentType(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

function assertJsonContentType(req: Request): void {
  if (!isJsonContentType(req)) throw new HttpError(415, "Expected Content-Type: application/json");
}

/** URL query parameters of a request. */
export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

/** Integer query parameter with default and optional clamp. */
export function intParam(value: string | null | undefined, fallback: number, min = -Infinity, max = Infinity): number {
  const n = value == null || value === "" ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** CSV download response. Values are quoted when needed. */
export function csv(filename: string, header: string[], rows: unknown[][]): Response {
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    },
  });
}
