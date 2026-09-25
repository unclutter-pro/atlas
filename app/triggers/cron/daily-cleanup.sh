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

# Prune agent sessions inactive for more than 14 days (through the backend's
# session store). Dreaming runs at 03:00 and analyzes recent sessions, so by
# 06:00 they're consolidated; 14 days leave room for re-analysis.
echo "[$(date)] $(/atlas/app/bin/sessions --prune-days 14)"

echo "[$(date)] Daily cleanup done" >> /atlas/logs/cleanup.log
