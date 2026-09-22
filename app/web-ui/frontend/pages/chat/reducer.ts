/**
 * Chat view state: snapshot + live stream events + optimistic sends.
 * Pure; the rules are documented next to each case and covered by reducer.test.ts.
 */

import type { ChatItem, ChatRun, ChatSessionDetail, ChatStreamEvent, ChatUserItem, SendChatMessageResponse, StreamDraft } from "../../../ui-api/chat/types";

export interface PendingSend {
  clientId: string;
  kind: "text" | "voice";
  text: string;
  /** Local blob URL of a recorded voice message. */
  audioUrl?: string;
  status: "sending" | "transcribing" | "failed";
  error?: string;
  at: string;
}

export type ChatDraft = StreamDraft & { interrupted?: boolean };

export interface ChatViewState {
  status: "loading" | "ready" | "not_found" | "deleted";
  connection: "connecting" | "open" | "reconnecting";
  session: ChatSessionDetail | null;
  items: ChatItem[];
  drafts: ChatDraft[];
  pending: PendingSend[];
  run: ChatRun;
  truncated: boolean;
}

export type ChatAction =
  | { type: "event"; event: ChatStreamEvent }
  | { type: "connection"; connection: ChatViewState["connection"] }
  | { type: "not_found" }
  | { type: "sent"; response: SendChatMessageResponse }
  | { type: "pending_add"; pending: PendingSend }
  | { type: "pending_update"; clientId: string; patch: Partial<Omit<PendingSend, "clientId">> }
  | { type: "pending_remove"; clientId: string }
  /** Idle drafts whose final item never arrived. */
  | { type: "expire_drafts" };

export const IDLE_RUN: ChatRun = { state: "idle", since: null, canStop: false };

export const initialChatState: ChatViewState = {
  status: "loading",
  connection: "connecting",
  session: null,
  items: [],
  drafts: [],
  pending: [],
  run: IDLE_RUN,
  truncated: false,
};

export function chatReducer(state: ChatViewState, action: ChatAction): ChatViewState {
  switch (action.type) {
    case "connection":
      return state.connection === action.connection ? state : { ...state, connection: action.connection };
    case "not_found":
      return { ...state, status: "not_found" };
    case "sent":
      return addItem(state, action.response.item);
    case "pending_add":
      return { ...state, pending: [...state.pending.filter((p) => p.clientId !== action.pending.clientId), action.pending] };
    case "pending_update":
      return { ...state, pending: state.pending.map((p) => (p.clientId === action.clientId ? { ...p, ...action.patch } : p)) };
    case "pending_remove":
      return { ...state, pending: state.pending.filter((p) => p.clientId !== action.clientId) };
    case "expire_drafts":
      return state.drafts.some((d) => !d.interrupted) ? { ...state, drafts: state.drafts.map((d) => ({ ...d, interrupted: true })) } : state;
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: ChatViewState, ev: ChatStreamEvent): ChatViewState {
  switch (ev.event) {
    case "snapshot": {
      // Replaces everything except optimistic sends that have no real item yet.
      const { session, items, drafts, run, truncated } = ev.data;
      const confirmed = new Set(items.map((i) => (i.kind === "user" ? i.clientId : undefined)).filter(Boolean));
      return {
        ...state,
        status: state.status === "deleted" ? "deleted" : "ready",
        session,
        items,
        drafts: drafts.map((d) => ({ ...d })),
        run,
        truncated,
        pending: state.pending.filter((p) => !confirmed.has(p.clientId)),
      };
    }
    case "item":
      return addItem(state, ev.data.item);
    case "item_update": {
      const idx = state.items.findIndex((i) => i.id === ev.data.item.id);
      if (idx < 0) return state;
      const items = state.items.slice();
      items[idx] = ev.data.item;
      return { ...state, items };
    }
    case "delta": {
      const { streamId, text } = ev.data;
      const idx = state.drafts.findIndex((d) => d.streamId === streamId);
      if (idx < 0) return { ...state, drafts: [...state.drafts, { streamId, text }] };
      const drafts = state.drafts.slice();
      drafts[idx] = { ...drafts[idx]!, text: drafts[idx]!.text + text, interrupted: false };
      return { ...state, drafts };
    }
    case "run": {
      const run = ev.data;
      // A stopped turn never finalizes its drafts. After a normal end the final
      // item may still follow (it replaces the draft by streamId); drafts that
      // outlive that grace period are expired by useChatStream.
      let drafts = state.drafts;
      if (run.state === "idle" && run.interrupted) drafts = drafts.map((d) => ({ ...d, interrupted: true }));
      else if (run.state === "running") drafts = drafts.filter((d) => !d.interrupted);
      return { ...state, run, drafts };
    }
    case "session":
      return { ...state, session: ev.data };
    case "session_deleted":
      return { ...state, status: "deleted" };
  }
}

/** New or replayed item: replace by id, else append; swaps an optimistic bubble and a finished draft. */
function addItem(state: ChatViewState, item: ChatItem): ChatViewState {
  const idx = state.items.findIndex((i) => i.id === item.id);
  let items: ChatItem[];
  if (idx >= 0) {
    items = state.items.slice();
    // The POST response and the stream event carry the same item; keep the clientId echo either way.
    const prev = items[idx]!;
    items[idx] = item.kind === "user" && prev.kind === "user" && !item.clientId && prev.clientId ? { ...item, clientId: prev.clientId } : item;
  } else {
    items = [...state.items, item];
  }
  const clientId = item.kind === "user" ? (item as ChatUserItem).clientId : undefined;
  const pending = clientId ? state.pending.filter((p) => p.clientId !== clientId) : state.pending;
  const drafts = item.kind === "assistant" && item.streamId ? state.drafts.filter((d) => d.streamId !== item.streamId) : state.drafts;
  return {
    ...state,
    items,
    pending: pending.length === state.pending.length ? state.pending : pending,
    drafts: drafts.length === state.drafts.length ? state.drafts : drafts,
  };
}

// --- Rendering helpers --------------------------------------------------------

export type ChatBlock =
  | { kind: "item"; item: Exclude<ChatItem, { kind: "tool" }> }
  | { kind: "tools"; id: string; tools: Extract<ChatItem, { kind: "tool" }>[] };

/** Items → render blocks; consecutive tool calls collapse into one group. */
export function groupItems(items: ChatItem[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.tools.push(item);
      else out.push({ kind: "tools", id: item.id, tools: [item] });
    } else {
      out.push({ kind: "item", item });
    }
  }
  return out;
}

/** What the tail of the conversation shows while a turn is in flight. */
export function activityHint(state: Pick<ChatViewState, "run" | "items" | "drafts">): { kind: "none" } | { kind: "typing" } | { kind: "tool"; name: string } {
  if (state.run.state === "idle") return { kind: "none" };
  const lastDraft = state.drafts[state.drafts.length - 1];
  if (lastDraft && !lastDraft.interrupted) return { kind: "none" };
  const last = state.items[state.items.length - 1];
  if (last?.kind === "tool" && last.result === null) return { kind: "tool", name: last.name };
  return { kind: "typing" };
}
