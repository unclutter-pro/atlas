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

test("relay does not pass a session key, so each event gets its own trigger-runner session", async () => {
  // Regression test: a hard-coded "_default" key here used to funnel every
  // webhook event for a trigger into one shared session. Fast-arriving events
  // then landed as mid-turn socket injections into whichever run was already
  // in progress, and an in-progress turn could ignore them (e.g. the GitHub
  // issue-triage webhook skipping an issue opened while another was handled).
  // trigger-runner.ts generates its own per-run "webhook-<id>" key when no
  // session key argument is passed, so the listener must leave it out.
  const calls: Array<[string, string, string | undefined]> = [];
  const dependencies = {
    getWebhookTriggers: () => [trigger],
    fireTrigger: async (name: string, payload: string, sessionKey?: string) => {
      calls.push([name, payload, sessionKey]);
    },
  };
  const authenticated = { ...event, "X-Webhook-Secret": "secret" };
  await handleSseEvent("test", authenticated, dependencies);
  await handleSseEvent("test", authenticated, dependencies);
  expect(calls).toHaveLength(2);
  expect(calls[0][2]).toBeUndefined();
  expect(calls[1][2]).toBeUndefined();
});
