---
name: dependencies
description: Install missing system tools, Python packages, or JavaScript dependencies persistently in the Atlas workspace.
---

# Dependencies

Check whether the command or package already exists before installing it. Keep project dependencies and their lockfiles with the project under `~/projects/`.

## System tools

Use `brew install <package>`. Homebrew lives in `~/.homebrew`, which persists with the home volume. Find package names with `brew search <name>`.

Atlas normally runs without elevation. Docker Compose permits sudo as a fallback; Kubernetes blocks privilege escalation. Prefer Homebrew in both environments. System changes outside the home volume survive a process restart but are lost when the container is replaced.

## Python

Create a project environment instead of modifying Ubuntu's externally managed Python:

```bash
python3 -m venv ~/projects/my-project/.venv
~/projects/my-project/.venv/bin/python -m pip install requests
~/projects/my-project/.venv/bin/python script.py
```

Record dependencies in the project's requirements or package metadata. Recreate the environment from that file if an image update changes Python's version.

## JavaScript and TypeScript

Install in the project directory with its existing package manager:

```bash
cd ~/projects/my-project
npm install docx
# For a Bun project, use bun add docx instead.
```

Use project-local executables via `npm exec -- <command>` or `bun run <script>`. Keep the lockfile. Avoid global installs into root-owned system paths.

## Startup provisioning

`~/user-extensions.sh` runs on every container start as the agent user. Use it only for idempotent setup that cannot be kept in the home volume. Do not reinstall persistent project packages on every startup.

The image already includes Bun, Node.js, Python, git, sqlite3, curl, jq, ripgrep, FFmpeg, pandoc, Typst, LibreOffice, ImageMagick, Poppler, LiteParse (`lit`), and `browser`. Check `command -v <tool>` before adding dependencies. There is no Docker daemon inside Atlas.
