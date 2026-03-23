# ============================================================
# Stage 1: Compile trigger-runner to a native Bun binary
# ============================================================
FROM oven/bun:1 AS trigger-builder

WORKDIR /build

# Copy package files and install dependencies
COPY app/triggers/package.json app/triggers/bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source files: trigger-runner + lib/config.ts (imported via ../lib/config.ts)
COPY app/triggers/trigger-runner.ts ./triggers/
COPY app/lib/config.ts ./lib/

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
# Claude CLI is installed at runtime via init.sh
# (too heavy for Kaniko on 8GB workers; will move to image when builder
# nodes are available via Hetzner limit increase).
RUN apt-get update && apt-get install -y --no-install-recommends \
  curl wget git jq ripgrep \
  supervisor \
  nginx \
  sqlite3 \
  python3 python3-pip \
  chromium-browser \
  openssh-client \
  ca-certificates \
  unzip xz-utils sudo \
  ffmpeg \
  pandoc \
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
  && ln -sf "$(which agent-browser)" /usr/local/bin/browser \
  && npm cache clean --force

ENV PATH="/atlas/app/bin:/home/agent/bin:${PATH}"
ENV HOME=/home/agent

# Create directory structure
RUN mkdir -p /atlas/app/hooks \
  /atlas/app/prompts \
  /atlas/app/triggers/cron \
  /atlas/app/atlas-mcp \
  /atlas/app/web-ui \
  /atlas/app/defaults/skills \
  /home/agent/memory/projects \
  /home/agent/memory/journal \
  /home/agent/.index \
  /home/agent/projects \
  /home/agent/skills \
  /home/agent/agents \
  /home/agent/mcps \
  /home/agent/triggers \
  /home/agent/secrets \
  /home/agent/helpers \
  /atlas/logs

# Copy application code
COPY app/ /atlas/app/
COPY .claude/settings.json /atlas/app/.claude/settings.json

# Copy compiled trigger-runner native binary from build stage
COPY --from=trigger-builder /build/triggers/trigger-runner /atlas/app/triggers/trigger-runner

# Set permissions + install all bun deps + nginx/supervisor config in one layer
RUN chmod +x /atlas/app/entrypoint.sh \
  && chmod +x /atlas/app/init.sh \
  && chmod +x /atlas/app/hooks/*.sh \
  && chmod +x /atlas/app/triggers/cron/*.sh \
  && chmod +x /atlas/app/triggers/trigger-runner \
  && chmod +x /atlas/app/bin/* \
  && cd /atlas/app/lib && bun install \
  && cd /atlas/app/atlas-mcp && bun install \
  && cd /atlas/app/triggers && bun install \
  && cd /atlas/app/integrations/whatsapp && bun install \
  && cd /atlas/app/web-ui && bun install

# Copy supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/atlas.conf

# Nginx config + symlinks + ownership (one final layer)
COPY app/nginx.conf /etc/nginx/sites-available/atlas
RUN ln -sf /etc/nginx/sites-available/atlas /etc/nginx/sites-enabled/atlas \
  && rm -f /etc/nginx/sites-enabled/default \
  && ln -s /home/agent /home/atlas \
  && chown -R agent:agent /atlas /home/agent \
  && (chown -R agent:agent /var/run 2>/dev/null || true) \
  && chown -R agent:agent /var/log/nginx /var/lib/nginx \
  && chown -R agent:agent /etc/supervisor

WORKDIR /home/agent

EXPOSE 8080

# Entrypoint runs as root to fix volume permissions, then drops to agent
ENTRYPOINT ["/atlas/app/entrypoint.sh"]
