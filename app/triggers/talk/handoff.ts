import { TalkLedger } from "./ledger.ts";
import { clipToTokenBudget } from "./router.ts";
import type { IncomingEvent } from "./types.ts";

function encodedText(text: string, budget: number): string {
  let low = 0, high = Math.min(Buffer.byteLength(text), budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(clipToTokenBudget(text, mid))) <= budget) low = mid;
    else high = mid - 1;
  }
  return clipToTokenBudget(text, low);
}

/** A new independent worker starts only once its opening message has a real address. */
export function queueHandoffs(ledger: TalkLedger, instance: string, allowedRooms: string[] = []): number {
  let count = 0;
  const pending = ledger.db.query(`SELECT c.id FROM talk_conversations c JOIN talk_meta m ON m.key='handoff:start:' || c.id
    JOIN talk_rooms r ON r.instance=c.instance AND r.room=c.room
    WHERE c.instance=? AND c.state='active' AND m.value='pending' AND r.enabled=1
    ${allowedRooms.length ? `AND c.room IN (${allowedRooms.map(() => "?").join(",")})` : ""}
    AND EXISTS (SELECT 1 FROM talk_outbox o WHERE o.instance=c.instance AND o.state='sent' AND json_extract(o.data,'$.conversationId')=c.id)
    ORDER BY c.rowid LIMIT 100`).all(instance, ...allowedRooms) as { id: string }[];
  for (const { id } of pending) {
    const owner = ledger.getConversation(id)!;
    if (!owner.handoff || (allowedRooms.length && !allowedRooms.includes(owner.room))) continue;
    const eventId = `talk:handoff:${owner.id}`;
    if (ledger.getDelivery(`delivery:${eventId}`)) continue;
    const row = ledger.db.query("SELECT id FROM talk_outbox WHERE instance=? AND state='sent' AND json_extract(data,'$.conversationId')=? ORDER BY rowid LIMIT 1")
      .get(instance, owner.id) as { id: string } | null;
    if (!row) continue;
    const opening = ledger.getOutbound(row.id)!;
    const message = ledger.readMessage(instance, opening.room, opening.messageId!);
    if (!message) continue;
    ledger.transaction(() => {
      const event: IncomingEvent = { id: eventId, instance, room: opening.room, message,
        status: "pending", reason: "independent-handoff", createdAt: ledger.now() };
      ledger.enqueue(event, owner, JSON.stringify({
        type: "talk_handoff", eventId, conversationId: owner.id,
        address: { instance, room: opening.room, threadId: opening.threadId },
        openingMessageId: opening.messageId,
        openingMessage: encodedText(message.text, 2000),
        handoff: encodedText(owner.handoff, 6000),
        handoffTruncated: encodedText(owner.handoff, 6000) !== owner.handoff,
        instruction: "Handle the explicitly handed-off independent work in this conversation. Create your own task records. Existing tasks remain owned by their source session; this is not a task transfer. Read the full handoff with talk conversation --id if truncated. Keep private context scoped to its audience.",
      }), 60, { reason: "independent-handoff" });
      ledger.setMeta(`handoff:start:${owner.id}`, "queued");
      count++;
    });
  }
  return count;
}
