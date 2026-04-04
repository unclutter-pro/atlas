#!/bin/bash
# Wrapper around nix-env that auto-persists the nix store after modifications.
# Ensures packages installed at runtime survive container restarts.
# Installed to /usr/local/bin/nix-env by the Dockerfile.
set -eo pipefail

REAL_NIX_ENV="$(readlink -f "$HOME/.nix-profile/bin/nix-env")"
NIX_BACKUP="$HOME/.nix"

# Run the real nix-env
"$REAL_NIX_ENV" "$@"
exit_code=$?

# Persist store after state-changing operations
if [ $exit_code -eq 0 ]; then
  case "$*" in
    *-i*|*--install*|*-e*|*--uninstall*|*-u*|*--upgrade*|*--rollback*|*--set-flag*)
      mkdir -p "$NIX_BACKUP"
      cp -au /nix/* "$NIX_BACKUP/" 2>/dev/null || true
      ;;
  esac
fi

exit $exit_code
