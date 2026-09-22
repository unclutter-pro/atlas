/** Create and edit form for triggers. Validation mirrors the API (ui-api/automations/validate.ts). */

import { useEffect, useMemo, useState } from "react";
import { apiPost, apiPut, useApi, useMutation } from "../../api";
import { Alert, Button, ButtonLink, Card, FormActions, PageHeader, Select, TextArea, TextField, Time, Toggle } from "../../components";
import { links } from "../../links";
import { navigate, withQuery } from "../../router";
import type { AutomationsResponse, CronPreviewResponse, OptionsResponse, TriggerDetail, TriggerInput, TriggerType } from "../../../ui-api/automations";
import { validateTriggerInput, type FieldErrors } from "../../../ui-api/automations/validate";

interface FormState {
  name: string;
  type: TriggerType;
  description: string;
  channel: string;
  schedule: string;
  sessionMode: "ephemeral" | "persistent";
  modelKey: string;
  prompt: string;
  webhookSecret: string;
  removeSecret: boolean;
  enabled: boolean;
}

const EMPTY: FormState = {
  name: "",
  type: "cron",
  description: "",
  channel: "internal",
  schedule: "0 9 * * *",
  sessionMode: "ephemeral",
  modelKey: "",
  prompt: "",
  webhookSecret: "",
  removeSecret: false,
  enabled: true,
};

const SCHEDULE_PRESETS: Array<[string, string]> = [
  ["Every 30 min", "*/30 * * * *"],
  ["Hourly", "0 * * * *"],
  ["Daily 07:00", "0 7 * * *"],
  ["Weekdays 09:00", "0 9 * * 1-5"],
  ["Mondays 09:00", "0 9 * * 1"],
];

export function CreateTriggerPage() {
  const existing = useApi<AutomationsResponse>("/ui/api/automations");
  const names = useMemo(() => new Set(existing.data?.triggers.map((t) => t.name) ?? []), [existing.data]);
  const create = useMutation((body: TriggerInput) => apiPost<TriggerDetail>("/ui/api/automations/triggers", body), {
    onSuccess: (t) => navigate(links.trigger(t.name)),
  });
  return (
    <>
      <PageHeader title="New trigger" back={{ href: links.automations(), label: "Automations" }} />
      <TriggerForm
        mode="create"
        initial={EMPTY}
        takenNames={names}
        pending={create.pending}
        error={create.error}
        onSubmit={(s) => create.run(toInput(s, "create"))}
        cancelHref={links.automations()}
      />
    </>
  );
}

export function EditTriggerForm(props: { trigger: TriggerDetail; onSaved: (t: TriggerDetail) => void }) {
  const t = props.trigger;
  const save = useMutation((body: TriggerInput) => apiPut<TriggerDetail>(`/ui/api/automations/triggers/${encodeURIComponent(t.name)}`, body), {
    onSuccess: (updated) => props.onSaved(updated),
  });
  const initial: FormState = {
    ...EMPTY,
    name: t.name,
    type: t.type,
    description: t.description,
    channel: t.channel,
    schedule: t.schedule?.expr ?? "",
    sessionMode: t.sessionMode,
    modelKey: t.modelKey ?? "",
    // Editing the runner's fallback text would pin it as a real prompt.
    prompt: t.promptSource === "default" ? "" : t.prompt,
    enabled: t.enabled,
  };
  return (
    <TriggerForm
      mode="edit"
      initial={initial}
      trigger={t}
      pending={save.pending}
      error={save.error}
      onSubmit={(s) => save.run(toInput(s, "edit", t))}
      cancelHref={links.trigger(t.name)}
    />
  );
}

