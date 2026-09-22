/**
 * Chat — "Talk to the agent".
 *   /chat         picks a chat (?session= / ?sessionKey=, last opened, newest, _default)
 *   /chat/:key    one chat, live over SSE (server: ui-api/chat.ts, wire types: ui-api/chat/types.ts)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, useApi } from "../../api";
import { Alert, Loading, NotFound } from "../../components";
import { links } from "../../links";
import { Redirect, Routes, navigate, useSearchParams, type Params } from "../../router";
import { DEFAULT_SESSION_KEY, type ChatSessionsResponse } from "../../../ui-api/chat/types";
import { chatApi, isValidSessionKey, readLastSession, sessionsPath, writeLastSession } from "./chatApi";
import { ChatSidebar } from "./ChatSidebar";
import { ChatView } from "./ChatView";
import "./chat.css";

export default function ChatArea() {
  return (
    <Routes
      routes={[
        { path: "/chat", component: ChatIndex },
        { path: "/chat/:key", component: ChatLayout },
      ]}
      fallback={<NotFound />}
    />
  );
}

function ChatIndex() {
  const [params] = useSearchParams();
  const requested = params.get("session") ?? params.get("sessionKey");
  const sessions = useApi<ChatSessionsResponse>(requested == null ? sessionsPath({}) : null);

  if (requested != null) return <Redirect to={links.chat(isValidSessionKey(requested) ? requested : DEFAULT_SESSION_KEY)} />;
  if (!sessions.data && !sessions.error) return <Loading />;
  const list = sessions.data?.sessions ?? [];
  const last = readLastSession();
  const target =
    (last && list.some((s) => s.key === last) ? last : null) ?? list.find((s) => !s.archivedAt)?.key ?? DEFAULT_SESSION_KEY;
  return <Redirect to={links.chat(target)} />;
}

const SEARCH_DEBOUNCE_MS = 250;
const REFRESH_DEBOUNCE_MS = 500;

function ChatLayout(props: { params: Params }) {
  const key = props.params.key!;
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const sessions = useApi<ChatSessionsResponse>(sessionsPath({ archived: archived ? "only" : "exclude", q: q || undefined }));
  const { refetch } = sessions;

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refetch(), REFRESH_DEBOUNCE_MS);
  }, [refetch]);
  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);

  const onDeleted = useCallback(() => {
    if (readLastSession() === key) writeLastSession(null);
    void refetch();
    navigate("/chat", { replace: true });
  }, [key, refetch]);

  const newChat = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await chatApi.create();
      setArchived(false);
      setSearch("");
      setDrawer(false);
      navigate(links.chat(res.session.key));
      void refetch();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={`chat${drawer ? " is-drawer-open" : ""}`}>
      <ChatSidebar
        sessions={sessions}
        activeKey={key}
        search={search}
        onSearch={setSearch}
        archived={archived}
        onArchived={setArchived}
        onNew={newChat}
        creating={creating}
        onNavigate={() => setDrawer(false)}
        onMutated={(mutated, change) => {
          void refetch();
          // The stream's session_deleted may already have navigated away.
          if (change === "deleted" && mutated === key && window.location.pathname === links.chat(key)) onDeleted();
        }}
      />
      <div className="chat-drawer-backdrop" onClick={() => setDrawer(false)} />
      {createError && (
        <div className="chat-toast">
          <Alert tone="error">Could not create a chat: {createError}</Alert>
        </div>
      )}
      {isValidSessionKey(key) ? (
        <ChatView key={key} sessionKey={key} onSessionsChanged={refreshSoon} onDeleted={onDeleted} onToggleSidebar={() => setDrawer((d) => !d)} />
      ) : (
        <div className="chat-main">
          <NotFound />
        </div>
      )}
    </div>
  );
}
