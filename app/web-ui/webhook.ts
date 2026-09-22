import type { Handler } from "hono";
import { authenticateWebhook } from "../lib/webhook-auth";

type WebhookTrigger = { name: string; enabled: number; webhook_secret: string | null };

export function createWebhookHandler({ getTrigger, fireTrigger }: {
  getTrigger: (name: string) => WebhookTrigger | undefined;
  fireTrigger: (name: string, payload: string) => void;
}): Handler {
  return async (c) => {
    const name = c.req.param("name")!;
    const t = getTrigger(name);
    if (!t) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    if (!t.enabled) {
      return c.json({ error: "Webhook disabled" }, 403);
    }

    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    if (!authenticateWebhook(t.webhook_secret, {
      header: c.req.header("X-Webhook-Secret"),
      query: c.req.query("secret"), // Legacy direct endpoint compatibility.
      githubSignature: c.req.header("X-Hub-Signature-256"),
      rawBody,
    })) {
      return c.json({ error: "Invalid secret or signature" }, 401);
    }

    // Read payload
    let payload = "";
    try {
      const ct = c.req.header("content-type") || "";
      if (ct.includes("application/json")) {
        payload = JSON.stringify(await c.req.json(), null, 2);
      } else if (ct.includes("form")) {
        payload = JSON.stringify(await c.req.parseBody(), null, 2);
      } else {
        payload = await c.req.text();
      }
    } catch {
      payload = "(could not parse payload)";
    }

    // Fire through trigger.sh for consistent behavior (session_mode, prompts, IPC)
    fireTrigger(t.name, payload);

    return c.json({
      ok: true,
      trigger: name,
      message: "Webhook received, Claude will process it",
    });
  };
}
