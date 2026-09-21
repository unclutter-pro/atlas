/** Conversation rendering: bubbles, tool calls, thinking, streaming drafts, optimistic sends. */

import { memo, useEffect, useMemo, useState } from "react";
import { Button, CodeBlock, CopyButton, Time, formatBytes, prettyJson } from "../../components";
import type { ChatAssistantItem, ChatAttachment, ChatThinkingItem, ChatToolItem, ChatUserItem } from "../../../ui-api/chat/types";
import { renderMarkdown } from "./markdown";
import { activityHint, groupItems, type ChatDraft, type ChatViewState, type PendingSend } from "./reducer";

export const Markdown = memo(function Markdown(props: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(props.text), [props.text]);
  return <div className={`chat-md ${props.className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
});

function Attachment(props: { a: ChatAttachment }) {
  const { a } = props;
  if (a.kind === "audio") {
    return (
      <div className="chat-attachment chat-attachment-audio">
        {a.url ? <audio controls preload="none" src={a.url} /> : <span className="faint small" title="The file is no longer on disk">{a.fileName} (gone)</span>}
        {a.transcription && <div className="chat-transcription">{a.transcription}</div>}
      </div>
    );
  }
  const label = (
    <>
      <span className="chat-chip-name">{a.fileName}</span>
      <span className="chat-chip-size">{formatBytes(a.fileSize)}</span>
    </>
  );
  return a.url ? (
    <a className="chat-chip" href={a.url} target="_blank" rel="noopener noreferrer" title={a.mimeType}>
      {label}
    </a>
  ) : (
    <span className="chat-chip is-gone" title="The file is no longer on disk">
      {label}
    </span>
  );
}

export const UserMessage = memo(function UserMessage(props: { item: ChatUserItem }) {
  const { item } = props;
  return (
    <div className="chat-row chat-row-user">
      <div className="chat-bubble chat-bubble-user">
        {item.text && <div className="chat-user-text">{item.text}</div>}
        {item.attachments.length > 0 && (
          <div className="chat-attachments">
            {item.attachments.map((a) => (
              <Attachment key={a.id} a={a} />
            ))}
          </div>
        )}
      </div>
      <div className="chat-meta">
        <Time value={item.at} />
      </div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage(props: { item: ChatAssistantItem }) {
  const { item } = props;
  return (
    <div className="chat-row chat-row-assistant">
      <div className="chat-bubble chat-bubble-assistant">
        <Markdown text={item.text} />
      </div>
      <div className="chat-meta">
        <Time value={item.at} />
        <CopyButton text={item.text} className="chat-copy" />
      </div>
    </div>
  );
});

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const ThinkingBlock = memo(function ThinkingBlock(props: { item: ChatThinkingItem }) {
  return (
    <details className="chat-aside chat-thinking">
      <summary>
        <span className="chat-aside-label">Thinking</span>
        <span className="chat-aside-hint">{oneLine(props.item.text, 120)}</span>
      </summary>
      <div className="chat-aside-body chat-thinking-text">{props.item.text}</div>
    </details>
  );
});

const Spinner = () => <span className="chat-spinner" aria-label="Running" />;

export const ToolCall = memo(function ToolCall(props: { tool: ChatToolItem; running: boolean }) {
  const { tool } = props;
  return (
    <details className={`chat-tool${tool.isError ? " is-error" : ""}`}>
      <summary>
        {props.running && tool.result === null ? <Spinner /> : <span className="chat-tool-dot" />}
        <span className="chat-tool-name">{tool.name}</span>
        {tool.summary && <span className="chat-tool-summary">{tool.summary}</span>}
        {tool.isError && <span className="tag chat-tag-error">error</span>}
      </summary>
      <div className="chat-tool-body">
        <CodeBlock label="Input" code={prettyJson(tool.input)} maxHeight={240} />
        {tool.result === null ? (
          <div className="faint small">{props.running ? "Waiting for result…" : "No result recorded"}</div>
        ) : (
          <CodeBlock label="Result" code={tool.result} maxHeight={320} copy />
        )}
      </div>
    </details>
  );
});

function toolNames(tools: ChatToolItem[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return parts.length > 4 ? `${parts.slice(0, 4).join(", ")}, …` : parts.join(", ");
}

export function ToolGroup(props: { tools: ChatToolItem[]; running: boolean }) {
  const { tools } = props;
  const last = tools[tools.length - 1]!;
  const active = props.running && last.result === null;
  if (tools.length === 1) return <ToolCall tool={last} running={props.running} />;
  const errors = tools.filter((t) => t.isError).length;
  return (
    <details className="chat-aside chat-toolgroup">
      <summary>
        {active ? <Spinner /> : null}
        <span className="chat-aside-label">{tools.length} tool calls</span>
        <span className="chat-aside-hint">{toolNames(tools)}</span>
        {errors > 0 && <span className="tag chat-tag-error">{errors} error{errors > 1 ? "s" : ""}</span>}
      </summary>
      <div className="chat-aside-body chat-toolgroup-body">
        {tools.map((t) => (
          <ToolCall key={t.id} tool={t} running={props.running} />
        ))}
      </div>
    </details>
  );
}

/** Streamed text; re-renders the markdown at most once per animation frame. */
export function DraftMessage(props: { draft: ChatDraft }) {
  const text = useFrameThrottled(props.draft.text);
  return (
    <div className="chat-row chat-row-assistant">
      <div className={`chat-bubble chat-bubble-assistant is-draft${props.draft.interrupted ? " is-interrupted" : ""}`}>
        <Markdown text={text} />
      </div>
      {props.draft.interrupted && <div className="chat-meta">Interrupted</div>}
    </div>
  );
}

function useFrameThrottled(value: string): string {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value === shown) return;
    if (typeof requestAnimationFrame !== "function") return setShown(value);
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value, shown]);
  return shown;
}

export function PendingMessage(props: { pending: PendingSend; onRetry: () => void; onDiscard: () => void }) {
  const p = props.pending;
  const failed = p.status === "failed";
  return (
    <div className={`chat-row chat-row-user is-pending${failed ? " is-failed" : ""}`}>
      <div className="chat-bubble chat-bubble-user">
        {p.text && <div className="chat-user-text">{p.text}</div>}
        {p.audioUrl && (
          <div className="chat-attachments">
            <div className="chat-attachment chat-attachment-audio">
              <audio controls preload="metadata" src={p.audioUrl} />
            </div>
          </div>
        )}
      </div>
      <div className="chat-meta">
        {failed ? (
          <>
            <span className="text-error">{p.error || "Failed to send"}</span>
            <Button size="sm" variant="ghost" onClick={props.onRetry}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onDiscard}>
              Discard
            </Button>
          </>
        ) : (
          <span>{p.status === "transcribing" ? "Transcribing…" : "Sending…"}</span>
        )}
      </div>
    </div>
  );
}

function ActivityHint(props: { state: Pick<ChatViewState, "run" | "items" | "drafts"> }) {
  const hint = activityHint(props.state);
  if (hint.kind === "none") return null;
  if (hint.kind === "tool") {
    return (
      <div className="chat-typing chat-typing-tool">
        <Spinner /> Running {hint.name}…
      </div>
    );
  }
  return (
    <div className="chat-typing" aria-label="Agent is working">
      <span className="chat-dot" />
      <span className="chat-dot" />
      <span className="chat-dot" />
    </div>
  );
}

/** Everything inside the scroll container. */
export function Conversation(props: {
  state: ChatViewState;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
}) {
  const { state } = props;
  const blocks = useMemo(() => groupItems(state.items), [state.items]);
  const running = state.run.state !== "idle";
  return (
    <>
      {blocks.map((b) => {
        if (b.kind === "tools") return <ToolGroup key={b.id} tools={b.tools} running={running} />;
        const item = b.item;
        switch (item.kind) {
          case "user":
            return <UserMessage key={item.id} item={item} />;
          case "assistant":
            return <AssistantMessage key={item.id} item={item} />;
          case "thinking":
            return <ThinkingBlock key={item.id} item={item} />;
        }
      })}
      {state.drafts.map((d) => (
        <DraftMessage key={`draft:${d.streamId}`} draft={d} />
      ))}
      {state.pending.map((p) => (
        <PendingMessage key={`pending:${p.clientId}`} pending={p} onRetry={() => props.onRetry(p.clientId)} onDiscard={() => props.onDiscard(p.clientId)} />
      ))}
      <ActivityHint state={state} />
    </>
  );
}
