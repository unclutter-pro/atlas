/**
 * /api/v1/chat/* on top of the chat hub, with the external contract unchanged:
 * the stream's event names and payloads (init, user_message,
 * assistant_message_chunk, assistant_message, tool_activity, agent_started,
 * agent_ended) and the GET /chat/messages shape.
 *
 * Differences that don't break clients: no polling behind it, no 5-minute
 * cap, and the heartbeat is the shared `: keepalive` comment.
 */

import { attachmentUrl } from "../../../lib/attachments";
import { loadConversation } from "./conversation";
import { getHub, type HubEvent } from "./hub";
import { sseResponse } from "./sse";
import type { ChatItem, ChatRunState } from "./types";

export interface LegacyChatMessage {
  role: string;
  content: string;
  timestamp: string;
  toolName?: string;
  attachments?: Array<{ id: string; kind: string; mime_type: string; file_name: string; file_size: number; url: string }>;
}

const running = (s: ChatRunState) => s !== "idle";

/** User / assistant / tool rows as the v1 API always sent them (no thinking, no tool results). */
export function legacyMessages(items: ChatItem[], opts: { attachments: boolean }): LegacyChatMessage[] {
  const out: LegacyChatMessage[] = [];
  for (const it of items) {
    if (it.kind === "user") {
      const m: LegacyChatMessage = { role: "user", content: it.text, timestamp: it.at ?? "" };
      if (opts.attachments && it.attachments.length > 0) {
        m.attachments = it.attachments.map((a) => ({
          id: a.id,
          kind: a.kind,
          mime_type: a.mimeType,
          file_name: a.fileName,
          file_size: a.fileSize,
          url: attachmentUrl(a.id),
        }));
      }
      out.push(m);
    } else if (it.kind === "assistant") out.push({ role: "assistant", content: it.text, timestamp: it.at ?? "" });
    else if (it.kind === "tool") out.push({ role: "tool", content: it.name, timestamp: it.at ?? "", toolName: it.name });
  }
  return out;
}

function conversationFor(key: string): { items: ChatItem[]; state: ChatRunState } {
  const hub = getHub(key);
  const snap = hub.snapshot();
  const items = snap.truncated ? loadConversation(key, { until: hub.cursor?.position }).items : snap.items;
  return { items, state: snap.run.state };
}

/** GET /api/v1/chat/messages body. */
export function legacyMessagesResponse(key: string) {
  const { items, state } = conversationFor(key);
  const isAgentRunning = running(state);
  return {
    ok: true,
    messages: legacyMessages(items, { attachments: true }),
    isAgentRunning,
    isTyping: isAgentRunning,
    toolSteps: items.filter((it) => it.kind === "tool").length,
  };
}

/** GET /api/v1/chat/stream?sessionKey&stream=false */
export function legacyChatStream(key: string, opts: { wantsStreamChunks: boolean }, req?: Request): Response {
  const hub = getHub(key);
  return sseResponse(req, (io) => {
    let wasRunning = false;
    let toolSteps = 0;
    let ended = false;
    const seen = new Set<string>();

    const added = (items: ChatItem[]) => {
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        if (it.kind === "user") io.send("user_message", { content: it.text, timestamp: it.at ?? "" });
        else if (it.kind === "assistant") {
          io.send("assistant_message", { content: it.text, timestamp: it.at ?? "", ...(it.streamId ? { messageId: it.streamId } : {}) });
        } else if (it.kind === "tool") io.send("tool_activity", { toolName: it.name, totalSteps: ++toolSteps });
      }
    };

    const runChanged = (state: ChatRunState) => {
      const isRunning = running(state);
      if (!wasRunning && isRunning) io.send("agent_started", {});
      if (wasRunning && !isRunning) {
        io.send("agent_ended", {});
        ended = true;
        sub.unsubscribe();
        // Give slow consumers time to read agent_ended before the connection drops.
        setTimeout(() => io.close(), 1500);
      }
      wasRunning = isRunning;
    };

    const onEvent = (e: HubEvent) => {
      if (ended) return;
      switch (e.type) {
        case "items_added":
          added(e.items);
          break;
        case "chunks":
          if (!opts.wantsStreamChunks) break;
          for (const r of e.rows) io.send("assistant_message_chunk", { messageId: r.streamId, index: r.index, delta: r.delta });
          break;
        case "run":
          runChanged(e.run.state);
          break;
        case "reset":
          added(e.snapshot.items);
          runChanged(e.snapshot.run.state);
          break;
        case "deleted":
          io.close();
          break;
      }
    };

    const sub = hub.subscribe(onEvent);
    const snap = sub.snapshot;
    const items = snap.truncated ? loadConversation(key, { until: hub.cursor?.position }).items : snap.items;
    for (const it of snap.items) seen.add(it.id);
    toolSteps = items.filter((it) => it.kind === "tool").length;
    wasRunning = running(snap.run.state);
    io.send("init", { messages: legacyMessages(items, { attachments: false }), isAgentRunning: wasRunning, toolSteps });
    return sub.unsubscribe;
  });
}
