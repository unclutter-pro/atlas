/**
 * Dependency-free pushState router.
 *
 *   navigate("/activity/42")                     push a URL (no reload)
 *   <Link href="/automations/daily-digest">       client-side link
 *   <Routes routes={[{ path: "/activity/:id", component: RunDetail }]} />
 *   const [q, setQ] = useSearchParams();         read/update the query string
 *   const [status, setStatus] = useQueryParam("status");
 *
 * Patterns: `:name` matches one segment, a trailing `*` matches the rest
 * (available as params["*"]). Params are URI-decoded.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type ComponentType, type MouseEvent, type ReactNode } from "react";

const NAV_EVENT = "atlas:navigate";

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

// Snapshots must be primitives (stable across renders), hence strings.
const getPathname = () => window.location.pathname;
const getSearch = () => window.location.search;

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getPathname);
}

/** Raw query string including "?" (or ""). */
export function useSearch(): string {
  return useSyncExternalStore(subscribe, getSearch);
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing (filters, tabs, typing). */
  replace?: boolean;
  /** Keep the scroll position (default: scroll to top on push). */
  keepScroll?: boolean;
}

export function navigate(href: string, opts: NavigateOptions = {}): void {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.href = url.href;
    return;
  }
  const next = url.pathname + url.search + url.hash;
  if (next === window.location.pathname + window.location.search + window.location.hash) return;
  if (opts.replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  if (!opts.replace && !opts.keepScroll) window.scrollTo(0, 0);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryPatch = Record<string, QueryValue>;

/** Build "path?a=1&b=2", dropping null/undefined/"" values. */
export function withQuery(path: string, params: QueryPatch): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "" && v !== false) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Current query params plus a setter that merges a patch into the URL
 * (null/""/undefined removes a key). Defaults to replace — pass
 * { replace: false } when the change should get its own history entry.
 */
export function useSearchParams(): [URLSearchParams, (patch: QueryPatch, opts?: NavigateOptions) => void] {
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const update = useCallback((patch: QueryPatch, opts: NavigateOptions = {}) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || v === false) next.delete(k);
      else next.set(k, String(v));
    }
    const s = next.toString();
    navigate(window.location.pathname + (s ? `?${s}` : ""), { replace: true, keepScroll: true, ...opts });
  }, []);
  return [params, update];
}

/** One query param as state: [value (or fallback), setter]. */
export function useQueryParam(name: string, fallback = ""): [string, (value: QueryValue, opts?: NavigateOptions) => void] {
  const [params, update] = useSearchParams();
  const set = useCallback((value: QueryValue, opts?: NavigateOptions) => update({ [name]: value }, opts), [name, update]);
  return [params.get(name) ?? fallback, set];
}

export type Params = Record<string, string>;

/** Match `pathname` against a pattern; returns params or null. */
export function matchPath(pattern: string, pathname: string): Params | null {
  const pat = pattern.split("/").filter(Boolean);
  const segs = pathname.split("/").filter(Boolean);
  const params: Params = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === "*" && i === pat.length - 1) {
      params["*"] = segs.slice(i).map(safeDecode).join("/");
      return params;
    }
    const s = segs[i];
    if (s === undefined) return null;
    if (p.startsWith(":")) params[p.slice(1)] = safeDecode(s);
    else if (p !== s) return null;
  }
  return segs.length === pat.length ? params : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface RouteDef {
  path: string;
  component: ComponentType<{ params: Params }>;
}

/** Render the first route whose pattern matches the current pathname. */
export function Routes(props: { routes: RouteDef[]; fallback?: ReactNode }) {
  const pathname = usePathname();
  for (const r of props.routes) {
    const params = matchPath(r.path, pathname);
    if (params) {
      const C = r.component;
      return <C params={params} />;
    }
  }
  return <>{props.fallback ?? null}</>;
}

/** Params of `pattern` for the current URL, or null if it doesn't match. */
export function useRouteParams(pattern: string): Params | null {
  const pathname = usePathname();
  return useMemo(() => matchPath(pattern, pathname), [pattern, pathname]);
}

/** True when the current pathname is `href`'s path or (unless exact) below it. */
export function useIsActive(href: string, exact = false): boolean {
  const pathname = usePathname();
  const path = href.split(/[?#]/)[0]!;
  return pathname === path || (!exact && path !== "/" && pathname.startsWith(`${path}/`));
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  replace?: boolean;
  children?: ReactNode;
};

/** Client-side link. Modified clicks (new tab etc.) keep native behaviour. */
export function Link({ href, replace, onClick, children, ...rest }: LinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (rest.target || rest.download != null || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href, { replace });
  };
  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}

/** Client-side redirect (e.g. /settings → /settings/personality). */
export function Redirect(props: { to: string }) {
  useEffect(() => navigate(props.to, { replace: true }), [props.to]);
  return null;
}

// --- Document title ---------------------------------------------------------
// "<page> · <area> — <agent>". The shell sets area + agent; pages call
// useTitle() for detail views. Separate slots, so effect order doesn't matter.

const titleParts = { page: "", area: "", agent: "Atlas" };

function applyTitle() {
  const page = titleParts.page === titleParts.area ? "" : titleParts.page;
  const main = [page, titleParts.area].filter(Boolean).join(" · ");
  document.title = main ? `${main} — ${titleParts.agent}` : titleParts.agent;
}

export function setShellTitle(area: string, agent: string): void {
  titleParts.area = area;
  titleParts.agent = agent;
  applyTitle();
}

/** Set the page part of the document title while mounted. */
export function useTitle(page: string | null | undefined): void {
  useEffect(() => {
    if (!page) return;
    titleParts.page = page;
    applyTitle();
    return () => {
      if (titleParts.page === page) {
        titleParts.page = "";
        applyTitle();
      }
    };
  }, [page]);
}