function toInput(s: FormState, mode: "create" | "edit", t?: TriggerDetail): TriggerInput {
  const input: TriggerInput = {
    description: s.description,
    channel: s.channel,
    sessionMode: s.sessionMode,
    modelKey: s.modelKey || null,
    prompt: s.prompt,
  };
  if (mode === "create") {
    input.name = s.name.trim();
    input.type = s.type;
    input.enabled = s.enabled;
  }
  if (s.type === "cron") input.schedule = s.schedule.trim();
  if (s.type === "webhook") {
    if (mode === "create") input.webhookSecret = s.webhookSecret.trim() || null;
    else if (s.removeSecret) input.webhookSecret = null;
    else if (s.webhookSecret.trim()) input.webhookSecret = s.webhookSecret.trim();
  }
  // Don't turn an untouched prompt.md fallback into an empty file.
  if (mode === "edit" && t?.promptSource === "default" && !s.prompt.trim()) delete input.prompt;
  return input;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function TriggerForm(props: {
  mode: "create" | "edit";
  initial: FormState;
  trigger?: TriggerDetail;
  takenNames?: Set<string>;
  pending: boolean;
  error: string | null;
  onSubmit: (s: FormState) => void;
  cancelHref: string;
}) {
  const [s, setS] = useState<FormState>(props.initial);
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof FormState>(k: K) => (v: FormState[K]) => setS((prev) => ({ ...prev, [k]: v }));
  const options = useApi<OptionsResponse>("/ui/api/automations/options");
  const preview = useCronPreview(s.type === "cron" ? s.schedule : null);

  const errors: FieldErrors = useMemo(() => {
    const e = validateTriggerInput(toInput(s, props.mode, props.trigger), props.mode === "create" ? "create" : "update", s.type);
    if (props.mode === "create" && props.takenNames?.has(s.name.trim())) e.name = "A trigger with this name already exists";
    return e;
  }, [s, props.mode, props.trigger, props.takenNames]);
  const hasErrors = Object.keys(errors).length > 0;
  // Show errors once the user tried to submit, or right away for fields that have content.
  const err = (k: keyof FieldErrors) => (submitted || (k === "name" && s.name) || k === "schedule" ? errors[k] : undefined);

  const channelOptions = useMemo(() => {
    const list = options.data?.channels ?? ["internal"];
    return list.includes(s.channel) ? list : [...list, s.channel];
  }, [options.data, s.channel]);

  const modelOptions = useMemo(() => {
    const models = options.data?.models ?? {};
    const def = options.data?.defaultModelKey ?? "trigger";
    const opts = [{ value: "", label: `Default (${def} → ${models[def] ?? "…"})` }];
    for (const [k, v] of Object.entries(models)) opts.push({ value: k, label: `${k} → ${v}` });
    if (s.modelKey && !(s.modelKey in models)) opts.push({ value: s.modelKey, label: `${s.modelKey} (unknown key, uses ${def})` });
    return opts;
  }, [options.data, s.modelKey]);

  const submit = () => {
    setSubmitted(true);
    if (!hasErrors) props.onSubmit(s);
  };

  const hasSecret = props.trigger?.webhook?.hasSecret ?? false;

  return (
    <form
      className="form automations-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {props.error && <Alert tone="error">{props.error}</Alert>}

      <Card title="What and when">
        <div className="form">
          {props.mode === "create" && (
            <div className="grid-2">
              <TextField
                label="Name"
                value={s.name}
                onChange={(v) => set("name")(v.toLowerCase())}
                placeholder="daily-digest"
                autoFocus
                error={err("name")}
                hint="Lowercase letters, digits, dashes and underscores. Cannot be changed later."
              />
              <Select
                label="Type"
                value={s.type}
                onChange={(v) => set("type")(v as TriggerType)}
                options={[
                  { value: "cron", label: "Scheduled (cron)" },
                  { value: "webhook", label: "Webhook (HTTP POST)" },
                  { value: "manual", label: "Manual (run on demand)" },
                ]}
                hint="Cannot be changed later."
              />
            </div>
          )}
          <TextField label="Description" value={s.description} onChange={set("description")} placeholder="What this trigger is for" error={err("description")} />

          {s.type === "cron" && (
            <div className="automations-schedule">
              <TextField label="Schedule" value={s.schedule} onChange={set("schedule")} placeholder="0 7 * * *" error={err("schedule")} hint="minute hour day-of-month month day-of-week" />
              <div className="row row-wrap automations-presets">
                {SCHEDULE_PRESETS.map(([label, expr]) => (
                  <Button key={expr} size="sm" variant={s.schedule.trim() === expr ? "secondary" : "ghost"} onClick={() => set("schedule")(expr)}>
                    {label}
                  </Button>
                ))}
              </div>
              {preview?.valid && (
                <div className="automations-preview">
                  <div className="strong">{preview.text ?? "Custom schedule"}</div>
                  <div className="muted small">
                    Next:{" "}
                    {preview.next.slice(0, 3).map((n, i) => (
                      <span key={n}>
                        {i > 0 && ", "}
                        <Time value={n} mode="absolute" />
                      </span>
                    ))}{" "}
                    <span className="faint">(server time zone {preview.timeZone})</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {s.type === "webhook" && (
            <div className="field">
              {props.mode === "create" || !hasSecret ? (
                <TextField
                  label="Webhook secret (optional)"
                  value={s.webhookSecret}
                  onChange={set("webhookSecret")}
                  error={err("webhookSecret")}
                  hint="Callers must send it in the X-Webhook-Secret header. Leave empty for an open webhook."
                />
              ) : (
                <>
                  <TextField
                    label="Webhook secret"
                    value={s.webhookSecret}
                    onChange={set("webhookSecret")}
                    disabled={s.removeSecret}
                    placeholder={`Current: ${props.trigger?.webhook?.secretMasked}`}
                    error={err("webhookSecret")}
                    hint="Leave empty to keep the current secret."
                  />
                  <Toggle checked={s.removeSecret} onChange={set("removeSecret")} label="Remove the secret (anyone with the URL can call it)" />
                </>
              )}
              {!s.removeSecret && (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => set("webhookSecret")(randomSecret())}>
                    Generate secret
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card title="Prompt">
        <TextArea
          value={s.prompt}
          onChange={set("prompt")}
          rows={12}
          error={err("prompt")}
          placeholder={props.trigger?.promptSource === "default" ? props.trigger.prompt : "What should Atlas do when this trigger fires?"}
          hint={
            <>
              Placeholders: <code>{"{{payload}}"}</code> <code>{"{{sender}}"}</code> <code>{"{{channel}}"}</code> <code>{"{{trigger_name}}"}</code>.{" "}
              {props.trigger?.promptSource === "db" ? "Stored in the database." : `Stored in ~/triggers/${props.trigger?.name ?? (s.name || "<name>")}/prompt.md.`}
            </>
          }
        />
      </Card>

      <Card title="How it runs">
        <div className="grid-2">
          <Select label="Channel" value={s.channel} onChange={set("channel")} options={channelOptions} hint="Where replies go and which channel prompt the session gets." />
          <Select
            label="Session"
            value={s.sessionMode}
            onChange={(v) => set("sessionMode")(v as FormState["sessionMode"])}
            options={[
              { value: "ephemeral", label: "Ephemeral: fresh session every run" },
              { value: "persistent", label: "Persistent: resume per session key" },
            ]}
          />
          <Select label="Model" value={s.modelKey} onChange={set("modelKey")} options={modelOptions} error={err("modelKey")} hint="A models.<key> entry from config.yml." />
          {props.mode === "create" && (
            <div className="field">
              <span className="field-label">State</span>
              <Toggle checked={s.enabled} onChange={set("enabled")} label={s.enabled ? "Enabled" : "Disabled"} />
            </div>
          )}
        </div>
      </Card>

      <FormActions>
        <Button type="submit" variant="primary" pending={props.pending} disabled={submitted && hasErrors}>
          {props.mode === "create" ? "Create trigger" : "Save changes"}
        </Button>
        <ButtonLink href={props.cancelHref} variant="ghost">
          Cancel
        </ButtonLink>
        {submitted && hasErrors && <span className="text-error small">Fix the highlighted fields.</span>}
      </FormActions>
    </form>
  );
}

/** Debounced server-side schedule check (next runs are computed in the server's time zone). */
function useCronPreview(expr: string | null): CronPreviewResponse | null {
  const [debounced, setDebounced] = useState(expr);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(expr), 250);
    return () => clearTimeout(id);
  }, [expr]);
  const res = useApi<CronPreviewResponse>(debounced ? withQuery("/ui/api/automations/cron", { expr: debounced }) : null);
  return expr ? res.data : null;
}
