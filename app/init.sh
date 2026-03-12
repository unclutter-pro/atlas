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
         "$WORKSPACE/.index" \
         "$WORKSPACE/projects" \
         "$WORKSPACE/skills" \
         "$WORKSPACE/agents" \
         "$WORKSPACE/mcps" \
         "$WORKSPACE/triggers" \
         "$WORKSPACE/secrets" \
         "$WORKSPACE/bin" \
         "$WORKSPACE/supervisor.d" \
         "$WORKSPACE/.qmd-cache"

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

# Set up QMD memory collection (idempotent)
if command -v qmd >/dev/null 2>&1; then
  qmd collection add "$WORKSPACE/memory/" --name "atlas-memory" 2>/dev/null || true
  echo "  QMD memory collection configured"
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

# Migrate old flat skill files → directory structure
for old_skill in "$WORKSPACE"/skills/*.md; do
  [ -f "$old_skill" ] || continue
  OLD_NAME=$(basename "$old_skill" .md)
  if [ -d "$WORKSPACE/skills/$OLD_NAME" ]; then
    rm "$old_skill"
    echo "  Migrated skill: removed old $OLD_NAME.md (replaced by $OLD_NAME/SKILL.md)"
  fi
done

# Remove stale system skill copies (now linked from app)
for skill_name in dependencies playwright triggers; do
  [ -d "$WORKSPACE/skills/$skill_name" ] && rm -rf "$WORKSPACE/skills/$skill_name" \
    && echo "  Cleaned up stale system skill: $skill_name"
done

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

# Self-heal: scan workspace for stale /home/atlas references
# Only runs if /home/agent is the actual home (i.e. migration has happened)
SELF_HEAL_MARKER="$WORKSPACE/.index/.self-heal-done"
if [ "$HOME" = "/home/agent" ] && [ ! -f "$SELF_HEAL_MARKER" ]; then
  STALE_FILES=$(grep -rql "/home/atlas" \
    "$WORKSPACE/config.yml" \
    "$WORKSPACE/.claude/" \
    "$WORKSPACE/scripts/" \
    "$WORKSPACE/triggers/" \
    "$WORKSPACE/crontab" \
    "$WORKSPACE/user-extensions.sh" \
    2>/dev/null || true)
  if [ -n "$STALE_FILES" ]; then
    echo "  [WARN] Found /home/atlas references in workspace files:"
    echo "$STALE_FILES" | sed 's/^/    /'
    echo "  Will start self-heal session after services are up"
    export SELF_HEAL_NEEDED=true
  else
    echo "  No stale /home/atlas references found"
    touch "$SELF_HEAL_MARKER"
  fi
fi

# Migrate Claude Code project directories: /home/atlas → /home/agent
# Claude Code stores sessions under .claude/projects/<cwd-slugified>/
# After the home dir rename, old sessions live under -home-atlas but Claude
# now looks under -home-agent. Merge old → new so session resume works.
CLAUDE_PROJECTS="$HOME/.claude/projects"
OLD_PROJECT_DIR="$CLAUDE_PROJECTS/-home-atlas"
NEW_PROJECT_DIR="$CLAUDE_PROJECTS/-home-agent"
if [ -d "$OLD_PROJECT_DIR" ] && [ "$HOME" = "/home/agent" ]; then
  mkdir -p "$NEW_PROJECT_DIR"
  # Move all session files/dirs, skip conflicts (new wins)
  for item in "$OLD_PROJECT_DIR"/*; do
    [ -e "$item" ] || continue
    base=$(basename "$item")
    if [ ! -e "$NEW_PROJECT_DIR/$base" ]; then
      mv "$item" "$NEW_PROJECT_DIR/$base"
    fi
  done
  # Remove old dir if empty
  rmdir "$OLD_PROJECT_DIR" 2>/dev/null && echo "  Migrated Claude projects: -home-atlas → -home-agent" || \
    echo "  Partially migrated Claude projects (some files remain in -home-atlas)"
fi


# ── Phase 6: Initialize SQLite DB ──
echo "[$(date)] Phase 6: Database init"
DB="$WORKSPACE/.index/atlas.db"
FIRST_DB=false
if [ ! -f "$DB" ]; then
  FIRST_DB=true
fi

# Always run canonical schema init + migrations (idempotent)
bun -e "import { initDb } from '/atlas/app/atlas-mcp/db'; initDb();" || {
  echo "  ⚠ Database init via bun failed (non-fatal)"
}

# Seed default trigger on first run
if [ "$FIRST_DB" = true ] && [ -f "$DB" ]; then
  sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, schedule, prompt) VALUES (
    'daily-cleanup', 'cron', 'Daily memory flush and session cleanup', 'internal', '0 6 * * *', '');"
  echo "  Database initialized with default trigger"
else
  echo "  Database ready (schema + migrations applied)"
fi

# Ensure memory-cleanup trigger exists (idempotent)
sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, schedule, prompt, session_mode) VALUES (
  'memory-cleanup', 'cron', 'Daily memory file cleanup and organization', 'internal', '0 7 * * *', '', 'ephemeral');" || echo "  ⚠ memory-cleanup trigger insert failed (non-fatal)"

# Create default memory-cleanup trigger prompt
mkdir -p "$WORKSPACE/triggers/memory-cleanup"
if [ ! -f "$WORKSPACE/triggers/memory-cleanup/prompt.md" ]; then
  cp /atlas/app/defaults/triggers/memory-cleanup/prompt.md "$WORKSPACE/triggers/memory-cleanup/prompt.md"
  echo "  Created memory-cleanup trigger prompt"
fi

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
# Agent User Extensions
# This script runs on every container start.
# Use it to install custom tools, e.g.:
#
# apt-get install -y signal-cli
# pip install some-package
#
# Changes to this file take effect on next container restart.
EXTENSIONS
  echo "  Created user-extensions.sh template"
fi

# ── Phase 8: Claude Code Settings + Discovery Links ──
# Regenerated on every start to pick up model changes from config.yml
echo "[$(date)] Phase 8: Claude Code settings + discovery links"
bun run /atlas/app/hooks/generate-settings.ts || echo "  ⚠ Settings generation failed (non-fatal)"

# Skills: merged real directory with per-skill symlinks
# System skills (from image) + agent-created skills (from home/skills/)
rm -rf "$HOME/.claude/skills"
mkdir -p "$HOME/.claude/skills"
for d in /atlas/app/defaults/skills/*/; do
  [ -d "$d" ] && ln -sfn "$d" "$HOME/.claude/skills/$(basename $d)"
