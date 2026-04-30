#!/bin/bash
# Skip dreaming if no Claude Code sessions ran in the last 24 hours.
# Exit 0 = fire, Exit 1 = skip.

CLAUDE_DIR="$HOME/.claude/projects"
[ ! -d "$CLAUDE_DIR" ] && exit 1

# Check for main session files (not subagents) modified in last 24h (1440 min)
FOUND=$(find "$CLAUDE_DIR" -maxdepth 2 -name "*.jsonl" -not -path "*/subagents/*" -mmin -1440 2>/dev/null | head -1)

if [ -n "$FOUND" ]; then
    exit 0
else
    echo "[$(date)] Dreaming skipped — no sessions in last 24h" >> /atlas/logs/trigger-dreaming.log
    exit 1
fi
