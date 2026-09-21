/** Small building blocks shared by the Activity list and detail pages. */

import type { ReactNode } from "react";
import { KeyValue, Num, Time, formatBytes } from "../../components";
import { links } from "../../links";
import { Link } from "../../router";
import type { ActivityItem, AttachmentInfo, Cause, MessageInfo, Metrics } from "../../../ui-api/activity";

const CAUSE_LABEL: Record<Cause, string> = {
  message: "Message",
  cron: "Cron",
  webhook: "Webhook",
  manual: "Manual",
  direct: "Direct",
  unknown: "Run",
};

export function causeLabel(cause: Cause): string {
  return CAUSE_LABEL[cause];
}

/** "Message · signal", "Cron", "Webhook" … */
export function CauseTag(props: { cause: Cause; channel?: string | null }) {
  const showChannel = props.cause === "message" && props.channel;
  return (
    <span className={`activity-cause activity-cause-${props.cause}`}>
      {CAUSE_LABEL[props.cause]}
      {showChannel && <span className="activity-cause-channel"> · {props.channel}</span>}
    </span>
  );
}

/** Detail URL for a timeline item. */
export function itemHref(item: ActivityItem): string | null {
  if (item.kind === "run" && item.runId != null) return links.run(item.runId);
  if (item.kind === "session" && item.sessionId) return links.session(item.sessionId);
  if (item.kind === "message" && item.messageId != null) return links.message(item.messageId);
  return null;
}

function Attachment(props: { a: AttachmentInfo }) {
  const { a } = props;
  return (
    <div className="activity-attachment">
      <div className="row">
        <span className="tag">{a.kind}</span>
        {a.url ? (
          <a href={a.url} target="_blank" rel="noreferrer">
            {a.fileName}
          </a>
        ) : (
          <span className="muted" title="The file is no longer on disk">
            {a.fileName}
          </span>
        )}
        <span className="faint small">
          {a.mimeType} · {formatBytes(a.fileSize)}
        </span>
      </div>
      {a.url && a.kind === "audio" && <audio controls preload="none" src={a.url} className="activity-audio" />}
      {a.url && a.kind === "image" && <img src={a.url} alt={a.fileName} className="activity-image" />}
      {a.transcription && <div className="activity-transcription">{a.transcription}</div>}
    </div>
  );
}

/** An inbound message: who, when, what, plus attachments. */
export function MessageCard(props: { message: MessageInfo; linkToDetail?: boolean; footer?: ReactNode }) {
  const m = props.message;
  return (
    <div className="activity-message">
      <div className="activity-message-head">
        <span className="strong">{m.sender || "unknown sender"}</span>
        <span className="tag">{m.channel}</span>
        <span className="spacer" />
        <Time value={m.createdAt} className="faint small" />
        {props.linkToDetail && (
          <Link href={links.message(m.id)} className="small">
            #{m.id}
          </Link>
        )}
      </div>
      <div className="activity-message-body">{m.content}</div>
      {m.attachments.length > 0 && (
        <div className="activity-attachments">
          {m.attachments.map((a) => (
            <Attachment key={a.id} a={a} />
          ))}
        </div>
      )}
      {props.footer}
    </div>
  );
}

/** Raw token counts and cost for one session invocation. */
export function MetricsList(props: { metrics: Metrics }) {
  const m = props.metrics;
  return (
    <KeyValue
      items={[
        ["Input tokens", <Num value={m.inputTokens} />],
        ["Output tokens", <Num value={m.outputTokens} />],
        ["Cache read", <Num value={m.cacheReadTokens} />],
        ["Cache write", <Num value={m.cacheCreationTokens} />],
        ["Turns", m.numTurns != null ? <Num value={m.numTurns} /> : null],
        ["Cost", m.costUsd != null ? <span className="num">${m.costUsd.toFixed(6)}</span> : null],
        ["Started", m.startedAt ? <Time value={m.startedAt} mode="absolute" /> : null],
        ["Ended", m.endedAt ? <Time value={m.endedAt} mode="absolute" /> : null],
      ]}
    />
  );
}
