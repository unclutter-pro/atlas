/** Reminders tab: pending first (with cancel), then fired/cancelled history. */

import { apiPost, useApi, useMutation } from "../../api";
import { Alert, ApiView, Card, ConfirmButton, DataTable, EmptyState, Section, StatusBadge, Time, type Column } from "../../components";
import { links } from "../../links";
import { Link } from "../../router";
import type { ReminderItem, RemindersResponse } from "../../../ui-api/automations";
import { formatInterval } from "./shared";

export function RemindersView(props: { onChange?: () => void }) {
  const state = useApi<RemindersResponse>("/ui/api/automations/reminders", { poll: 30_000 });
  return <ApiView state={state}>{(data) => <RemindersBody data={data} refetch={() => (state.refetch(), props.onChange?.())} />}</ApiView>;
}

/** Reminder table used here and on the trigger detail page. */
export function RemindersBody(props: { data: RemindersResponse; refetch: () => void; hideTarget?: boolean }) {
  const pending = props.data.items.filter((r) => r.status === "pending");
  const history = props.data.items.filter((r) => r.status !== "pending");

  if (props.data.items.length === 0) {
    return (
      <EmptyState title="No reminders">
        Atlas schedules reminders for itself with the <code>reminder</code> CLI: at a time, when an email reply arrives, or when a script check
        passes. They show up here, and pending ones can be cancelled.
      </EmptyState>
    );
  }

  return (
    <>
      <Section title="Pending" count={pending.length}>
        <Card flush>
          <DataTable rows={pending} rowKey={(r) => r.id} empty={<EmptyState compact title="Nothing pending." />} columns={pendingColumns(props.refetch, props.hideTarget)} />
        </Card>
      </Section>
      {history.length > 0 && (
        <Section title="History" count={history.length}>
          <Card flush>
            <DataTable dense rows={history} rowKey={(r) => r.id} columns={historyColumns(props.hideTarget)} />
          </Card>
        </Section>
      )}
    </>
  );
}

function When(props: { r: ReminderItem }) {
  const { r } = props;
  if (r.fireAt) {
    return (
      <div>
        <div className="cell-primary">
          <Time value={r.fireAt} />
        </div>
        <div className="cell-secondary">
          <Time value={r.fireAt} mode="absolute" />
        </div>
      </div>
    );
  }
  const kind = r.triggerType === "reply" || r.triggerType === "email_reply" ? "On reply" : r.triggerType === "script" || r.triggerType === "script_check" ? "On script check" : "On event";
  return (
    <div>
      <div className="cell-primary">{kind}</div>
      {r.timeoutAt && (
        <div className="cell-secondary">
          gives up <Time value={r.timeoutAt} />
        </div>
      )}
    </div>
  );
}

function What(props: { r: ReminderItem }) {
  return (
    <div className="automations-reminder-what">
      <div className="cell-primary">{props.r.title}</div>
      <div className="cell-secondary truncate" title={props.r.prompt}>
        {props.r.prompt}
      </div>
    </div>
  );
}

function Target(props: { r: ReminderItem }) {
  const { r } = props;
  return (
    <div>
      {r.triggerName ? <Link href={links.trigger(r.triggerName)}>{r.triggerName}</Link> : <span className="muted">{r.channel}</span>}
      {r.sessionKey && <div className="cell-secondary truncate">{r.sessionKey}</div>}
    </div>
  );
}

function CancelButton(props: { r: ReminderItem; onDone: () => void }) {
  const cancel = useMutation(() => apiPost(`/ui/api/automations/reminders/${props.r.id}/cancel`, {}), { onSuccess: props.onDone });
  return (
    <div className="stack automations-cancel">
      <ConfirmButton size="sm" variant="ghost" prompt="Cancel reminder?" confirmLabel="Cancel it" pending={cancel.pending} onConfirm={() => cancel.run()}>
        Cancel
      </ConfirmButton>
      {cancel.error && <Alert tone="error">{cancel.error}</Alert>}
    </div>
  );
}

function pendingColumns(refetch: () => void, hideTarget?: boolean): Column<ReminderItem>[] {
  return [
    { key: "when", header: "When", width: 170, render: (r) => <When r={r} /> },
    { key: "what", header: "Reminder", render: (r) => <What r={r} /> },
    ...(hideTarget ? [] : [{ key: "target", header: "Delivers to", render: (r: ReminderItem) => <Target r={r} /> }]),
    {
      key: "repeat",
      header: "Repeats",
      render: (r) => (r.recurringIntervalSeconds ? <span className="muted">{formatInterval(r.recurringIntervalSeconds)}</span> : <span className="faint">once</span>),
    },
    { key: "actions", header: "", align: "right", render: (r) => <CancelButton r={r} onDone={refetch} /> },
  ];
}

function historyColumns(hideTarget?: boolean): Column<ReminderItem>[] {
  return [
    {
      key: "status",
      header: "Outcome",
      width: 110,
      render: (r) => (r.status === "fired" ? <StatusBadge status="ok">Fired</StatusBadge> : <StatusBadge status="idle">Cancelled</StatusBadge>),
    },
    { key: "when", header: "When", width: 130, render: (r) => <Time value={r.firedAt ?? r.fireAt ?? r.createdAt} /> },
    { key: "what", header: "Reminder", render: (r) => <What r={r} /> },
    ...(hideTarget ? [] : [{ key: "target", header: "Delivers to", render: (r: ReminderItem) => <Target r={r} /> }]),
  ];
}
