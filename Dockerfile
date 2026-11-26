# Stage 1: Copy Docker CLI & Compose plugin so Darkin can deploy Docker projects when docker.sock is mounted
FROM docker:28-cli AS docker-cli

# Stage 2: Install production dependencies with Bun cache
FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 3: Final runtime image
FROM oven/bun:1-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    rsync \
    tini \
    unzip \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'

# Docker CLI + Compose plugin (used when /var/run/docker.sock is mounted)
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data /workspace

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7554 \
    DARKIN_DB=/app/data/darkin.sqlite \
    DARKIN_WORKDIR=/workspace

EXPOSE 7554

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-7554}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
