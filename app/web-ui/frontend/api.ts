/**
 * Data access for /ui/api/*.
 *
 *   const runs = useApi<RunsResponse>(withQuery("/ui/api/activity", { status }), { poll: 5000 });
 *   runs.data / runs.error / runs.loading / runs.refetch()
 *
 *   const save = useMutation((body: Trigger) => apiPut(`/ui/api/automations/${name}`, body), {
 *     onSuccess: () => runs.refetch(),
 *   });
 *   <button onClick={() => save.run(form)} disabled={save.pending}>Save</button>
 *
 * Errors: non-2xx responses throw ApiError with the server's `{ error }` message.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    signal,
    headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
    // Mutations always send JSON (the server rejects other content types).
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return parseResponse<T>(res);
}

/**
 * Multipart POST (file uploads). The browser sets the multipart Content-Type;
 * endpoints that accept it require an extra header (e.g. X-Atlas-UI) instead.
 */
export async function apiPostForm<T>(path: string, form: FormData, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, { method: "POST", headers, body: form });
  return parseResponse<T>(res);
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const serverMsg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "";
    throw new ApiError(res.status, serverMsg || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const apiGet = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal);
export const apiPost = <T = unknown>(path: string, body?: unknown) => request<T>("POST", path, body);
export const apiPut = <T = unknown>(path: string, body?: unknown) => request<T>("PUT", path, body);
export const apiPatch = <T = unknown>(path: string, body?: unknown) => request<T>("PATCH", path, body);
export const apiDelete = <T = unknown>(path: string, body?: unknown) => request<T>("DELETE", path, body);

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  /** True until the first response (or error) for the current path. */
  loading: boolean;
  /** Re-fetch without clearing data. Resolves when done. */
  refetch: () => Promise<void>;
  /** Replace data locally (optimistic updates, mutation responses). */
  setData: (data: T) => void;
}

/**
 * GET a /ui/api endpoint. Re-fetches when `path` changes (data is kept until
 * the new response arrives, so filters don't flash). `path = null` skips.
 * `poll` re-fetches every n ms while the tab is visible.
 */
export function useApi<T>(path: string | null, opts: { poll?: number } = {}): ApiState<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loadedPath: string | null }>({
    data: null,
    error: null,
    loadedPath: null,
  });
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const data = await apiGet<T>(path, ctrl.signal);
      if (!ctrl.signal.aborted) setState({ data, error: null, loadedPath: path });
    } catch (err) {
      if (!ctrl.signal.aborted) setState((s) => ({ ...s, error: errorMessage(err), loadedPath: path }));
    }
  }, [path]);

  useEffect(() => {
    load();
    return () => ctrlRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!opts.poll || !path) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, opts.poll);
    return () => clearInterval(id);
  }, [load, opts.poll, path]);

  const setData = useCallback((data: T) => setState((s) => ({ ...s, data, error: null })), []);

  return {
    data: state.data,
    error: state.error,
    loading: path !== null && state.loadedPath !== path,
    refetch: load,
    setData,
  };
}

export interface Mutation<A, R> {
  /** Run the mutation. Resolves with the result, or undefined on error (see `error`). */
  run: (arg: A) => Promise<R | undefined>;
  pending: boolean;
  error: string | null;
  reset: () => void;
}

export function useMutation<A = void, R = unknown>(
  fn: (arg: A) => Promise<R>,
  opts: { onSuccess?: (result: R, arg: A) => void; onError?: (message: string) => void } = {},
): Mutation<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  const optsRef = useRef(opts);
  fnRef.current = fn;
  optsRef.current = opts;

  const run = useCallback(async (arg: A) => {
    setPending(true);
    setError(null);
    try {
      const result = await fnRef.current(arg);
      optsRef.current.onSuccess?.(result, arg);
      return result;
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      optsRef.current.onError?.(msg);
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { run, pending, error, reset: useCallback(() => setError(null), []) };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
