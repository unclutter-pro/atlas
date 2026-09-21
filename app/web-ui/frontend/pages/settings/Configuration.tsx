import { useState } from "react";
import { apiGet, apiPut, useApi, useMutation } from "../../api";
import { Alert, ApiView, Card, EmptyState, Section, Select, Tabs } from "../../components";
import { links } from "../../links";
import { useQueryParam, withQuery } from "../../router";
import type { ConfigEntry, ConfigSaveResponse, ConfigurationResponse, ValidationResult } from "../../../ui-api/settings";
import { SECRET_PLACEHOLDER } from "../../../ui-api/settings/placeholder";
import { ConfigValue, FileEditor, IssueList, SourceTag, useDraftValidation, useFileEditor } from "./common";

const API = "/ui/api/settings/configuration";
const BASE = links.settings("configuration");

const SOURCE_FILTERS = [
  { value: "", label: "All sources" },
  { value: "overridden", label: "Overridden (env or runtime)" },
  { value: "env", label: "Environment" },
  { value: "runtime", label: "Runtime config" },
  { value: "file", label: "config.yml" },
  { value: "default", label: "Defaults" },
];

export default function Configuration() {
  const state = useApi<ConfigurationResponse>(API);
  const [view] = useQueryParam("view");
  return (
    <ApiView state={state}>
      {(data) => (
        <>
          <ConfigAlerts data={data} />
          <div className="settings-subtabs">
            <Tabs
              items={[
                { label: "Effective values", href: BASE },
                { label: "Edit config.yml", href: withQuery(BASE, { view: "edit" }) },
              ]}
            />
          </div>
          {view === "edit" ? <ConfigEditor data={data} onSaved={() => state.refetch()} /> : <EffectiveValues data={data} />}
        </>
      )}
    </ApiView>
  );
}

function ConfigAlerts({ data }: { data: ConfigurationResponse }) {
  const syntax = data.validation.syntaxError;
  const overridden = data.entries.filter((e) => e.source === "runtime" || e.source === "env");
  return (
    <>
      {syntax && (
        <Alert tone="error">
          config.yml does not parse{syntax.line ? ` (line ${syntax.line})` : ""}: {syntax.message}. Every value in it is ignored and Atlas runs
          on defaults until it is fixed.
        </Alert>
      )}
      {data.runtime.error && (
        <Alert tone="error">
          {data.runtime.path} is corrupt and ignored: {data.runtime.error}
        </Alert>
      )}
      {overridden.length > 0 && (
        <Alert tone="warn">
          <span>
            {overridden.length} {overridden.length === 1 ? "value is" : "values are"} overridden outside config.yml:{" "}
            {overridden.map((e, i) => (
              <span key={e.key}>
                {i > 0 && ", "}
                <code>{e.key}</code> ({e.source === "env" ? "env" : "runtime"})
              </span>
            ))}
            . Changing {overridden.length === 1 ? "it" : "them"} in config.yml has no effect.
          </span>
        </Alert>
      )}
    </>
  );
}

