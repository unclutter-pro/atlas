import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkLedger } from "../../triggers/talk/ledger.ts";
import { queueHandoffs } from "../../triggers/talk/handoff.ts";
import { parseTalkConfig } from "./config.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "talk-cli-"));
  closes.push(() => rmSync(home, { recursive: true, force: true }));
  const rooms = new Map<string, any>([["group", { token: "group", type: 2, name: "Team", displayName: "Team" }]]);
  const sent: any[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url), body = request.method === "POST" ? await request.json() as any : {};
    const ocs = (data: unknown, status = 200) => Response.json({ ocs: { meta: { status: "ok", statuscode: status }, data } }, { status });
    if (url.pathname.endsWith("/cloud/capabilities")) return ocs({ capabilities: { spreed: { features: ["conversation-v4", "chat-v2", "chat-replies", "chat-get-context", "threads"], config: { chat: { "max-length": 32000 } } } } });
    if (url.pathname.endsWith("/v4/room")) {
      if (request.method === "GET") return ocs([...rooms.values()]);
      const room = { token: `dm${body.invite}`, type: 1, name: body.invite, displayName: body.invite };
      rooms.set(room.token, room); return ocs(room, 201);
    }
    const path = url.pathname.match(/\/chat\/(\w+)(?:\/(\d+)\/context)?$/);
    if (path && request.method === "POST") {
      const id = sent.length + 1, parent = sent.find(m => m.id === body.replyTo);
      const threadId = body.threadTitle ? id : parent ? parent.threadId : body.threadId ?? null;
      const message = { id, token: path[1], actorType: "users", actorId: "atlas", actorDisplayName: "Atlas", timestamp: Math.floor(Date.now() / 1000),
        message: body.message, messageParameters: {}, referenceId: body.referenceId, threadId: threadId ?? id, isThread: !!threadId,
        parent: parent ?? undefined };
      sent.push(message); return ocs(message, 201);
    }
    if (path?.[2]) return ocs(sent.filter(m => m.token === path[1]));
    if (path) return ocs(sent.filter(m => m.token === path[1]));
    return new Response("Not found", { status: 404 });
  } });
  closes.push(() => server.stop(true));
  const raw = { talk: { url: server.url.origin, username: "atlas", allow_insecure_http: true } };
  const env = { ...process.env, HOME: home, TALK_URL: server.url.origin, TALK_USERNAME: "atlas", TALK_APP_PASSWORD: "fake-test-app-password", ATLAS_TRIGGER: "", ATLAS_TRIGGER_SESSION_KEY: "" };
  writeFileSync(join(home, "config.yml"), JSON.stringify(raw));
  const config = parseTalkConfig(raw, { env, home });
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code, json: () => JSON.parse(out) };
  };
  return { home, config, sent, cli };
}

test("CLI setup, proactive DM question and repeat send keep the private owner and original task", async () => {
  const f = fixture();
  expect((await f.cli(["setup"])).code).toBe(0);
  expect(readFileSync(join(f.home, "supervisor.d/talk.conf"), "utf8")).toContain("exitcodes=0,78");
  const db = new Database(join(f.home, ".index/atlas.db")); closes.push(() => db.close());
  db.query("INSERT INTO triggers(name,type,channel,prompt,session_mode) VALUES ('github-worker','manual','github','{{payload}}','persistent')").run();
  db.query("INSERT INTO tasks(id,title,trigger_name,session_key) VALUES (42,'Release','github-worker','repo-42')").run();
  const args = ["dm", "--user", "max", "--task", "42", "--message", "Which release date?", "--send-id", "release-question"];
  const scope = { ATLAS_TRIGGER: "github-worker", ATLAS_TRIGGER_SESSION_KEY: "repo-42" };
  const first = await f.cli(args, scope);
  expect({ code: first.code, err: first.err }).toEqual({ code: 0, err: "" });
  const retry = await f.cli(args, scope);
  expect({ code: retry.code, err: retry.err }).toEqual({ code: 0, err: "" });
  expect(retry.json()).toEqual(first.json()); expect(f.sent).toHaveLength(1);
  const ledger = new TalkLedger(join(f.home, ".index/talk/talk.db")); closes.push(() => ledger.close());
  const request = ledger.getQuestion(first.json().requestId)!;
  expect(request).toMatchObject({ state: "pending", originTrigger: "github-worker", originSessionKey: "repo-42", taskId: 42, expectedUser: "max" });
  expect(ledger.getConversation(first.json().conversationId)?.triggerName).toBe("talk-worker");
  expect((await f.cli(["can-pause"], scope)).code).toBe(0);
  db.query("INSERT INTO tasks(id,title,trigger_name,session_key) VALUES (43,'Unrelated work','github-worker','repo-42')").run();
  expect((await f.cli(["can-pause"], scope)).code).toBe(1);
});

