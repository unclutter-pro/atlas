# Usage Reporting

Atlas can report session metrics to an external webhook after each session completes. This enables billing based on actual work hours, monitoring agent utilization, and integrating with external dashboards.

## Configuration

Add the `usage_reporting` section to your `config.yml`:

```yaml
usage_reporting:
  enabled: true
  webhook_url: "https://app.example.org/api/usage"  # Required: POST endpoint
  webhook_secret: "your-shared-secret"               # Optional: sent as X-Webhook-Secret header
  include_tokens: false                               # Optional: include token/cost breakdown
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Enable/disable usage reporting |
| `webhook_url` | string | `""` | POST endpoint that receives session metrics |
| `webhook_secret` | string | `""` | Shared secret sent via `X-Webhook-Secret` header for authentication |
| `include_tokens` | bool | `false` | Include token counts and cost in the payload |

## Webhook Payload

After each session completes, Atlas sends a `POST` request to the configured endpoint.

### Base Payload

```json
{
  "event": "session.completed",
  "session_id": "abc123",
  "trigger_name": "signal-chat",
  "started_at": "2026-03-12T08:00:00.000Z",
  "ended_at": "2026-03-12T08:15:30.000Z",
  "duration_ms": 930000,
  "duration_seconds": 930,
  "num_turns": 12,
  "is_error": false,
  "timestamp": "2026-03-12T08:15:31.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Always `"session.completed"` |
| `session_id` | string | Unique identifier for the session |
| `trigger_name` | string | Name of the trigger that started the session |
| `started_at` | string | ISO 8601 timestamp when the session started |
| `ended_at` | string | ISO 8601 timestamp when the session ended |
| `duration_ms` | number | Session duration in milliseconds |
| `duration_seconds` | number | Session duration in seconds (rounded) |
| `num_turns` | number | Number of conversation turns in the session |
| `is_error` | bool | Whether the session ended with an error |
| `timestamp` | string | ISO 8601 timestamp of when the webhook was sent |

### Extended Payload (include_tokens: true)

When `include_tokens` is enabled, additional fields are included:

```json
{
  "...base fields...",
  "input_tokens": 15000,
  "output_tokens": 8500,
  "cache_read_tokens": 12000,
  "cache_creation_tokens": 3000,
  "cost_usd": 0.42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `input_tokens` | number | Total input tokens consumed |
| `output_tokens` | number | Total output tokens generated |
| `cache_read_tokens` | number | Tokens read from prompt cache |
| `cache_creation_tokens` | number | Tokens written to prompt cache |
| `cost_usd` | number | Estimated session cost in USD |

## Authentication

If `webhook_secret` is configured, Atlas includes it as a header:

```
X-Webhook-Secret: your-shared-secret
```

Your endpoint should validate this header to ensure requests originate from Atlas.

## Behavior

- **Fire-and-forget**: The webhook is sent asynchronously with a 10-second timeout. It never blocks session teardown.
- **Error handling**: Failed requests are logged but do not affect session flow.
- **Timing**: The webhook fires after the session fully completes (all hooks finished, metrics recorded).
- **Scope**: Reports on trigger sessions only (the main Claude sessions, not agent teammates).

## Example: Receiving Webhooks

A minimal endpoint to receive and log usage data:

```typescript
app.post("/api/usage", async (req) => {
  const secret = req.headers.get("X-Webhook-Secret");
  if (secret !== process.env.WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const data = await req.json();
  console.log(`Session ${data.session_id}: ${data.duration_seconds}s via ${data.trigger_name}`);

  // Store for billing, dashboards, etc.
  await db.insert(sessionMetrics).values({
    sessionId: data.session_id,
    triggerName: data.trigger_name,
    durationSeconds: data.duration_seconds,
    startedAt: new Date(data.started_at),
    endedAt: new Date(data.ended_at),
  });

  return new Response("OK");
});
```