function EffectiveValues({ data }: { data: ConfigurationResponse }) {
  const [source, setSource] = useQueryParam("source");
  const rows = data.entries.filter((e) =>
    !source ? true : source === "overridden" ? e.source === "env" || e.source === "runtime" : e.source === source,
  );
  const sections = new Map<string, ConfigEntry[]>();
  for (const e of rows) sections.set(e.section, [...(sections.get(e.section) ?? []), e]);

  const counts = data.entries.reduce<Record<string, number>>((acc, e) => ((acc[e.source] = (acc[e.source] ?? 0) + 1), acc), {});

  return (
    <>
      <div className="toolbar">
        <Select value={source} onChange={(v) => setSource(v || null)} options={SOURCE_FILTERS} />
        <span className="small muted">
          {data.entries.length} keys · {counts.file ?? 0} from config.yml · {counts.runtime ?? 0} runtime · {counts.env ?? 0} env ·{" "}
          {counts.default ?? 0} default
        </span>
      </div>
      <Card flush>
        {rows.length === 0 ? (
          <EmptyState compact title="No keys come from this source." />
        ) : (
          <div className="table-wrap">
            <table className="table table-dense settings-config-table">
              <thead>
                <tr>
                  <th style={{ width: "34%" }}>Key</th>
                  <th>Value</th>
                  <th style={{ width: 110 }}>Source</th>
                </tr>
              </thead>
              <tbody>
                {[...sections].map(([section, entries]) => (
                  <SectionRows key={section} section={section} entries={entries} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!source && data.plugins.length > 0 && (
        <Section title="Plugins" count={data.plugins.filter((p) => p.enabled).length}>
          <div className="settings-plugins">
            {data.plugins.map((p) => (
              <span key={p.id} className={`tag ${p.enabled ? "settings-plugin-on" : "settings-plugin-off"}`} title={p.enabled ? "Enabled" : "Disabled"}>
                {p.id.replace(/@claude-plugins-official$/, "")}
              </span>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function SectionRows({ section, entries }: { section: string; entries: ConfigEntry[] }) {
  return (
    <>
      <tr className="settings-config-section">
        <td colSpan={3}>{section}</td>
      </tr>
      {entries.map((e) => (
        <tr key={e.key}>
          <td>
            {/* Top-level scalar keys (e.g. "timezone") have no section prefix to strip. */}
            {e.key === section ? (
              <span className="strong">{e.key}</span>
            ) : (
              <>
                <span className="faint">{section}.</span>
                <span className="strong">{e.key.slice(section.length + 1)}</span>
              </>
            )}
          </td>
          <td className="settings-config-value">
            <ConfigValue value={e.value} />
            {e.fileValue !== undefined && (
              <div className="small faint">
                config.yml: <ConfigValue value={e.fileValue} /> (ignored)
              </div>
            )}
          </td>
          <td>
            <SourceTag source={e.source} />
            {e.envVar && (
              <div className={`small ${e.source === "env" ? "muted" : "faint"}`} title="Environment variable that overrides this key">
                {e.envVar}
              </div>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

function ConfigEditor({ data, onSaved }: { data: ConfigurationResponse; onSaved: () => void }) {
  const editor = useFileEditor(data.file);
  const live = useDraftValidation<ValidationResult>(`${API}/validate`, editor.draft, editor.dirty);
  // Unchanged file: the server already validated it in GET.
  const validation = editor.dirty ? live.value : data.validation;
  const fresh = !editor.dirty || !live.stale;
  const syntax = fresh ? validation?.syntaxError : null;
  const typeErrors = fresh ? (validation?.issues.filter((i) => i.severity === "error").length ?? 0) : 0;
  const [saved, setSaved] = useState<ConfigSaveResponse | null>(null);

  const save = useMutation(
    () => apiPut<ConfigSaveResponse>(API, { content: editor.draft, version: editor.base?.version ?? null, force: typeErrors > 0 }),
    {
      onSuccess: (res) => {
        editor.adopt(res.file);
        setSaved(res);
        onSaved();
      },
    },
  );

  return (
    <FileEditor
      title="config.yml"
      editor={editor}
      rows={28}
      pending={save.pending}
      error={save.error}
      saveDisabled={!!syntax}
      saveLabel={typeErrors > 0 ? "Save anyway" : "Save"}
      saveVariant={typeErrors > 0 ? "danger" : "primary"}
      onSave={() => {
        setSaved(null);
        save.run();
      }}
      onReload={async () => {
        editor.adopt((await apiGet<ConfigurationResponse>(API)).file);
        save.reset();
      }}
      headerExtra={editor.dirty && fresh && validation && !syntax && validation.issues.length === 0 ? <span className="text-ok">Valid YAML</span> : null}
      footer={
        <>
          {editor.draft.includes(SECRET_PLACEHOLDER) && (
            <p className="muted">
              Inline secrets are hidden as <code>{SECRET_PLACEHOLDER}</code> and kept as they are when you save. Replace the
              placeholder to change one; better, move it to a file under Secrets and reference it with a <code>*_file</code> key.
            </p>
          )}
          {syntax && (
            <ul className="settings-issues">
              <li className="text-error">
                <span className="settings-issue-kind">YAML</span>
                {syntax.line != null && <span className="muted">line {syntax.line}</span>}
                <span>{syntax.message}</span>
              </li>
            </ul>
          )}
          {fresh && validation && <IssueList issues={validation.issues} />}
          {saved && !editor.dirty && (
            <Alert tone="ok">
              Saved.{" "}
              {saved.applied.claudeSettings || saved.applied.crontab
                ? [saved.applied.claudeSettings && "Claude settings regenerated", saved.applied.crontab && "crontab synced"].filter(Boolean).join(", ") + "."
                : "Settings regeneration and crontab sync only run inside the container."}{" "}
              Integration changes (Signal, email) apply on the next restart.
            </Alert>
          )}
        </>
      }
    />
  );
}
