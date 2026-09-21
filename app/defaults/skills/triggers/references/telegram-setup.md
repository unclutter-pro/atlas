## Telegram Integration Setup

Telegram uses a **Bot API** approach — simpler than Signal/WhatsApp but NOT end-to-end encrypted.

**Step 1: Create a bot via BotFather**

Guide the user through this (or do it for them if they share the token):
1. Open Telegram → search @BotFather → send `/newbot`
2. Choose a name and username (must end with "bot")
3. Copy the token — share it via a **secure channel** (NOT Telegram itself)

**Step 2: Configure `~/config.yml`**

```yaml
telegram:
  bot_token: "123456:ABC-DEF..."
```

**Step 3: Create the trigger**

```bash
trigger create \
  --name=telegram-chat \
  --type=manual \
  --session-mode=persistent \
  --channel=telegram \
  --enabled
```

Write `~/triggers/telegram-chat/prompt.md`:
```markdown
{{payload}}

Please respond directly using `telegram send "{{sender}}" "..."`.
```

**Step 4: Add supervisor service**

Create `~/supervisor.d/telegram.conf`:
```ini
[program:telegram-daemon]
command=python3 -u /atlas/app/integrations/telegram/telegram-daemon.py
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/telegram-daemon.log
stderr_logfile=/atlas/logs/telegram-daemon-error.log
stdout_logfile_maxbytes=10MB
stderr_logfile_maxbytes=1MB
```

Then: `supervisorctl reread && supervisorctl update`

**Security note:** Telegram bots are NOT end-to-end encrypted. Never share passwords, API keys, or sensitive data via Telegram. Recommend Signal or Dashboard chat for sensitive information.

**CLI tools:**

```bash
telegram send "<chat_id>" "Hello!"
telegram send "<chat_id>" "See attached" --attach /path/to/file.pdf
telegram contacts
telegram history "<chat_id>"
telegram status
telegram setup   # Print setup instructions
```

**Data storage:**

| Item | Location |
|------|----------|
| Contact/message DB | `~/.index/telegram/telegram.db` |
| Downloaded attachments | `~/.local/share/telegram/attachments/` |
| Daemon logs | `/atlas/logs/telegram-daemon.log` |
