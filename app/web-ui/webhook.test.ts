import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { createWebhookHandler } from "./webhook";

function fixture(enabled = 1) {
  const fired: string[] = [];
  const app = new Hono();
  app.post("/api/webhook/:name", createWebhookHandler({
    getTrigger: name => name === "github" ? { name, enabled, webhook_secret: "secret" } : undefined,
    fireTrigger: (_name, payload) => { fired.push(payload); },
  }));
  return { app, fired };
}

test("direct GitHub webhook authenticates original bytes and still parses payload", async () => {
  const { app, fired } = fixture();
  const body = '{ "ref": "refs/heads/main", "text": "Grüße" }\n';
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  const headers = { "content-type": "application/json", "x-hub-signature-256": signature };
  expect((await app.request("/api/webhook/github", { method: "POST", headers, body })).status).toBe(200);
  expect(JSON.parse(fired[0]).text).toBe("Grüße");
  expect((await app.request("/api/webhook/github", { method: "POST", headers, body: JSON.stringify(JSON.parse(body)) })).status).toBe(401);
  expect(fired).toHaveLength(1);
});

test("shared-secret text/form payloads remain readable after authentication", async () => {
  const { app, fired } = fixture();
  for (const [contentType, body] of [["text/plain", "hello"], ["application/x-www-form-urlencoded", "message=hello"]]) {
    const response = await app.request("/api/webhook/github", {
      method: "POST", headers: { "content-type": contentType, "x-webhook-secret": "secret" }, body,
    });
    expect(response.status).toBe(200);
  }
  expect(fired[0]).toBe("hello");
  expect(JSON.parse(fired[1]).message).toBe("hello");
});

test("missing, disabled and unauthenticated triggers never fire", async () => {
  const active = fixture();
  expect((await active.app.request("/api/webhook/missing", { method: "POST" })).status).toBe(404);
  expect((await active.app.request("/api/webhook/github", { method: "POST" })).status).toBe(401);
  const disabled = fixture(0);
  expect((await disabled.app.request("/api/webhook/github", { method: "POST" })).status).toBe(403);
  expect(active.fired).toHaveLength(0);
  expect(disabled.fired).toHaveLength(0);
});

test("github channel triggers get the {body, headers} envelope; others keep the bare body", async () => {
  const fired: { name: string; payload: string }[] = [];
  const app = new Hono();
  app.post("/api/webhook/:name", createWebhookHandler({
    getTrigger: (name) => ({ name, enabled: 1, webhook_secret: "secret", channel: name === "github" ? "github" : "internal" }),
    fireTrigger: (name, payload) => { fired.push({ name, payload }); },
  }));
  const body = JSON.stringify({ action: "opened", issue: { number: 42 } });
  const headers = {
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
    "x-github-event": "issues",
    "x-github-delivery": "d-1",
  };
  for (const name of ["github", "deploy-hook"]) {
    expect((await app.request(`/api/webhook/${name}`, { method: "POST", headers, body })).status).toBe(200);
  }
  const envelope = JSON.parse(fired[0]!.payload);
  expect(envelope.body).toEqual({ action: "opened", issue: { number: 42 } });
  expect(envelope.headers).toEqual({ "x-github-event": "issues", "x-github-delivery": "d-1" });
  expect(JSON.parse(fired[1]!.payload)).toEqual({ action: "opened", issue: { number: 42 } });
});
