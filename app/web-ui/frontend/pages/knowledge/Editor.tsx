/**
 * Edit a memory file with conflict protection: saves send the mtime the
 * edit started from, and a 409 means someone (usually the agent) wrote the
 * file in the meantime. The user then picks: reload theirs or overwrite.
 */

import { useState, type KeyboardEvent } from "react";
import { ApiError, apiGet, apiPut } from "../../api";
import { Alert, Button, FormActions, Time, useUnsavedWarning } from "../../components";
import type { MemoryFileResponse, SaveFileRequest } from "../../../ui-api/knowledge";
import { fileApi } from "./common";

export function FileEditor(props: { file: MemoryFileResponse; onSaved: (file: MemoryFileResponse) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(props.file.content);
  const [base, setBase] = useState(props.file);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Version on disk after a conflict (null = deleted meanwhile). */
  const [conflict, setConflict] = useState<{ current: MemoryFileResponse | null } | null>(null);
  const dirty = draft !== base.content;

  useUnsavedWarning(dirty);

  const save = async (baseMtimeMs: number | null) => {
    setPending(true);
    setError(null);
    try {
      const saved = await apiPut<MemoryFileResponse>(fileApi(base.path), { content: draft, baseMtimeMs } satisfies SaveFileRequest);
      setConflict(null);
      setBase(saved);
      props.onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = await apiGet<MemoryFileResponse>(fileApi(base.path)).catch(() => null);
        setConflict({ current });
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (!pending && !conflict) save(base.mtimeMs);
    }
  };

  return (
    <div className="knowledge-editor" onKeyDown={onKeyDown}>
      {conflict && (
        <Alert tone="warn">
          <div className="stack">
            <div>
              {conflict.current ? (
                <>
                  <strong>{base.path}</strong> changed on disk <Time value={conflict.current.modifiedAt} /> while you were editing.
                </>
              ) : (
                <>
                  <strong>{base.path}</strong> was deleted while you were editing.
                </>
              )}
            </div>
            <div className="row row-wrap">
              {conflict.current && (
                <Button
                  size="sm"
                  onClick={() => {
                    setBase(conflict.current!);
                    setDraft(conflict.current!.content);
                    setConflict(null);
                  }}
                >
                  Load their version (discard mine)
                </Button>
              )}
              <Button size="sm" variant="danger" pending={pending} onClick={() => save(conflict.current ? conflict.current.mtimeMs : null)}>
                {conflict.current ? "Overwrite with mine" : "Recreate with mine"}
              </Button>
            </div>
          </div>
        </Alert>
      )}
      {error && <Alert tone="error">Save failed: {error}</Alert>}
      <textarea
        className="textarea knowledge-editor-text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        autoFocus
        aria-label={`Contents of ${base.path}`}
      />
      <FormActions>
        <Button variant="primary" pending={pending} disabled={!dirty || !!conflict} onClick={() => save(base.mtimeMs)}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => (!dirty || window.confirm("Discard your unsaved changes?")) && props.onCancel()}>
          {dirty ? "Discard changes" : "Close editor"}
        </Button>
        <span className="spacer" />
        <span className="small faint">{dirty ? "Unsaved changes" : "No changes"} · Ctrl/Cmd+S saves</span>
      </FormActions>
    </div>
  );
}
