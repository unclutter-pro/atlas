/** Building blocks shared by the settings sections: file editor, source tags, value formatting. */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { apiPost } from "../../api";
import { Button, Card, MarkdownView, Time, useUnsavedWarning } from "../../components";
import type { ConfigSource, FileDoc, ValidationIssue } from "../../../ui-api/settings";

// --- Values and sources ------------------------------------------------------

const SOURCE_LABEL: Record<ConfigSource, string> = {
  env: "env",
  runtime: "runtime",
  file: "config.yml",
  default: "default",
};

const SOURCE_TITLE: Record<ConfigSource, string> = {
  env: "Set by an environment variable (highest priority)",
  runtime: "Set in ~/.atlas-runtime-config.json (overrides config.yml)",
  file: "Set in ~/config.yml",
  default: "Built-in default",
};

export function SourceTag(props: { source: ConfigSource }) {
  return (
    <span className={`tag settings-source settings-source-${props.source}`} title={SOURCE_TITLE[props.source]}>
      {SOURCE_LABEL[props.source]}
    </span>
  );
}

/** Config value for display: strings verbatim, lists comma-joined, empty/unset as a faint dash. */
export function ConfigValue(props: { value: unknown; secret?: boolean }) {
  const v = props.value;
  if (props.secret) return v ? <span className="text-ok">set</span> : <span className="faint">not set</span>;
  if (v == null || v === "") return <span className="faint">{v === "" ? '""' : "—"}</span>;
  if (Array.isArray(v)) return v.length ? <span>{v.join(", ")}</span> : <span className="faint">[]</span>;
  if (typeof v === "boolean") return <span className={v ? "text-ok" : "muted"}>{String(v)}</span>;
  if (typeof v === "object") return <span>{JSON.stringify(v)}</span>;
  return <span>{String(v)}</span>;
}

// --- File editing ------------------------------------------------------------

export interface FileEditorState {
  base: FileDoc | null;
  draft: string;
  setDraft: (v: string) => void;
  dirty: boolean;
  /** Replace base and draft, e.g. with the server's copy after a save. */
  adopt: (doc: FileDoc) => void;
  revert: () => void;
}

/**
 * Draft state for one file. New server data replaces the draft only while
 * there are no local edits, so a background refetch never eats typing.
 */
export function useFileEditor(doc: FileDoc | null | undefined): FileEditorState {
  const [base, setBase] = useState<FileDoc | null>(doc ?? null);
  const [draft, setDraft] = useState(doc?.content ?? "");
  const dirty = base != null && draft !== base.content;

  useEffect(() => {
    if (!doc) return;
    if (!base || !dirty) {
      setBase(doc);
      setDraft(doc.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.version, doc?.content]);

  useUnsavedWarning(dirty);

  return {
    base,
    draft,
    setDraft,
    dirty,
    adopt: (d) => {
      setBase(d);
      setDraft(d.content);
    },
    revert: () => base && setDraft(base.content),
  };
}

/**
 * Server-side validation of a draft, debounced. `value` is the latest
 * result; `stale` is true while it belongs to an older draft.
 */
export function useDraftValidation<T>(path: string, content: string, enabled: boolean, delayMs = 400): { value: T | null; stale: boolean } {
  const [result, setResult] = useState<{ content: string; value: T } | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      apiPost<T>(path, { content })
        .then((value) => n === seq.current && setResult({ content, value }))
        .catch(() => {});
    }, delayMs);
    return () => clearTimeout(t);
  }, [path, content, enabled, delayMs]);
  return { value: result?.value ?? null, stale: enabled && result?.content !== content };
}

export function FileEditor(props: {
  title: ReactNode;
  editor: FileEditorState;
  onSave: () => void;
  pending: boolean;
  /** Error from the last save attempt. */
  error: string | null;
  /** Called when the user wants to drop local edits and load the disk version (after a 409). */
  onReload?: () => void;
  saveLabel?: string;
  saveVariant?: "primary" | "danger";
  saveDisabled?: boolean;
  rows?: number;
  markdown?: boolean;
  /** Below the textarea: validation output, save feedback. */
  footer?: ReactNode;
  headerExtra?: ReactNode;
}) {
  const { editor } = props;
  const [preview, setPreview] = useState(false);
  const canSave = editor.dirty && !props.saveDisabled && !props.pending;

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (canSave) props.onSave();
    }
  };

  const base = editor.base;
  return (
    <Card
      className="settings-editor"
      title={
        <span className="settings-editor-title">
          {props.title}
          {editor.dirty && <span className="tag settings-unsaved">Unsaved</span>}
        </span>
      }
      actions={
        <>
          {props.markdown && (
            <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)}>
              {preview ? "Edit" : "Preview"}
            </Button>
          )}
          {editor.dirty && (
            <Button size="sm" variant="ghost" onClick={editor.revert}>
              Revert
            </Button>
          )}
          <Button size="sm" variant={props.saveVariant ?? "primary"} disabled={!canSave} pending={props.pending} onClick={props.onSave} title="Save (Ctrl/Cmd+S)">
            {props.saveLabel ?? "Save"}
          </Button>
        </>
      }
    >
      <div className="settings-editor-meta small muted">
        <span className="settings-path">{base?.path}</span>
        {base && (base.exists ? <span>updated <Time value={base.updatedAt} /></span> : <span>does not exist yet — saving creates it</span>)}
        {props.headerExtra}
      </div>
      {props.error && (
        <div className="alert alert-error settings-editor-error" role="alert">
          <span>{props.error}</span>
          {props.onReload && props.error.includes("changed on disk") && (
            <Button size="sm" variant="secondary" onClick={props.onReload}>
              Discard my edits and reload
            </Button>
          )}
        </div>
      )}
      {preview && props.markdown ? (
        <div className="settings-preview">{editor.draft.trim() ? <MarkdownView text={editor.draft} /> : <span className="faint">Empty</span>}</div>
      ) : (
        <div onKeyDown={onKeyDown}>
          <textarea
            className="textarea settings-textarea"
            value={editor.draft}
            rows={props.rows ?? 20}
            spellCheck={false}
            aria-label={typeof props.title === "string" ? props.title : base?.path}
            onChange={(e) => editor.setDraft(e.target.value)}
          />
        </div>
      )}
      {props.footer}
    </Card>
  );
}

export function IssueList(props: { issues: ValidationIssue[] }) {
  if (!props.issues.length) return null;
  return (
    <ul className="settings-issues">
      {props.issues.map((i, n) => (
        <li key={n} className={i.severity === "error" ? "text-error" : "text-warn"}>
          <span className="settings-issue-kind">{i.severity === "error" ? "Error" : "Warning"}</span>
          {i.path && <code>{i.path}</code>}
          {i.line != null && !i.message.includes(`line ${i.line}`) && <span className="muted">line {i.line}</span>}
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}
