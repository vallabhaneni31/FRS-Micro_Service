#!/usr/bin/env bash
# PM2 entrypoint for frs-iam-api/backend/api. Ensures Kafka topics exist
# (idempotent, best-effort — the service itself degrades gracefully if
# Kafka is unreachable) before starting the server.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
npm run create-topics || echo "WARN: create-topics failed — continuing without it (Kafka may be down)"
exec node src/server.js
