---
name: dependencies
description: How to install packages in the container. Use Nix for system packages (no root needed), pip for Python, bun for JS/TS.
---

# Installing Dependencies

You run inside a Docker container with **Nix** as the package manager. No root/sudo needed.

## System Packages (via Nix)

Nix is installed in single-user mode. Install packages directly:

```bash
nix-env -iA nixpkgs.<package>
```

Examples:
```bash
nix-env -iA nixpkgs.signal-cli
nix-env -iA nixpkgs.imagemagick
nix-env -iA nixpkgs.yt-dlp
```

Search for packages: `nix-env -qaP | grep <name>` or check https://search.nixos.org/packages

Nix packages persist across container restarts when `/nix` is mounted as a volume.

To remove a package:
```bash
nix-env -e <package>
```

## Python Packages

```bash
pip install <package>
```

Note: pip installs go to `/home/agent/.local` and persist if the home volume is mounted.

## Bun / Node.js Packages

For JavaScript/TypeScript dependencies:
- Project-local: `cd /some/project && bun add <package>`
- Global: `bun add -g <package>`

## Important

- **Use `nix-env`** for system packages — do NOT use `apt-get` (requires root, which is not available)
- Nix packages are stored in `/nix` — mount it as a volume for persistence
- The container has no Docker daemon — you cannot run `docker` commands
- Pre-installed: Bun, Node.js, Python, git, sqlite3, curl, jq, ripgrep, ffmpeg, pandoc, typst
