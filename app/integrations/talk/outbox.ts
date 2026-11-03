import { createHash, randomUUID } from "node:crypto";
import { TalkClient, TalkError } from "./client.ts";
import { roomAllowed, type TalkConfig } from "./config.ts";
import { assertNoSecrets } from "./secret-guard.ts";
import { TalkLedger } from "../../triggers/talk/ledger.ts";
import type { Outbound, PrepareSendInput } from "../../triggers/talk/types.ts";

interface Batch {
  id: string;
  input: PrepareSendInput;
  parts: string[];
  createdAt?: number;
  completedAt?: number;
  inputDigest?: string;
  expiredAt?: number;
}
export interface SendResult { batchId: string; state: string; outboundIds: string[]; messageIds: number[]; requestId: string | null; }

function schema(ledger: TalkLedger): void {
  ledger.db.exec(`CREATE TABLE IF NOT EXISTS talk_send_batches (
    id TEXT PRIMARY KEY, instance TEXT NOT NULL, data TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0
  )`);
}

export function splitMessage(text: string, maxLength: number): string[] {
  if (!text.trim()) throw new Error("Message must not be empty");
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error("Invalid Talk message length capability");
  const points = Array.from(text);
  const parts: string[] = [];
  for (let at = 0; at < points.length; at += maxLength) {
    const part = points.slice(at, at + maxLength).join("");
    // Talk rejects whitespace-only messages; separating whitespace can be omitted
    // between chat parts, while every non-whitespace character remains intact.
    if (part.trim()) parts.push(part);
  }
  return parts;
}

export async function sendOutbound(ledger: TalkLedger, client: TalkClient, out: Outbound): Promise<Outbound> {
  if (!ledger.markSending(out.id)) return ledger.getOutbound(out.id)!;
  try {
    if (out.instance !== client.config.instance || !roomAllowed(client.config, out.room)) {
      throw new TalkError("Outgoing Talk destination is excluded by the current account configuration", "forbidden");
    }
    const room = ledger.getRoom(out.instance, out.room);
    if (!room || room.readOnly || room.isFederated) throw new TalkError("Outgoing Talk conversation is unavailable, read-only or federated", "forbidden");
    try { assertNoSecrets(`${out.title ?? ""}\n${out.body}`, client.config.appPassword); }
    catch { throw new TalkError("Outgoing Talk content contains a stored credential or secret inspection failed", "invalid_request"); }
    const message = await client.send(out.room, {
      message: out.body, threadId: out.threadId ?? undefined, replyTo: out.replyTo ?? undefined,
      threadTitle: out.title ?? undefined, referenceId: out.referenceId, silent: out.silent,
    });
    if (message.actorType !== "users" || message.actorId !== client.config.username) {
      throw new TalkError("Talk sent-message author does not match the configured account", "protocol", null, null, true);
    }
    return ledger.confirmSend(out.id, message);
  } catch (error) {
    // A process can also die here after the server committed. `sending` is then
    // reconciled by referenceId, exactly like an uncertain network result.
    if (error instanceof TalkError && error.code === "aborted" && !error.unknownOutcome) {
      // Cancellation before POST did not deliver anything. Keep the persisted
      // intent (and preparing question) available for the next process startup.
      ledger.db.query("UPDATE talk_outbox SET state='pending',error='',updated_at=? WHERE id=? AND state='sending'")
        .run(ledger.now(), out.id);
    } else if (!(error instanceof TalkError) || error.unknownOutcome) {
      ledger.markSendUncertain(out.id, "Delivery outcome unknown; awaiting history reconciliation");
    } else {
      ledger.markSendFailed(out.id, error.message);
    }
    if (error instanceof TalkError && ["auth", "aborted"].includes(error.code)) throw error;
    return ledger.getOutbound(out.id)!;
  }
}

async function runBatch(ledger: TalkLedger, client: TalkClient, batch: Batch, maySend: () => boolean = () => true): Promise<SendResult> {
  if (batch.expiredAt !== undefined) throw new Error("Stored Talk send content has expired; this send ID will not resend. Inspect delivery IDs or Talk history.");
  const result: SendResult = { batchId: batch.id, state: "sent", outboundIds: [], messageIds: [], requestId: null };
  let threadId = batch.input.threadId;
  for (let i = 0; i < batch.parts.length; i++) {
    const id = `${batch.id}:${i}`;
    let out = ledger.getOutbound(id) ?? ledger.prepareSend({
      ...batch.input, id, body: batch.parts[i]!, threadId,
      title: i === 0 ? batch.input.title : null,
      // Every split part keeps the resolved destination, including quote replies.
      replyTo: batch.input.title && i > 0 ? null : batch.input.replyTo,
      request: i === 0 ? batch.input.request : undefined,
    });
    result.outboundIds.push(out.id);
    result.requestId ??= out.requestId;
    if (out.state === "pending" && !maySend()) { result.state = "pending"; return result; }
    if (out.state === "pending") out = await sendOutbound(ledger, client, out);
    if (out.state !== "sent") {
      result.state = out.state;
      if (out.state === "failed") completeBatch(ledger, batch);
      return result;
    }
    result.messageIds.push(out.messageId!);
    if (batch.input.title) {
      if (!out.threadId) throw new Error("Confirmed Talk thread is missing its server identity");
      threadId = out.threadId;
    }
  }
  completeBatch(ledger, batch);
  return result;
}

