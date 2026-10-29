import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTalkWebhookHandler, NonceCache, talkBotSecret, TALK_WEBHOOK_PATH, verifyTalkSignature } from "./talk-webhook";

const SECRET = "0123456789abcdef".repeat(4);
// Shape of a Talk chat webhook (spreed BotService::afterChatMessageSent)
const BODY = JSON.stringify({
  type: "Create",
  actor: { type: "Person", id: "users/alice", name: "Alice" },
  object: { type: "Note", id: "4720", name: "message", content: JSON.stringify({ message: "@Claudius Grüße", parameters: {} }), mediaType: "text/markdown", threadId: 4711 },
  target: { type: "Collection", id: "abc123xy", name: "Ops" },
});

let counter = 0;
function signed(body: string, secret = SECRET, random = `${"r".repeat(60)}${String(++counter).padStart(4, "0")}`) {
  const signature = createHmac("sha256", secret).update(random + body).digest("hex");
  return { "content-type": "application/json", "x-nextcloud-talk-random": random, "x-nextcloud-talk-signature": signature, "x-nextcloud-talk-backend": "https://cloud.example.com/" };
}

function fixture(secret = SECRET) {
  const delivered: string[] = [];
  const app = new Hono();
  app.post(TALK_WEBHOOK_PATH, createTalkWebhookHandler({
    getSecret: () => secret,
    deliver: (raw) => { delivered.push(new TextDecoder().decode(raw)); return true; },
  }));
  const post = (body: string, headers: Record<string, string>) => app.request(TALK_WEBHOOK_PATH, { method: "POST", headers, body });
  return { delivered, post };
}

describe("verifyTalkSignature", () => {
  const raw = new TextEncoder().encode(BODY);
  const random = "a".repeat(64);
  const sig = createHmac("sha256", SECRET).update(random + BODY).digest("hex");

  test("accepts Talk's HMAC over random + raw body", () => {
    expect(verifyTalkSignature(SECRET, random, sig, raw)).toBe(true);
    expect(verifyTalkSignature(SECRET, random, sig.toUpperCase(), raw)).toBe(true);
  });

  test("rejects other bodies, secrets, randoms and malformed input", () => {
    expect(verifyTalkSignature(SECRET, random, sig, new TextEncoder().encode(BODY + " "))).toBe(false);
    expect(verifyTalkSignature("x".repeat(64), random, sig, raw)).toBe(false);
    expect(verifyTalkSignature(SECRET, "b".repeat(64), sig, raw)).toBe(false);
    expect(verifyTalkSignature(SECRET, "short", createHmac("sha256", SECRET).update("short" + BODY).digest("hex"), raw)).toBe(false);
    expect(verifyTalkSignature(SECRET, random, "zz", raw)).toBe(false);
    expect(verifyTalkSignature(SECRET, random, undefined, raw)).toBe(false);
    expect(verifyTalkSignature("", random, sig, raw)).toBe(false);
  });
});

describe("NonceCache", () => {
  test("accepts a nonce once until it expires", () => {
    const cache = new NonceCache(1000, 10);
    expect(cache.check("n1", 0)).toBe(false);
    expect(cache.check("n1", 500)).toBe(true);
    expect(cache.check("n1", 1500)).toBe(false);
  });

  test("stays bounded", () => {
    const cache = new NonceCache(60_000, 5);
    for (let i = 0; i < 50; i++) cache.check(`n${i}`, i);
    expect(cache.size).toBeLessThanOrEqual(5);
  });
});

describe("POST /api/integrations/talk/webhook", () => {
  test("delivers the original bytes of a verified request", async () => {
    const { delivered, post } = fixture();
    const res = await post(BODY, signed(BODY));
    expect(res.status).toBe(200);
    expect(delivered).toEqual([BODY]);
  });

  test("a re-serialized body no longer verifies", async () => {
    const { delivered, post } = fixture();
    const headers = signed(BODY);
    expect((await post(JSON.stringify(JSON.parse(BODY), null, 2), headers)).status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  test("rejects missing or wrong signatures without delivering", async () => {
    const { delivered, post } = fixture();
    expect((await post(BODY, { "content-type": "application/json" })).status).toBe(401);
    expect((await post(BODY, signed(BODY, "wrong-secret".repeat(4)))).status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  test("rejects a replayed request", async () => {
    const { delivered, post } = fixture();
    const headers = signed(BODY);
    expect((await post(BODY, headers)).status).toBe(200);
    expect((await post(BODY, headers)).status).toBe(409);
    expect(delivered).toHaveLength(1);
  });

  test("refuses when no secret is configured", async () => {
    const { delivered, post } = fixture("");
    expect((await post(BODY, signed(BODY))).status).toBe(503);
    expect(delivered).toHaveLength(0);
  });

  test("rejects oversized bodies before verifying", async () => {
    const { post } = fixture();
    const big = "x".repeat(1_000_001);
    expect((await post(big, signed(big))).status).toBe(413);
  });

  test("reports an unavailable add-on so Talk records the error", async () => {
    const app = new Hono();
    app.post(TALK_WEBHOOK_PATH, createTalkWebhookHandler({ getSecret: () => SECRET, deliver: () => false }));
    const res = await app.request(TALK_WEBHOOK_PATH, { method: "POST", headers: signed(BODY), body: BODY });
    expect(res.status).toBe(503);
  });

  test("is mounted on the legacy app", async () => {
    const { app } = await import("./index");
    // No secret in the test workspace: the route exists and refuses.
    const saved = process.env.TALK_BOT_SECRET;
    delete process.env.TALK_BOT_SECRET;
    const res = await app.request(TALK_WEBHOOK_PATH, { method: "POST", body: BODY });
    if (saved !== undefined) process.env.TALK_BOT_SECRET = saved;
    expect([401, 503]).toContain(res.status);
  });
});

describe("talkBotSecret", () => {
  let home: string;
  const saved = process.env.TALK_BOT_SECRET;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "talk-secret-"));
    delete process.env.TALK_BOT_SECRET;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (saved !== undefined) process.env.TALK_BOT_SECRET = saved;
    else delete process.env.TALK_BOT_SECRET;
  });

  test("reads env first, then talk.secret_file, then ~/secrets/talk-bot-secret", () => {
    expect(talkBotSecret(home)).toBe("");
    mkdirSync(join(home, "secrets"));
    writeFileSync(join(home, "secrets", "talk-bot-secret"), `${SECRET}\n`);
    expect(talkBotSecret(home)).toBe(SECRET);
    writeFileSync(join(home, "other"), "from-config-file\n");
    writeFileSync(join(home, "config.yml"), `talk:\n  secret_file: "${join(home, "other")}"\n`);
    expect(talkBotSecret(home)).toBe("from-config-file");
    process.env.TALK_BOT_SECRET = "from-env";
    expect(talkBotSecret(home)).toBe("from-env");
  });
});
