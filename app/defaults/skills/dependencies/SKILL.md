---
name: dependencies
description: Install system packages, Python libs, or JS/TS modules. Use when you need a tool or library that isn't pre-installed, or when the user asks to install something.
---

# Installing Dependencies

You have **no root or sudo access**. Everything outside `~/` (`/home/agent/`) is lost on container restart. Use the tools below to install what you need.

| What | How | Example |
|------|-----|---------|
| System packages | `nix-env -iA nixpkgs.<pkg>` | `nix-env -iA nixpkgs.imagemagick` |
| Python packages | `pip install <pkg>` | `pip install requests` |

Search for Nix packages: `nix-env -qaP | grep <name>` or https://search.nixos.org/packages

Remove a Nix package: `nix-env -e <package>`

## Survive Restarts

Packages installed at runtime are lost on container restart. To make them persistent, add your install commands to `~/user-extensions.sh`:

```bash
#!/bin/bash
nix-env -iA nixpkgs.imagemagick
pip install requests
```

This script runs automatically on every container start.

## Gotchas

- **Never use `apt-get` or `sudo`** — you don't have access. Use `nix-env` instead.
- Nix package names can differ from apt (e.g. `nixpkgs.python3` not `python3-pip`). Search first.
- First `nix-env -qaP` is slow (downloads index). Use the web search instead.
- No Docker daemon available — you cannot run `docker` commands.

## Pre-installed

Bun, Node.js, Python, git, sqlite3, curl, wget, jq, ripgrep, ffmpeg, pandoc, typst, chromium, browser (headless web CLI — see browser skill)