function identity(input: PrepareSendInput): string {
  return JSON.stringify({
    instance: input.instance, room: input.room, threadId: input.threadId ?? null,
    conversationId: input.conversationId, body: input.body, title: input.title ?? null,
    replyTo: input.replyTo ?? null, silent: input.silent ?? false,
    request: input.request ? {
      originTrigger: input.request.originTrigger, originSessionKey: input.request.originSessionKey,
      taskId: input.request.taskId ?? null, expectedUser: input.request.expectedUser, blocking: input.request.blocking ?? false,
    } : null,
  });
}

function digest(input: PrepareSendInput): string {
  return createHash("sha256").update(identity(input)).digest("hex");
}

function completeBatch(ledger: TalkLedger, batch: Batch): void {
  ledger.db.query("UPDATE talk_send_batches SET complete=1,data=json_set(data,'$.completedAt',?,'$.inputDigest',?) WHERE id=? AND complete=0")
    .run(ledger.now(), digest(batch.input), batch.id);
}

function existingBatch(ledger: TalkLedger, id: string, input: PrepareSendInput): Batch | null {
  const row = ledger.db.query("SELECT data FROM talk_send_batches WHERE id=?").get(id) as { data: string } | null;
  if (!row) return null;
  const batch = JSON.parse(row.data) as Batch;
  if ((batch.inputDigest ?? digest(batch.input)) !== digest(input)) throw new Error("Talk send ID already used for a different destination, message or question");
  if (batch.expiredAt !== undefined) throw new Error("Stored Talk send content has expired; this send ID will not resend. Inspect delivery IDs or Talk history.");
  return batch;
}

/** Persist the entire multipart plan before the first network call. */
export async function sendText(ledger: TalkLedger, client: TalkClient, config: TalkConfig, input: PrepareSendInput): Promise<SendResult> {
  if (input.instance !== config.instance || client.config.instance !== config.instance) throw new Error("Outgoing Talk account does not match the configured account");
  assertNoSecrets(`${input.title ?? ""}\n${input.body}`, config.appPassword);
  if (input.id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(input.id)) throw new Error("Talk send ID must contain 1 to 160 letters, digits, dots, underscores, colons or hyphens");
  schema(ledger);
  const id = input.id === undefined ? randomUUID() : `${config.instance}:${input.id}`;
  const existing = existingBatch(ledger, id, input);
  // Keep the originally persisted chunk boundaries even if server limits changed.
  if (existing) return runBatch(ledger, client, existing);
  const caps = await client.capabilities();
  const parts = splitMessage(input.body, caps.maxMessageLength);
  if (input.request && parts.length > 1) throw new Error("A task question must fit one Talk message; shorten it and send details separately");
  if ((input.title || input.threadId) && !caps.features.includes("threads")) throw new Error("This Talk server does not support native threads");
  const batch = ledger.transaction(() => {
    // A CLI command and recovery worker may admit the same intent concurrently.
    const admitted = existingBatch(ledger, id, input);
    if (admitted) return admitted;
    const batch: Batch = { id, input, parts, createdAt: ledger.now(), inputDigest: digest(input) };
    ledger.db.query("INSERT INTO talk_send_batches(id,instance,data) VALUES (?,?,?)").run(batch.id, input.instance, JSON.stringify(batch));
    ledger.prepareSend({ ...input, id: `${batch.id}:0`, body: parts[0]! });
    return batch;
  });
  return runBatch(ledger, client, batch);
}

