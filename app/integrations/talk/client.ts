import { randomBytes } from "node:crypto";
import type { TalkConfig } from "./config.ts";
import { ROOM_TOKEN, normalizeMessage, normalizeRoom, type TalkMessage, type TalkRoom } from "./events.ts";

export type TalkErrorCode = "auth" | "forbidden" | "not_found" | "lobby" | "rate_limited"
  | "unavailable" | "invalid_request" | "unsupported" | "network" | "timeout" | "aborted" | "protocol";

/** Safe to log: deliberately excludes server bodies, credentials and fetch error causes. */
export class TalkError extends Error {
  constructor(
    message: string,
    readonly code: TalkErrorCode,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly unknownOutcome = false,
  ) {
    super(message);
    this.name = "TalkError";
  }
}

export interface TalkCapabilities {
  features: string[];
  maxMessageLength: number;
  signalingMode: string;
}

export interface TalkMessagePage {
  messages: TalkMessage[];
  /** Forward cursor for receive; backward cursor for history. Null means no messages. */
  cursor: number | null;
}

export interface TalkSendOptions {
  message: string;
  replyTo?: number;
  threadId?: number;
  threadTitle?: string;
  referenceId?: string;
  silent?: boolean;
  signal?: AbortSignal;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const API = "/ocs/v2.php/apps/spreed/api";

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TalkError(`Invalid ${name}`, "invalid_request");
  return value;
}

function offset(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TalkError(`Invalid ${name}`, "invalid_request");
  return value;
}

function token(room: string): string {
  if (!ROOM_TOKEN.test(room)) throw new TalkError("Invalid Talk conversation token", "invalid_request");
  return room;
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  return Math.min(positive(value ?? fallback, "message limit"), max);
}

function retryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 86_400_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 86_400_000) : null;
}

function statusError(status: number, response: Response, mutation: boolean): TalkError {
  const code: TalkErrorCode = status === 401 || status === 997 ? "auth"
    : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 412 ? "lobby"
    : status === 429 ? "rate_limited" : status >= 500 && status !== 998 ? "unavailable" : "invalid_request";
  const description = code === "auth" ? "Talk authentication failed; check the account and app password"
    : code === "forbidden" ? "Talk permission denied"
    : code === "not_found" ? "Talk conversation or message is no longer accessible"
    : code === "lobby" ? "Talk conversation is restricted by a lobby"
    : code === "rate_limited" ? "Talk request rate limited"
    : code === "unavailable" ? "Talk server is unavailable"
    : "Talk request rejected";
  return new TalkError(description, code, status, retryAfter(response.headers.get("Retry-After")), mutation && code === "unavailable");
}

async function readJson(response: Response, mutation: boolean): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new TalkError("Talk returned an empty response", "protocol", response.status, null, mutation);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      // History pages are bounded, but rich object payloads are controlled by the server.
      if (length > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new TalkError("Talk response exceeded the size limit", "protocol", response.status, null, mutation);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let index = 0;
  for (const chunk of chunks) { bytes.set(chunk, index); index += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new TalkError("Talk returned invalid JSON", "protocol", response.status, null, mutation); }
}

/** Regular Nextcloud user API. The account must use an app password, never a bot secret. */
export class TalkClient {
  private readonly fetcher: Fetch;
  private readonly authorization: string;
  private readonly defaultSignal?: AbortSignal;
  private cachedCapabilities: TalkCapabilities | null = null;

