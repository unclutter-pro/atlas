## WhatsApp Integration Setup

WhatsApp uses [Baileys](https://github.com/WhiskeySockets/Baileys) — an unofficial WhatsApp Web API that connects via WebSocket. A single daemon process handles both incoming messages and outgoing sends.

> **Warning:** Baileys is unofficial. WhatsApp can ban accounts using third-party clients. Use a **dedicated phone number**, not your main one. Avoid bulk messaging.

**Step 1: Configure `~/config.yml`** (optional)

```yaml
whatsapp:
  whitelist: []   # empty = accept all; or ["+491701234567", "+491709876543"]
  history_turns: 20
```

No phone number config needed — Baileys derives it from the linked device session.

**Step 2: Create the trigger**

The `whatsapp-chat` trigger is auto-created by `init.sh`. If it's missing:

```bash
trigger create \
  --name=whatsapp-chat \
  --type=webhook \
  --session-mode=persistent \
  --channel=whatsapp \
  --description="WhatsApp messenger conversations"
```

Write `~/triggers/whatsapp-chat/prompt.md`:
```
<message from="{{sender}}">
{{payload}}
</message>

Please respond directly using `whatsapp send "{{sender}}" "..."`.
```

**Step 3: Add supervisor service**

Create `~/supervisor.d/whatsapp.conf`:
```ini
[program:whatsapp-daemon]
command=bun run /atlas/app/integrations/whatsapp/whatsapp-daemon.ts
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/whatsapp-daemon.log
stderr_logfile=/atlas/logs/whatsapp-daemon-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

Activate:
```bash
supervisorctl reread && supervisorctl update
```

**Step 4: Pair via QR code**

On first start, the daemon generates a QR code and saves it as an image:

```bash
# Check status and get QR code path
whatsapp status
# → Status: waiting_for_scan
# → QR Code: ~/.local/share/whatsapp/qr-code.png
```

**Send the QR code image directly to the user** via their current channel (Signal, email, dashboard). Tell them:
"Öffne WhatsApp → Einstellungen → Verknüpfte Geräte → Gerät hinzufügen, und scanne den QR-Code."

The QR code expires after ~60 seconds — the daemon auto-generates a new one if it times out.

Auth credentials persist to `~/.local/share/whatsapp/auth/` — subsequent restarts reconnect automatically. If the linked device is revoked (phone offline 14+ days), delete the auth directory and re-scan.

**Architecture:**

Unlike Signal (which needs two processes — signal-cli daemon + listener), WhatsApp uses a **single daemon** (`whatsapp-daemon.ts`) that:

1. Connects to WhatsApp via Baileys WebSocket
2. Listens for incoming messages → spawns `whatsapp incoming` per message
3. Exposes a UNIX socket (`/tmp/whatsapp.sock`) for outgoing sends (JSON-RPC, same protocol as signal-cli)

Voice messages are automatically downloaded and transcribed via the same STT pipeline as Signal. Outgoing messages are rate-limited (1.5s between sends) to reduce ban risk.

**CLI tools available in trigger sessions:**

```bash
whatsapp send "+491701234567" "Hello!"
whatsapp send "+491701234567" "See attached" --attach /path/to/file.pdf
whatsapp contacts
whatsapp history "+491701234567"
```

**Data storage:**

| Item | Location |
|------|----------|
| Auth credentials | `~/.local/share/whatsapp/auth/` |
| Downloaded attachments | `~/.local/share/whatsapp/attachments/` |
| Contact/message DB | `~/.index/whatsapp/whatsapp.db` |
| Daemon logs | `/atlas/logs/whatsapp-daemon.log` |
| Send socket | `/tmp/whatsapp.sock` |
