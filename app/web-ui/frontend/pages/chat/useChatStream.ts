/**
 * Live state of one chat: EventSource → reducer, plus send/stop actions with
 * optimistic bubbles. No polling; the stream pushes everything.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { errorMessage } from "../../api";
import type { ChatSessionDetail, ChatStreamEvent } from "../../../ui-api/chat/types";
import { chatApi, newClientId, sessionPath, streamUrl } from "./chatApi";
import { chatReducer, initialChatState, type ChatViewState, type PendingSend } from "./reducer";
import { ChatStream } from "./stream";

export interface ChatStreamApi {
  state: ChatViewState;
  sendText: (text: string) => Promise<void>;
  sendVoice: (blob: Blob, caption: string) => Promise<void>;
  retry: (clientId: string) => void;
  discard: (clientId: string) => void;
  /** Apply a session detail from a mutation response (the stream sends the same shortly). */
  applySession: (session: ChatSessionDetail) => void;
  /** Set when the last send was saved but no agent could be started. */
  notice: string | null;
  dismissNotice: () => void;
}

type Outgoing = { kind: "text"; text: string } | { kind: "voice"; file: File; caption: string };

const EXT: Record<string, string> = { webm: "webm", ogg: "ogg", mp4: "m4a", mpeg: "mp3", wav: "wav", aac: "aac" };

export function voiceFileName(mime: string, now = new Date()): string {
  const sub = mime.split(";")[0]!.split("/")[1] ?? "";
  return `voice-${now.toISOString().replace(/[:.]/g, "-")}.${EXT[sub] ?? "webm"}`;
}

/** How long an idle draft may wait for its final item before it is shown as interrupted. */
const DRAFT_GRACE_MS = 10_000;

export function useChatStream(sessionKey: string, opts: { onEvent?: (e: ChatStreamEvent) => void } = {}): ChatStreamApi {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  // After a normal turn end the final item usually replaces the draft within a
  // second; a draft still open well after that will never be finalized.
  const openIdleDrafts = state.run.state === "idle" && state.drafts.some((d) => !d.interrupted);
  useEffect(() => {
    if (!openIdleDrafts) return;
    const t = setTimeout(() => dispatch({ type: "expire_drafts" }), DRAFT_GRACE_MS);
    return () => clearTimeout(t);
  }, [openIdleDrafts]);
  const [notice, setNotice] = useState<string | null>(null);
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;
  // Payloads of optimistic sends, kept for Retry.
  const outgoing = useRef(new Map<string, Outgoing>());
  const blobUrls = useRef(new Map<string, string>());

  useEffect(() => {
    dispatch({ type: "connection", connection: "connecting" });
    const stream = new ChatStream({
      url: streamUrl(sessionKey),
      onEvent: (event) => {
        dispatch({ type: "event", event });
        onEventRef.current?.(event);
      },
      onConnection: (connection) => dispatch({ type: "connection", connection }),
      onNotFound: () => dispatch({ type: "not_found" }),
      checkExists: async () => {
        try {
          const res = await fetch(sessionPath(sessionKey));
          return res.status === 404 ? "missing" : res.ok ? "exists" : "unknown";
        } catch {
          return "unknown";
        }
      },
    });
    stream.start();
    return () => stream.close();
  }, [sessionKey]);

  useEffect(() => {
    const urls = blobUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const forget = useCallback((clientId: string) => {
    outgoing.current.delete(clientId);
    const url = blobUrls.current.get(clientId);
    if (url) {
      URL.revokeObjectURL(url);
      blobUrls.current.delete(clientId);
    }
  }, []);

  const deliver = useCallback(
    async (clientId: string, out: Outgoing) => {
      try {
        const res =
          out.kind === "text" ? await chatApi.send(sessionKey, out.text, clientId) : await chatApi.sendVoice(sessionKey, out.file, out.caption, clientId);
        dispatch({ type: "sent", response: res });
        forget(clientId);
        setNotice(res.triggered ? null : "Saved, but the agent could not be started.");
      } catch (err) {
        dispatch({ type: "pending_update", clientId, patch: { status: "failed", error: errorMessage(err) } });
      }
    },
    [sessionKey, forget],
  );

  const start = useCallback(
    (out: Outgoing, clientId = newClientId()) => {
      outgoing.current.set(clientId, out);
      let audioUrl = blobUrls.current.get(clientId);
      if (out.kind === "voice" && !audioUrl && typeof URL.createObjectURL === "function") {
        audioUrl = URL.createObjectURL(out.file);
        blobUrls.current.set(clientId, audioUrl);
      }
      const pending: PendingSend = {
        clientId,
        kind: out.kind,
        text: out.kind === "text" ? out.text : out.caption,
        audioUrl,
        status: out.kind === "voice" ? "transcribing" : "sending",
        at: new Date().toISOString(),
      };
      dispatch({ type: "pending_add", pending });
      return deliver(clientId, out);
    },
    [deliver],
  );

  const sendText = useCallback((text: string) => start({ kind: "text", text }), [start]);

  const sendVoice = useCallback(
    (blob: Blob, caption: string) => {
      const type = blob.type || "audio/webm";
      const file = new File([blob], voiceFileName(type), { type });
      return start({ kind: "voice", file, caption });
    },
    [start],
  );

  const retry = useCallback(
    (clientId: string) => {
      const out = outgoing.current.get(clientId);
      if (out) void start(out, clientId);
    },
    [start],
  );

  const discard = useCallback(
    (clientId: string) => {
      forget(clientId);
      dispatch({ type: "pending_remove", clientId });
    },
    [forget],
  );

  const applySession = useCallback((session: ChatSessionDetail) => dispatch({ type: "event", event: { event: "session", data: session } }), []);

  return { state, applySession, sendText, sendVoice, retry, discard, notice, dismissNotice: useCallback(() => setNotice(null), []) };
}
