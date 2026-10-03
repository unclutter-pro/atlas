# Triggers

Triggers are autonomous agent sessions that process events independently. Each trigger spawns its own Claude session, acts as a project manager, and delegates complex work to subagents via `Agent(...)`.

## Architecture

```
Event arrives (cron / webhook / manual)
         │
         ▼
┌─────────────────────────────┐
│  trigger.sh <trigger-name>  │
│  Spawns own Claude session  │
│  (PM role, MCP access)      │
└──────────┬──────────────────┘
           │
     ┌─────┴──────┐
     │  Can handle │
     │  itself?    │
     └─────┬──────┘
       Yes │        No
       ┌───┘        └───┐
       ▼                ▼
┌──────────────┐  ┌──────────────────────────────────────┐
│ Respond      │  │ Agent(subagent_type=..., model=...,   │
│ directly     │  │   prompt="<self-contained task>")     │
│ (CLI tools,  │  │ → trigger reviews result before relay │
│  MCP action) │  │                                       │
└──────────────┘  └──────────────────────────────────────┘
```

### Session Types

| | Trigger Session |
|---|---|
| **Role** | Project manager, user communication, task delegation |
| **System prompt** | SOUL + IDENTITY + trigger-system-prompt + channel prompt |
| **MCP tools** | — |
| **Spawned by** | `trigger.sh` per event |
| **Session persistence** | Configurable per trigger (ephemeral or persistent) |

Subagents are spawned by the trigger session via `Agent(subagent_type=..., model=..., prompt=...)`. They are stateless workers that receive all needed context via the prompt.

### Session Modes

Each trigger has a configurable `session_mode`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `ephemeral` | New session per run, discarded after | Cron jobs, one-off webhooks |
| `persistent` | Resume session based on session key | Signal channel, email thread, ongoing context |

Persistent sessions have no hard timeout and can run for hours. Stale sessions (no activity for 30+ minutes) are automatically killed and resumed with a `<system-notice>` when the next message arrives. See [watcher.md](watcher.md) for the full session state machine.

### Session Key

Persistent triggers use a **session key** to determine which session to resume. The key is passed as the 3rd argument to `trigger.sh`:

```bash
trigger.sh <trigger-name> [payload] [session-key]
```

The `(trigger_name, session_key)` pair maps to a session ID in the `trigger_sessions` table. This means one trigger can manage many independent sessions:

| Trigger | Session Key | Effect |
|---------|-------------|--------|
| `email-handler` | `thread-4821` | Resumes the session for that email thread |
| `email-handler` | `thread-9944` | Different session for a different thread |
| `signal-chat` | `+49170123456` | Per-contact conversation session |
| `deploy-hook` | `repo-myapp` | Per-repository deployment context |
| `daily-standup` | *(none)* | `_default` key — one global session |

If no session key is provided, it defaults to `_default` (one session per trigger).

## Trigger Types

### Cron

Scheduled execution via supercronic. Uses standard cron syntax.

| Schedule | Meaning |
|----------|---------|
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * 1-5` | Weekdays at 9:00 |
| `0 6 * * *` | Daily at 6:00 |
| `0 8 * * 1` | Mondays at 8:00 |

Typically `ephemeral` — each run is independent.

The crontab at `workspace/crontab` is auto-generated from the triggers database. Static entries (like the daily cleanup) are preserved above the `AUTO-GENERATED` marker. Manage cron triggers via the web-ui or MCP tools.

### Webhook

HTTP endpoints that accept POST requests:

```
POST /api/webhook/<trigger-name>
```

The request payload is injected into the prompt template via `{{payload}}`. Optional authentication via `X-Webhook-Secret` header.

Typically `ephemeral` per event, but can be `persistent` if webhook events relate to an ongoing conversation.

### Manual

On-demand triggers. Fire via the web-ui "Run" button or by asking Claude.

## Creating Triggers

### Via Web-UI

1. Open **Automations** (`/automations`)
2. Click **New trigger** (`/automations?create=1`)
3. Fill in the form:
   - **Name:** Lowercase slug (e.g. `github-check`)
   - **Type:** Cron, Webhook, or Manual
   - **Schedule:** Numeric 5-field cron expression (for cron triggers; names and `@daily`-style macros are rejected because the crontab sync drops them). The form previews the next runs.
   - **Session Mode:** `ephemeral` (default) or `persistent`
   - **Webhook Secret:** Optional auth token (for webhooks)
   - **Channel:** Inbox channel for generated messages (default: `internal`)
   - **Prompt:** What the trigger session should do. Use `{{payload}}` for webhook data.
4. Click **Create trigger**

Each trigger has its own page (`/automations/<name>`) with its prompt, schedule, webhook URL, run history and cost, plus Edit, Enable/Disable, Run now and Delete.

### Via MCP

```json
{
  "name": "github-issues",
  "type": "cron",
  "schedule": "0 * * * *",
  "session_mode": "ephemeral",
  "description": "Hourly GitHub issue check",
  "prompt": "Check GitHub repos for new issues. If there are critical issues, delegate via Agent to investigate and respond."
}
```

### Via CLI (inside the container)

```bash
bun /atlas/app/triggers/manage.ts create --name=my-trigger --type=manual \
  --session-mode=ephemeral --description="Test trigger"
