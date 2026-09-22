import { apiGet, apiPut, useApi, useMutation } from "../../api";
import { Alert, ApiView } from "../../components";
import type { ExtensionsResponse, ExtensionsSaveResponse, FileDoc, ValidationIssue } from "../../../ui-api/settings";
import { FileEditor, IssueList, useDraftValidation, useFileEditor } from "./common";

const API = "/ui/api/settings/extensions";

export default function Extensions() {
  const state = useApi<ExtensionsResponse>(API);
  return <ApiView state={state}>{(data) => <ExtensionsEditor doc={data.file} />}</ApiView>;
}

function ExtensionsEditor(props: { doc: FileDoc }) {
  const editor = useFileEditor(props.doc);
  const check = useDraftValidation<{ issues: ValidationIssue[] | null }>(`${API}/validate`, editor.draft, editor.dirty);
  const issues = editor.dirty && !check.stale ? (check.value?.issues ?? null) : null;
  const hasErrors = !!issues?.length;

  const save = useMutation(
    () => apiPut<ExtensionsSaveResponse>(API, { content: editor.draft, version: editor.base?.version ?? null, force: hasErrors }),
    { onSuccess: (res) => editor.adopt(res.file) },
  );

  return (
    <>
      <Alert tone="info">
        Runs with bash on every container start, before Atlas starts its services. Changes take effect on the next restart; a failing
        script is logged and does not block startup.
      </Alert>
      <FileEditor
        title="user-extensions.sh"
        editor={editor}
        rows={26}
        pending={save.pending}
        error={save.error}
        saveLabel={hasErrors ? "Save anyway" : "Save"}
        saveVariant={hasErrors ? "danger" : "primary"}
        onSave={() => save.run()}
        onReload={async () => {
          editor.adopt((await apiGet<ExtensionsResponse>(API)).file);
          save.reset();
        }}
        headerExtra={
          editor.dirty && issues && !hasErrors ? <span className="text-ok">bash -n: no syntax errors</span> : null
        }
        footer={issues && <IssueList issues={issues} />}
      />
    </>
  );
}
