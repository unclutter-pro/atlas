import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { rmSync } from "node:fs";
import { getLockPath, getSocketPath, sendSocketMessage, trySocketInject, type SocketAck, type SocketMessage } from "./trigger-socket";

describe("runner socket and lock paths", () => {
  test("safe keys keep their readable path", () => {
    expect(getSocketPath("web-chat", "_default")).toBe("/tmp/.trigger-web-chat-_default.sock");
    expect(getLockPath("signal-chat", "491701234567")).toBe("/tmp/.trigger-signal-chat-491701234567.flock");
  });

  test("keys that differ only in replaced characters never share a runner", () => {
    const a = getSocketPath("web-chat", "a-b");
    const b = getSocketPath("web-chat", "a_b");
    const c = getSocketPath("web-chat", "a.b");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(getLockPath("web-chat", "a-b")).not.toBe(getLockPath("web-chat", "a_b"));
  });

  test("long keys are hashed below the unix socket path limit", () => {
    const key = "x".repeat(200);
    expect(getSocketPath("web-chat", key).length).toBeLessThanOrEqual(104);
  });
});

async function withAckServer(
  ack: (message: SocketMessage) => SocketAck | null,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const path = `/tmp/atlas-receipt-${crypto.randomUUID()}.sock`;
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const reply = ack(JSON.parse(input.trim()));
      socket.end(reply ? JSON.stringify(reply) + "\n" : undefined);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  try { await run(path); }
  finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
}

describe("durable socket acknowledgement", () => {
  test("legacy ok still works for legacy input, but cannot confirm durable input", async () => {
    await withAckServer(() => ({ ok: true }), async (path) => {
      expect(await trySocketInject(path, "hello", "internal", "key")).toBe(true);
      expect(await trySocketInject(path, "hello", "internal", "key", undefined, "event-1")).toBe(false);
    });
  });

  test("the acknowledgement must name the delivered ID and a durable state", async () => {
    await withAckServer((message) => ({ ok: true, eventId: message.eventId, state: "accepted" }), async (path) => {
      expect(await trySocketInject(path, "hello", "internal", "key", undefined, "event-1")).toBe(true);
    });
    await withAckServer(() => ({ ok: true, eventId: "other", state: "accepted" }), async (path) => {
      expect(await trySocketInject(path, "hello", "internal", "key", undefined, "event-1")).toBe(false);
    });
  });

  test("a connection closed without an ack is unconfirmed", async () => {
    await withAckServer(() => null, async (path) => {
      expect(await sendSocketMessage(path, { message: "hello", channel: "internal", sessionKey: "key" })).toBeNull();
    });
  });
});
