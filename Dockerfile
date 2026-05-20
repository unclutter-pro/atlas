# ============================================================
# Stage 1: Compile trigger-runner to a native Bun binary
# ============================================================
FROM oven/bun:1 AS trigger-builder

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy package files and install dependencies
COPY app/triggers/package.json app/triggers/bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source files: trigger-runner + lib imports (config.ts, db.ts)
COPY app/triggers/trigger-runner.ts ./triggers/
COPY app/lib/config.ts ./lib/
COPY app/lib/db.ts ./lib/

# Compile to native binary (auto-detect architecture)
RUN ARCH=$(uname -m) && \
  if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then BUN_TARGET="bun-linux-arm64"; \
  else BUN_TARGET="bun-linux-x64"; fi && \
  cd triggers && \
  bun build --compile --target=${BUN_TARGET} trigger-runner.ts --outfile trigger-runner

# ============================================================
# Stage 2: Main application image
# ============================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Europe/Berlin

# ---- Single mega-install layer ----
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
  curl wget git jq ripgrep \
  supervisor \
  nginx \
  sqlite3 \
  python3 python3-pip \
  openssh-client \
  ca-certificates \
  unzip xz-utils sudo \
  ffmpeg \
  pandoc libreoffice imagemagick \
  gnupg build-essential procps \
  && rm -rf /var/lib/apt/lists/* \
  # --- Create non-root user ---
  && useradd -m -s /bin/bash -G sudo agent \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  # --- Node.js 22 ---
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/* \
  # --- Bun ---
  && ARCH=$(dpkg --print-architecture) \
  && if [ "$ARCH" = "arm64" ]; then BUN_ARCH="aarch64"; else BUN_ARCH="x64"; fi \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-${BUN_ARCH}.zip" -o /tmp/bun.zip \
  && unzip -o /tmp/bun.zip -d /tmp/bun-extract \
  && mv /tmp/bun-extract/*/bun /usr/local/bin/bun \
  && chmod +x /usr/local/bin/bun \
  && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
  && rm -rf /tmp/bun.zip /tmp/bun-extract \
  # --- Supercronic ---
  && SUPERCRONIC_URL="https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-${ARCH}" \
  && curl -fsSL "$SUPERCRONIC_URL" -o /usr/local/bin/supercronic \
  && chmod +x /usr/local/bin/supercronic \
  # --- Typst ---
  && TYPST_VERSION="0.14.2" \
  && if [ "$ARCH" = "arm64" ]; then TYPST_ARCH="aarch64"; else TYPST_ARCH="x86_64"; fi \
  && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${TYPST_ARCH}-unknown-linux-musl.tar.xz" \
  | tar -xJ --strip-components=1 -C /usr/local/bin "typst-${TYPST_ARCH}-unknown-linux-musl/typst" \
  && chmod +x /usr/local/bin/typst \
  # --- npm globals ---
  && npm install -g agent-browser \
  # Install chrome (for arm64 no native install is possible)
  && if [ "$ARCH" = "arm64" ]; \
  # Install for add-apt-repository (only ARM64)
  then wget https://launchpad.net/~xtradeb/+archive/ubuntu/apps/+files/xtradeb-apt-source_0.6_all.deb \
  && apt install ./xtradeb-apt-source_0.6_all.deb \
  && rm ./xtradeb-apt-source_0.6_all.deb \
  && apt-get install -y chromium chromium-driver \
  && rm -rf /var/lib/apt/lists/*; \
  else agent-browser install; fi \
  && ln -sf "$(which agent-browser)" /usr/local/bin/browser \
  && npm cache clean --force \
  # --- Python packages (used by messaging addons for config parsing) ---
  && pip install --break-system-packages pyyaml html2text \
  # --- Claude Code CLI ---
  && npm install -g @anthropic-ai/claude-code \
  && claude --version \
  # --- LiteParse CLI (OCR on Client) ---
  && npm i -g @llamaindex/liteparse \
  # --- Beads (bd) — kept available so existing sessions can migrate themselves.
  #     Hooks no longer invoke it; the `task` CLI is the system path.
  && npm i -g @beads/bd@0.63.3 \
  # --- RTK (Rust Token Killer) — CLI proxy for 60-90% token savings ---
  && RTK_VERSION="0.38.0" \
  && if [ "$ARCH" = "arm64" ]; then RTK_ARCH="aarch64-unknown-linux-gnu"; else RTK_ARCH="x86_64-unknown-linux-musl"; fi \
  && curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-${RTK_ARCH}.tar.gz" \
  | tar -xz -C /usr/local/bin rtk \
  && chmod +x /usr/local/bin/rtk \
  # --- Homebrew — installed directly into agent home dir for persistence ---
  && mkdir -p /home/agent/.homebrew \
  && curl -fsSL https://github.com/Homebrew/brew/tarball/master \
  | tar xz --strip-components 1 -C /home/agent/.homebrew \
  && /home/agent/.homebrew/bin/brew --version

ENV PATH="/home/agent/.homebrew/bin:/atlas/app/bin:/home/agent/bin:${PATH}"
ENV HOME=/home/agent
ENV BEADS_DIR=/home/agent/.beads
ENV HOMEBREW_NO_AUTO_UPDATE=1
ENV HOMEBREW_NO_ANALYTICS=1

# Create directory structure
# /home/agent — agent-owned workspace (mounted as volume)
# /atlas/app  — system code, root-owned (agent has read+execute only)
# /atlas/logs — root:agent, group-writable (agent can write but not tamper)
RUN mkdir -p /atlas/app /atlas/logs \
  /home/agent/memory/projects \
  /home/agent/memory/journal \
  /home/agent/.index \
  /home/agent/projects \
  /home/agent/mcps \
  /home/agent/triggers \
  /home/agent/secrets \
  /home/agent/helpers \
  && chown -R agent:agent /home/agent \
  && chown -R root:agent /atlas/logs && chmod -R 775 /atlas/logs \
  && ln -s /home/agent /home/atlas

# Copy application code (root-owned — agent should not modify system code)
COPY app/ /atlas/app/

# Install default skills and agents as system-level policy (SDK reads /etc/claude-code/.claude/...)
COPY app/defaults/skills/ /etc/claude-code/.claude/skills/
COPY app/defaults/agents/ /etc/claude-code/.claude/agents/
COPY .claude/settings.json /atlas/app/.claude/settings.json
COPY supervisord.conf /etc/supervisor/conf.d/atlas.conf
COPY app/nginx.conf /etc/nginx/sites-available/atlas

# Copy compiled trigger-runner native binary from build stage
COPY --from=trigger-builder /build/triggers/trigger-runner /atlas/app/triggers/trigger-runner

# Set permissions, install bun deps, configure nginx/supervisor (single layer)
RUN chmod +x /atlas/app/entrypoint.sh \
  && chmod +x /atlas/app/init.sh \
  && chmod +x /atlas/app/hooks/*.sh \
  && chmod +x /atlas/app/triggers/cron/*.sh \
  && chmod +x /atlas/app/triggers/trigger-runner \
  && chmod +x /atlas/app/bin/* \
  && cd /atlas/app/lib && bun install \
  && cd /atlas/app/triggers && bun install \
  && cd /atlas/app/integrations/whatsapp && bun install \
  && cd /atlas/app/web-ui && bun install \
  && ln -sf /etc/nginx/sites-available/atlas /etc/nginx/sites-enabled/atlas \
  && rm -f /etc/nginx/sites-enabled/default \
  && mkdir -p /var/log/nginx /var/lib/nginx/body \
  && chown -R root:agent /var/log/nginx /var/lib/nginx \
  && chmod -R 775 /var/log/nginx /var/lib/nginx \
  && chown -R root:agent /etc/supervisor && chmod -R 775 /etc/supervisor \
  && sed -i 's|pid /run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf \
  && ln -sf /etc/supervisor/conf.d/atlas.conf /etc/supervisor/supervisord.conf

WORKDIR /home/agent
EXPOSE 8080

# Run as non-root agent user. Homebrew handles package installs without root.
# sudo is available as fallback for Docker Compose (blocked in K8s by securityContext).
USER agent
ENTRYPOINT ["/atlas/app/entrypoint.sh"]
