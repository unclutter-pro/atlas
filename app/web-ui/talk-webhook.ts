/**
 * Nextcloud Talk bot webhook (POST /api/integrations/talk/webhook).
 *
 * Talk signs every webhook with the shared bot secret:
 *   X-Nextcloud-Talk-Signature = hex(HMAC-SHA256(secret, X-Nextcloud-Talk-Random + rawBody))
 * Only verified bodies go on to `talk incoming --stdin` (app/integrations/talk),
 * which filters, stores and fires the talk-chat trigger. The handler answers
 * at once: Talk waits at most 5 s and counts any status but 200/202 as a bot error.
 */

import type { Handler } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { isTestRun } from "./ui-api/shared/env";

export const TALK_WEBHOOK_PATH = "/api/integrations/talk/webhook";
const MAX_BODY_BYTES = 1_000_000;
const TALK_BIN = "/atlas/app/bin/talk";
const TALK_LOG = "/atlas/logs/talk.log";

/** Constant-time check of Talk's webhook signature over the original bytes. */
export function verifyTalkSignature(
  secret: string,
  random: string | undefined,
  signature: string | undefined,
  rawBody: Uint8Array,
): boolean {
  if (!secret || !random || !signature) return false;
  // Talk sends 64 random characters; the bot API itself requires at least 32.
  if (random.length < 32 || random.length > 256 || !/^[a-fA-F0-9]{64}$/.test(signature.trim())) return false;
  const expected = createHmac("sha256", secret).update(random).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.trim().toLowerCase(), "hex"));
}

/**
 * Replay protection: Talk signs without a timestamp, so a captured request
 * would verify forever. Each random value is accepted once while it is
 * remembered; `talk incoming` additionally drops message ids it has stored.
 */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(
    private ttlMs = 60 * 60 * 1000,
    private max = 20_000,
  ) {}

  /** True when the nonce was already used; records it otherwise. */
  check(nonce: string, now = Date.now()): boolean {
    const expires = this.seen.get(nonce);
    if (expires !== undefined && expires > now) return true;
    if (this.seen.size >= this.max) this.prune(now);
    this.seen.set(nonce, now + this.ttlMs);
    return false;
  }

  private prune(now: number) {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    // Still full: drop the oldest entries (Map keeps insertion order).
    for (const k of this.seen.keys()) {
      if (this.seen.size < this.max) break;
      this.seen.delete(k);
    }
  }

  get size() {
    return this.seen.size;
  }
}

/** Bot secret: TALK_BOT_SECRET, else talk.secret_file, else ~/secrets/talk-bot-secret. Empty when unset. */
export function talkBotSecret(home = process.env.HOME!): string {
  const env = process.env.TALK_BOT_SECRET?.trim();
  if (env) return env;
  let file = join(home, "secrets", "talk-bot-secret");
  try {
    const cfg = yaml.load(readFileSync(join(home, "config.yml"), "utf-8")) as { talk?: { secret_file?: string } } | null;
    if (cfg?.talk?.secret_file) file = cfg.talk.secret_file;
  } catch {
    // no or unreadable config.yml: default secret path
  }
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

/** Hand a verified body to `talk incoming --stdin` (fire and forget, output to /atlas/logs/talk.log). */
export function deliverToTalkAddon(rawBody: Uint8Array): boolean {
  if (isTestRun() || !existsSync(TALK_BIN)) return false;
  let fd: number | "ignore" = "ignore";
  try {
    fd = openSync(TALK_LOG, "a");
  } catch {
    // log dir missing outside the container
  }
  try {
    const proc = Bun.spawn([TALK_BIN, "incoming", "--stdin"], { stdin: rawBody, stdout: fd, stderr: fd });
    if (typeof fd === "number") {
      const logFd = fd;
      proc.exited.finally(() => closeSync(logFd));
    }
    return true;
  } catch (err) {
    if (typeof fd === "number") closeSync(fd);
    console.error("[talk] could not start talk incoming:", err);
    return false;
  }
}

export function createTalkWebhookHandler({
  getSecret = () => talkBotSecret(),
  deliver = deliverToTalkAddon,
  nonces = new NonceCache(),
}: {
  getSecret?: () => string;
  deliver?: (rawBody: Uint8Array) => boolean;
  nonces?: NonceCache;
} = {}): Handler {
  return async (c) => {
    const secret = getSecret();
    if (!secret) return c.json({ error: "Talk bot is not configured" }, 503);

    const declared = Number(c.req.header("content-length") || 0);
    if (declared > MAX_BODY_BYTES) return c.json({ error: "Payload too large" }, 413);
    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) return c.json({ error: "Payload too large" }, 413);

    const random = c.req.header("X-Nextcloud-Talk-Random");
    if (!verifyTalkSignature(secret, random, c.req.header("X-Nextcloud-Talk-Signature"), rawBody)) {
      console.warn("[talk] rejected webhook with an invalid signature");
      return c.json({ error: "Invalid signature" }, 401);
    }
    if (nonces.check(random!)) {
      console.warn("[talk] rejected replayed webhook");
      return c.json({ error: "Replayed request" }, 409);
    }

    if (!deliver(rawBody)) return c.json({ error: "Talk add-on unavailable" }, 503);
    return c.json({ ok: true });
  };
}
