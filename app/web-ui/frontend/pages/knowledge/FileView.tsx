/** One file under ~/memory: rendered view, editor (?edit=1), delete. */

import { useState } from "react";
import { apiDelete, useApi } from "../../api";
import { Alert, ApiView, ButtonLink, Card, CodeBlock, ConfirmButton, EmptyState, NotFound, PageHeader, Time, formatBytes } from "../../components";
import { links } from "../../links";
import { Redirect, navigate, useQueryParam, withQuery, type Params } from "../../router";
import type { MemoryFileResponse } from "../../../ui-api/knowledge";
import { FileEditor } from "./Editor";
import { MemoryMarkdown, fileApi } from "./common";

export function FileView(props: { params: Params }) {
  const path = (props.params["*"] ?? "").replace(/^\/+|\/+$/g, "");
  const date = path.match(/^(?:journal\/)?(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
  if (!path) return <Redirect to={links.knowledge()} />;
  // Journal entries have their own date view.
  if (date) return <Redirect to={links.journal(date)} />;
  return <FileViewInner key={path} path={path} />;
}

function FileViewInner(props: { path: string }) {
  const { path } = props;
  const file = useApi<MemoryFileResponse>(fileApi(path));
  const [edit, setEdit] = useQueryParam("edit");
  const [saved, setSaved] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const back = { href: links.knowledge(), label: "Knowledge" };

  if (file.error && /no such file/i.test(file.error)) {
    return (
      <>
        <PageHeader title={path} back={back} />
        <EmptyState title="This file does not exist." action={<ButtonLink href={links.knowledge()}>Back to Knowledge</ButtonLink>} />
      </>
    );
  }
  if (file.error && /invalid path/i.test(file.error)) return <NotFound what="File" />;

  const f = file.data;
  const editing = edit === "1" && !!f?.editable;
  const isMarkdown = /\.(md|markdown)$/i.test(path);

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiDelete(fileApi(path));
      navigate(links.knowledge(), { replace: true });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader
        title={<span className="knowledge-filetitle">{path}</span>}
        documentTitle={path}
        back={back}
        badge={f && !f.editable ? <span className="tag">read-only</span> : undefined}
        subtitle={
          f && (
            <>
              Modified <Time value={f.modifiedAt} /> · {formatBytes(f.size)}
            </>
          )
        }
        actions={
          f &&
          !editing && (
            <>
              {f.editable && (
                <ButtonLink href={withQuery(links.memoryFile(path), { edit: 1 })} variant="primary">
                  Edit
                </ButtonLink>
              )}
              {f.deletable && (
                <ConfirmButton onConfirm={remove} pending={deleting} prompt={`Delete ${path.split("/").pop()}?`} confirmLabel="Delete">
                  Delete
                </ConfirmButton>
              )}
            </>
          )
        }
      />
      {deleteError && <Alert tone="error">Delete failed: {deleteError}</Alert>}
      {saved && !editing && <Alert tone="ok">Saved.</Alert>}
      <ApiView state={file}>
        {(f) =>
          editing ? (
            <FileEditor
              file={f}
              onSaved={(next) => {
                file.setData(next);
                setSaved(true);
                setEdit(null, { replace: false });
              }}
              onCancel={() => {
                setSaved(false);
                setEdit(null, { replace: false });
              }}
            />
          ) : !f.content.trim() ? (
            <Card>
              <EmptyState compact title="This file is empty." />
            </Card>
          ) : isMarkdown ? (
            <Card className="knowledge-doc">
              <MemoryMarkdown text={f.content} path={path} />
            </Card>
          ) : (
            <CodeBlock code={f.content} label={path.split("/").pop()} copy />
          )
        }
      </ApiView>
    </>
  );
}
