#!/bin/bash
# Entrypoint: fix home directory permissions, then start supervisord.
# Runs as agent user (Dockerfile USER directive).
set -e

# Fix ownership once per volume, not on every start: walking every inode on a
# large network volume can outlast a startup probe. The marker records a
# completed pass; delete it to force another. The agent user may lack
# CAP_CHOWN, so a root-owned workspace file must not prevent startup.
# Exclude lost+found (ext4 journal dir, root-owned, may not be chownable)
OWNERSHIP_MARKER=/home/agent/.ownership-fixed
if [ ! -O "$OWNERSHIP_MARKER" ]; then
  if find /home/agent -mindepth 1 -path /home/agent/lost+found -prune -o \( ! -user agent -o ! -group agent \) -exec chown -h agent:agent {} +; then
    touch "$OWNERSHIP_MARKER"
  else
    echo "WARNING: Could not fix ownership of some workspace files; continuing startup. Check the ownership errors above if services fail." >&2
  fi
  chown agent:agent /home/agent 2>/dev/null || true
fi

# Resolve agent display name: AGENT_NAME env > config.yml agent.name > "Atlas"
if [ -z "${AGENT_NAME:-}" ]; then
  if [ -f "/home/agent/config.yml" ]; then
    AGENT_NAME=$(grep -A1 '^agent:' "/home/agent/config.yml" 2>/dev/null | grep 'name:' | sed 's/.*name: *"\?\([^"#]*\)"\?.*/\1/' | xargs) || true
  fi
fi
export AGENT_NAME="${AGENT_NAME:-Atlas}"

# Start supervisord directly as agent — all env vars are inherited naturally
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/atlas.conf
