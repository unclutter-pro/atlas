#!/bin/bash
set -euo pipefail

DB=$HOME/.index/atlas.db

# Prune old data (30 days)
if [ -f "$DB" ]; then
  sqlite3 "$DB" <<'SQL'
    DELETE FROM messages WHERE created_at < datetime('now', '-30 days');
    DELETE FROM trigger_sessions WHERE updated_at < datetime('now', '-30 days');
    DELETE FROM session_metrics WHERE started_at < datetime('now', '-90 days');
    DELETE FROM reminders WHERE status IN ('fired','cancelled') AND fire_at < datetime('now', '-30 days');
SQL
  echo "[$(date)] DB pruned (30-day retention, 90-day metrics)"
fi

# Prune old JSONL session files (>14 days)
# Dreaming runs at 03:00 and analyzes recent sessions, so by 06:00 they're consolidated.
# 14-day window gives enough buffer for re-analysis if needed.
CLAUDE_DIR="$HOME/.claude/projects"
if [ -d "$CLAUDE_DIR" ]; then
  DELETED=$(find "$CLAUDE_DIR" -name "*.jsonl" -mtime +14 -delete -print 2>/dev/null | wc -l)
  echo "[$(date)] JSONL pruned: $DELETED files older than 14 days removed"
fi

echo "[$(date)] Daily cleanup done" >> /atlas/logs/cleanup.log
