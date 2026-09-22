/** Session transcript: prompts, replies, thinking and collapsible tool calls. */

import { useState } from "react";
import { Button, EmptyState, MarkdownView, formatDuration, parseTime } from "../../components";
import type { Transcript, TranscriptEntry } from "../../../ui-api/activity";

const LONG_TEXT = 700;

function offset(at: string | null, start: number | null): string {
  const t = parseTime(at)?.getTime();
  if (t == null || start == null) return "";
  return `+${formatDuration(Math.max(0, t - start))}`;
}

/** One-line hint of what a tool call did (command, path, pattern …). */
function toolHint(input: string): string {
  try {
    const obj = JSON.parse(input) as Record<string, unknown>;
    for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").trim();
    }
  } catch {}
  return input.replace(/\s+/g, " ").trim();
}

function LongText(props: { text: string; markdown?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = props.text.length > LONG_TEXT;
  const text = long && !open ? `${props.text.slice(0, LONG_TEXT)}…` : props.text;
  return (
    <>
      {props.markdown ? <MarkdownView text={text} /> : <div className="activity-pre">{text}</div>}
      {long && (
        <button type="button" className="activity-more" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show all (${props.text.length.toLocaleString("en-US")} characters)`}
        </button>
      )}
    </>
  );
}

function Entry(props: { entry: TranscriptEntry; start: number | null; openTools: boolean }) {
  const e = props.entry;
  const time = <span className="activity-t-time">{offset(e.at, props.start)}</span>;
  if (e.kind === "user") {
    return (
      <div className="activity-t activity-t-user">
        <div className="activity-t-label">Input {time}</div>
        <LongText text={e.text} />
      </div>
    );
  }
  if (e.kind === "assistant") {
    return (
      <div className="activity-t activity-t-assistant">
        <div className="activity-t-label">Reply {time}</div>
        <LongText text={e.text} markdown />
      </div>
    );
  }
  if (e.kind === "thinking") {
    return (
      <details className="activity-t activity-t-fold">
        <summary>
          <span className="activity-t-label-inline">Thinking</span>
          <span className="activity-t-hint">{e.text.replace(/\s+/g, " ").slice(0, 120)}</span>
          {time}
        </summary>
        <div className="activity-pre">{e.text}</div>
      </details>
    );
  }
  const pending = e.result == null;
  return (
    <details className={`activity-t activity-t-fold activity-t-tool${e.isError ? " is-error" : ""}`} open={props.openTools}>
      <summary>
        <span className="activity-t-tool-name">{e.name}</span>
        <span className="activity-t-hint">{toolHint(e.input)}</span>
        {e.isError && <span className="text-error small">error</span>}
        {pending && <span className="faint small">no result</span>}
        {time}
      </summary>
      <div className="activity-t-tool-body">
        {e.input && (
          <>
            <div className="activity-t-sub">Input</div>
            <div className="activity-pre activity-code">{e.input}</div>
          </>
        )}
        {e.result != null && (
          <>
            <div className="activity-t-sub">{e.isError ? "Error" : "Result"}</div>
            <div className={`activity-pre activity-code${e.isError ? " text-error" : ""}`}>{e.result || "(empty)"}</div>
          </>
        )}
      </div>
    </details>
  );
}

export function TranscriptView(props: { transcript: Transcript | null; emptyTitle?: string; emptyBody?: string }) {
  const [openTools, setOpenTools] = useState(false);
  const t = props.transcript;
  if (!t || t.entries.length === 0) {
    return (
      <EmptyState compact title={props.emptyTitle ?? "No transcript."}>
        {props.emptyBody ?? "The session file was not found under ~/.claude/projects. It may still be starting or was cleaned up."}
      </EmptyState>
    );
  }
  const start = parseTime(t.entries.find((e) => e.at)?.at ?? null)?.getTime() ?? null;
  const tools = t.entries.filter((e) => e.kind === "tool").length;
  return (
    <div className="activity-transcript">
      <div className="activity-transcript-bar">
        <span className="faint small">
          {t.entries.length} entries · {tools} tool call{tools === 1 ? "" : "s"}
          {t.model && ` · ${t.model}`}
          {t.windowed && " · this run only"}
        </span>
        <span className="spacer" />
        {tools > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setOpenTools(!openTools)}>
            {openTools ? "Collapse tools" : "Expand tools"}
          </Button>
        )}
      </div>
      {t.truncated ? (
        <div className="faint small activity-t-omitted">Large transcript: only the most recent entries are shown.</div>
      ) : (
        t.omitted > 0 && <div className="faint small activity-t-omitted">{t.omitted.toLocaleString("en-US")} earlier entries not shown.</div>
      )}
      {/* Keyed on openTools so the toggle also resets tools opened by hand. */}
      {t.entries.map((e, i) => (
        <Entry key={`${i}-${openTools}`} entry={e} start={start} openTools={openTools} />
      ))}
    </div>
  );
}
