# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/design-system/package.json packages/design-system/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG APP_VERSION=0.1.0
ARG GIT_COMMIT_SHA=unknown
ARG BUILD_TIMESTAMP=unknown
ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/data \
    DATABASE_URL=file:/data/database/oloka-dev.db \
    APP_VERSION=${APP_VERSION} \
    GIT_COMMIT_SHA=${GIT_COMMIT_SHA} \
    BUILD_TIMESTAMP=${BUILD_TIMESTAMP} \
    LOG_LEVEL=info
WORKDIR /app
RUN mkdir -p /data/database && chown -R 1000:1000 /data /app
COPY --from=build --chown=1000:1000 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=1000:1000 /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=1000:1000 /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=1000:1000 /app/packages/contracts/dist ./packages/contracts/dist
USER 1000:1000
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7860/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/server/dist/index.js"]
