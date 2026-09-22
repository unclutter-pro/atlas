/** One chat: header, live conversation, composer. */

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api";
import { Alert, Button, ButtonLink, EmptyState, Loading, Money, StatusBadge } from "../../components";
import { links } from "../../links";
import { useStatus } from "../../shell/status";
import { Link, useTitle } from "../../router";
import type { ChatRun, ChatSessionDetail, ChatStreamEvent } from "../../../ui-api/chat/types";
import { chatApi, writeLastSession } from "./chatApi";
import { Composer } from "./Composer";
import { sessionTitle } from "./days";
import { Conversation } from "./Messages";
import { useChatStream } from "./useChatStream";
import { useStickToBottom } from "./useStickToBottom";

export function ChatView(props: {
  sessionKey: string;
  /** Sidebar should refresh (title, preview, order may have changed). */
  onSessionsChanged: () => void;
  onDeleted: () => void;
  onToggleSidebar: () => void;
}) {
  const { sessionKey, onSessionsChanged } = props;
  const onChangedRef = useRef(onSessionsChanged);
  onChangedRef.current = onSessionsChanged;
  const chat = useChatStream(sessionKey, {
    onEvent: (e: ChatStreamEvent) => {
      if (e.event === "session" || (e.event === "item" && e.data.item.kind === "user")) onChangedRef.current();
    },
  });
  const { state } = chat;
  const scroll = useStickToBottom([state.items, state.drafts, state.pending, state.run.state]);

  useTitle(state.session ? sessionTitle(state.session) : null);

  useEffect(() => {
    if (state.status === "ready") writeLastSession(sessionKey);
  }, [state.status, sessionKey]);

  const onDeleted = props.onDeleted;
  useEffect(() => {
    if (state.status === "deleted") onDeleted();
  }, [state.status, onDeleted]);

  if (state.status === "not_found") {
    return (
      <div className="chat-main">
        <ChatTopBar onToggleSidebar={props.onToggleSidebar} />
        <EmptyState title="Chat not found">It may have been deleted. Pick another chat or start a new one.</EmptyState>
      </div>
    );
  }

  const session = state.session;
  const archived = !!session?.archivedAt;
  // Sends are refused while paused (409); say so instead of failing the bubble.
  const paused = useStatus().data?.control.paused === true;

  return (
    <div className="chat-main">
      {session ? (
        <ChatHeader
          session={session}
          run={state.run}
          sessionKey={sessionKey}
          onToggleSidebar={props.onToggleSidebar}
          onChanged={(detail) => {
            chat.applySession(detail);
            onSessionsChanged();
          }}
        />
      ) : (
        <ChatTopBar onToggleSidebar={props.onToggleSidebar} />
      )}
      {state.connection === "reconnecting" && state.status === "ready" && (
        <div className="chat-banner chat-banner-warn">Connection lost, reconnecting…</div>
      )}
      <div className="chat-scroll" ref={scroll.containerRef} onScroll={scroll.onScroll}>
        <div className="chat-thread" ref={scroll.contentRef}>
          {state.truncated && (
            <div className="chat-truncated">
              Showing the latest entries.{" "}
              {session?.sessionId ? <Link href={links.session(session.sessionId)}>Full transcript in Activity</Link> : "Full transcript in Activity"}
            </div>
          )}
          {state.status === "loading" ? (
            <Loading />
          ) : state.items.length === 0 && state.drafts.length === 0 && state.pending.length === 0 ? (
            <EmptyState title="Start a conversation">
              {archived ? "This chat is archived." : "Messages go to the agent's persistent web chat session."}
            </EmptyState>
          ) : (
            <Conversation state={state} onRetry={chat.retry} onDiscard={chat.discard} />
          )}
        </div>
      </div>
      {scroll.hasNew && (
        <button type="button" className="chat-new-pill" onClick={scroll.scrollToBottom}>
          New messages ↓
        </button>
      )}
      <div className="chat-footer">
        {chat.notice && (
          <Alert tone="warn">
            <span className="spacer">{chat.notice}</span>
            <Button size="sm" variant="ghost" onClick={chat.dismissNotice}>
              Dismiss
            </Button>
          </Alert>
        )}
        <Composer
          key={sessionKey}
          autoFocus
          disabled={state.status !== "ready" || archived || paused}
          disabledHint={archived ? "Unarchive to continue" : paused ? "Atlas is paused. Resume it in the status bar to chat." : "Connecting…"}
          onSend={(text) => {
            scroll.scrollToBottomNext();
            void chat.sendText(text);
          }}
          onSendVoice={(blob, caption) => {
            scroll.scrollToBottomNext();
            void chat.sendVoice(blob, caption);
          }}
        />
      </div>
    </div>
  );
}