test("standalone send retries reuse the original owner; changed content is rejected", async () => {
  const f = fixture(), args = ["send", "--room", "group", "--message", "Ready", "--send-id", "ready"];
  const first = await f.cli(args), second = await f.cli(args);
  expect([first.code, second.code]).toEqual([0, 0]); expect(second.json()).toEqual(first.json());
  const changed = await f.cli(["send", "--room", "group", "--message", "Changed", "--send-id", "ready"]);
  expect(changed.code).toBe(1); expect(f.sent).toHaveLength(1);
});

test("independent native-thread handoff queues exactly once after confirmation and retains source tasks", async () => {
  const f = fixture(); await f.cli(["setup"]);
  const handoff = join(f.home, "handoff.txt"); writeFileSync(handoff, "Investigate latency independently; read memory/projects/service.md; report measurements.");
  const sent = await f.cli(["send", "--room", "group", "--new-thread", "Latency", "--new-conversation", "--handoff-file", handoff, "--message", "Investigating latency."]);
  expect({ code: sent.code, err: sent.err }).toEqual({ code: 0, err: "" });
  const ledger = new TalkLedger(join(f.home, ".index/talk/talk.db")); closes.push(() => ledger.close());
  expect(queueHandoffs(ledger, f.config.instance)).toBe(1);
  expect(queueHandoffs(ledger, f.config.instance)).toBe(0);
  const delivery = ledger.deliveries()[0]!;
  expect(JSON.parse(delivery.payload)).toMatchObject({ type: "talk_handoff", address: { room: "group", threadId: 1 }, openingMessageId: 1 });
  expect(delivery.sessionKey).toBe(sent.json().conversationId);
});

test("CLI resolves a quote's real thread and rejects conflicting destinations before sending", async () => {
  const f = fixture();
  expect((await f.cli(["send", "--room", "group", "--new-thread", "Topic", "--message", "Start"])).code).toBe(0);
  const reply = await f.cli(["send", "--room", "group", "--reply-to", "1", "--message", "Reply"]);
  expect({ code: reply.code, err: reply.err }).toEqual({ code: 0, err: "" });
  expect(f.sent[1].threadId).toBe(1);
  const conflict = await f.cli(["send", "--room", "group", "--thread", "99", "--reply-to", "1", "--message", "Wrong"]);
  expect(conflict.code).toBe(1); expect(f.sent).toHaveLength(2);
});

test("an uncached quote can load context without consuming an unread neighboring message", async () => {
  const f = fixture();
  f.sent.push({ id: 50, token: "group", actorType: "users", actorId: "max", message: "Quote this", timestamp: 1 },
    { id: 51, token: "group", actorType: "users", actorId: "max", message: "@atlas unread", timestamp: 2 });
  const reply = await f.cli(["send", "--room", "group", "--reply-to", "50", "--message", "Response"]);
  expect({ code: reply.code, err: reply.err }).toEqual({ code: 0, err: "" });
  const ledger = new TalkLedger(join(f.home, ".index/talk/talk.db")); closes.push(() => ledger.close());
  expect(ledger.readMessage(f.config.instance, "group", 51)?.text).toBe("@atlas unread");
  expect(ledger.db.query("SELECT 1 FROM talk_events WHERE message_id=51").get()).toBeNull();
});

test("missing credential files stop supervisor retries with configuration exit code", async () => {
  const f = fixture();
  const result = await f.cli(["listen"], { TALK_APP_PASSWORD: "", TALK_PASSWORD_FILE: join(f.home, "missing-password") });
  expect(result.code).toBe(78);
  expect(result.err).toContain("password");
});
