# Web-UI

The Web-UI is a `Bun.serve` server with a React frontend. Every page, Chat included, is React. Hono.js is left only for the external API `/api/v1/*`, the webhook receiver `/api/webhook/:name` and `/healthz`.

## Implementation

| File | Role |
|------|------|
| `app/web-ui/server.ts` | Entrypoint. `Bun.serve` with native `routes`: the React shell on every area path, `/ui/api/*`, redirects from old page URLs. Everything else falls through to the Hono app. Port from `PORT` (default 3000) |
| `app/web-ui/frontend/areas.ts` | Information architecture: areas, their URL prefixes, the grouped nav. Shared by the server and the React shell |
| `app/web-ui/frontend/` | React app: `App.tsx` (shell), `shell/` (sidebar, status strip), `router.tsx` (pushState router), `api.ts` (`useApi`, mutations), `links.ts` (canonical URLs), `components/`, `pages/<area>/` |
| `app/web-ui/ui-api/` | JSON endpoints under `/ui/api/*`: `core.ts` (meta, status, kill switch), one module per area, `shared/` (env, HTTP helpers, integration health, status, cron) |
| `app/web-ui/ui-api/chat/` | Chat service shared by `/ui/api/chat` and `/api/v1/chat`: `service.ts` (sessions, send, stop, reset), `hub.ts` (live per-chat state), `conversation.ts` (transcript JSONL to chat items), `sse.ts`, `legacy.ts` (the `/api/v1` stream and message shapes), `notify-server.ts` (runner pings), `stt.ts`, `types.ts` (wire types shared with the frontend) |
| `app/web-ui/index.ts` | Hono app: `/api/v1/*`, `/api/webhook/:name`, `/healthz` |
| `app/web-ui/dev/seed.ts` | Seeds an isolated HOME with fixture data for local development |

In the container the web-ui runs as one compiled binary (`/atlas/app/web-ui/web-ui`) that contains the server and the minified frontend bundle. The Dockerfile stage `web-ui-builder` builds it with `bun run build`.

## Information architecture

Every area answers one question. Pages put state first, then what needs attention (errors, running runs), then history.

| Nav group | Area | URL space | Question |
|-----------|------|-----------|----------|
| Operate | Overview | `/` | Is everything running, what is happening right now? |
| Operate | Chat | `/chat/*` | Talk to the agent |
| Operate | Activity | `/activity/*` | What happened and why? |
| Control | Automations | `/automations/*` | What does Atlas do on its own? |
| Control | Knowledge | `/knowledge/*` | What does Atlas know and remember? |
| System | Usage | `/usage` | What does it cost? |
| System | Storage | `/storage/*` | What is on disk, and how full is it? |
| System | Settings | `/settings/*` | How is Atlas set up? |

A status strip sits on top of every page: Active or Paused, how many runs are running (links to Activity), integrations that are down, and the kill switch. **Pause** stops new trigger runs, **Resume** re-enables them, and **Stop** kills all running sessions and pauses. Stop asks for confirmation first.

### Areas

- **Overview** (`/`): headline state, a "Needs attention" list (integrations down, stuck runs, failed runs in the last 24h, overdue reminders, cron schedules that never run, failing usage webhooks), running runs, what fires next (cron triggers and pending reminders), and today's runs, failures, cost and inbound messages.
- **Chat**: web chats with the agent (trigger `web-chat`, one Claude session per chat).
  - `/chat/:key` shows one chat: a sidebar with the chats grouped by Today, Yesterday and Earlier, search, archived chats, rename, archive and delete; a header with the title, run state ("Starting", "Working · m:ss"), cost, run count, **Stop turn** and a link to the session in Activity; the conversation with markdown replies, collapsed thinking, tool calls with input and result, and live streamed text; a composer with voice recording where the browser supports it.
  - `/chat` opens the last chat used in this browser, else the newest one, else `_default`. The old `/chat?session=<key>` and `?sessionKey=<key>` URLs redirect to `/chat/<key>`.
  - Stop turn interrupts only the current turn through the runner's control socket. The session stays alive. The global Stop in the status strip still kills everything.
  - Markdown goes through `marked` and DOMPurify, both bundled (no CDN).
