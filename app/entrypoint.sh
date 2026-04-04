#!/bin/bash
# Entrypoint: fix home directory permissions, then start supervisord.
# Runs as agent user (Dockerfile USER directive).
set -e

# Fix ownership on home directory volume mount (may be root-owned from host)
# Uses CHOWN capability (granted in pod securityContext) — no sudo needed
# Exclude lost+found (ext4 journal dir, root-owned, may not be chownable)
find /home/agent -maxdepth 1 ! -name lost+found ! -path /home/agent -exec chown -R agent:agent {} + 2>/dev/null
chown agent:agent /home/agent 2>/dev/null || true

# Resolve agent display name: AGENT_NAME env > config.yml agent.name > "Atlas"
if [ -z "${AGENT_NAME:-}" ]; then
  if [ -f "/home/agent/config.yml" ]; then
    AGENT_NAME=$(grep -A1 '^agent:' "/home/agent/config.yml" 2>/dev/null | grep 'name:' | sed 's/.*name: *"\?\([^"#]*\)"\?.*/\1/' | xargs) || true
  fi
fi
export AGENT_NAME="${AGENT_NAME:-Atlas}"

# ── Restore Nix store from persistent backup ──
# /nix/store on the container overlay resets on restart, losing user-installed
# packages. Restore from ~/.nix (persisted by init.sh after user-extensions).
if [ -d /home/agent/.nix/store ]; then
  echo "Restoring nix packages from persistent backup..."
  cp -an /home/agent/.nix/* /nix/ 2>/dev/null || true
fi

# Start supervisord directly as agent — all env vars are inherited naturally
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/atlas.conf