/** Bounded reconciliation; absence is not proof of failure and never triggers a resend. */
export async function recoverOutbox(ledger: TalkLedger, client: TalkClient, config: TalkConfig,
  { maySend = () => true }: { maySend?: () => boolean } = {}): Promise<void> {
  schema(ledger);
  const unsettled = ledger.pendingOutbox(config.instance);
  const rooms = [...new Set(unsettled.filter(o => o.state === "sending" || o.state === "uncertain").map(o => o.room))];
  const rotationKey = `outbox-room-offset:${config.instance}`;
  const at = Math.max(0, Number(ledger.getMeta(rotationKey)) || 0) % Math.max(1, rooms.length);
  const selectedRooms = [...rooms.slice(at), ...rooms.slice(0, at)].slice(0, 20);
  ledger.setMeta(rotationKey, String((at + selectedRooms.length) % Math.max(1, rooms.length)));
  for (const room of selectedRooms) {
    if (!roomAllowed(config, room) || !ledger.getRoom(config.instance, room)) continue;
    try {
      const page = await client.history(room, { limit: 200 });
      for (const message of page.messages) {
        if (message.actorType !== "users" || message.actorId !== config.username || !message.referenceId) continue;
        const out = ledger.findOutboundByReference(config.instance, message.referenceId);
        if (out && out.room === room && ["sending", "uncertain"].includes(out.state)) {
          try { ledger.confirmSend(out.id, message); }
          catch { ledger.markSendUncertain(out.id, "Received message does not match the intended Talk destination; inspect delivery"); }
        }
      }
    } catch (error) {
      if (error instanceof TalkError && ["auth", "aborted"].includes(error.code)) throw error;
    }
  }
  // Terminal or unresolved old batches must not block later multipart continuations.
  ledger.db.query(`UPDATE talk_send_batches AS b SET complete=1,
    data=json_set(data,'$.completedAt',COALESCE((SELECT MAX(o.updated_at) FROM talk_outbox o
      WHERE substr(o.id,1,length(b.id)+1)=b.id||':' AND instr(substr(o.id,length(b.id)+2),':')=0),?))
    WHERE b.instance=? AND b.complete=0
    AND EXISTS (SELECT 1 FROM talk_outbox o WHERE substr(o.id,1,length(b.id)+1)=b.id||':'
      AND instr(substr(o.id,length(b.id)+2),':')=0 AND o.state='failed')`).run(ledger.now(), config.instance);
  const batches = ledger.db.query(`SELECT b.data FROM talk_send_batches b WHERE b.instance=? AND b.complete=0
    AND NOT EXISTS (SELECT 1 FROM talk_outbox o WHERE substr(o.id,1,length(b.id)+1)=b.id||':'
      AND instr(substr(o.id,length(b.id)+2),':')=0 AND o.state IN ('sending','uncertain'))
    ORDER BY b.rowid LIMIT 20`).all(config.instance) as { data: string }[];
  for (const { data } of batches) await runBatch(ledger, client, JSON.parse(data), maySend);
}

/** Remove completed plan text while keeping immutable send IDs permanently reserved. */
export function pruneSendBatches(ledger: TalkLedger, retentionDays = 30): number {
  schema(ledger);
  const now = ledger.now();
  const cutoff = now - Math.max(1, retentionDays) * 86_400_000;
  return ledger.transaction(() => {
    const rows = ledger.db.query(`SELECT b.id,b.data FROM talk_send_batches b WHERE b.complete=1
      AND json_extract(b.data,'$.expiredAt') IS NULL
      AND COALESCE(json_extract(b.data,'$.completedAt'),(SELECT MAX(o.updated_at) FROM talk_outbox o
        WHERE substr(o.id,1,length(b.id)+1)=b.id||':' AND instr(substr(o.id,length(b.id)+2),':')=0),?)<?
      AND NOT EXISTS (SELECT 1 FROM talk_outbox o WHERE substr(o.id,1,length(b.id)+1)=b.id||':'
        AND instr(substr(o.id,length(b.id)+2),':')=0 AND o.state NOT IN ('sent','failed'))
      AND NOT EXISTS (SELECT 1 FROM talk_questions q WHERE substr(q.outbound_id,1,length(b.id)+1)=b.id||':'
        AND instr(substr(q.outbound_id,length(b.id)+2),':')=0 AND q.state IN ('preparing','pending'))`)
      .all(now, cutoff) as { id: string; data: string }[];
    for (const row of rows) {
      const batch = JSON.parse(row.data) as Batch;
      const input = batch.input;
      const tombstone: Batch = {
        id: batch.id, createdAt: batch.createdAt, completedAt: batch.completedAt,
        inputDigest: batch.inputDigest ?? digest(input), expiredAt: now, parts: [],
        input: {
          id: input.id, instance: input.instance, room: input.room, threadId: input.threadId,
          conversationId: input.conversationId, body: "", title: null,
          replyTo: input.replyTo, silent: input.silent,
        },
      };
      ledger.db.query("UPDATE talk_send_batches SET data=? WHERE id=?").run(JSON.stringify(tombstone), row.id);
    }
    return rows.length;
  });
}
