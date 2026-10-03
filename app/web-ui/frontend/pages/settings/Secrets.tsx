import { useState } from "react";
import { apiDelete, apiPut, useApi, useMutation } from "../../api";
import { Alert, ApiView, Button, Card, ConfirmButton, DataTable, EmptyState, FormActions, Section, TextArea, TextField, Time, Toggle } from "../../components";
import { links } from "../../links";
import { Link } from "../../router";
import type { SecretItem, SecretsResponse } from "../../../ui-api/settings";

const API = "/ui/api/settings/secrets";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** null: no form · "": add a new secret · name: replace that secret. */
type FormTarget = string | null;

export default function Secrets() {
  const state = useApi<SecretsResponse>(API);
  const [form, setForm] = useState<FormTarget>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const remove = useMutation((name: string) => apiDelete(`${API}/${encodeURIComponent(name)}`), {
    onSuccess: (_r, name) => {
      setFlash(`Deleted ${name}.`);
      if (form === name) setForm(null);
      state.refetch();
    },
  });

  const onSaved = (name: string, created: boolean) => {
    setForm(null);
    setFlash(created ? `Added ${name}.` : `Replaced the value of ${name}.`);
    state.refetch();
  };

  return (
    <ApiView state={state}>
      {(data) => (
        <Section
          title="Secrets"
          count={data.items.length}
          description={<span className="settings-path">{data.dir}</span>}
          actions={
            form === null && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setFlash(null);
                  setForm("");
                }}
              >
                Add secret
              </Button>
            )
          }
        >
          {flash && <Alert tone="ok">{flash}</Alert>}
          {remove.error && <Alert tone="error">Delete failed: {remove.error}</Alert>}
          {form !== null && (
            <SecretForm key={form} name={form} existing={data.items.map((s) => s.name)} onCancel={() => setForm(null)} onSaved={onSaved} />
          )}
          {data.items.length === 0 ? (
            form === null && (
              <EmptyState
                title="No secrets yet."
                action={
                  <Button variant="primary" onClick={() => setForm("")}>
                    Add secret
                  </Button>
                }
              >
                Each secret is a file in {data.dir}, readable by the agent and its scripts (for example <code>email.password_file</code>). Values
                are write-only here: you can set, replace and delete them, but never read them back.
              </EmptyState>
            )
          ) : (
            <Card flush>
              <DataTable<SecretItem>
                rows={data.items}
                rowKey={(s) => s.name}
                columns={[
                  { key: "name", header: "Name", render: (s) => <span className="cell-primary settings-secret-name">{s.name}</span> },
                  {
                    key: "usedBy",
                    header: "Used by",
                    render: (s) =>
                      s.usedBy.length ? (
                        <span className="row row-wrap settings-tags">
                          {s.usedBy.map((k) => (
                            <Link key={k} href={links.settings("configuration")} className="tag" title="Config key">
                              {k}
                            </Link>
                          ))}
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                  { key: "updatedAt", header: "Updated", width: 130, render: (s) => <Time value={s.updatedAt} className="cell-secondary" /> },
                  {
                    key: "actions",
                    header: "",
                    align: "right",
                    width: 260,
                    render: (s) => (
                      <span className="settings-row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setFlash(null);
                            setForm(s.name);
                          }}
                        >
                          Replace
                        </Button>
                        <ConfirmButton size="sm" prompt={`Delete ${s.name}?`} confirmLabel="Delete" onConfirm={() => remove.run(s.name)}>
                          Delete
                        </ConfirmButton>
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
          )}
        </Section>
      )}
    </ApiView>
  );
}

function SecretForm(props: { name: string; existing: string[]; onCancel: () => void; onSaved: (name: string, created: boolean) => void }) {
  const replacing = props.name !== "";
  const [name, setName] = useState(props.name);
  const [value, setValue] = useState("");
  const [multiline, setMultiline] = useState(false);
  const [touched, setTouched] = useState(false);

  const nameError = !replacing && touched && name && !NAME_RE.test(name) ? "Letters, digits, '.', '_' and '-' only; no leading dot." : null;
  const willOverwrite = !replacing && props.existing.includes(name);

  const save = useMutation(
    () => apiPut<{ ok: true; name: string; created: boolean }>(`${API}/${encodeURIComponent(name)}`, { value }),
    { onSuccess: (res) => props.onSaved(res.name, res.created) },
  );
  const canSave = NAME_RE.test(name) && value !== "" && !save.pending;
  const submit = () => canSave && save.run();

  return (
    <Card title={replacing ? `Replace ${props.name}` : "Add secret"} className="settings-secret-form">
      <div className="stack">
        {!replacing && (
          <TextField
            label="Name"
            value={name}
            autoFocus
            placeholder="e.g. github-token"
            error={nameError}
            hint={willOverwrite ? `A secret named ${name} exists; saving replaces its value.` : undefined}
            onChange={(v) => {
              setTouched(true);
              setName(v.trim());
            }}
          />
        )}
        {multiline ? (
          <TextArea label="Value" value={value} rows={5} onChange={setValue} />
        ) : (
          <TextField label="Value" type="password" value={value} autoFocus={replacing} onChange={setValue} onEnter={submit} />
        )}
        {save.error && <Alert tone="error">{save.error}</Alert>}
        <FormActions>
          <Button variant="primary" disabled={!canSave} pending={save.pending} onClick={submit}>
            {replacing || willOverwrite ? "Replace value" : "Save secret"}
          </Button>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <span className="spacer" />
          <Toggle checked={multiline} onChange={setMultiline} label="Multi-line value" />
        </FormActions>
      </div>
    </Card>
  );
}
