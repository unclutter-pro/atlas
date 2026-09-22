## Signal Integration Setup

Signal uses `signal-cli` in **daemon mode** — a persistent process that pushes messages in real-time via a UNIX socket. This is lower-latency and more reliable than cron polling.

**Install signal-cli** with `brew install signal-cli` if `command -v signal-cli` fails. Homebrew persists in `~/.homebrew`; use the `dependencies` skill for environment setup.

**One-time registration** (run once manually inside the container, not in user-extensions.sh):
```bash
signal-cli -a +491701234567 register
# If a captcha is required:
#   1. Visit https://signalcaptchas.org/registration/generate and complete it
#   2. Copy the URL (format: signalcaptcha://<token>)
#   3. Re-run: signal-cli -a +491701234567 register --captcha <token>
signal-cli -a +491701234567 verify 123-456  # code from SMS
```

**Step 1: Configure `~/config.yml`**

```yaml
signal:
  number: "+491701234567"
  whitelist: []   # empty = accept all contacts
```

**Step 2: Create the trigger**

```bash
trigger create \
  --name=signal-chat \
  --type=webhook \
  --session-mode=persistent \
  --channel=signal \
  --description="Signal messenger conversations"
```

Write `~/triggers/signal-chat/prompt.md`:
```
<message from="{{sender}}">
{{payload}}
</message>

Please respond directly using `signal send "{{sender}}" "..."`.
```

**Step 3: Add supervisor services**

Create `~/supervisor.d/signal.conf` (replace number with your own):
```ini
[program:signal-daemon]
command=python3 /atlas/app/integrations/signal/signal-daemon-start.py
environment=SIGNAL_NUMBER="+491701234567"
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/signal-daemon.log
stderr_logfile=/atlas/logs/signal-daemon-error.log

[program:signal-listen]
command=/atlas/app/bin/signal listen
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/signal-listen.log
stderr_logfile=/atlas/logs/signal-listen-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

Activate:
```bash
supervisorctl reread && supervisorctl update
```

The listener connects to the socket and calls `signal incoming` for each message, which stores it in the inbox and fires the trigger. Each sender gets their own persistent session automatically.

**CLI tools available in trigger sessions:**

```bash
signal send +491701234567 "Hello!"
signal contacts
signal history +491701234567
```
