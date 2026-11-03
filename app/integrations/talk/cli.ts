#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../lib/atlas-db.ts";
import { isTalkConfigured, loadTalkConfig, roomAllowed, type TalkConfig } from "./config.ts";
import { TalkClient, TalkError } from "./client.ts";
import { TalkLedger } from "../../triggers/talk/ledger.ts";
import type { Conversation, QuestionInput } from "../../triggers/talk/types.ts";
import { isTaskActive, canPauseForTalk } from "../../triggers/talk/lifecycle.ts";
import { provisionTalk } from "./setup.ts";
import { recoverOutbox, sendText } from "./outbox.ts";

const HELP = `Nextcloud Talk (dedicated regular-user account)

talk setup                         Provision worker + supervisor config
talk listen                        Run durable ingestion and delivery
talk check                         Verify credentials and capabilities
talk status                        Read listener health and pending work
talk rooms                         Refresh accessible conversations
talk send --room TOKEN --message TEXT [--thread ID | --reply-to ID]
talk dm --user UID --message TEXT [--task ID]
talk send --room TOKEN --new-thread TITLE --message TEXT
          [--conversation ID | --new-conversation --handoff-file FILE]
talk history --room TOKEN [--thread ID] [--limit N]
talk message --room TOKEN --id ID   Read the retained full message
talk request --id ID [--cancel | --pending]
talk conversation --id ID [--summary TEXT] [--close]
talk react --room TOKEN --id ID --reaction EMOJI [--remove]
talk reconcile                     Check uncertain sends against server history

Send options: --message-file FILE replaces --message; '-' reads stdin.
--send-id ID makes retries of the same complete send plan reuse the durable result.
--task ID records a blocking question owned by the current ATLAS_TRIGGER session.
For room questions add --expect UID. --question creates a nonblocking question.
Only confirmed sends allow a task to pause; replies resume the original session.
--new-thread keeps the current conversation when it belongs to this room.
--new-conversation needs an explicit handoff for independent work; existing tasks
remain with their owner. Use memory file references for shared background.
Outgoing sends return durable batch/request IDs. An uncertain result is reconciled;
resending it manually may duplicate a message. No reply reminder is needed.
`;

const OPTIONS = {
  room: { type: "string" }, user: { type: "string" }, message: { type: "string" }, "message-file": { type: "string" },
  thread: { type: "string" }, "reply-to": { type: "string" }, "new-thread": { type: "string" },
  conversation: { type: "string" }, "new-conversation": { type: "boolean" }, "handoff-file": { type: "string" },
  task: { type: "string" }, expect: { type: "string" }, question: { type: "boolean" },
  "send-id": { type: "string" },
  id: { type: "string" }, instance: { type: "string" }, limit: { type: "string" }, before: { type: "string" },
  summary: { type: "string" }, close: { type: "boolean" }, cancel: { type: "boolean" }, pending: { type: "boolean" },
  reaction: { type: "string" }, remove: { type: "boolean" }, silent: { type: "boolean" }, help: { type: "boolean", short: "h" },
} as const;

