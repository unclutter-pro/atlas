#!/bin/bash
set -euo pipefail

WORKSPACE="$HOME"
LOG="/atlas/logs/init.log"
exec > >(tee -a "$LOG") 2>&1

echo "[$(date)] Atlas init starting..."

# ── Phase 1: Auth Check ──
echo "[$(date)] Phase 1: Auth check"
if [ -f "$HOME/.claude/.credentials.json" ]; then
  echo "  OAuth credentials found"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  API key configured"
else
  echo "  ⚠ No authentication configured!"
  echo "  Run: docker run -it --rm -v \$(pwd)/volume:/home/atlas atlas claude login"
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

# Migrate inbox/ → .index/
if [ -d "$WORKSPACE/inbox" ] && [ ! -d "$WORKSPACE/.index" ]; then
  mv "$WORKSPACE/inbox" "$WORKSPACE/.index"
  echo "  Migrated inbox/ → .index/"
elif [ -d "$WORKSPACE/inbox" ] && [ -d "$WORKSPACE/.index" ]; then
  # Merge: copy anything not already in .index
  cp -rn "$WORKSPACE/inbox/." "$WORKSPACE/.index/" 2>/dev/null || true
  rm -rf "$WORKSPACE/inbox"
  echo "  Merged inbox/ → .index/ (both existed)"
fi

# ── Phase 6: Initialize SQLite DB ──
echo "[$(date)] Phase 6: Database init"
DB="$WORKSPACE/.index/atlas.db"
FIRST_DB=false
if [ ! -f "$DB" ]; then
  FIRST_DB=true
fi

# Always run canonical schema init + migrations (idempotent)
bun -e "import { initDb } from '/atlas/app/inbox-mcp/db'; initDb();" || {
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

# Ensure web-chat trigger exists (idempotent migration)
sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, prompt, session_mode) VALUES (
  'web-chat', 'manual', 'Web UI chat message handler', 'web', '', 'persistent');" || echo "  ⚠ web-chat trigger insert failed (non-fatal)"

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
# Atlas User Extensions
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

# .mcp.json discovery (Claude Code looks for this in CWD = $HOME)
ln -sf /atlas/app/.mcp.json "$HOME/.mcp.json"
echo "  MCP config symlinked: $HOME/.mcp.json -> /atlas/app/.mcp.json"

# Skills: merged real directory with per-skill symlinks
# System skills (from image) + Atlas-created skills (from home/skills/)
rm -rf "$HOME/.claude/skills"
mkdir -p "$HOME/.claude/skills"
for d in /atlas/app/defaults/skills/*/; do
  [ -d "$d" ] && ln -sfn "$d" "$HOME/.claude/skills/$(basename $d)"
done
for d in "$HOME/skills/"*/; do
  [ -d "$d" ] && ln -sfn "$d" "$HOME/.claude/skills/$(basename $d)"
done
echo "  Skills discovery dir rebuilt: $HOME/.claude/skills/"

# Agents: simple symlink to atlas-created agents dir
rm -f "$HOME/.claude/agents"
ln -sfn "$HOME/agents" "$HOME/.claude/agents"
echo "  Agents symlinked: $HOME/.claude/agents -> $HOME/agents"

# Install built-in review agents (available to reviewer sessions)
if [ -d "/atlas/app/defaults/agents" ]; then
  mkdir -p "$HOME/agents"
  for agent_file in "/atlas/app/defaults/agents"/*.md; do
    [ -f "$agent_file" ] || continue
    agent_name=$(basename "$agent_file")
    # Only install if user hasn't overridden it
    if [ ! -f "$HOME/agents/$agent_name" ]; then
      cp "$agent_file" "$HOME/agents/$agent_name"
      echo "  Agent installed: $agent_name"
    fi
  done
fi

# Disable remote MCP connectors (claudeai-mcp) that cause session hangs.
if [ -f "$HOME/.claude.json" ] && command -v jq &>/dev/null; then
  jq '.cachedGrowthBookFeatures.tengu_claudeai_mcp_connectors = false' \
    "$HOME/.claude.json" > "$HOME/.claude.json.tmp" && mv "$HOME/.claude.json.tmp" "$HOME/.claude.json"
  echo "  Remote MCP connectors disabled in .claude.json"
fi

# ── Phase 9: Sync Crontab from Triggers ──
echo "[$(date)] Phase 9: Crontab sync"
bun run /atlas/app/triggers/sync-crontab.ts || echo "  ⚠ Crontab sync failed (non-fatal)"

# ── Phase 10: Start Services ──
echo "[$(date)] Phase 10: Starting services"
supervisorctl start inbox-mcp || true
sleep 1
supervisorctl start qmd || true
supervisorctl start playwright-mcp || true
supervisorctl start web-ui || true
supervisorctl start watcher || true
supervisorctl start supercronic || true

echo "[$(date)] Atlas init complete. First run: $FIRST_RUN"
echo "[$(date)] Dashboard: http://127.0.0.1:8080"

exit 0
