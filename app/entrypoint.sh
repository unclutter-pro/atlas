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

# ── Persist Nix store in workspace ──
# /nix is a symlink to ~/.nix (set up in Dockerfile).
# On first boot, seed from /nix-base (base image packages).
# On subsequent boots, ~/.nix already has all installed packages.
if [ -d /nix-base ] && [ ! -d /home/agent/.nix/store ]; then
  echo "Seeding nix store from base image..."
  mkdir -p /home/agent/.nix
  cp -a /nix-base/* /home/agent/.nix/
  chown -R agent:agent /home/agent/.nix 2>/dev/null || true
fi
# Ensure symlink exists (overlay reset may restore /nix as directory)
if [ ! -L /nix ] && [ -d /home/agent/.nix/store ]; then
  rm -rf /nix 2>/dev/null
  ln -s /home/agent/.nix /nix
fi

# Start supervisord directly as agent — all env vars are inherited naturally
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/atlas.conf
