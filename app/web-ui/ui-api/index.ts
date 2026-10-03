/**
 * Registry of keyless JSON endpoints backing the React frontend.
 *
 * Each area owns ui-api/<area>.ts and exports `routes` with paths under
 * /ui/api/<area>. This file only wires them together — areas never edit it.
 * `/ui/api/*` is perimeter-trusted (no API key).
 */

import { AREA_KEYS, type AreaKey } from "../frontend/areas";
import { routes as core } from "./core";
import { routes as overview } from "./overview";
import { routes as chat } from "./chat";
import { routes as activity } from "./activity";
import { routes as automations } from "./automations";
import { routes as knowledge } from "./knowledge";
import { routes as usage } from "./usage";
import { routes as storage } from "./storage";
import { routes as settings } from "./settings";
import { errorResponse, type ApiRoutes } from "./shared/http";

const AREA_ROUTES: Record<AreaKey, ApiRoutes> = { overview, chat, activity, automations, knowledge, usage, storage, settings };

/** Merge core + area routes; fail fast on duplicates or paths outside an area's prefix. */
export function collectApiRoutes(): ApiRoutes {
  const merged: ApiRoutes = { ...core };
  for (const area of AREA_KEYS) {
    const prefix = `/ui/api/${area}`;
    for (const [path, methods] of Object.entries(AREA_ROUTES[area])) {
      if (path !== prefix && !path.startsWith(`${prefix}/`)) {
        throw new Error(`ui-api/${area}.ts: route ${path} must live under ${prefix}`);
      }
      if (merged[path]) throw new Error(`ui-api: duplicate route ${path}`);
      merged[path] = methods;
    }
  }
  return merged;
}

export const apiRoutes = {
  ...collectApiRoutes(),
  // Unknown /ui/api paths get a JSON 404 instead of falling through to the legacy app.
  "/ui/api/*": () => errorResponse(404, "Not found"),
};
