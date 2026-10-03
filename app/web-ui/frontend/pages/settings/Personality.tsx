import { apiGet, apiPut, useApi, useMutation } from "../../api";
import { ApiView } from "../../components";
import type { FileDoc, PersonalityResponse } from "../../../ui-api/settings";
import { FileEditor, useFileEditor } from "./common";

const API = "/ui/api/settings/personality";

export default function Personality() {
  const state = useApi<PersonalityResponse>(API);
  return (
    <ApiView state={state}>
      {(data) => (
        <div className="grid-2 settings-personality">
          <PersonalityFile which="identity" title="Identity" doc={data.identity} />
          <PersonalityFile which="soul" title="Soul" doc={data.soul} />
        </div>
      )}
    </ApiView>
  );
}

function PersonalityFile(props: { which: "identity" | "soul"; title: string; doc: FileDoc }) {
  const editor = useFileEditor(props.doc);
  const save = useMutation(() => apiPut<FileDoc>(`${API}/${props.which}`, { content: editor.draft, version: editor.base?.version ?? null }), {
    onSuccess: (doc) => editor.adopt(doc),
  });

  return (
    <FileEditor
      title={props.title}
      editor={editor}
      markdown
      rows={24}
      pending={save.pending}
      error={save.error}
      onSave={() => save.run()}
      onReload={async () => {
        const fresh = await apiGet<PersonalityResponse>(API);
        editor.adopt(fresh[props.which]);
        save.reset();
      }}
    />
  );
}
