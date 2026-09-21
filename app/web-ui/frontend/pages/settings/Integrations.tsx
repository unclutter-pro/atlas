import { useApi } from "../../api";
import { Alert, ApiView, Card, DataTable, healthBadge, KeyValue, Section, StatusBadge, Time } from "../../components";
import { links } from "../../links";
import { Link } from "../../router";
import type { IntegrationsResponse, IntegrationView } from "../../../ui-api/settings";
import type { HealthState, ServiceHealth } from "../../../ui-api/shared/integrations";
import { ConfigValue, SourceTag } from "./common";

const API = "/ui/api/settings/integrations";

// Problems first, then healthy, then unknown.
const ORDER: Record<HealthState, number> = { stopped: 0, degraded: 1, running: 2, unknown: 3, not_configured: 4 };

export default function Integrations() {
  const state = useApi<IntegrationsResponse>(API, { poll: 15_000 });
  return (
    <ApiView state={state}>
      {(data) => {
        const configured = data.integrations.filter((i) => i.configured).sort((a, b) => ORDER[a.state] - ORDER[b.state]);
        const unconfigured = data.integrations.filter((i) => !i.configured);
        return (
          <>
            {!data.supervisorAvailable && <Alert tone="warn">supervisorctl is unreachable, so process state is unknown.</Alert>}
            <div className="stack settings-integrations">
              {configured.map((i) => (
                <IntegrationCard key={i.key} integration={i} />
              ))}
            </div>
            {unconfigured.length > 0 && (
              <Section title="Not configured" count={unconfigured.length}>
                <Card flush>
                  <DataTable
                    rows={unconfigured}
                    rowKey={(i) => i.key}
                    columns={[
                      { key: "label", header: "Integration", width: 160, render: (i) => <span className="cell-primary">{i.label}</span> },
                      { key: "enabledBy", header: "Enable with", render: (i) => <span className="cell-secondary">{i.enabledBy}</span> },
                    ]}
                  />
                </Card>
              </Section>
            )}
            <Section title="Services">
              <Card flush>
                <DataTable<ServiceHealth>
                  rows={data.services}
                  rowKey={(s) => s.name}
                  columns={[
                    { key: "label", header: "Service", width: 220, render: (s) => <span className="cell-primary">{s.label}</span> },
                    { key: "state", header: "State", width: 150, render: (s) => <HealthBadge state={s.state} /> },
                    { key: "detail", header: "Detail", render: (s) => <span className="cell-secondary">{s.detail}</span> },
                  ]}
                />
              </Card>
            </Section>
          </>
        );
      }}
    </ApiView>
  );
}

function HealthBadge(props: { state: HealthState }) {
  const b = healthBadge(props.state);
  return <StatusBadge status={b.status}>{b.label}</StatusBadge>;
}

const PROGRAM_TONE: Record<string, string> = { RUNNING: "text-ok", STARTING: "text-running", BACKOFF: "text-warn", FATAL: "text-error", EXITED: "text-error", STOPPED: "text-error" };

function IntegrationCard({ integration: i }: { integration: IntegrationView }) {
  const tone = i.state === "stopped" ? "error" : i.state === "degraded" ? "warn" : undefined;
  return (
    <Card
      tone={tone}
      title={
        <span className="settings-integration-title">
          {i.label}
          <HealthBadge state={i.state} />
        </span>
      }
      actions={
        <Link href={links.activity({ channel: i.key })} className="small">
          Activity →
        </Link>
      }
    >
      <div className="grid-2 settings-integration-body">
        <KeyValue
          items={[
            { label: "Status", value: <span className={tone ? `text-${tone}` : undefined}>{i.detail}</span> },
            { label: "Enabled via", value: i.configuredVia },
            {
              label: "Processes",
              value: i.programs.length ? (
                <span className="row row-wrap settings-tags">
                  {i.programs.map((p) => (
                    <span key={p.name} className="tag">
                      {p.name} <span className={PROGRAM_TONE[p.state] ?? "muted"}>{p.state.toLowerCase().replace("_", " ")}</span>
                    </span>
                  ))}
                </span>
              ) : undefined,
            },
            {
              label: "Last message",
              value: i.lastMessageAt ? (
                <span>
                  <Time value={i.lastMessageAt} />
                  <span className="muted"> · {i.messages24h} in 24h</span>
                </span>
              ) : null,
            },
            {
              label: "Triggers",
              value: i.triggers.length ? (
                <span className="row row-wrap settings-tags">
                  {i.triggers.map((t) => (
                    <Link key={t.name} href={links.trigger(t.name)} className={`tag${t.enabled ? "" : " settings-trigger-off"}`} title={t.enabled ? "Enabled" : "Disabled"}>
                      {t.name}
                    </Link>
                  ))}
                </span>
              ) : null,
            },
          ]}
        />
        {i.settings.length > 0 ? (
          <table className="table table-dense settings-integration-keys">
            <tbody>
              {i.settings.map((s) => (
                <tr key={s.key}>
                  <td className="muted">{s.key}</td>
                  <td>
                    <ConfigValue value={s.value} secret={s.secret} />
                  </td>
                  <td className="align-right">
                    <SourceTag source={s.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="small muted">{i.enabledBy}</div>
        )}
      </div>
    </Card>
  );
}
