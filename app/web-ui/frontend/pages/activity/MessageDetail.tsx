/** /activity/message/:id — an inbound message and the run it started or landed in. */

import { useApi } from "../../api";
import { ApiView, ButtonLink, Card, EmptyState, NotFound, PageHeader, Section, StatusBadge } from "../../components";
import { links } from "../../links";
import { Link, type Params } from "../../router";
import type { MessageDetailResponse } from "../../../ui-api/activity";
import { RunTable } from "./RunDetail";
import { MessageCard } from "./shared";

export function MessageDetail(props: { params: Params }) {
  const id = props.params.id!;
  const valid = /^\d+$/.test(id);
  const state = useApi<MessageDetailResponse>(valid ? `/ui/api/activity/messages/${id}` : null);
  if (!valid || state.error?.includes("not found")) return <NotFound what={`Message #${id}`} />;
  return <ApiView state={state}>{(d) => <MessageView d={d} />}</ApiView>;
}

function MessageView(props: { d: MessageDetailResponse }) {
  const { d } = props;
  const m = d.message;
  const badge =
    d.link.mode === "caused" ? (
      <StatusBadge status="ok">Started a run</StatusBadge>
    ) : d.link.mode === "injected" ? (
      <StatusBadge status="idle">Injected into a run</StatusBadge>
    ) : (
      <StatusBadge status="warn">No run</StatusBadge>
    );
  return (
    <>
      <PageHeader
        title={`Message #${m.id}`}
        badge={badge}
        back={{ href: "/activity", label: "Activity" }}
        subtitle={`${m.channel} · ${m.sender ?? "unknown sender"}`}
        actions={
          m.channel === "web" && m.sessionKey ? (
            <ButtonLink href={links.chat(m.sessionKey)}>
              Open in Chat
            </ButtonLink>
          ) : undefined
        }
      />

      <Section title={d.link.mode === "caused" ? "Started" : d.link.mode === "injected" ? "Delivered into" : "Handling"}>
        {d.link.run ? (
          <Card flush>
            <RunTable runs={[d.link.run]} showTrigger />
          </Card>
        ) : (
          <Card>
            <EmptyState compact title="No run is linked to this message.">
              {d.handler ? (
                <>
                  It may still be queued, or it was read by a session without a run record. <Link href={links.trigger(d.handler)}>{d.handler}</Link> handles{" "}
                  {m.channel} messages.
                </>
              ) : (
                <>No trigger handles the {m.channel} channel.</>
              )}
            </EmptyState>
          </Card>
        )}
      </Section>

      <Section title="Message">
        <MessageCard message={m} />
      </Section>

      <Section>
        <Link href={links.activity({ channel: m.channel })}>All {m.channel} activity</Link>
      </Section>
    </>
  );
}