done
for d in "$HOME/skills/"*/; do
  [ -d "$d" ] && ln -sfn "$d" "$HOME/.claude/skills/$(basename $d)"
done
echo "  Skills discovery dir rebuilt: $HOME/.claude/skills/"

# Agents: merged directory with system defaults + user agents
# System agent specs (from image) are copied as defaults, user agents override
rm -rf "$HOME/.claude/agents"
mkdir -p "$HOME/.claude/agents"
for f in /atlas/app/defaults/agents/*.md; do
  [ -f "$f" ] && ln -sfn "$f" "$HOME/.claude/agents/$(basename $f)"
done
for f in "$HOME/agents/"*.md; do
  [ -f "$f" ] && ln -sfn "$f" "$HOME/.claude/agents/$(basename $f)"
done
echo "  Agents discovery dir rebuilt: $HOME/.claude/agents/"

# ── Phase 9: Sync Crontab from Triggers ──
echo "[$(date)] Phase 9: Crontab sync"
bun run /atlas/app/triggers/sync-crontab.ts || echo "  ⚠ Crontab sync failed (non-fatal)"

# ── Phase 10: Start Services ──
echo "[$(date)] Phase 10: Starting services"
supervisorctl start atlas-mcp || true
sleep 1
supervisorctl start playwright-mcp || true
supervisorctl start web-ui || true
supervisorctl start supercronic || true

# ── Phase 11: Resume interrupted trigger sessions ──
echo "[$(date)] Phase 11: Resuming interrupted triggers"
if [ -f "$DB" ]; then
  # Get interrupted runs (started but never completed)
  INTERRUPTED=$(sqlite3 -json "$DB" \
    "SELECT id, trigger_name, session_key, session_mode, session_id, payload FROM trigger_runs WHERE completed_at IS NULL;" 2>/dev/null || echo "[]")

  # Mark all as completed to prevent double-recovery
  sqlite3 "$DB" "UPDATE trigger_runs SET completed_at=datetime('now') WHERE completed_at IS NULL;" 2>/dev/null || true

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

# ── Phase 12: Self-heal stale path references ──
if [ "${SELF_HEAL_NEEDED:-}" = "true" ]; then
  echo "[$(date)] Phase 12: Starting self-heal session for /home/atlas → /home/agent migration"
  SELF_HEAL_PROMPT="Scan the workspace at $HOME for files that contain hardcoded /home/atlas paths and replace them with /home/agent.

Rules:
- Only touch: config files (.yml, .yaml, .json), shell scripts (.sh), markdown (.md), crontab, .claude/ project configs
- NEVER touch: .git/, node_modules/, databases (.db), secrets/, binary files
- Skip files under .index/
- For each file changed, report what was updated
- After all changes, create the marker file: touch $HOME/.index/.self-heal-done

This is an automated migration task. Be thorough but conservative."

  /atlas/app/triggers/trigger.sh "self-heal" "$SELF_HEAL_PROMPT" "self-heal" &
  echo "  Self-heal session started in background"
fi

echo "[$(date)] $AGENT_NAME init complete. First run: $FIRST_RUN"
echo "[$(date)] Dashboard: http://127.0.0.1:8080"

exit 0
