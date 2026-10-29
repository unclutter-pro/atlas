## Nextcloud Talk Integration Setup

Talk uses the **webhook bot API** (Talk 17.1+, threads need Talk 22+). Nextcloud posts every message of the conversations the bot is enabled in to Atlas, signed with a shared secret; Atlas answers through the signed bot endpoints. No Nextcloud user account is needed (an optional one, `agent_user`, makes one-to-one chats possible). Installing the bot needs a **Nextcloud admin** (`occ`).

**Step 1: Secret** (40–128 characters, never in `config.yml`)

```bash
mkdir -p ~/secrets && openssl rand -hex 32 > ~/secrets/talk-bot-secret && chmod 600 ~/secrets/talk-bot-secret
```

Or set `TALK_BOT_SECRET` in the container environment (Kubernetes secret). The admin needs the same value for step 3; hand it over through a secure channel, never through Talk itself.

**Step 2: Configure `~/config.yml`**

```yaml
talk:
  url: "https://cloud.example.com"   # Nextcloud base URL
  bot_name: "Claudius"               # the name people @mention; default agent.name
  # agent_user: "claudius"           # optional Nextcloud account of the agent: one-to-one chats with it
  rooms: []                          # optional allowlist of room tokens
  whitelist: []                      # optional allowlist of users ("alice" or "users/alice")
```

**Step 3: Install the bot in Nextcloud** (admin, e.g. `sudo -u www-data php occ …`)

```bash
occ talk:bot:install --no-setup -f webhook -f response -f reaction \
  "Claudius" "<SECRET>" "https://<atlas-host>/api/integrations/talk/webhook" "Atlas agent"
occ talk:bot:list                                # note the bot id
occ talk:bot:setup <bot-id> <room-token> [<room-token> ...]
```

`--no-setup` keeps moderators from adding the bot to other rooms themselves. The room token is the last part of the conversation URL (`/call/<token>`). The bot name shown in Talk is the first argument; use the same name as `bot_name`.

**Step 4: Create the trigger**

```bash
trigger create \
  --name=talk-chat \
  --type=manual \
  --session-mode=persistent \
  --channel=talk \
  --description="Nextcloud Talk conversations"
```

Write `~/triggers/talk-chat/prompt.md`:
```markdown
{{payload}}

Reply with `talk send "..."` (goes to this conversation and thread).
```

**Step 5: Network**

- Nextcloud → Atlas: Nextcloud must reach `POST /api/integrations/talk/webhook` on the web UI (port 8080). Expose only this path to the Nextcloud host, e.g. a reverse-proxy location or a cluster-internal service URL. Talk allows private addresses for bot URLs.
- Atlas → Nextcloud: outbound HTTPS to `talk.url` (`/ocs/v2.php/apps/spreed/api/v1/bot/...`).

**Step 6: Check**

```bash
talk status    # config, secret present, features Nextcloud reports for each room
```

If `talk status` reports `HTTP 401`, the secrets differ: fix it before trying again. About 10 failed signatures lock the Atlas IP out of the bot API (`500`, then `429` for every request); after fixing the secret, the admin runs `occ security:bruteforce:reset <atlas-ip>`.

Then write `@Claudius hello` in the room. `talk rooms` lists conversations the bot has seen; logs go to `/atlas/logs/talk.log`.

**Behaviour:**

- Group rooms: only messages that `@mention` the bot (or reply to one of its messages) start a session. Follow-ups in a thread the bot is part of need no mention (`follow_threads: false` turns that off).
- One-to-one conversations with `agent_user` (and rooms set to `mode: all` under `talk.rooms`) pass every message on. A bot can't be a one-to-one partner itself: in a one-to-one between two people it only reacts to mentions. Without an agent account, a "Note to self" conversation with `mode: all` works as a personal channel.
- Each thread is its own session: `talk/<room>/<thread-id>`, outside threads `talk/<room>/main`.
- `/new` (with the mention in group rooms) starts a fresh session for that conversation/thread.

**CLI tools:**

```bash
talk send "Hello"                               # in a trigger session: this conversation/thread
talk send --room <token> "Hello"                # anywhere else
talk send --new-thread "Title" "First message"
talk react <message-id> "👍"
talk history --room <token> [--thread <id>]
talk rooms
talk threads
```

**Data storage:**

| Item | Location |
|------|----------|
| Messages, rooms, threads | `~/.index/talk/talk.db` |
| Bot secret | `~/secrets/talk-bot-secret` or `TALK_BOT_SECRET` |
| Log | `/atlas/logs/talk.log` |
