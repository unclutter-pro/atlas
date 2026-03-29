---
name: dependencies
description: How to install packages in the container. Use Nix for system packages (no root needed), pip for Python, bun for JS/TS.
---

# Installing Dependencies

You run inside a Docker container **without root or sudo access**. Use **Nix** as the package manager.

## System Packages (via Nix)

Nix is installed in single-user mode. Install packages directly:

```bash
nix-env -iA nixpkgs.<package>
```

Examples:
```bash
nix-env -iA nixpkgs.imagemagick
nix-env -iA nixpkgs.yt-dlp
```

Search for packages: `nix-env -qaP | grep <name>` or check https://search.nixos.org/packages

To remove a package:
```bash
nix-env -e <package>
```

## Python Packages

```bash
pip install <package>
```

## Bun / Node.js Packages

For JavaScript/TypeScript dependencies:
- Project-local: `cd /some/project && bun add <package>`
- Global: `bun add -g <package>`

## Persistent Installation

Edit `~/user-extensions.sh` to add install commands that run on every container start:

```bash
#!/bin/bash
nix-env -iA nixpkgs.imagemagick
pip install some-package
```

Use this for packages you always need — they'll be reinstalled automatically after restarts.

## Gotchas

- **Do NOT use `apt-get`** — it requires root, which is not available in the container. Always use `nix-env` for system packages.
- **Do NOT use `sudo`** — it is blocked by the container's security policy (`allowPrivilegeEscalation: false`).
- `nix-env -qaP` can be slow on first run (downloads channel index). Be patient or use https://search.nixos.org/packages instead.
- Some Nix package names differ from their apt equivalents (e.g. `nixpkgs.python3` not `nixpkgs.python3-pip`). Search first if unsure.
- The container has no Docker daemon — you cannot run `docker` commands.

## Troubleshooting

**`nix-env: command not found`**
-> Nix profile not in PATH. Run: `source ~/.nix-profile/etc/profile.d/nix.sh`

**`error: file 'nixpkgs' was not found in the Nix search path`**
-> Channel not configured. Run: `nix-channel --add https://nixos.org/channels/nixpkgs-unstable nixpkgs && nix-channel --update`

**Package installed but binary not found**
-> New shell sessions pick up nix PATH automatically. In current session, run: `export PATH="$HOME/.nix-profile/bin:$PATH"` or start a new shell.

**`error: this derivation is not meant to be built`**
-> You're likely using the wrong attribute path. Try `nix-env -qaP | grep <name>` to find the exact attribute.

## Pre-installed

Bun, Node.js, Python, git, sqlite3, curl, jq, ripgrep, ffmpeg, pandoc, typst, chromium, browser (headless web browsing CLI)
