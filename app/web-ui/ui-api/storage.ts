/**
 * /ui/api/storage/* — "What is on disk, and how full is it?" (frontend/pages/storage/).
 *
 *   GET /ui/api/storage/volumes              capacity of HOME / /atlas/logs / /tmp / root, deduplicated by filesystem
 *   GET /ui/api/storage/workspace?refresh=1   size + file count per top-level HOME entry, largest files, DB size (cached 60s)
 *   GET /ui/api/storage/browse                directory listing of HOME
 *   GET /ui/api/storage/browse/<path>         listing (dir) or metadata + preview (file), relative to HOME
 *   GET /ui/api/storage/download/<path>       raw file download; denied for secrets (config.yml is masked instead)
 *
 * Path handling, the secret denylist and the config.yml masking live in ./storage/browse.ts.
 */

import { badRequest, handler, HttpError, json, notFound, query, type ApiRoutes } from "./shared/http";
import { loadVolumes, type VolumesResponse } from "./storage/volumes";
import { getWorkspace, type WorkspaceResponse } from "./storage/workspace";
import { listDir, loadDownload, loadFile, resolveHomePath, statOrNull, type BrowseDir, type BrowseFile } from "./storage/browse";

export type { VolumesResponse, Volume, VolumeRole } from "./storage/volumes";
export type { WorkspaceResponse, WorkspaceEntry, WorkspaceLargestFile, WorkspaceDatabase } from "./storage/workspace";
export type { BrowseDir, BrowseEntry, BrowseFile, BetterView } from "./storage/browse";

export type BrowseResponse = BrowseDir | BrowseFile;

const BROWSE_PREFIX = "/ui/api/storage/browse/";
const DOWNLOAD_PREFIX = "/ui/api/storage/download/";

/** Path after a prefix, decoded per segment (Bun gives no params for a trailing `*`). */
function pathAfter(req: Request, prefix: string): string {
  const pathname = new URL(req.url).pathname;
  if (!pathname.startsWith(prefix)) badRequest("Missing path");
  try {
    return pathname
      .slice(prefix.length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
  } catch {
    badRequest("Invalid path");
  }
}

function browse(rel: string): BrowseResponse {
  const { abs, rel: cleanRel } = resolveHomePath(rel);
  const st = statOrNull(abs);
  if (!st) notFound("No such file or directory");
  if (st.isDirectory()) return listDir(cleanRel, abs);
  if (st.isFile()) return loadFile(cleanRel, abs, st);
  badRequest("Not a regular file or directory");
}

function download(rel: string): Response {
  const { abs, rel: cleanRel } = resolveHomePath(rel);
  if (!cleanRel) badRequest("Not a file");
  const st = statOrNull(abs);
  if (!st) notFound("No such file");
  if (!st.isFile()) badRequest("Not a file");
  const result = loadDownload(cleanRel, abs);
  if (!result) throw new HttpError(403, "This file is not available for download");
  const filename = cleanRel.slice(cleanRel.lastIndexOf("/") + 1).replace(/"/g, "");
  return new Response(result.body, {
    headers: {
      "Content-Type": result.mime,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const routes: ApiRoutes = {
  "/ui/api/storage/volumes": {
    GET: handler(async () => json(await loadVolumes() satisfies VolumesResponse)),
  },
  "/ui/api/storage/workspace": {
    GET: handler(async (req) => {
      const refresh = query(req).get("refresh");
      return json(await getWorkspace({ refresh: refresh === "1" || refresh === "true" }) satisfies WorkspaceResponse);
    }),
  },
  "/ui/api/storage/browse": {
    GET: handler(() => json(browse(""))),
  },
  "/ui/api/storage/browse/*": {
    GET: handler((req) => json(browse(pathAfter(req, BROWSE_PREFIX)))),
  },
  "/ui/api/storage/download/*": {
    GET: handler((req) => download(pathAfter(req, DOWNLOAD_PREFIX))),
  },
};
