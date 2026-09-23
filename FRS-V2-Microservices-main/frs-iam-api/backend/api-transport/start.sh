#!/usr/bin/env bash
# start.sh — launches the packaged jar with real credentials sourced from
# .env.transport.local (gitignored). Spring Boot doesn't read .env files
# itself (see .env.transport.example's own header comment) — this script
# is what actually bridges that gap for PM2, which just runs this file.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

set -a
source .env.transport.local
set +a

exec java -jar target/api-transport-0.1.0.jar
