# Web-UI

The Web-UI is a Hono.js server with HTMX for live updates. It's server-side rendered (no SPA build step) and provides the dashboard interface to Atlas.

## Implementation

Source: `app/web-ui/index.ts`

Stack:
- **Runtime**: Bun
- **Framework**: Hono.js
- **Frontend**: HTMX (2.0.4 from CDN)
- **Database**: better-sqlite3 (via shared db module)

## Available Pages

| Route | Purpose |
|-------|---------|
| `/` | Dashboard with session status, pending messages, recent activity |
| `/inbox` | Message list with status filters |
| `/tasks` | Task queue management |
| `/triggers` | Trigger CRUD, toggle, run |
| `/memory` | MEMORY.md viewer and file browser |
| `/journal` | Date-based journal viewer |
| `/chat` | Web chat interface |
| `/settings` | Identity, config, extensions editor |

## API Endpoints

### Webhook Receiver

```
POST /api/webhook/:name
```

Receives external webhook events. Request body becomes `{{payload}}` in trigger prompt.

Authentication via:
- Header: `X-Webhook-Secret: <secret>`
- Query: `?secret=<secret>`

Response:
```json
{ "ok": true, "trigger": "github-push", "message": "Trigger session started" }
```

### Trigger Management

```
POST /triggers              # Create trigger (form data)
POST /triggers/:id/toggle   # Enable/disable (HTMX)
POST /triggers/:id/run      # Manual run (HTMX)
DELETE /triggers/:id        # Delete trigger
```

### Chat

```
GET /chat                   # Chat interface
POST /chat                  # Send message (form: content)
```

### Memory/Journal

```
GET /memory                 # Memory browser
GET /memory?file=path       # View specific file
GET /journal                # Journal list
GET /journal?date=YYYY-MM-DD # View specific date
```

### Settings

```
GET /settings               # Settings editor
POST /settings/identity     # Update IDENTITY.md
POST /settings/config       # Update config.yml
POST /settings/extensions   # Update user-extensions.sh
```

## HTMX Integration

Live updates without page reload:

- Toggle trigger: `hx-post="/triggers/123/toggle" hx-target="#trigger-123"`
- Run trigger: `hx-post="/triggers/123/run" hx-target="#trigger-status"`
- Refresh inbox: `hx-get="/inbox" hx-trigger="every 5s"`

## Rate Limiting

nginx proxy includes rate limiting:
- 10 requests/second with burst of 20
- Excess requests get 503

## nginx Proxy

The web-ui runs on port 3000. nginx listens on port 8080 and proxies:

```nginx
server {
  listen 8080;
  location / {
    proxy_pass http://127.0.0.1:3000;
    limit_req zone=default burst=20 nodelay;
  }
}
```

Config: `app/nginx.conf`

## Styling

Dark theme with purple accent (#7c6ef0):
- Background: #1a1b2e
- Card background: #252640
- Border: #3a3b55
- Text: #e0e0e0
- Muted: #999

Monospace font stack: SF Mono, Cascadia Code, Consolas

## Session Status

The dashboard shows session status from the database, reflecting real-time task execution state.
