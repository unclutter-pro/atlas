import { describe, expect, test } from "bun:test";
import { getLockPath, getSocketPath } from "./trigger-socket";

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