# The prompt lives in ~/triggers/my-trigger/prompt.md
```

## Webhook Integration

### Setup

1. Create a webhook trigger (via web-ui or MCP):
   - Name: `github-push`
   - Type: Webhook
   - Secret: `my-secret-token` (optional)
   - Prompt: `A push event was received:\n\n{{payload}}\n\nSummarize the changes.`

2. Configure the external service to POST to your Atlas instance:
   ```
   URL:    https://your-atlas-host:8080/api/webhook/github-push
   Secret: my-secret-token  (as X-Webhook-Secret header)
   ```

### Request Format

Webhooks accept any content type:

**JSON:**
```bash
curl -X POST http://localhost:8080/api/webhook/github-push \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"ref": "refs/heads/main", "commits": [{"message": "fix: resolve login bug"}]}'
```

**Form data:**
```bash
curl -X POST http://localhost:8080/api/webhook/contact-form \
  -H "X-Webhook-Secret: my-secret-token" \
  -d "name=Alice&email=alice@example.com&message=Hello"
```

**Plain text:**
```bash
curl -X POST http://localhost:8080/api/webhook/alert \
  -H "X-Webhook-Secret: my-secret-token" \
  -d "Server CPU at 95%"
```

### Response

```json
{ "ok": true, "trigger": "github-push", "message": "Trigger session started" }
```

### Authentication

If `webhook_secret` is set, the webhook validates the `X-Webhook-Secret` header (or `?secret=` query parameter). Requests without a matching secret are rejected with 401.

If no secret is configured, the webhook accepts all requests.

### Payload in Prompts

The `{{payload}}` placeholder is replaced with the request body:

| Content-Type | Payload Format |
|-------------|----------------|
| `application/json` | Pretty-printed JSON |
| `application/x-www-form-urlencoded` | JSON of parsed form fields |
| Anything else | Raw text body |

## Work Delegation

Trigger sessions act as project managers. The delegation flow from `trigger-system-prompt.md`:

### Quick tasks (online research, simple fix)
```
Agent(subagent_type="general-purpose", model="haiku", prompt="<task>")
```

### Medium tasks (feature, bug fix, complex research)
```
Agent(subagent_type="general-purpose", model="sonnet", prompt="<detailed task>")
```

### Complex multi-step tasks
```
# Plan tasks with `task add`, then spawn subagents for each unit of work:
Agent(subagent_type="general-purpose", model="sonnet", prompt="<self-contained task with acceptance criteria>")
# Optional review pass:
Agent(subagent_type="general-purpose", model="haiku", prompt="<review task>")
# Review results yourself before relaying to the user
```

See `app/prompts/trigger-system-prompt.md` for the full delegation guidelines.

## Integration Examples

### GitHub Webhooks (Filter + Delegate)

```
Name:           github-push
Type:           Webhook
Session Mode:   ephemeral
Secret:         (generate one)
Prompt:         A push event was received:

                {{payload}}

                Analyze the commits. If there are only docs changes, just log it.
                If there are code changes, delegate a code review via Agent.
```

### Signal Channel (Persistent Session)

```
Name:           signal-alice
Type:           Webhook
Session Mode:   persistent
Channel:        signal
Prompt:         New message from Signal:

                {{payload}}

                Respond conversationally. If the message requests a complex task
                (code changes, research report, etc.), delegate via Agent.
```

### Daily Standup (Ephemeral Cron)

```
Name:           standup-reminder
Type:           Cron
Schedule:       0 9 * * 1-5
Session Mode:   ephemeral
Prompt:         Prepare a standup summary by reading recent journal entries and memory.
                If there are pending items that need attention, delegate via Agent.
```

### Health Check (Ephemeral Cron)

```
Name:           health-check
Type:           Cron
Schedule:       */30 * * * *
Session Mode:   ephemeral
Prompt:         Run a system health check (disk, memory, services).
                Only delegate a task if something needs attention.
                Otherwise, silently succeed.
