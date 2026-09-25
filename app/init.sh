#!/bin/bash
set -euo pipefail

WORKSPACE="$HOME"
LOG="/atlas/logs/init.log"
exec > >(tee -a "$LOG") 2>&1

# Resolve agent display name: AGENT_NAME env > config.yml agent.name > "Atlas"
if [ -z "${AGENT_NAME:-}" ]; then
  if [ -f "$WORKSPACE/config.yml" ]; then
    AGENT_NAME=$(grep -A1 '^agent:' "$WORKSPACE/config.yml" 2>/dev/null | grep 'name:' | sed 's/.*name: *"\?\([^"#]*\)"\?.*/\1/' | xargs)
  fi
  AGENT_NAME="${AGENT_NAME:-Atlas}"
fi
export AGENT_NAME

echo "[$(date)] $AGENT_NAME init starting..."

# ── Phase 1: Auth Check ──
echo "[$(date)] Phase 1: Auth check"
if [ -f "$HOME/.claude/.credentials.json" ]; then
  echo "  OAuth credentials found"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  API key configured"
else
  echo "  ⚠ No authentication configured!"
  echo "  Run: docker run -it --rm -v \$(pwd)/volume:/home/agent atlas claude login"
  echo "  Or set ANTHROPIC_API_KEY in docker-compose.yml"
  # Don't exit - web-ui should still start for setup instructions
fi

# ── Phase 2: Directory Setup ──
echo "[$(date)] Phase 2: Directory setup"
mkdir -p "$WORKSPACE/memory/projects" \
         "$WORKSPACE/memory/journal" \
         "$WORKSPACE/memory/entities" \
         "$WORKSPACE/memory/decisions" \
         "$WORKSPACE/memory/workflows" \
         "$WORKSPACE/memory/responsibilities" \
         "$WORKSPACE/memory/notes" \
         "$WORKSPACE/.index" \
         "$WORKSPACE/projects" \
         "$WORKSPACE/agents" \
         "$WORKSPACE/mcps" \
         "$WORKSPACE/triggers" \
         "$WORKSPACE/secrets" \
         "$WORKSPACE/bin" \
         "$WORKSPACE/supervisor.d"

