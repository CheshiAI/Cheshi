FROM oven/bun:1.3.14 AS bun-runtime
FROM node:22-bookworm-slim AS specialist-environment

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH
ARG CODEX_VERSION=0.163.0
RUN bun add --global @openai/codex@${CODEX_VERSION} \
    && codex --version \
    && mkdir -p /agent/codex /agent/state /agent/memory /agent/artifacts \
    && chown -R node:node /agent
FROM specialist-environment AS specialist-worker
WORKDIR /app
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node profiles ./profiles
USER node
EXPOSE 8787
CMD ["bun", "src/worker.ts"]
