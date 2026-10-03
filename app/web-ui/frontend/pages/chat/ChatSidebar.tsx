/** Chat list: New chat, search, Today / Yesterday / Earlier, per-row actions, archived toggle. */

import { useEffect, useRef, useState } from "react";
import { errorMessage, type ApiState } from "../../api";
import { Alert, Button, ConfirmButton, Loading, TextField, Time, Toggle } from "../../components";
import { links } from "../../links";
import { Link } from "../../router";
import type { ChatSessionSummary, ChatSessionsResponse } from "../../../ui-api/chat/types";
import { InlineRename } from "./ChatView";
import { chatApi } from "./chatApi";
import { bucketSessions, sessionTitle } from "./days";

export function ChatSidebar(props: {
  sessions: ApiState<ChatSessionsResponse>;
  activeKey: string | null;
  search: string;
  onSearch: (q: string) => void;
  archived: boolean;
  onArchived: (v: boolean) => void;
  onNew: () => void;
  creating: boolean;
  /** After a rename/archive/delete of `key`. */
  onMutated: (key: string, change: "renamed" | "archived" | "unarchived" | "deleted") => void;
  onNavigate: () => void;
}) {
  const { sessions } = props;
  const list = sessions.data?.sessions ?? [];
  const groups = bucketSessions(list);
  const [error, setError] = useState<string | null>(null);

  return (
    <aside className="chat-sidebar" aria-label="Chats">
      <div className="chat-sidebar-top">
        <Button variant="primary" className="chat-new" onClick={props.onNew} pending={props.creating}>
          + New chat
        </Button>
        <TextField type="search" value={props.search} onChange={props.onSearch} placeholder="Search chats" />
      </div>
      <div className="chat-sidebar-list">
        {error && (
          <div className="chat-sidebar-error">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        {sessions.data == null ? (
          sessions.error ? (
            <div className="chat-sidebar-empty text-error">{sessions.error}</div>
          ) : (
            <Loading />
          )
        ) : list.length === 0 ? (
          <div className="chat-sidebar-empty">{props.search ? "No chats match." : props.archived ? "No archived chats." : "No chats yet."}</div>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="chat-group">
              <div className="chat-group-label">{g.label}</div>
              {g.sessions.map((s) => (
                <SessionRow
                  key={s.key}
                  session={s}
                  active={s.key === props.activeKey}
                  onNavigate={props.onNavigate}
                  onError={setError}
                  onMutated={(change) => {
                    setError(null);
                    props.onMutated(s.key, change);
                  }}
                />
              ))}
            </div>
          ))
        )}
      </div>
      <div className="chat-sidebar-bottom">
        <Toggle checked={props.archived} onChange={props.onArchived} label="Archived" title="Show archived chats" />
      </div>
    </aside>
  );
}

function SessionRow(props: {
  session: ChatSessionSummary;
  active: boolean;
  onNavigate: () => void;
  onError: (msg: string | null) => void;
  onMutated: (change: "renamed" | "archived" | "unarchived" | "deleted") => void;
}) {
  const s = props.session;
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !rowRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const run = async (fn: () => Promise<unknown>, change: "renamed" | "archived" | "unarchived" | "deleted") => {
    setBusy(true);
    try {
      await fn();
      setMenu(false);
      props.onMutated(change);
      return true;
    } catch (err) {
      props.onError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const title = sessionTitle(s);
  if (renaming) {
    return (
      <div className="chat-session is-editing" ref={rowRef}>
        <InlineRename
          initial={s.title ?? ""}
          placeholder={title}
          onCancel={() => setRenaming(false)}
          onSave={async (v) => {
            if (await run(() => chatApi.update(s.key, { title: v || null }), "renamed")) setRenaming(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className={`chat-session${props.active ? " is-active" : ""}${menu ? " has-menu" : ""}`} ref={rowRef}>
      <Link href={links.chat(s.key)} className="chat-session-link" aria-current={props.active ? "page" : undefined} onClick={props.onNavigate}>
        <span className="chat-session-title">{title}</span>
        <span className="chat-session-sub">
          <span className="chat-session-preview">{s.preview ?? "No messages yet"}</span>
          <Time value={s.lastActivityAt} className="chat-session-time" />
        </span>
      </Link>
      {!s.isDefault && (
        <button type="button" className="chat-session-more" aria-label={`Actions for ${title}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          ⋯
        </button>
      )}
      {menu && (
        <div className="chat-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="chat-menu-item"
            onClick={() => {
              setMenu(false);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="chat-menu-item"
            disabled={busy}
            onClick={() => run(() => chatApi.update(s.key, { archived: !s.archivedAt }), s.archivedAt ? "unarchived" : "archived")}
          >
            {s.archivedAt ? "Unarchive" : "Archive"}
          </button>
          <div className="chat-menu-danger">
            <ConfirmButton size="sm" prompt="Delete?" confirmLabel="Delete" pending={busy} onConfirm={() => run(() => chatApi.remove(s.key), "deleted")}>
              Delete
            </ConfirmButton>
          </div>
        </div>
      )}
    </div>
  );
}