  constructor(readonly config: TalkConfig, options: { fetch?: Fetch; signal?: AbortSignal } = {}) {
    if (!config.appPassword) throw new TalkError("Talk app password is not configured", "auth");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.defaultSignal = options.signal;
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.appPassword}`, "utf8").toString("base64")}`;
  }

  private async request(
    path: string,
    { method = "GET", query, body, signal, timeoutMs, allow304 = false }: {
      method?: string; query?: Record<string, string | number>; body?: Record<string, unknown>;
      signal?: AbortSignal; timeoutMs?: number; allow304?: boolean;
    } = {},
  ): Promise<{ data: any; headers: Headers }> {
    const signals = [...new Set([this.defaultSignal, signal].filter((value): value is AbortSignal => Boolean(value)))];
    if (signals.some((value) => value.aborted)) throw new TalkError("Talk request cancelled", "aborted");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    for (const value of signals) value.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs ?? this.config.requestTimeoutMs);
    const mutation = method !== "GET";
    try {
      const url = new URL(this.config.url + path);
      url.searchParams.set("format", "json");
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
      const response = await this.fetcher(url, {
        method,
        headers: { Authorization: this.authorization, "OCS-APIRequest": "true", Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        // Never forward account credentials to a redirect target, including an SSO login page.
        redirect: "error",
      });
      if (response.status === 304 && allow304) return { data: [], headers: response.headers };
      if (!response.ok) {
        await response.body?.cancel();
        throw statusError(response.status, response, mutation);
      }
      const json = await readJson(response, mutation);
      const ocs = json?.ocs;
      const status = Number(ocs?.meta?.statuscode);
      if (!ocs || !Number.isInteger(status) || !("data" in ocs)) {
        throw new TalkError("Talk returned an invalid OCS response", "protocol", response.status, null, mutation);
      }
      if (ocs.meta.status === "failure" || !(status === 100 || status >= 200 && status < 300)) throw statusError(status, response, mutation);
      return { data: ocs.data, headers: response.headers };
    } catch (error) {
      if (error instanceof TalkError) throw error;
      if (timedOut) throw new TalkError("Talk request timed out", "timeout", null, null, mutation);
      if (signals.some((value) => value.aborted)) throw new TalkError("Talk request cancelled", "aborted", null, null, mutation);
      throw new TalkError("Cannot reach the Talk server", "network", null, null, mutation);
    } finally {
      clearTimeout(timer);
      for (const value of signals) value.removeEventListener("abort", cancel);
    }
  }

  async capabilities(signal?: AbortSignal, refresh = false): Promise<TalkCapabilities> {
    if (this.cachedCapabilities && !refresh) return this.cachedCapabilities;
    const { data } = await this.request("/ocs/v2.php/cloud/capabilities", { signal });
    const spreed = data?.capabilities?.spreed;
    if (!spreed || !Array.isArray(spreed.features)) throw new TalkError("Talk is not available for this account", "unsupported");
    const features = spreed.features.filter((f: unknown) => typeof f === "string");
    if (!features.includes("conversation-v4") || !features.includes("chat-v2")) {
      throw new TalkError("Talk requires conversation-v4 and chat-v2 capabilities", "unsupported");
    }
    const max = Number(spreed.config?.chat?.["max-length"]);
    this.cachedCapabilities = {
      features,
      maxMessageLength: Number.isSafeInteger(max) && max > 0 ? max : 32_000,
      signalingMode: String(spreed.config?.signaling?.mode ?? "unknown"),
    };
    return this.cachedCapabilities;
  }

  async rooms(signal?: AbortSignal): Promise<TalkRoom[]> {
    // Full snapshots detect disinvites; modifiedSince intentionally omits removals.
    const { data } = await this.request(`${API}/v4/room`, { query: { noStatusUpdate: 1, includeStatus: "false" }, signal });
    if (!Array.isArray(data)) throw new TalkError("Talk returned an invalid conversation list", "protocol");
    try { return data.map(normalizeRoom); }
    catch { throw new TalkError("Talk returned an invalid conversation", "protocol"); }
  }

  async createDirectConversation(userId: string, signal?: AbortSignal): Promise<TalkRoom> {
    if (!userId || /[\r\n\0]/.test(userId)) throw new TalkError("A valid Nextcloud user ID is required", "invalid_request");
    const { data } = await this.request(`${API}/v4/room`, { method: "POST", body: { roomType: 1, invite: userId }, signal });
    try {
      const room = normalizeRoom(data);
      if (room.type !== 1) throw new Error("Not a direct conversation");
      return room;
    } catch { throw new TalkError("Talk returned an invalid direct conversation", "protocol", null, null, true); }
  }

  private page(data: unknown, headers: Headers, room: string, forward: boolean, after?: number): TalkMessagePage {
    if (!Array.isArray(data)) throw new TalkError("Talk returned an invalid message list", "protocol");
    let messages: TalkMessage[];
    try { messages = data.map((message) => normalizeMessage(message, room)).sort((a, b) => a.id - b.id); }
    catch { throw new TalkError("Talk returned an invalid message", "protocol"); }
    const header = headers.get("X-Chat-Last-Given");
    let cursor = header == null ? null : Number(header);
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new TalkError("Talk returned an invalid history cursor", "protocol");
    const fallback = forward ? messages.at(-1)?.id : messages[0]?.id;
    cursor ??= fallback ?? after ?? null;
    if (forward && cursor !== null && (cursor < (after ?? 0) || cursor < (fallback ?? 0))) {
      throw new TalkError("Talk returned a backwards receive cursor", "protocol");
    }
    return { messages, cursor };
  }

  async receive(room: string, options: { after?: number; limit?: number; wait?: boolean; signal?: AbortSignal } = {}): Promise<TalkMessagePage> {
    const forward = options.after !== undefined;
    const query: Record<string, string | number> = {
      lookIntoFuture: forward ? 1 : 0,
      limit: boundedLimit(options.limit, 100, 200),
      timeout: forward && options.wait !== false ? this.config.pollTimeoutSeconds : 0,
      setReadMarker: 0,
      includeLastKnown: 0,
      noStatusUpdate: 1,
    };
    if (forward) query.lastKnownMessageId = offset(options.after!, "receive cursor");
    if (this.cachedCapabilities?.features.includes("chat-keep-notifications")) query.markNotificationsAsRead = 0;
    const { data, headers } = await this.request(`${API}/v1/chat/${token(room)}`, {
      query, signal: options.signal, allow304: true,
      timeoutMs: Number(query.timeout) > 0 ? Math.max(this.config.requestTimeoutMs, (Number(query.timeout) + 5) * 1000) : this.config.requestTimeoutMs,
    });
    return this.page(data, headers, room, forward, options.after);
  }

  async history(room: string, options: { before?: number; limit?: number; signal?: AbortSignal } = {}): Promise<TalkMessagePage> {
    const query: Record<string, string | number> = {
      lookIntoFuture: 0, limit: boundedLimit(options.limit, 50, 200), timeout: 0,
      setReadMarker: 0, includeLastKnown: 0, noStatusUpdate: 1,
    };
    if (options.before !== undefined) query.lastKnownMessageId = offset(options.before, "history cursor");
    if (this.cachedCapabilities?.features.includes("chat-keep-notifications")) query.markNotificationsAsRead = 0;
    const { data, headers } = await this.request(`${API}/v1/chat/${token(room)}`, { query, signal: options.signal, allow304: true });
    return this.page(data, headers, room, false);
  }

  async context(room: string, messageId: number, limit = 20, signal?: AbortSignal): Promise<TalkMessage[]> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.features.includes("chat-get-context")) throw new TalkError("Talk server does not support message context", "unsupported");
    const { data, headers } = await this.request(`${API}/v1/chat/${token(room)}/${positive(messageId, "message ID")}/context`, {
      query: { limit: boundedLimit(limit, 20, 100) }, signal,
    });
    return this.page(data, headers, room, false).messages;
  }

  async send(room: string, options: TalkSendOptions): Promise<TalkMessage> {
    token(room);
    const capabilities = await this.capabilities(options.signal);
    if (typeof options.message !== "string" || !options.message.trim() || [...options.message].length > capabilities.maxMessageLength) {
      throw new TalkError(`Talk messages must contain 1 to ${capabilities.maxMessageLength} characters`, "invalid_request");
    }
    const body: Record<string, unknown> = { message: options.message, referenceId: options.referenceId ?? randomBytes(32).toString("hex") };
    if (typeof body.referenceId !== "string" || !body.referenceId || body.referenceId.length > 64) throw new TalkError("Invalid Talk reference ID", "invalid_request");
    if (options.replyTo !== undefined) {
      if (!capabilities.features.includes("chat-replies")) throw new TalkError("Talk server does not support replies", "unsupported");
      body.replyTo = positive(options.replyTo, "reply message ID");
    }
    if (options.threadId !== undefined || options.threadTitle !== undefined) {
      if (!capabilities.features.includes("threads")) throw new TalkError("Talk server does not support threads", "unsupported");
      if (options.threadTitle !== undefined && (options.threadId !== undefined || options.replyTo !== undefined)) throw new TalkError("A new thread cannot also be a reply or existing thread", "invalid_request");
      if (options.threadId !== undefined) body.threadId = positive(options.threadId, "thread ID");
      if (options.threadTitle !== undefined) {
        if (!options.threadTitle.trim()) throw new TalkError("A thread title is required", "invalid_request");
        body.threadTitle = options.threadTitle;
      }
    }
    if (options.silent !== undefined) {
      if (options.silent && !capabilities.features.includes("silent-send")) throw new TalkError("Talk server does not support silent messages", "unsupported");
      body.silent = options.silent;
    }
    const { data } = await this.request(`${API}/v1/chat/${room}`, { method: "POST", body, signal: options.signal });
    let message: TalkMessage;
    try { message = normalizeMessage(data, room); }
    catch { throw new TalkError("Talk did not return the sent message identity; delivery needs reconciliation", "protocol", null, null, true); }
    if ((options.threadTitle || options.threadId) && !message.threadId) {
      throw new TalkError("Talk did not return the thread identity; delivery needs reconciliation", "protocol", null, null, true);
    }
    return message;
  }

  async react(room: string, messageId: number, reaction: string, signal?: AbortSignal): Promise<void> {
    return this.reaction("POST", room, messageId, reaction, signal);
  }

  async unreact(room: string, messageId: number, reaction: string, signal?: AbortSignal): Promise<void> {
    return this.reaction("DELETE", room, messageId, reaction, signal);
  }

  private async reaction(method: string, room: string, messageId: number, reaction: string, signal?: AbortSignal): Promise<void> {
    const capabilities = await this.capabilities(signal);
    if (!capabilities.features.includes("reactions")) throw new TalkError("Talk server does not support reactions", "unsupported");
    if (!reaction || reaction.length > 64) throw new TalkError("A reaction emoji is required", "invalid_request");
    await this.request(`${API}/v1/reaction/${token(room)}/${positive(messageId, "message ID")}`, { method, body: { reaction }, signal });
  }
}