# ── Migration: Consolidate .claude/projects memory into ~/memory/ ──
AGENT_USER=$(basename "$HOME")
CLAUDE_MEMORY_DIR="$HOME/.claude/projects/-home-${AGENT_USER}/memory"
if [ -d "$CLAUDE_MEMORY_DIR" ]; then
  echo "  Migrating .claude/projects memory to ~/memory/..."

  # Merge MEMORY.md (keep ~/memory/ version if both exist, but preserve .claude version as backup)
  if [ -f "$CLAUDE_MEMORY_DIR/MEMORY.md" ] && [ ! -f "$WORKSPACE/memory/MEMORY.md" ]; then
    cp "$CLAUDE_MEMORY_DIR/MEMORY.md" "$WORKSPACE/memory/MEMORY.md"
    echo "    Migrated MEMORY.md"
  fi

  # Merge journal entries (copy missing ones)
  if [ -d "$CLAUDE_MEMORY_DIR/journal" ]; then
    for f in "$CLAUDE_MEMORY_DIR/journal"/*.md; do
      [ -f "$f" ] || continue
      basename_f=$(basename "$f")
      if [ ! -f "$WORKSPACE/memory/journal/$basename_f" ]; then
        cp "$f" "$WORKSPACE/memory/journal/$basename_f"
        echo "    Migrated journal/$basename_f"
      fi
    done
  fi

  # Merge project files (copy missing ones)
  if [ -d "$CLAUDE_MEMORY_DIR/projects" ]; then
    for f in "$CLAUDE_MEMORY_DIR/projects"/*.md; do
      [ -f "$f" ] || continue
      basename_f=$(basename "$f")
      if [ ! -f "$WORKSPACE/memory/projects/$basename_f" ]; then
        cp "$f" "$WORKSPACE/memory/projects/$basename_f"
        echo "    Migrated projects/$basename_f"
      fi
    done
  fi

  # Remove old .claude memory dir to avoid future confusion
  rm -rf "$CLAUDE_MEMORY_DIR"
  echo "  Migration complete — removed $CLAUDE_MEMORY_DIR"
fi

# Create default MEMORY.md if it doesn't exist yet
if [ ! -f "$WORKSPACE/memory/MEMORY.md" ]; then
  DISPLAY_NAME="${AGENT_NAME:-Atlas}"
  cat > "$WORKSPACE/memory/MEMORY.md" << MEMEOF
# ${DISPLAY_NAME} Memory

## Key Infrastructure
- [Services, APIs, credentials — document as you learn them.]

## Projects
- See \`memory/projects/\` for detailed project notes.

## Active Scripts
- [Cron jobs, automation scripts — document as you create them.]

## Known Limitations
- [Platform constraints, workarounds, known issues.]

## Workflow
- [Commit conventions, branch strategy, delegation patterns, etc.]
MEMEOF
  echo "  Created default MEMORY.md"
fi

# ── Phase 2b: ENV Secret Bridge ──
# Any env var matching ATLAS_SECRET_* gets written to $HOME/secrets/<lowercase_suffix>
echo "[$(date)] Phase 2b: ENV secret bridge"
{ env | grep '^ATLAS_SECRET_' || true; } | while IFS='=' read -r key value; do
  secret_name=$(echo "$key" | sed 's/^ATLAS_SECRET_//' | tr '[:upper:]' '[:lower:]')
  secret_file="$WORKSPACE/secrets/$secret_name"
  echo "$value" > "$secret_file"
  chmod 600 "$secret_file"
  echo "  Bridged env $key → secrets/$secret_name"
done

# ── Phase 2c: Injection Directory ──
# Process $HOME/.atlas-inject/ for first-boot data injection (Docker mount pattern)
INJECT_DIR="$WORKSPACE/.atlas-inject"
if [ -d "$INJECT_DIR" ] && [ ! -f "$INJECT_DIR/.done" ]; then
  echo "[$(date)] Phase 2c: Processing injection directory"

  # Inject IDENTITY.md
  if [ -f "$INJECT_DIR/identity.md" ]; then
    cp "$INJECT_DIR/identity.md" "$WORKSPACE/IDENTITY.md"
    echo "  Injected IDENTITY.md"
  fi

  # Inject SOUL.md
  if [ -f "$INJECT_DIR/soul.md" ]; then
    cp "$INJECT_DIR/soul.md" "$WORKSPACE/SOUL.md"
    echo "  Injected SOUL.md"
  fi

  # Inject memory files (merge into memory/)
  if [ -d "$INJECT_DIR/memory" ]; then
    cp -rn "$INJECT_DIR/memory/"* "$WORKSPACE/memory/" 2>/dev/null || true
    echo "  Injected memory files"
  fi

  # Inject runtime config overrides
  if [ -f "$INJECT_DIR/config-overrides.json" ]; then
    cp "$INJECT_DIR/config-overrides.json" "$WORKSPACE/.atlas-runtime-config.json"
    echo "  Injected runtime config overrides"
  fi

  # Mark as processed
  touch "$INJECT_DIR/.done"
  echo "  Injection complete"
fi

# ── Phase 2d: Projects Directory Symlink ──
# Allow ATLAS_PROJECTS_DIR to customize where projects/ points
if [ -n "${ATLAS_PROJECTS_DIR:-}" ] && [ "$ATLAS_PROJECTS_DIR" != "$WORKSPACE/projects" ]; then
  if [ -d "$ATLAS_PROJECTS_DIR" ]; then
    # Remove default projects dir if it's empty, then symlink
    if [ -d "$WORKSPACE/projects" ] && [ ! -L "$WORKSPACE/projects" ]; then
      if [ -z "$(ls -A "$WORKSPACE/projects" 2>/dev/null)" ]; then
        rmdir "$WORKSPACE/projects"
      fi
    fi
    if [ ! -e "$WORKSPACE/projects" ]; then
      ln -sfn "$ATLAS_PROJECTS_DIR" "$WORKSPACE/projects"
      echo "  Linked projects/ → $ATLAS_PROJECTS_DIR"
    fi
  else
    echo "  ⚠ ATLAS_PROJECTS_DIR=$ATLAS_PROJECTS_DIR does not exist"
  fi
fi

# ── Phase 3: Default Config ──
echo "[$(date)] Phase 3: Default config"
if [ ! -f "$WORKSPACE/config.yml" ]; then
  cp /atlas/app/defaults/config.yml "$WORKSPACE/config.yml"
  echo "  Created default config.yml"
fi

# ── Phase 4: Default Crontab ──
echo "[$(date)] Phase 4: Crontab"
if [ ! -f "$WORKSPACE/crontab" ]; then
  cp /atlas/app/defaults/crontab "$WORKSPACE/crontab"
  echo "  Created default crontab"
fi

# ── Phase 5: First-Run Check + Migrations ──
echo "[$(date)] Phase 5: First-run check + migrations"
FIRST_RUN=false

if [ ! -f "$WORKSPACE/IDENTITY.md" ]; then
    FIRST_RUN=true
    echo "  First run detected - creating placeholder IDENTITY.md"

    cp /atlas/app/defaults/IDENTITY.md "$WORKSPACE/IDENTITY.md"

    echo "  Created placeholder IDENTITY.md"
fi

# Soul (separate from identity — internal behavioral philosophy)
if [ ! -f "$WORKSPACE/SOUL.md" ]; then
  cp /atlas/app/defaults/SOUL.md "$WORKSPACE/SOUL.md"
  echo "  Created default SOUL.md"
fi

# Migrate journal files to journal/ subdir
for f in "$WORKSPACE/memory/"[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md; do
  [ -f "$f" ] || continue
  mv "$f" "$WORKSPACE/memory/journal/$(basename $f)"
  echo "  Migrated journal: $(basename $f)"
done

# Migrate stale MCP system.json (inbox-mcp → atlas-mcp rename)
MCP_SYS="$WORKSPACE/.atlas-mcp/system.json"
if [ -f "$MCP_SYS" ] && grep -q "inbox-mcp" "$MCP_SYS" 2>/dev/null; then
  rm -f "$MCP_SYS"
  echo "  Removed stale MCP system.json (inbox-mcp reference)"
fi

# ── Phase 6: Initialize SQLite DB ──
echo "[$(date)] Phase 6: Database init"
DB="$WORKSPACE/.index/atlas.db"

# Always run canonical schema init + migrations (idempotent)
bun -e "import { initDb } from '/atlas/app/lib/atlas-db'; initDb();" || {
  echo "  ⚠ Database init via bun failed (non-fatal)"
}

echo "  Database ready (schema + migrations applied)"

# Migration: remove legacy triggers replaced by static crontab scripts / dreaming.
# - daily-cleanup: ran an empty-prompt Claude session twice daily; the actual
#   DB/JSONL pruning is done by app/triggers/cron/daily-cleanup.sh from the
#   static crontab, not via a trigger session.
# - memory-cleanup: replaced by the dreaming trigger.
sqlite3 "$DB" "DELETE FROM triggers WHERE name IN ('daily-cleanup', 'memory-cleanup');" 2>/dev/null || true

# Ensure dreaming trigger exists (nightly memory consolidation — replaces legacy memory-cleanup)
# model_key='dreaming' routes it to models.dreaming (opus by default) instead of the
# cheaper models.cron — the nightly synthesis is the one place where reasoning depth
# pays off directly, and it runs once a day offline.
sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, schedule, prompt, session_mode, model_key) VALUES (
  'dreaming', 'cron', 'Nightly cognitive consolidation — session replay, memory cleanup, knowledge updates', 'internal', '0 3 * * *', '', 'ephemeral', 'dreaming');" || echo "  ⚠ dreaming trigger insert failed (non-fatal)"

# Upgrade existing containers: adopt the dedicated model key, but never override a
# deliberate user choice (only fills NULL/empty).
sqlite3 "$DB" "UPDATE triggers SET model_key = 'dreaming'
  WHERE name = 'dreaming' AND (model_key IS NULL OR TRIM(model_key) = '');" 2>/dev/null || true

# Create / upgrade the dreaming trigger prompt.
# The workspace copy is user-customizable, so local edits must never be clobbered.
# Upgrade rule: refresh the live file only when we can prove the user never touched
# it — that is, it is byte-identical to the default we last shipped. From now on that
# baseline is recorded next to it in .prompt.shipped.md.
#
# DREAM_KNOWN_SUMS bootstraps the same check for containers created *before*
# .prompt.shipped.md existed, where no baseline is on disk to compare against. It
# holds the sha256 of the last default shipped without tracking, reproducible with:
#   git show 9586dbf:app/defaults/triggers/dreaming/prompt.md | sha256sum
# It is a one-time bootstrap and does not need to grow when the default changes
# again: every container running this code writes .prompt.shipped.md, which takes
# over from the checksum path on all later upgrades.
mkdir -p "$WORKSPACE/triggers/dreaming"
DREAM_DEFAULT=/atlas/app/defaults/triggers/dreaming/prompt.md
DREAM_LIVE="$WORKSPACE/triggers/dreaming/prompt.md"
DREAM_SHIPPED="$WORKSPACE/triggers/dreaming/.prompt.shipped.md"
DREAM_KNOWN_SUMS="08b72de4346e3015ef143d96bba42c033b301dcfc77fc0286a89f47e9500d30c"

if [ ! -f "$DREAM_LIVE" ]; then
  cp "$DREAM_DEFAULT" "$DREAM_LIVE"
  cp "$DREAM_DEFAULT" "$DREAM_SHIPPED"
  echo "  Created dreaming trigger prompt"
else
  DREAM_UNMODIFIED=0
  if [ -f "$DREAM_SHIPPED" ] && cmp -s "$DREAM_LIVE" "$DREAM_SHIPPED"; then
    DREAM_UNMODIFIED=1
  else
    DREAM_LIVE_SUM=$(sha256sum "$DREAM_LIVE" 2>/dev/null | cut -d' ' -f1 || true)
    for known in $DREAM_KNOWN_SUMS; do
      if [ "$DREAM_LIVE_SUM" = "$known" ]; then
        DREAM_UNMODIFIED=1
      fi
    done
  fi

  if [ "$DREAM_UNMODIFIED" = "1" ]; then
    if cmp -s "$DREAM_DEFAULT" "$DREAM_LIVE"; then
      : # already current
    else
      cp "$DREAM_DEFAULT" "$DREAM_LIVE"
      echo "  Upgraded dreaming trigger prompt (workspace copy was unmodified)"
    fi
    cp "$DREAM_DEFAULT" "$DREAM_SHIPPED"
  else
    echo "  Kept customized dreaming trigger prompt — new default at $DREAM_DEFAULT"
  fi
fi

# Always refresh dreaming trigger filter — system-managed (not user-customizable),
# so we overwrite on every init to ensure upgrades reach existing containers.
cp /atlas/app/defaults/triggers/dreaming/filter.sh "$WORKSPACE/triggers/dreaming/filter.sh"
chmod +x "$WORKSPACE/triggers/dreaming/filter.sh"

# Ensure web-chat trigger exists (idempotent migration)
sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, prompt, session_mode) VALUES (
  'web-chat', 'manual', 'Web UI chat message handler', 'web', '', 'persistent');" || echo "  ⚠ web-chat trigger insert failed (non-fatal)"

# Ensure whatsapp-chat trigger exists (idempotent migration)
sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, prompt, session_mode) VALUES (
  'whatsapp-chat', 'webhook', 'WhatsApp messenger conversations', 'whatsapp', '', 'persistent');" || echo "  ⚠ whatsapp-chat trigger insert failed (non-fatal)"

# Create web-chat spawn prompt
mkdir -p "$WORKSPACE/triggers/web-chat"
if [ ! -f "$WORKSPACE/triggers/web-chat/prompt.md" ]; then
  cat > "$WORKSPACE/triggers/web-chat/prompt.md" << 'WCPROMPT'
New web UI message:

{{payload}}

Reply to the user's "message" field conversationally.
WCPROMPT
  echo "  Created web-chat trigger prompt"
fi

# ── Phase 7: User Extensions ──
echo "[$(date)] Phase 7: User extensions"
if [ -f "$WORKSPACE/user-extensions.sh" ]; then
  echo "  Running user-extensions.sh..."
  bash "$WORKSPACE/user-extensions.sh" || echo "  ⚠ user-extensions.sh failed (non-fatal)"
else
  # Create empty template
  cat > "$WORKSPACE/user-extensions.sh" << 'EXTENSIONS'
#!/bin/bash
# User Extensions — runs on every container start.
# Use for custom setup, e.g.:
#
# brew install signal-cli             # system packages (no root needed)
# pip install some-package           # python packages
# git config --global user.name "…"  # configuration
#
# Changes take effect on next container restart.
EXTENSIONS
  echo "  Created user-extensions.sh template"
fi

# ── Phase 7b: Task System ──
echo "[$(date)] Phase 7b: Atlas task management system (atlas.db)"
# Task tables (goals, tasks, task_deps, goal_validations) are created by atlas-db.ts
# initDb() which runs in Phase 7a above. Log a quick sanity check.
TASK_TABLES=$(sqlite3 "$HOME/.index/atlas.db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('goals','tasks','task_deps','goal_validations');" 2>/dev/null) || TASK_TABLES=0
echo "  Task management tables ready: ${TASK_TABLES}/4"

# ── Phase 8: Agent backend configuration ──
# Regenerated on every start to pick up config.yml changes: hooks, permissions,
# plugins, skill and agent locations (and ATLAS_DEFAULT_SKILLS_DIR /
# ATLAS_DEFAULT_AGENTS_DIR installs) of the configured harness backend.
echo "[$(date)] Phase 8: Agent backend configuration"
bun run /atlas/app/triggers/harness/configure.ts || echo "  ⚠ Agent backend configuration failed (non-fatal)"

# ── Phase 9: Sync Crontab from Triggers ──
echo "[$(date)] Phase 9: Crontab sync"
bun run /atlas/app/triggers/sync-crontab.ts || echo "  ⚠ Crontab sync failed (non-fatal)"

# ── Phase 9b: Auto-setup email poller (if email is configured) ──
# Check runtime config + config.yml for imap_host. If set, provision the
# email-poller supervisord service and email-handler trigger automatically.
# This handles pod restarts where the runtime config already exists.
echo "[$(date)] Phase 9b: Email poller setup"
_imap_host=""
# Check runtime config first (higher priority)
if [ -f "$WORKSPACE/.atlas-runtime-config.json" ]; then
  _imap_host=$(python3 -c "
import json, sys
try:
    d = json.load(open('$WORKSPACE/.atlas-runtime-config.json'))
    print(d.get('email', {}).get('imap_host', ''))
except: pass
" 2>/dev/null || true)
fi
# Fall back to config.yml
if [ -z "$_imap_host" ] && [ -f "$WORKSPACE/config.yml" ]; then
  _imap_host=$(python3 -c "
import sys
try:
    import yaml
    d = yaml.safe_load(open('$WORKSPACE/config.yml')) or {}
    print(d.get('email', {}).get('imap_host', ''))
except: pass
" 2>/dev/null || true)
fi
# Also check env var override
if [ -z "$_imap_host" ] && [ -n "${ATLAS_EMAIL_IMAP_HOST:-}" ]; then
  _imap_host="$ATLAS_EMAIL_IMAP_HOST"
fi

if [ -n "$_imap_host" ]; then
  echo "  Email configured (host=$_imap_host) — provisioning email-poller"
  mkdir -p "$WORKSPACE/supervisor.d" "$WORKSPACE/triggers/email-handler"

  # Write supervisor conf (idempotent)
  cat > "$WORKSPACE/supervisor.d/email-poller.conf" << 'SUPEOF'
[program:email-poller]
command=/atlas/app/bin/email poll
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/email-poller.log
stderr_logfile=/atlas/logs/email-poller-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
SUPEOF

  # Add email-handler trigger (idempotent).
  # prompt uses {{payload}} so the trigger-runner injects the email JSON;
  # the channel system prompt (trigger-channel-email.md) provides all behavioral context.
  if [ -f "$DB" ]; then
    sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, prompt, session_mode) VALUES ('email-handler', 'webhook', 'Email conversations (IMAP)', 'email', '{{payload}}', 'persistent');" 2>/dev/null || true
  fi
  echo "  Email poller provisioned (will start with supervisord in Phase 10)"
else
  echo "  Email not configured — skipping email-poller setup"
fi

# ── Phase 10: Start Services ──
echo "[$(date)] Phase 10: Starting services"
supervisorctl start web-ui || true

# Check pause state before starting cron
if [ -f "$WORKSPACE/.atlas-paused" ]; then
  echo "  ⚠ Atlas is PAUSED — skipping supercronic. Use API POST /api/v1/control/resume to unpause."
else
  supervisorctl start supercronic || true
fi

# ── Phase 11: Resume interrupted trigger sessions ──
echo "[$(date)] Phase 11: Resuming interrupted triggers"
if [ -f "$DB" ]; then
  # Claim interrupted runs atomically: concurrent boots each get a disjoint set,
  # so a run is recovered exactly once.
  INTERRUPTED=$(sqlite3 -json "$DB" \
    "UPDATE trigger_runs SET completed_at=datetime('now') WHERE completed_at IS NULL RETURNING id, trigger_name, session_key, session_mode, session_id, payload;" 2>/dev/null || echo "[]")
  INTERRUPTED="${INTERRUPTED:-[]}"

  echo "$INTERRUPTED" | python3 -c "
import json, sys, subprocess, os
rows = json.loads(sys.stdin.read())
for row in rows:
    rid = row['id']
    name = row['trigger_name']
    key = row['session_key']
    mode = row['session_mode']
    sid = row.get('session_id') or ''
    payload = row.get('payload') or ''

    if mode == 'persistent' and sid:
        # Re-fire with recovery payload — trigger.sh will --resume the session
        recovery = 'Session resumed after container restart. Continue where you left off.'
        print(f'  Resuming persistent session: {name} (key={key}, session={sid})')
        subprocess.Popen(
            ['/atlas/app/triggers/trigger.sh', name, recovery, key],
            stdout=open(f'/atlas/logs/trigger-{name}.log', 'a'),
            stderr=subprocess.STDOUT,
            start_new_session=True
        )
    elif payload:
        # Re-fire with stored payload — starts fresh
        print(f'  Re-firing ephemeral trigger: {name} (key={key})')
        subprocess.Popen(
            ['/atlas/app/triggers/trigger.sh', name, payload, key],
            stdout=open(f'/atlas/logs/trigger-{name}.log', 'a'),
            stderr=subprocess.STDOUT,
            start_new_session=True
        )
    else:
        print(f'  Skipping unrecoverable run #{rid}: {name} (no session_id or payload)')
" 2>/dev/null || echo "  ⚠ Trigger resume failed (non-fatal)"
fi

echo "[$(date)] $AGENT_NAME init complete. First run: $FIRST_RUN"
echo "[$(date)] Dashboard: http://127.0.0.1:8080"

exit 0
