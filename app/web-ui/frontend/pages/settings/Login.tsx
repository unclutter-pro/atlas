/**
 * Settings › Login: how the agent backend authenticates, whether that still
 * works, and a new login from the browser. The backend's CLI runs the login;
 * this page shows its sign-in URL and hands it the code from that page.
 */

import { useState } from "react";
import { apiDelete, apiPost, useApi, useMutation } from "../../api";
import { useStatus } from "../../shell/status";
import {
  Alert,
  ApiView,
  authBadge,
  Button,
  Card,
  ConfirmButton,
  CopyButton,
  FormActions,
  KeyIcon,
  KeyValue,
  Section,
  StatusBadge,
  TextField,
  Time,
} from "../../components";
import type { AuthStatus, PendingLogin } from "../../../ui-api/settings";

const API = "/ui/api/settings/login";

export default function Login() {
  const state = useApi<AuthStatus>(API);
  const status = useStatus();
  const [flash, setFlash] = useState<string | null>(null);
  /** A failed code ends the CLI's login, so its error outlives the pending card. */
  const [loginError, setLoginError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  /** New status from a mutation: show it here and in the status strip at once. */
  const apply = (s: AuthStatus, message?: string) => {
    state.setData(s);
    setFlash(message ?? null);
    setLoginError(null);
    status.refetch();
  };

  const start = useMutation(
    async (method: string) => {
      setStarting(method);
      setFlash(null);
      setLoginError(null);
      try {
        return await apiPost<PendingLogin>(`${API}/start`, { method });
      } finally {
        setStarting(null);
      }
    },
    { onSuccess: () => state.refetch() },
  );
  const removeToken = useMutation(() => apiDelete<AuthStatus>(`${API}/token`), {
    onSuccess: (s) => apply(s, "Removed the token created here."),
  });

  return (
    <ApiView state={state}>
      {(s) => (
        <>
          {flash && <Alert tone="ok">{flash}</Alert>}
          <Section>
            <StatusCard status={s} onRemoveToken={() => removeToken.run()} removing={removeToken.pending} />
            {removeToken.error && <Alert tone="error">{removeToken.error}</Alert>}
          </Section>

          <Section title={s.credential ? "Log in again" : "Log in"}>
            {s.override && <Alert tone="warn">{s.override} A login made here only takes effect once that variable is removed.</Alert>}
            {s.pending ? (
              <PendingCard
                key={s.pending.id}
                pending={s.pending}
                methodLabel={s.methods.find((m) => m.id === s.pending!.method)?.label ?? s.pending.method}
                onDone={(next) => apply(next, "Logged in. New runs use the new login; running sessions keep the one they started with.")}
                onCancelled={(next) => apply(next)}
                onFailed={(message) => {
                  setLoginError(message);
                  state.refetch();
                }}
              />
            ) : (
              <div className="settings-login-methods">
                {s.methods.map((m) => (
                  <Card key={m.id}>
                    <div className="stack">
                      <span className="settings-login-method-title">
                        {m.label}
                        {m.recommended && <span className="tag settings-login-recommended">Recommended</span>}
                      </span>
                      <span className="muted">{m.description}</span>
                      <FormActions>
                        <Button variant={m.recommended ? "primary" : "secondary"} pending={starting === m.id} disabled={start.pending} onClick={() => start.run(m.id)}>
                          Start login
                        </Button>
                      </FormActions>
                    </div>
                  </Card>
                ))}
              </div>
            )}
            {start.error && <Alert tone="error">{start.error}</Alert>}
            {loginError && <Alert tone="error">{loginError} Start the login again to get a new code.</Alert>}
          </Section>
        </>
      )}
    </ApiView>
  );
}

function StatusCard(props: { status: AuthStatus; onRemoveToken: () => void; removing: boolean }) {
  const s = props.status;
  const badge = authBadge(s.state);
  const tone = badge.status === "error" ? "error" : badge.status === "warn" ? "warn" : undefined;
  const account = s.account ? [s.account.email, s.account.organization, s.account.plan && `${s.account.plan} plan`].filter(Boolean).join(" · ") : null;
  return (
    <Card
      tone={tone}
      title={
        <span className="settings-integration-title">
          <KeyIcon />
          {s.backend === "claude-code" ? "Claude Code" : s.backend}
          <StatusBadge status={badge.status}>{badge.label}</StatusBadge>
        </span>
      }
      actions={
        s.credential?.source === "dashboard" && (
          <ConfirmButton size="sm" pending={props.removing} prompt="Remove the token created here?" confirmLabel="Remove" onConfirm={props.onRemoveToken}>
            Remove token
          </ConfirmButton>
        )
      }
    >
      <div className="stack">
        {s.state !== "missing" && <span className="strong">{s.summary}</span>}
        <KeyValue
          items={[
            ["Uses", s.credential ? s.credential.label : <span className="muted">No credential</span>],
            ["Account", account ?? undefined],
            [
              "Valid until",
              s.expiresAt ? (
                <span className={s.state === "expired" ? "text-error" : s.state === "expiring" ? "text-warn" : undefined}>
                  <Time value={s.expiresAt} mode="date" /> ({daysLeft(s.expiresAt)})
                </span>
              ) : s.credential?.kind === "subscription" ? (
                <span className="muted">Renews itself while in use</span>
              ) : undefined,
            ],
          ]}
        />
        {s.failure && (
          <Alert tone="error">
            Claude refused the login <Time value={s.failure.at} />: {s.failure.message}
          </Alert>
        )}
      </div>
    </Card>
  );
}

function daysLeft(iso: string): string {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} ago`;
  return days === 0 ? "today" : `${days} ${days === 1 ? "day" : "days"} left`;
}

function PendingCard(props: {
  pending: PendingLogin;
  methodLabel: string;
  onDone: (s: AuthStatus) => void;
  onCancelled: (s: AuthStatus) => void;
  onFailed: (message: string) => void;
}) {
  const p = props.pending;
  const [code, setCode] = useState("");
  const complete = useMutation(() => apiPost<AuthStatus>(`${API}/complete`, { id: p.id, code }), { onSuccess: props.onDone, onError: props.onFailed });
  const cancel = useMutation(() => apiPost<AuthStatus>(`${API}/cancel`, { id: p.id }), { onSuccess: props.onCancelled });
  const canSubmit = code.trim() !== "" && !complete.pending;
  const submit = () => canSubmit && complete.run();

  return (
    <Card title={`${props.methodLabel}: waiting for sign-in`}>
      <ol className="settings-login-steps">
        <li>
          <span>Open the Claude sign-in page and approve the login.</span>
          <FormActions>
            <a className="btn btn-primary" href={p.url} target="_blank" rel="noopener noreferrer">
              Open sign-in page
            </a>
            <CopyButton text={p.url} label="Copy link" />
          </FormActions>
        </li>
        <li>
          <TextField
            label="Code from the sign-in page"
            value={code}
            onChange={setCode}
            onEnter={submit}
            placeholder="Paste the code here"
            hint={
              <>
                The login waits until <Time value={p.expiresAt} mode="absolute" />.
              </>
            }
          />
        </li>
      </ol>
      {cancel.error && <Alert tone="error">{cancel.error}</Alert>}
      <FormActions>
        <Button variant="primary" disabled={!canSubmit} pending={complete.pending} onClick={submit}>
          Finish login
        </Button>
        <Button variant="ghost" pending={cancel.pending} disabled={complete.pending} onClick={() => cancel.run()}>
          Cancel
        </Button>
      </FormActions>
    </Card>
  );
}
