import { expect, test } from "bun:test";
import { handleSseEvent } from "./webhook-sse-listener";

const trigger = { name: "test", webhook_channel: "channel", webhook_secret: "secret", enabled: 1, session_mode: "ephemeral" };
const event = { body: { ref: "refs/heads/main" }, query: {}, timestamp: 1 };

test("relay rejects missing/wrong secrets and signed events without raw bytes before firing", async () => {
  let fires = 0;
  const dependencies = { getWebhookTriggers: () => [trigger], fireTrigger: async () => { fires++; } };
  await handleSseEvent("test", event, dependencies);
  await handleSseEvent("test", { ...event, "x-webhook-secret": "wrong" }, dependencies);
  await handleSseEvent("test", { ...event, "x-webhook-secret": "secret", "x-hub-signature-256": "sha256=" + "a".repeat(64) }, dependencies);
  expect(fires).toBe(0);
});

test("relay passes an authenticated payload once and uses current policy on every event", async () => {
  const calls: string[] = [];
  let rows = [trigger];
  const dependencies = {
    getWebhookTriggers: () => rows,
    fireTrigger: async (_name: string, payload: string) => { calls.push(payload); },
  };
  const authenticated = { ...event, "X-Webhook-Secret": "secret" };
  await handleSseEvent("test", authenticated, dependencies);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]).body.ref).toBe("refs/heads/main");
  expect(JSON.parse(calls[0]).headers["x-webhook-secret"]).toBeUndefined();
  rows = [{ ...trigger, webhook_secret: "rotated" }];
  await handleSseEvent("test", authenticated, dependencies);
  rows = []; // Disabled/deleted triggers no longer appear in the query.
  await handleSseEvent("test", authenticated, dependencies);
  expect(calls).toHaveLength(1);
});
