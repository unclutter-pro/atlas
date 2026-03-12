# External Configuration Interfaces

Atlas can be fully configured from outside via three complementary mechanisms:

1. **Environment Variables** — Set at container startup (docker-compose, Kubernetes, etc.)
2. **REST API** — Runtime configuration via HTTP endpoints
3. **File Injection** — Pre-populate data via Docker volume mounts

## Configuration Resolution Order

Values are resolved with the following priority (highest wins):

```
ENV variables  >  Runtime config  >  config.yml  >  Built-in defaults
```

- **ENV variables**: `ATLAS_*` prefixed, set in docker-compose or orchestrator
- **Runtime config**: `$HOME/.atlas-runtime-config.json`, set via API
- **config.yml**: `$HOME/config.yml`, edited manually or via web UI
- **Defaults**: Built into the Atlas image

---

## Environment Variables

All config.yml values can be overridden via `ATLAS_*` environment variables.

### Core

| Variable | config.yml path | Default | Description |
|---|---|---|---|
| `ATLAS_AGENT_NAME` | `agent.name` | `"Atlas"` | Agent display name. Alias: `AGENT_NAME` |
| `ATLAS_AGENT_EMAIL` | `agent.email` | `""` | Agent email address |
| `ATLAS_API_KEY` | — | `""` | API key to protect `/api/v1/*` endpoints |
| `ANTHROPIC_API_KEY` | — | — | Claude API key (alternative to OAuth) |

### Models

| Variable | config.yml path | Default |
|---|---|---|
| `ATLAS_MODEL_TRIGGER` | `models.trigger` | `"opus"` |
| `ATLAS_MODEL_CRON` | `models.cron` | `"sonnet"` |
| `ATLAS_MODEL_SUBAGENT_REVIEW` | `models.subagent_review` | `"sonnet"` |
| `ATLAS_MODEL_HOOKS` | `models.hooks` | `"haiku"` |

### Signal Integration

| Variable | config.yml path | Default |
|---|---|---|
| `ATLAS_SIGNAL_NUMBER` | `signal.number` | `""` |
| `ATLAS_SIGNAL_HISTORY_TURNS` | `signal.history_turns` | `20` |
| `ATLAS_SIGNAL_WHITELIST` | `signal.whitelist` | `[]` (comma-separated) |

### Email Integration

| Variable | config.yml path | Default |
|---|---|---|
| `ATLAS_EMAIL_IMAP_HOST` | `email.imap_host` | `""` |
| `ATLAS_EMAIL_IMAP_PORT` | `email.imap_port` | `993` |
| `ATLAS_EMAIL_SMTP_HOST` | `email.smtp_host` | `""` |
| `ATLAS_EMAIL_SMTP_PORT` | `email.smtp_port` | `587` |
| `ATLAS_EMAIL_USERNAME` | `email.username` | `""` |
| `ATLAS_EMAIL_PASSWORD_FILE` | `email.password_file` | `"$HOME/secrets/email-password"` |
| `ATLAS_EMAIL_WHITELIST` | `email.whitelist` | `[]` (comma-separated) |
| `ATLAS_EMAIL_MARK_READ` | `email.mark_read` | `true` |

### Other

| Variable | config.yml path | Default |
|---|---|---|
| `ATLAS_STT_ENABLED` | `stt.enabled` | `true` |
| `ATLAS_STT_URL` | `stt.url` | `"http://stt:5092/..."` |
| `ATLAS_WEBHOOK_RELAY_URL` | `webhook.relay_url` | `"https://webhooks.unclutter.pro"` |
| `ATLAS_PROJECTS_DIR` | `workspace.projects_dir` | `"$HOME/projects"` |

### Secrets via ENV

Any environment variable matching `ATLAS_SECRET_*` is automatically written to `$HOME/secrets/<name>` (lowercase) with `chmod 600` during container startup.

```yaml
environment:
  - ATLAS_SECRET_GITHUB_TOKEN=ghp_abc123
  - ATLAS_SECRET_STRIPE_KEY=sk_live_...
```

Creates:
- `$HOME/secrets/github_token` containing `ghp_abc123`
- `$HOME/secrets/stripe_key` containing `sk_live_...`

---

## REST API

All API endpoints are under `/api/v1/`. If `ATLAS_API_KEY` is set, requests must include:

```
Authorization: Bearer <api-key>
```
or:
```
X-API-Key: <api-key>
```

### Configuration

```bash
# Get full resolved config
curl -s http://localhost:8080/api/v1/config

# Get specific section
curl -s http://localhost:8080/api/v1/config/models

# Update config (partial merge, persisted to .atlas-runtime-config.json)
curl -s -X PATCH http://localhost:8080/api/v1/config \
  -H "Content-Type: application/json" \
  -d '{"models": {"trigger": "sonnet"}, "agent": {"name": "MyAgent"}}'
```

### Secrets

```bash
# List secret names (values never returned)
curl -s http://localhost:8080/api/v1/secrets

# Set a secret
curl -s -X PUT http://localhost:8080/api/v1/secrets/github-token \
  -H "Content-Type: application/json" \
  -d '{"value": "ghp_abc123"}'

# Delete a secret
curl -s -X DELETE http://localhost:8080/api/v1/secrets/github-token
```

### Identity & Soul

