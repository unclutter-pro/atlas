/**
 * API Authentication Middleware for Atlas External Configuration API.
 *
 * If ATLAS_API_KEY is set, all /api/v1/* routes require authentication via:
 *   - Header: Authorization: Bearer <key>
 *   - Header: X-API-Key: <key>
 *
 * If ATLAS_API_KEY is not set, all routes are open (relying on Docker port
 * binding and nginx rate limiting for protection).
 */

import type { Context, Next } from "hono";

const API_KEY = process.env.ATLAS_API_KEY || "";

/**
 * Hono middleware that validates API key if configured.
 */
export async function apiKeyAuth(c: Context, next: Next): Promise<Response | void> {
  if (!API_KEY) {
    return next();
  }

  const authHeader = c.req.header("Authorization") || "";
  const apiKeyHeader = c.req.header("X-API-Key") || "";

  let token = "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (apiKeyHeader) {
    token = apiKeyHeader;
  }

  if (token !== API_KEY) {
    return c.json({ error: "Unauthorized", message: "Invalid or missing API key" }, 401);
  }

  return next();
}
