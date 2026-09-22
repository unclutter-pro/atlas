/** Client for /ui/api/chat/* (wire types: ui-api/chat/types.ts). */

import { apiDelete, apiPatch, apiPost, apiPostForm } from "../../api";
import { withQuery } from "../../router";
import {
  SESSION_KEY_PATTERN,
  UI_CLIENT_HEADER,
  UI_CLIENT_HEADER_VALUE,
  type ChatSessionsQuery,
  type CreateChatSessionResponse,
  type DeleteChatSessionResponse,
  type SendChatMessageResponse,
  type StopChatTurnResponse,
  type UpdateChatSessionRequest,
  type UpdateChatSessionResponse,
} from "../../../ui-api/chat/types";

const BASE = "/ui/api/chat/sessions";
const KEY_RE = new RegExp(SESSION_KEY_PATTERN);

export const isValidSessionKey = (key: string | null | undefined): key is string => !!key && KEY_RE.test(key);

export const sessionPath = (key: string) => `${BASE}/${encodeURIComponent(key)}`;
export const streamUrl = (key: string) => `${sessionPath(key)}/stream`;
export const sessionsPath = (q: ChatSessionsQuery) => withQuery(BASE, { archived: q.archived === "exclude" ? undefined : q.archived, q: q.q });

export const chatApi = {
  create: (title?: string | null) => apiPost<CreateChatSessionResponse>(BASE, title ? { title } : {}),
  update: (key: string, patch: UpdateChatSessionRequest) => apiPatch<UpdateChatSessionResponse>(sessionPath(key), patch),
  remove: (key: string) => apiDelete<DeleteChatSessionResponse>(sessionPath(key), {}),
  stop: (key: string) => apiPost<StopChatTurnResponse>(`${sessionPath(key)}/stop`, {}),
  send: (key: string, content: string, clientId: string) => apiPost<SendChatMessageResponse>(`${sessionPath(key)}/messages`, { content, clientId }),
  sendVoice: (key: string, file: File, caption: string, clientId: string) => {
    const form = new FormData();
    form.append("file", file);
    if (caption) form.append("message", caption);
    form.append("clientId", clientId);
    return apiPostForm<SendChatMessageResponse>(`${sessionPath(key)}/messages`, form, { [UI_CLIENT_HEADER]: UI_CLIENT_HEADER_VALUE });
  },
};

/** crypto.randomUUID needs a secure context; the UI is often served over plain http on a LAN. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // insecure context
    }
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export const LAST_SESSION_KEY = "atlas.chat.lastSession";

export function readLastSession(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

export function writeLastSession(key: string | null): void {
  try {
    if (key) localStorage.setItem(LAST_SESSION_KEY, key);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // storage disabled
  }
}
