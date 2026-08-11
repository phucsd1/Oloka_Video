# syntax=docker/dockerfile:1.7
FROM debian:bookworm-slim AS litestream
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.5.11
ARG LITESTREAM_SHA256=2f80fdb6b0a0ff7a116ee37adf02d3de8e977ef76e052b28a6690218f0f7ab55
RUN test "$TARGETARCH" = "amd64" && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    archive="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" && \
    curl --fail --location --silent --show-error \
      --output "/tmp/${archive}" \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${archive}" && \
    echo "${LITESTREAM_SHA256}  /tmp/${archive}" | sha256sum --check --strict && \
    mkdir -p /opt/litestream && \
    tar -xzf "/tmp/${archive}" -C /opt/litestream litestream LICENSE

FROM node:22.16.0-bookworm-slim AS dependencies
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

FROM node:22.16.0-bookworm-slim AS runtime
ARG APP_VERSION=0.1.0
ARG GIT_COMMIT_SHA=unknown
ARG BUILD_TIMESTAMP=unknown
LABEL org.oloka.litestream.version="0.5.11" \
      org.oloka.litestream.archive.sha256="2f80fdb6b0a0ff7a116ee37adf02d3de8e977ef76e052b28a6690218f0f7ab55"
ENV NODE_ENV=production \
    PORT=7860 \
    DATABASE_PATH=/var/lib/oloka/database/oloka.db \
    OBJECT_STORAGE_ROOT=/data \
    HF_S3_ENDPOINT=https://s3.hf.co/phucsd \
    HF_S3_REGION=us-east-1 \
    HF_S3_BUCKET=oloka-video-dev-data \
    HF_S3_SQLITE_PREFIX=sqlite-replica/dev \
    APP_VERSION=${APP_VERSION} \
    GIT_COMMIT_SHA=${GIT_COMMIT_SHA} \
    BUILD_TIMESTAMP=${BUILD_TIMESTAMP} \
    LOG_LEVEL=info
WORKDIR /app
RUN mkdir -p /var/lib/oloka/database /data /etc /usr/share/licenses/litestream && \
    chown -R 1000:1000 /var/lib/oloka /data /app
COPY --from=litestream /opt/litestream/litestream /usr/local/bin/litestream
COPY --from=litestream /opt/litestream/LICENSE /usr/share/licenses/litestream/LICENSE
COPY docker/litestream.yml /etc/litestream.yml
COPY docker/entrypoint.sh /usr/local/bin/oloka-entrypoint
RUN chmod 0555 /usr/local/bin/litestream /usr/local/bin/oloka-entrypoint && \
    chmod 0444 /etc/litestream.yml /usr/share/licenses/litestream/LICENSE
COPY --from=build --chown=1000:1000 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=1000:1000 /app/apps/server/migrations ./apps/server/migrations
COPY --from=build --chown=1000:1000 /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=1000:1000 /app/third_party ./third_party
COPY --from=build --chown=1000:1000 /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=1000:1000 /app/packages/contracts/dist ./packages/contracts/dist
USER 1000:1000
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7860/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/oloka-entrypoint"]
