# syntax=docker/dockerfile:1

# The identity/control plane needs Node's built-in SQLite and the TypeScript
# worker, so the builder ships source and `server/run.mjs` starts Next plus the
# realtime gateway and webhook worker as separate processes.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3210 \
    MOBILECLOUD_REALTIME_PORT=3211 \
    MOBILECLOUD_WEB_HOST=0.0.0.0 \
    MOBILECLOUD_DB=/app/data/mobilecloud.db \
    MOBILECLOUD_DATA_ROOT=/app/data

RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid app --shell /usr/sbin/nologin --no-create-home app \
 && mkdir -p /app/data && chown app:app /app/data

COPY --from=builder --chown=app:app /app/.next ./.next
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/server ./server
COPY --from=builder --chown=app:app /app/lib ./lib

USER app
EXPOSE 3210 3211
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/run.mjs", "start"]