- **Activity**: one timeline of events, each with its cause (message on a channel, cron, webhook, manual, direct session), outcome, duration and cost. An inbound message that started a run shows as that run's cause.
  - `/activity/:id`: one trigger run with its payload, transcript and tool calls. Raw token counts appear only here.
  - `/activity/session/:sessionId` and `/activity/message/:id`: detail pages for a session and a message.
  - Filters are query parameters: `trigger`, `status=running|ok|failed`, `channel`, `type=cron|webhook|manual|direct|trigger`, `from`/`to` and `q`. `from` and `to` are inclusive calendar days (`YYYY-MM-DD`) in the resolved Atlas zone (see [Time zone](#time-zone)), the same days Usage and Overview count in.
- **Automations**: triggers grouped by type, plus reminders (`?view=reminders`, pending first, each with Cancel).
  - `/automations/:name`: prompt, schedule in words and the next runs, webhook URL, run history and cost, with Edit (`?edit=1`), Enable/Disable, Run now and Delete. New triggers are created at `?create=1`.
  - Cron schedules must use the numeric 5-field syntax, because `sync-crontab.ts` drops anything else.
- **Knowledge**: `MEMORY.md` first, then the `~/memory` file tree and search (`?q=`).
  - `/knowledge/file/<path>` shows and edits a file. Saves are rejected with 409 if the file changed on disk in the meantime.
  - `/knowledge/journal/:date` is a read-only day view with a calendar. It reads both `memory/journal/` and the older root-level `memory/YYYY-MM-DD.md`.
- **Usage**: aggregates only. Cost, runs, error rate and tokens over time, broken down by trigger and by type, compared with the previous period. Ranges are `range=7d|30d|90d` or custom `from`/`to`, filterable by `trigger` and `type`. Every number links to Activity with the matching filter. CSV export is at `/ui/api/usage/export.csv`.
- **Storage**: volumes (capacity of HOME, `/atlas/logs`, `/tmp` and `/`, deduplicated by filesystem, warn at 80%/error at 90%), a workspace breakdown (size and file count per top-level entry in HOME, the 20 largest files, SQLite DB size including `-wal`/`-shm`), and a read-only file browser.
  - The workspace breakdown walks HOME asynchronously and is cached for 60s (`computedAt`); `?refresh=1` recomputes.
  - `/storage/browse/<path>` is rooted at HOME: a directory listing, or a file's metadata and a text preview (capped, tail shown for `.log` files). Secrets (`~/secrets/**`, `.ssh/**`, `.claude/.credentials.json`, `*.pem`/`*.key`, `.env*`, `*.credentials*`) are listed but their content and download are denied; `config.yml` is shown masked instead, the same as Settings. Files link to their better view where one exists (memory files → Knowledge, session transcripts → Activity).
- **Settings**: `/settings/<section>`, with `/settings` redirecting to Personality.
  - `personality`: edit IDENTITY.md and SOUL.md.
  - `integrations`: Signal, Email, WhatsApp, Telegram and Web. Shows whether each is configured and running, and the triggers on its channel.
  - `configuration`: effective values and where each came from (env, runtime, config.yml or default), plus a validated config.yml editor (`?view=edit`).
  - `secrets`: names only. Values can be set and deleted but are never returned.
  - `extensions`: `user-extensions.sh`, syntax-checked with `bash -n`.

Every object has its own URL, built with `frontend/links.ts`. Triggers, runs, sessions and messages link to each other.

### Old URLs

The server-rendered pages were removed. Their URLs redirect (302) to the page that replaced them, including the object a bookmark pointed at where there is one:

| Old | New |
|-----|-----|
| `/inbox`, `/inbox/:id` | `/activity`, `/activity/message/:id` |
| `/sessions`, `/sessions/:id` | `/activity`, `/activity/session/:id` |
| `/triggers` | `/automations` |
| `/analytics`, `/analytics.csv` | `/usage`, `/ui/api/usage/export.csv` (keeps `from`, `to`, `trigger`, `status`; the legacy `types` and `min_cost` filters are dropped, and `trigger` now matches exactly instead of by substring) |
| `/memory`, `/memory/search?q=`, `/memory/view?file=` | `/knowledge`, `/knowledge?q=`, `/knowledge/file/<file>` |
| `/journal`, `/journal?date=` | `/knowledge/journal`, `/knowledge/journal/<date>` |

## Time zone

Atlas resolves a single IANA zone (`app/lib/timezone.ts`'s `resolveTimezone()`) used everywhere day boundaries or cron schedules matter, so a run at 00:30 local never shows under "yesterday" in one place and "today" in another:

1. **Explicit**: `timezone:` in `config.yml`, or the `ATLAS_TIMEZONE` env var (env wins, like every other config key — see [docs/external-configuration.md](external-configuration.md)).
2. **Container runtime**: the `TZ` env var, then `/etc/timezone`, then the `/etc/localtime` symlink target.
3. **UTC**.

An invalid explicit value is ignored (logged, and reported as `invalid` by `resolveTimezone()`) and resolution falls through to the runtime layer.

What uses it:
- **Web-ui**: Overview's "today", Usage's day series and Activity's `from`/`to` filters all bucket by this zone (converted to UTC instants for the SQLite queries — SQLite has no time zone database, so `session_metrics`/`trigger_runs` are grouped by day in JS rather than with SQLite's `date()`). `GET /ui/api/meta` returns `{ timeZone, timeZoneSource }`; the frontend fetches it once and formats every absolute time (`<Time>`, Usage's day labels, Settings) in that zone instead of the browser's. Settings > Configuration shows `timezone` like any other key, with its source.
- **Cron next-run**: `ui-api/shared/cron.ts`'s `nextRuns()` takes an optional IANA zone and computes fire times (including across DST) with `Intl`, independent of the process's own zone.
- **supercronic**: `app/triggers/sync-crontab.ts` prepends a `CRON_TZ=<zone>` line to the generated crontab (supercronic, like Vixie cron, honors `CRON_TZ`), so scheduling follows the resolved Atlas zone even when it differs from the container's `TZ`.
- **Agent sessions**: `trigger-runner.ts` sets `process.env.TZ` to the resolved zone at startup, before spawning the Claude Code session, so journal dates and "today" in prompts match the zone above.

## Local development

Never run the UI against the real `~/.index/atlas.db` or `~/memory`. Seed an isolated HOME:

```bash
cd app/web-ui
bun install
bun dev/seed.ts /tmp/atlas-dev      # fresh DB + fixtures; re-running re-seeds
HOME=/tmp/atlas-dev ATLAS_SUPERVISORCTL_STATUS_FILE=/tmp/atlas-dev/.dev/supervisorctl-status.txt \
  PORT=3100 bun --hot server.ts
HOME=/tmp/atlas-dev bun test        # tests that write to the DB only run on a seeded HOME
bunx tsc -p .
bun run build                       # compile ./web-ui binary (delete it afterwards)
```

The seed contains 11 triggers of all three types, about 50 trigger runs over 10 days (some running, some failed) with transcripts and session metrics, inbound messages on four channels, reminders, a failing usage webhook, memory and journal files, IDENTITY.md, SOUL.md, config.yml, a runtime override, secrets and supervisor configs. `ATLAS_SUPERVISORCTL_STATUS_FILE` substitutes a file for `supervisorctl status` output, so integration health shows real states outside the container (in the seed, the email poller is FATAL).

Scripts under `/atlas/...` exist only in the container. Server code starts them through the guarded helpers in `ui-api/shared/env.ts` (`trySpawn`, `trySpawnSync`, `fireTrigger`, `syncCrontab`), which return false instead of failing the request when the script is missing. They also return false under `bun test`: inside the container the scripts do exist, and a test run must never start a billable agent session. The compiled binary pins `NODE_ENV` to `production`, so the guard folds away in production.

### Adding to an area

- Frontend: `frontend/pages/<area>/`. `index.tsx` default-exports the area root and routes sub-paths with `<Routes>`. Area CSS goes in `pages/<area>/<area>.css`, with classes prefixed `.<area>-`.
- API: `ui-api/<area>.ts` exports `routes`, with every path under `/ui/api/<area>`. `ui-api/index.ts` refuses duplicates and paths outside the prefix at startup. Handlers are plain Bun route handlers wrapped in `handler()` from `ui-api/shared/http.ts`.
- Mutations must call `readJson(req)`. It requires `Content-Type: application/json`, which cross-site HTML forms cannot send.
- Send timestamps to the client through `toIso()`.
- Shared UI lives in `frontend/components/` (page layout, tables, badges including `OutcomeBadge`, formatting, `CopyButton`, forms, `useUnsavedWarning`). Design tokens are in `frontend/styles.css`.

## Security

The UI has no login; it relies on being reachable only from trusted networks. Three guards keep other websites from using it through the browser:

- **Cross-site mutations** (`crossSiteRejection` in `ui-api/shared/http.ts`): every non-GET on `/ui/api` needs `Content-Type: application/json` and is refused with 403 when `Sec-Fetch-Site` says cross-site or the `Origin` host differs. Voice uploads are multipart and need the `X-Atlas-UI` header instead. `/api/v1` gets the origin check too.
- **DNS rebinding** (`ui-api/shared/host.ts`): `/ui/api` (and `/api/v1` when no `ATLAS_API_KEY` is set) answer 421 unless the `Host` is localhost, an IP address, a single-label name (`atlas`), `*.local`, or listed in `web_ui.allowed_hosts` / `ATLAS_WEB_UI_ALLOWED_HOSTS`. Add your domain there if you open the UI through one (Tailscale, reverse proxy).
- **Assistant markdown** is sanitised with DOMPurify; remote images and media become plain links, so a prompt-injected reply cannot send data to another host just by being rendered.

## API endpoints

### Frontend data (`/ui/api/*`)

There is no API key, the same trust level as the pages (perimeter-trusted). Unknown paths return a JSON 404, and errors are `{ "error": "..." }`.

```
GET  /ui/api/meta                                  { agentName, timeZone, timeZoneSource }
GET  /ui/api/status                                control state, running runs, integration + service health
POST /ui/api/control/pause | resume                body {}
POST /ui/api/control/stop                          body {"confirm": true}; kills sessions and pauses

GET  /ui/api/overview?upcoming=1..50

GET  /ui/api/activity?trigger&status&channel&type&from&to&q&cursor&limit
GET  /ui/api/activity/filters
GET  /ui/api/activity/runs/:id | sessions/:sessionId | messages/:id
GET  /ui/api/activity/attachments/:id

GET  /ui/api/automations                           triggers + summary
GET  /ui/api/automations/options                   model keys, channels, time zone
GET  /ui/api/automations/cron?expr=                validate + describe + next runs
POST /ui/api/automations/triggers                  create
GET|PUT|DELETE /ui/api/automations/triggers/:name
GET  /ui/api/automations/triggers/:name/runs?page&pageSize
POST /ui/api/automations/triggers/:name/toggle | run | secret
GET  /ui/api/automations/reminders?status=pending|all
POST /ui/api/automations/reminders/:id/cancel

GET  /ui/api/knowledge                             MEMORY.md, file tree, recent journal days
GET  /ui/api/knowledge/search?q=
GET|PUT|DELETE /ui/api/knowledge/file/<path>       PUT body {content, baseMtimeMs|null}
GET  /ui/api/knowledge/journal
GET  /ui/api/knowledge/journal/:date

GET  /ui/api/usage?range&from&to&trigger&type
GET  /ui/api/usage/export.csv?range&from&to&trigger&type&status

GET  /ui/api/storage/volumes                       capacity of HOME, /atlas/logs, /tmp and /, deduplicated by filesystem
GET  /ui/api/storage/workspace?refresh=1            size/file count per top-level HOME entry, largest files, DB size; cached 60s
GET  /ui/api/storage/browse                         directory listing of HOME
GET  /ui/api/storage/browse/<path>                  listing (dir) or metadata + preview (file), relative to HOME
GET  /ui/api/storage/download/<path>                raw file download; 403 for secrets (config.yml is masked instead)

GET  /ui/api/settings/personality
PUT  /ui/api/settings/personality/identity|soul    body {content, version?}
GET  /ui/api/settings/integrations
GET|PUT /ui/api/settings/configuration             PUT body {content, version?, force?}
POST /ui/api/settings/configuration/validate
GET  /ui/api/settings/secrets
PUT|DELETE /ui/api/settings/secrets/:name          PUT body {value}; values are never returned
GET|PUT /ui/api/settings/extensions
POST /ui/api/settings/extensions/validate
```

### Chat (`/ui/api/chat/*`)

```
GET    /ui/api/chat/sessions?archived=exclude|only|all&q=   chats, newest activity first; q searches titles and user messages
POST   /ui/api/chat/sessions                   body {title?}; 201 {session}
GET    /ui/api/chat/sessions/:key              snapshot {session, items, drafts, run, truncated}; 404 unknown
PATCH  /ui/api/chat/sessions/:key              body {title?, archived?}; 400 when archiving _default
DELETE /ui/api/chat/sessions/:key              body {}; 400 for _default, 409 while a turn runs
POST   /ui/api/chat/sessions/:key/messages     JSON {content, clientId?} or multipart voice; 201 {item, triggered}
POST   /ui/api/chat/sessions/:key/stop         body {}; {stopped, reason?: not_running|unreachable}
GET    /ui/api/chat/sessions/:key/stream       text/event-stream (below)
```

Wire types are in `ui-api/chat/types.ts`, which the frontend imports too. Sending returns 409 when Atlas is paused or the chat is archived. `triggered: false` means the message was saved but trigger.sh could not start (outside the container).

Voice messages are `multipart/form-data` with one audio `file`, an optional `message` caption and an optional `clientId`, at most 25 MiB (413 above). Multipart is a content type cross-site forms can send, so these requests need the `X-Atlas-UI: 1` header on top of the cross-site check (403 without it). The server transcribes the audio inline (STT settings as for `/api/v1`). When STT fails and there is no caption, the text is "(Voice message, transcription failed)".

The stream starts with `retry: 2000` and a `snapshot` event, then sends `item`, `item_update` (a tool result arrived), `delta` (streamed text per `streamId`), `run`, `session` and `session_deleted` (the server closes the stream after it). A later `snapshot` replaces all state. The stream has no time cap. A `: keepalive` comment goes out every 8 s, under Bun's 10 s idle timeout.

#### How live updates work

Nothing polls. Each open chat has one in-memory hub (`ui-api/chat/hub.ts`) shared by every stream on that chat, including `/api/v1` streams. The hub re-reads a source only when something says it changed, and a 30 ms coalesced flush then reads each changed source once for all subscribers:

- new user messages by `messages.id`,
- new rows in `web_chat_stream_chunks` by id (the streamed text deltas),
- new bytes of the session transcript JSONL from the last byte offset.

The signals are:

- **Runner pings.** The web-chat trigger-runner POSTs small JSON hints to a Unix socket at `~/.index/web-ui.sock` (mode 0600, override with `ATLAS_WEB_UI_NOTIFY_SOCKET`): `{v: 1, trigger, sessionKey, sessionId, kind, isError?, interrupted?}` with `kind` one of `session`, `turn_start`, `chunk`, `message`, `turn_end`, `run_end`. The socket accepts only `POST /notify` with a body of at most 1 KiB. Pings carry no data, the hub reads the data itself. The runner side (`lib/web-ui-notify.ts`) never waits for or fails on a ping, sends them in order, throttles `chunk` and `message` pings to one per 40 ms per chat and drops pings when four are queued.
- **`fs.watch`** on the transcript file.
- **Local changes** in the web-ui: sends, renames, resets, deletes, and the kill switch (`notifyAllChats()`).

The run state (`idle`, `starting`, `running`) follows the pings: `turn_start` means running, `turn_end` or `run_end` means idle. A send that started trigger.sh shows `starting` until the runner reports. One timer does I/O: while a turn is starting or running and someone is watching, 15 s without any signal re-derive the state from the runner's lock file PID, one query and a 64 KiB transcript tail. That catches a runner killed by SIGKILL or OOM, or a trigger.sh that never started. Idle chats cost nothing, and the keepalive timer runs only while a stream is open.

The runner also deletes a chat's old stream chunks at each turn start, so the table holds only the current turn. If the notify socket cannot start, `server.ts` logs a warning and live updates fall back to `fs.watch` plus the safety net.

### External API (`/api/v1/*`)

API-key protected (`Authorization: Bearer <key>` or `X-API-Key: <key>`) for other tools. Browser requests from other sites are rejected on mutations even when no key is set (same origin check as above, no JSON requirement since voice messages are multipart). Endpoints: config, secrets, identity and soul, memory files, control (pause/resume/stop/status), sessions, triggers (list, toggle, run), chat messages, sessions and stream, attachments. See `index.ts`. The chat endpoints keep their paths, shapes and SSE event names (`init`, `user_message`, `assistant_message_chunk`, `assistant_message`, `tool_activity`, `agent_started`, `agent_ended`) but run on the same chat service and hub as the web UI (`ui-api/chat/legacy.ts`). Their stream has no 5-minute cap any more.

### Webhook receiver

```
POST /api/webhook/:name
```

Receives external webhook events. The request body becomes `{{payload}}` in the trigger prompt. If the trigger has a secret, send it as the `X-Webhook-Secret: <secret>` header or the `?secret=<secret>` query parameter.

```json
{ "ok": true, "trigger": "github-push", "message": "Webhook received, Claude will process it" }
```

## nginx proxy

The web-ui listens on port 3000. nginx listens on 8080, proxies everything to it and rate-limits to 10 requests/second with a burst of 20 (excess requests get 503). `/ui/api/chat/` has its own location with buffering off, a 180 s read timeout (SSE and inline STT) and a 26 MB body limit for voice messages. Config: `app/nginx.conf`.

## Styling

Design tokens and component classes are in `frontend/styles.css`: a dark palette (background `#1a1b2e`, cards `#252640`, borders `#3a3b55`, accent `#7c6ef0`), status colors for ok, warn, error and running, and a monospace font stack.