```

## Built-in Triggers

### Dreaming (Cron)

Nightly cognitive consolidation — inspired by how memory consolidation works during sleep. Runs a multi-phase process:

1. **Session Replay** — Extracts the last 24h of agent sessions with the `sessions` tool and hands each to a `session-analyzer` subagent (haiku, in parallel) for extraction
2. **Synthesis** — The consolidation session itself works out what the day *meant*: patterns across sessions and across days, user corrections, second-order consequences, open loops
3. **Writing** — Journal entry (mandatory), then folding new knowledge into memory; the agent chooses the form, extends existing files over creating near-duplicates, and appends dated lines to playbooks rather than rewriting them
4. **Reconciliation** — Verifies memory against external reality and supersedes outdated facts (`invalidated`, `superseded_by`) instead of overwriting them
5. **Hygiene** — Index size, contradictions, broken wikilinks, redundancy, staleness, frontmatter
6. **Skill Creation** — Can create skills from tool-specific patterns seen at least twice

- **Schedule:** `0 3 * * *` (daily at 03:00)
- **Session Mode:** ephemeral
- **Model:** `model_key='dreaming'` → `models.dreaming` (opus by default). The nightly synthesis is where reasoning depth pays off, and it runs offline once a day with no user waiting.
- **Default prompt:** `app/defaults/triggers/dreaming/prompt.md`
- **Session extractor:** `sessions` (`app/triggers/sessions.ts`)

The workspace copy at `workspace/triggers/dreaming/prompt.md` is user-customizable. On upgrade, `init.sh` refreshes it only when it is byte-identical to the default previously shipped (tracked in `.prompt.shipped.md`); customized prompts are left untouched and the new default is logged instead.

The session extractor reads sessions through the configured backend's session store (`HarnessSessionStore`, see [harness-interface.md](harness-interface.md#session-storage)), drops system messages and tool results, and produces a condensed conversation summary within a configurable token budget:

```bash
sessions --hours 24 --max-tokens 30000                      # extract for consolidation
sessions --hours 24 --list --exclude-trigger dreaming       # index; last column is the session reference
sessions --session <session>                                # one session, or <session>/<agent> for a nested agent
sessions --prune-days 14                                    # retention (daily-cleanup)
```

`--session` also accepts a transcript path, for dreaming prompts written against the earlier extractor.

## Managing Triggers

### Web-UI

**Automations** (`/automations`) provides full CRUD:
- **List** triggers grouped into Scheduled, Webhooks and Manual, with next run, last outcome, run count and 7-day cost
- **Toggle** enable/disable inline
- **Run** any enabled trigger manually (even cron triggers; refused while Atlas is paused)
- **Edit** description, schedule, prompt, secret, channel, session mode, model
- **Delete** with confirmation
- **Reminders** tab (`/automations?view=reminders`): pending reminders with Cancel, then history

Every run links to its detail page in **Activity** (`/activity/<run id>`).

### MCP Tools

| Tool | Description |
|------|-------------|
| `trigger_list` | List all triggers (optional filter by type) |
| `trigger_create` | Create with name, type, schedule, prompt, session_mode, secret |
| `trigger_update` | Update fields by name |
| `trigger_delete` | Delete by name |

### Prompt Fallback

If a trigger's `prompt` field is empty, `trigger.sh` looks for:
```
workspace/triggers/<trigger-name>/prompt.md
```

## Crontab Sync

When cron triggers are created, updated, or deleted, the crontab is automatically regenerated:

1. Static entries (above `AUTO-GENERATED` marker) are preserved
2. All enabled cron triggers from the database are appended
3. supercronic detects the file change and reloads

## How It All Connects

```
                           ┌─────────────┐
                           │  supercronic │
                           │  (crontab)   │
                           └──────┬──────┘
                                  │ schedule fires
                                  ▼
┌───────────┐         ┌──────────────────┐         ┌──────────────┐
│ External   │  POST   │    Web-UI        │  button  │  Claude      │
│ Service    │────────▸│  /api/webhook/   │◂────────│  MCP: trigger│
└───────────┘         │  Automations     │         │  _create     │
                      │  "Run now"       │         └──────────────┘
                      └────────┬─────────┘
                               │
                               ▼
                    ┌────────────────────┐
                    │ trigger.sh <name>  │
                    │ Spawns trigger     │
                    │ Claude session     │
                    │ (PM role + MCPs)   │
                    └────────┬───────────┘
                             │
                   ┌─────────┴─────────┐
                   │                   │
              Handles it          Delegates via
              directly            Agent(...)
                   │                   │
                   ▼                   ▼
              ┌─────────┐    ┌────────────────────┐
              │  Done   │    │ Subagents on       │
              └─────────┘    │ focused tasks      │
                             │ (stateless)        │
                             └────────────────────┘
```
