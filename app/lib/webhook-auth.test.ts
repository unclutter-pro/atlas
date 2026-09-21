import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { authenticateWebhook } from "./webhook-auth";

const secret = "test-secret";
const rawBody = new TextEncoder().encode('{ "ref": "refs/heads/main" }\n');
const githubSignature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

test("shared-secret policy rejects missing/wrong credentials and accepts header or legacy query", () => {
  expect(authenticateWebhook(secret, {})).toBe(false);
  expect(authenticateWebhook(secret, { header: "wrong" })).toBe(false);
  expect(authenticateWebhook(secret, { header: secret })).toBe(true);
  expect(authenticateWebhook(secret, { query: secret })).toBe(true);
  expect(authenticateWebhook(secret, { header: "wrong", query: secret })).toBe(false);
  expect(authenticateWebhook(null, {})).toBe(true);
});

test("GitHub requires a valid SHA256 signature over unchanged request bytes", () => {
  expect(authenticateWebhook(secret, { rawBody, githubSignature })).toBe(true);
  const reformatted = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(rawBody))));
  expect(authenticateWebhook(secret, { rawBody: reformatted, githubSignature })).toBe(false);
  expect(authenticateWebhook(secret, { rawBody, githubSignature: "sha256=abc" })).toBe(false);
  expect(authenticateWebhook(secret, { rawBody, githubSignature, header: "wrong" })).toBe(true);
});

test("a parsed SSE body cannot authenticate a GitHub signature, even with a secret header", () => {
  expect(authenticateWebhook(secret, { githubSignature })).toBe(false);
  expect(authenticateWebhook(secret, { githubSignature, header: secret })).toBe(false);
});
