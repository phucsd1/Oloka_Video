#!/bin/sh
set -eu

: "${HF_S3_ACCESS_KEY_ID:?HF_S3_ACCESS_KEY_ID is required}"
: "${HF_S3_SECRET_ACCESS_KEY:?HF_S3_SECRET_ACCESS_KEY is required}"

export LITESTREAM_ACCESS_KEY_ID="$HF_S3_ACCESS_KEY_ID"
export LITESTREAM_SECRET_ACCESS_KEY="$HF_S3_SECRET_ACCESS_KEY"

node apps/server/dist/startup/bootstrap-database.js

exec litestream replicate \
  -config /etc/litestream.yml \
  -exec "node apps/server/dist/index.js"
