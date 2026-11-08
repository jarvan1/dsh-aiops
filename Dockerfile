# ---- Build stage: install, compile, and prepare the GitHub source bundle ----
FROM node:24-slim AS build
WORKDIR /build
RUN corepack enable \
  && corepack prepare pnpm@11.7.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json cordis.patch.yml ./
COPY scripts ./scripts
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
  && pnpm run build:github

# ---- Runtime stage: DSH Web profile with the AIOps bundle installed ----
FROM node:24-slim
RUN corepack enable \
  && corepack prepare pnpm@11.7.0 --activate \
  && npm install --global --silent @deepseek-ai/dsh@0.2.2-rc.1
WORKDIR /opt/dsh-aiops
COPY --from=build /build /opt/dsh-aiops
# Seed the Web profile at build time so the first container boot needs no network.
RUN DSH_HOME=/opt/dsh-aiops-seed dsh plugin --profile web add link:/opt/dsh-aiops
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

ENV DSH_HOME=/data \
    AIOPS_WEBHOOK_PORT=3081 \
    DSH_WEB_PORT=8080

# Sessions, SQLite stores, settings, and .credentials.yaml all live here.
VOLUME /data
EXPOSE 8080 3081
ENTRYPOINT ["docker-entrypoint.sh"]