function positive(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}
function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
function scope(): { trigger: string; key: string } {
  return { trigger: process.env.ATLAS_TRIGGER ?? "", key: process.env.ATLAS_TRIGGER_SESSION_KEY ?? "" };
}
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
class ConfigurationError extends Error {}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values: v, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true });
  const command = positionals[0];
  if (v.help || !command || command === "help") { console.log(HELP); return 0; }
  if (positionals.length > 1) throw new Error("Use named options; see talk --help");
  const home = process.env.HOME ?? "/home/agent";
  const origin = scope();
  if (command === "can-pause") return canPauseForTalk(getDb(), origin.trigger, origin.key) ? 0 : 1;
  if (command === "setup") {
    const config = isTalkConfigured() ? loadTalkConfig(undefined, { requirePassword: false }) : null;
    provisionTalk(config, home, getDb());
    console.log(config ? "Talk listener and conversation worker provisioned" : "Talk is not configured");
    return 0;
  }
  const network = ["listen", "check", "rooms", "send", "dm", "react", "reconcile"].includes(command);
  let config: TalkConfig;
  try { config = loadTalkConfig(undefined, { requirePassword: network }); }
  catch (error) { throw new ConfigurationError(error instanceof Error ? error.message : "Invalid Talk configuration"); }
  if (v.instance && v.instance !== config.instance) throw new Error("The message belongs to a different Talk account");
  const ledger = new TalkLedger();
  const client = new TalkClient(config);
  try {
    if (command === "listen") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGTERM", stop); process.on("SIGINT", stop);
      try { await (await import("../../triggers/talk/runtime.ts")).runTalkService(config, ledger, getDb(), controller.signal); }
      finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
    } else if (command === "check") {
      print({ instance: config.instance, username: config.username, capabilities: await client.capabilities(), rooms: (await client.rooms()).length });
    } else if (command === "status") {
      let health: unknown = null;
      try { health = JSON.parse(readFileSync(join(home, ".index/talk/status.json"), "utf8")); } catch {}
      print({ health, instance: config.instance,
        pendingDeliveries: ledger.deliveries().filter(d => d.instance === config.instance && d.status !== "completed").map(d => ({ id: d.id, state: d.status, error: d.error })),
        outbox: ledger.pendingOutbox(config.instance).map(o => ({ id: o.id, state: o.state, requestId: o.requestId, error: o.error })),
      });
    } else if (command === "rooms") {
      const rooms = (await client.rooms()).filter(r => roomAllowed(config, r.token));
      ledger.upsertRooms(config.instance, rooms); print(rooms);
    } else if (command === "message" || command === "history") {
      const room = requireValue(v.room, "--room");
      if (!roomAllowed(config, room)) throw new Error("Conversation excluded by talk.rooms");
      if (command === "message") {
        const message = ledger.readMessage(config.instance, room, positive(v.id, "--id") ?? 0);
        if (!message) throw new Error("Message is not retained locally");
        print(message);
      } else print(ledger.history({ instance: config.instance, room, threadId: positive(v.thread, "--thread") },
        { limit: Math.min(200, positive(v.limit, "--limit") ?? 20), beforeId: positive(v.before, "--before") ?? undefined }));
    } else if (command === "request") {
      const request = ledger.getQuestion(requireValue(v.id, "--id"));
      if (!request || request.instance !== config.instance) throw new Error("Unknown question in this Talk account");
      if (v.cancel) {
        if (request.originTrigger !== origin.trigger || request.originSessionKey !== origin.key) throw new Error("Only the owning session can cancel a question");
        ledger.cancelQuestion(request.id);
      }
      const fresh = ledger.getQuestion(request.id)!;
      if (v.pending) return fresh.state === "pending" && (fresh.taskId === null || isTaskActive(getDb(), fresh.originTrigger, fresh.originSessionKey, fresh.taskId)) ? 0 : 1;
      print(fresh);
    } else if (command === "conversation") {
      const conversation = ledger.getConversation(requireValue(v.id, "--id"));
      if (!conversation || conversation.instance !== config.instance) throw new Error("Unknown conversation in this account");
      if (v.summary !== undefined || v.close) {
        if (conversation.triggerName !== origin.trigger || conversation.sessionKey !== origin.key) throw new Error("Only the owning session can update a conversation");
        ledger.updateConversation(conversation.id, { ...(v.summary !== undefined ? { summary: v.summary.slice(0, 4000) } : {}), ...(v.close ? { state: "closed" } : {}) });
      }
      print(ledger.getConversation(conversation.id));
    } else if (command === "react") {
      const room = requireValue(v.room, "--room");
      if (!roomAllowed(config, room)) throw new Error("Conversation excluded by talk.rooms");
      const id = positive(v.id, "--id"); if (!id) throw new Error("--id is required");
      await client[v.remove ? "unreact" : "react"](room, id, requireValue(v.reaction, "--reaction"));
      print({ ok: true });
    } else if (command === "reconcile") {
      await recoverOutbox(ledger, client, config); print({ ok: true });
    } else if (command === "send" || command === "dm") {
      if (v.message !== undefined && v["message-file"]) throw new Error("Choose --message or --message-file");
      const body = v["message-file"] === "-" ? await Bun.stdin.text()
        : v["message-file"] ? readFileSync(v["message-file"], "utf8") : requireValue(v.message, "--message");
      if (v["new-thread"] && (v.thread || v["reply-to"])) throw new Error("A new thread starts independently of any current thread or quote");
      if (v["new-conversation"] && !v["handoff-file"]) throw new Error("Independent work needs --handoff-file with request, constraints and memory references");
      if (v["new-conversation"] && v.conversation) throw new Error("Choose an existing conversation or a new one");
      if (v["new-conversation"] && (v.thread || v["reply-to"])) throw new Error("Independent work starts with a new message or thread");
      if (v["handoff-file"] && !v["new-conversation"]) throw new Error("Use --new-conversation for an independent handoff");
      const task = positive(v.task, "--task");
      let request: QuestionInput | undefined;
      if (task !== null || v.question) {
        if (!origin.trigger || !origin.key) throw new Error("Questions need an owning ATLAS_TRIGGER session");
        const db = getDb();
        if (!db.query("SELECT 1 FROM triggers WHERE name=? AND enabled=1 AND session_mode='persistent'").get(origin.trigger)) throw new Error("The question owner must be an enabled persistent trigger");
        if (task !== null && !isTaskActive(db, origin.trigger, origin.key, task)) throw new Error("Task is not open in the current session");
        const expectedUser = requireValue(command === "dm" ? v.user : v.expect, command === "dm" ? "--user" : "--expect");
        if (config.whitelist.length && !config.whitelist.includes(expectedUser)) throw new Error("Expected user excluded by talk.whitelist");
        request = { originTrigger: origin.trigger, originSessionKey: origin.key, taskId: task, expectedUser, blocking: task !== null };
      }
      let room = v.room;
      if (command === "dm") {
        if (v.room || v.conversation || v["new-conversation"] || v["new-thread"]) throw new Error("Use talk send for explicit rooms, conversations or threads");
        const user = requireValue(v.user, "--user");
        if (config.whitelist.length && !config.whitelist.includes(user)) throw new Error("Recipient excluded by talk.whitelist");
        const direct = await client.createDirectConversation(user);
        if (!roomAllowed(config, direct.token)) throw new Error("Direct conversation excluded by talk.rooms");
        ledger.registerOutgoingRoom(config.instance, direct); room = direct.token;
      }
      room = requireValue(room, "--room");
      if (!roomAllowed(config, room)) throw new Error("Conversation excluded by talk.rooms");
      if (!ledger.getRoom(config.instance, room)) ledger.upsertRooms(config.instance, (await client.rooms()).filter(r => r.token === room));
      const roomInfo = ledger.getRoom(config.instance, room);
      if (!roomInfo || roomInfo.readOnly || roomInfo.isFederated) throw new Error("Conversation is unavailable, read-only or federated");
      ledger.registerOutgoingRoom(config.instance, roomInfo);
      let thread = v["new-thread"] ? null : positive(v.thread, "--thread");
      const parent = v["new-thread"] ? null : positive(v["reply-to"], "--reply-to");
      if (parent !== null) {
        let quoted = ledger.readMessage(config.instance, room, parent);
        if (!quoted) {
          const context = await client.context(room, parent, 10);
          ledger.cacheMessages(config.instance, room, context);
          quoted = context.find(message => message.id === parent) ?? null;
        }
        if (!quoted) throw new Error("Cannot resolve the quoted message's destination");
        if (v.thread && thread !== quoted.threadId) throw new Error("Quoted message belongs to another thread; reply-to determines the destination");
        thread = quoted.threadId;
      }
      let owner: Conversation | null = null;
      if (v["send-id"] && ledger.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='talk_send_batches'").get()) {
        const saved = ledger.db.query("SELECT data FROM talk_send_batches WHERE id=? AND instance=?").get(`${config.instance}:${v["send-id"]}`, config.instance) as { data: string } | null;
        if (saved) {
          owner = ledger.getConversation(JSON.parse(saved.data).input.conversationId);
          if (v.conversation && owner?.id !== v.conversation) throw new Error("Send ID belongs to a different conversation");
        }
      }
      if (v.conversation) owner = ledger.getConversation(v.conversation);
      else if (!owner && !v["new-conversation"]) {
        owner = parent ? ledger.lookup(config.instance, room, "message", parent) : null;
        owner ??= thread ? ledger.lookup(config.instance, room, "thread", thread) : null;
        const current = ledger.resolveAddress(origin.trigger, origin.key);
        if (current?.instance === config.instance && current.room === room) owner ??= current;
        if (command === "dm") owner ??= ledger.lookup(config.instance, room, "direct", "main");
      }
      if (owner && (owner.instance !== config.instance || owner.room !== room)) throw new Error("Conversation belongs to a different account or room");
      if (v.conversation && !owner) throw new Error("Unknown conversation");
      const handoff = v["handoff-file"] ? readFileSync(v["handoff-file"], "utf8").trim() : "";
      if (v["new-conversation"] && !handoff) throw new Error("Handoff must not be empty");
      const created = !owner;
      owner ??= ledger.createConversation({ instance: config.instance, room, threadId: thread, triggerName: config.workerTrigger, title: v["new-thread"] ?? body.slice(0, 120), handoff });
      if (v["new-conversation"] && created) ledger.setMeta(`handoff:start:${owner.id}`, "pending");
      if (command === "dm") owner = ledger.bind(config.instance, room, "direct", "main", owner.id);
      const result = await sendText(ledger, client, config, { instance: config.instance, room, threadId: thread, conversationId: owner.id,
        body, title: v["new-thread"], replyTo: parent, silent: v.silent, request, id: v["send-id"] });
      print({ ...result, conversationId: owner.id, room });
      return result.state === "sent" ? 0 : 2;
    } else throw new Error(`Unknown command: ${command}. Use talk --help`);
    return 0;
  } finally { ledger.close(); }
}

if (import.meta.main) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : "Talk command failed");
    process.exitCode = error instanceof ConfigurationError || error instanceof TalkError && ["auth", "unsupported"].includes(error.code) ? 78 : 1;
  });
}