function SidebarToggle(props: { onClick: () => void }) {
  return (
    <button type="button" className="chat-drawer-toggle btn btn-ghost btn-sm" onClick={props.onClick} aria-label="Show chats">
      ☰ Chats
    </button>
  );
}

function ChatTopBar(props: { onToggleSidebar: () => void }) {
  return (
    <header className="chat-header">
      <SidebarToggle onClick={props.onToggleSidebar} />
    </header>
  );
}

function ChatHeader(props: { session: ChatSessionDetail; run: ChatRun; sessionKey: string; onToggleSidebar: () => void; onChanged: (session: ChatSessionDetail) => void }) {
  const { session, run, sessionKey } = props;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // "Stopping…" lasts until the runner reports a run change.
  useEffect(() => setStopping(false), [run]);

  const patch = async (body: { title?: string | null; archived?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await chatApi.update(sessionKey, body);
      props.onChanged(res.session);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      const res = await chatApi.stop(sessionKey);
      if (!res.stopped) {
        setStopping(false);
        if (res.reason === "unreachable") setError("Could not reach the running session");
      }
    } catch (err) {
      setStopping(false);
      setError(errorMessage(err));
    }
  };

  const title = sessionTitle(session);
  return (
    <header className="chat-header">
      <SidebarToggle onClick={props.onToggleSidebar} />
      <div className="chat-header-title">
        {editing ? (
          <InlineRename
            initial={session.title ?? ""}
            placeholder={title}
            onCancel={() => setEditing(false)}
            onSave={async (v) => {
              if (await patch({ title: v || null })) setEditing(false);
            }}
          />
        ) : (
          <button type="button" className="chat-title" title="Rename" onClick={() => setEditing(true)}>
            <span className="chat-title-text">{title}</span>
            <span className="chat-title-pencil" aria-hidden="true">
              ✎
            </span>
          </button>
        )}
        {session.archivedAt && <span className="badge badge-idle">Archived</span>}
        <RunBadge run={run} />
      </div>
      <div className="chat-header-actions">
        {error && <span className="small text-error">{error}</span>}
        {run.canStop && (
          <Button size="sm" variant="danger" onClick={stop} disabled={stopping} title="Interrupt the current turn; the chat stays open">
            {stopping ? "Stopping…" : "Stop turn"}
          </Button>
        )}
        {session.archivedAt && (
          <Button size="sm" onClick={() => patch({ archived: false })} pending={busy}>
            Unarchive
          </Button>
        )}
        {session.stats && (
          <span className="chat-stats small muted" title="Cost and runs of the current Claude session">
            <Money usd={session.stats.costUsd} /> · {session.stats.runs} {session.stats.runs === 1 ? "run" : "runs"}
          </span>
        )}
        {session.sessionId && (
          <ButtonLink size="sm" variant="ghost" href={links.session(session.sessionId)}>
            Open in Activity
          </ButtonLink>
        )}
      </div>
    </header>
  );
}

export function RunBadge(props: { run: ChatRun }) {
  const { run } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run.state !== "running") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [run.state]);
  if (run.state === "idle") return null;
  if (run.state === "starting") return <StatusBadge status="running">Starting</StatusBadge>;
  const since = run.since ? Date.parse(run.since) : NaN;
  const secs = Number.isNaN(since) ? null : Math.max(0, Math.floor((now - since) / 1000));
  return (
    <StatusBadge status="running">
      Working{secs != null && <span className="num"> · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>}
    </StatusBadge>
  );
}

/** Text input for renames: Enter saves, Escape cancels, blur saves. */
export function InlineRename(props: { initial: string; placeholder?: string; onSave: (value: string) => unknown; onCancel: () => void }) {
  const [value, setValue] = useState(props.initial);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (v === props.initial.trim()) props.onCancel();
    // Re-arm when the save fails and the input stays open.
    else void Promise.resolve(props.onSave(v)).finally(() => (done.current = false));
  };
  return (
    <input
      className="input chat-rename"
      value={value}
      maxLength={200}
      placeholder={props.placeholder}
      autoFocus
      aria-label="Chat title"
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          props.onCancel();
        }
      }}
    />
  );
}