```bash
# Read/write IDENTITY.md
curl -s http://localhost:8080/api/v1/identity
curl -s -X PUT http://localhost:8080/api/v1/identity \
  -H "Content-Type: application/json" \
  -d '{"content": "# My Agent\n\nI am a helpful assistant."}'

# Read/write SOUL.md
curl -s http://localhost:8080/api/v1/soul
curl -s -X PUT http://localhost:8080/api/v1/soul \
  -H "Content-Type: application/json" \
  -d '{"content": "# Soul\n\nBe helpful and precise."}'
```

### Memory

```bash
# List all memory files
curl -s http://localhost:8080/api/v1/memory

# Read a memory file
curl -s http://localhost:8080/api/v1/memory/MEMORY.md

# Write a memory file (creates directories as needed)
curl -s -X PUT http://localhost:8080/api/v1/memory/projects/my-project.md \
  -H "Content-Type: application/json" \
  -d '{"content": "# My Project\n\nNotes here."}'

# Delete a memory file
curl -s -X DELETE http://localhost:8080/api/v1/memory/projects/old-notes.md
```

### Control (Kill Switch)

```bash
# Get current status
curl -s http://localhost:8080/api/v1/control/status
# → {"ok":true,"paused":false,"paused_at":null,"active_sessions":[...]}

# Pause Atlas (stops cron, blocks new triggers)
curl -s -X POST http://localhost:8080/api/v1/control/pause

# Resume Atlas
curl -s -X POST http://localhost:8080/api/v1/control/resume

# Hard stop: kill all active sessions and pause
curl -s -X POST http://localhost:8080/api/v1/control/stop
```

### Sessions (read-only)

```bash
# List recent sessions
curl -s http://localhost:8080/api/v1/sessions?limit=20
```

### Triggers

```bash
# List all triggers
curl -s http://localhost:8080/api/v1/triggers

# Toggle a trigger on/off
curl -s -X POST http://localhost:8080/api/v1/triggers/daily-cleanup/toggle

# Fire a trigger manually
curl -s -X POST http://localhost:8080/api/v1/triggers/daily-cleanup/run
```

---

## File Injection (`.atlas-inject/`)

For Docker-based deployments, you can pre-populate the agent's workspace by mounting an injection directory. Files in `.atlas-inject/` are processed once on first boot.

### Directory Structure

```
.atlas-inject/
├── identity.md              # → copied to IDENTITY.md
├── soul.md                  # → copied to SOUL.md
├── config-overrides.json    # → copied to .atlas-runtime-config.json
└── memory/                  # → merged into memory/
    ├── MEMORY.md
    └── projects/
        └── my-project.md
```

### Docker Compose Example

```yaml
services:
  atlas:
    build: .
    volumes:
      - ./volume:/home/agent
      - ./inject:/home/agent/.atlas-inject:ro  # One-time injection
    environment:
      - ATLAS_AGENT_NAME=CustomerBot
      - ATLAS_API_KEY=my-secret-api-key
      - ATLAS_SECRET_STRIPE_KEY=sk_live_...
```

### How It Works

1. On container startup, `init.sh` checks for `$HOME/.atlas-inject/`
2. If the directory exists and `$HOME/.atlas-inject/.done` does NOT exist:
   - Copies `identity.md` → `IDENTITY.md`
   - Copies `soul.md` → `SOUL.md`
   - Merges `memory/*` into `memory/`
   - Copies `config-overrides.json` → `.atlas-runtime-config.json`
3. Creates `.atlas-inject/.done` marker to prevent re-injection
4. Subsequent restarts skip injection

---

## Workspace Path Configuration

### Custom Projects Directory

Mount a shared volume for projects:

```yaml
services:
  atlas:
    volumes:
      - ./volume:/home/agent
      - /shared/projects:/shared/projects
    environment:
      - ATLAS_PROJECTS_DIR=/shared/projects
```

This creates a symlink: `$HOME/projects → /shared/projects`

---

## Integration Example: Unclutter

```yaml
# Unclutter-managed Atlas instance
services:
  atlas:
    image: ghcr.io/mxzinke/atlas:latest
    volumes:
      - atlas-data:/home/agent
      - ./inject/${INSTANCE_ID}:/home/agent/.atlas-inject:ro
    environment:
      - ATLAS_AGENT_NAME=${AGENT_NAME}
      - ATLAS_AGENT_EMAIL=${AGENT_EMAIL}
      - ATLAS_API_KEY=${MANAGEMENT_API_KEY}
      - ATLAS_SECRET_ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
      - ATLAS_MODEL_TRIGGER=sonnet
      - ATLAS_USAGE_ENABLED=true
      - ATLAS_USAGE_WEBHOOK_URL=https://app.unclutter.pro/api/usage
      - ATLAS_USAGE_WEBHOOK_SECRET=${USAGE_SECRET}
    ports:
      - "${PORT}:8080"
```

Management via API:
```bash
# Pause agent (e.g., subscription expired)
curl -X POST -H "X-API-Key: ${KEY}" https://agent.example.com/api/v1/control/pause

# Update identity
curl -X PUT -H "X-API-Key: ${KEY}" https://agent.example.com/api/v1/identity \
  -H "Content-Type: application/json" \
  -d '{"content": "# Updated Identity\n..."}'

# Inject memory
curl -X PUT -H "X-API-Key: ${KEY}" https://agent.example.com/api/v1/memory/MEMORY.md \
  -H "Content-Type: application/json" \
  -d '{"content": "# Agent Memory\n..."}'
```
