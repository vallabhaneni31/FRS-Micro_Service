#!/usr/bin/env bash
# up.sh — bring up the split FRS application locally: four processes across
# four sibling repos (this script lives one level above all of them):
#
#   frs-iam-api/backend/api — IAM only: auth, MFA, session bootstrap,
#                                  user accounts, RBAC, internal Keycloak/
#                                  invite provisioning. Path changed again
#                                  since the last update: frs-iam-api's
#                                  develop2 branch restructured backend/ into
#                                  three independent services — backend/api
#                                  (this one, Node), backend/api-retail
#                                  (Node, retail vertical), and
#                                  backend/api-transport (Java/Maven, Spring
#                                  Boot, transport vertical). Only
#                                  backend/api is started by this script —
#                                  see the "Not started" note below for the
#                                  other two.
#   frs-fe-api                   — frontend-facing business API
#   frs-edge-api                 — Jetson/edge-device-facing API
#   frs-web-ui                   — the React app (Vite dev server)
#
# frs-web-ui's dev-server proxy routes /api/auth, /api/me/bootstrap,
# /api/users, /api/admin/rbac, and /api/internal to frs-iam-api/backend/api
# (IAM) on port 8082 — see its vite.config.ts. /api/me/manifest and
# /api/me/preferences (UI config, not identity) and everything else go to
# frs-fe-api on 8080. All three backends verify JWTs against the same
# Keycloak realm (dev, remote), so no other wiring between them is needed.
#
# IMPORTANT — two port issues you need to resolve once, outside this script:
#  1. frs-web-ui's vite.config.ts hardcodes the IAM proxy target as
#     http://localhost:8082, but frs-iam-api/backend/api's real .env
#     currently has PORT=8080 — same as frs-fe-api. Change
#     frs-iam-api/backend/api/.env's PORT to 8082 before running this.
#  2. frs-edge-api's real .env also has PORT=8082 (collides with the fix
#     above). Nothing else in the codebase depends on frs-edge-api
#     specifically being on 8082 (its own .env.example even defaults to
#     8080), so change frs-edge-api/.env's PORT to a free port (e.g. 8081)
#     too.
#  Until both are fixed, whichever of the three starts last will fail to
#  bind its port.
#
# Not started by this script (separate verticals, out of scope so far):
#   - frs-iam-api/backend/api-retail  (Node) — needs backend/api-retail/.env
#     from .env.retail.example.
#   - frs-iam-api/backend/api-transport (Java/Maven, Spring Boot) — needs
#     backend/api-transport/.env.transport from .env.transport.example, a
#     JDK, and Maven. Different runtime stack entirely; start with
#     ./start.sh or `mvn spring-boot:run` in that directory if/when needed.
#
# Dev infra assumed already reachable, NOT started by this script:
#   - Postgres: remote dev DB (dev-frs.motivitylabs.com) — see each .env
#   - Keycloak: remote dev Keycloak (https://dev-frs.motivitylabs.com/auth)
#   - Kafka:    local, KRaft mode — start separately, e.g.
#               C:\Work\tools\kafka_2.13-4.3.1\bin\windows\kafka-server-start.bat config\server.properties
#
# Usage:
#   ./up.sh              Start all four, foreground, Ctrl+C stops everything.
#   ./up.sh --logs-only   Same, but don't tail logs to this terminal (background).
#
# Requires each repo's real .env (and frs-edge-api's .env.retail) to already
# exist — this script does NOT fabricate secrets. See each repo's
# .env.example for what's needed; ask a teammate or check your credential
# store for real values.
#
# Does NOT run database migrations — frs-iam-api/backend/api connects to a
# shared dev database; migrations there are a deliberate, separate step
# (coordinate with the team before running scripts/migrate.js), not
# something this script should do on every startup.

set -euo pipefail

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31mFAILED:\033[0m %s\n' "$1"; exit 1; }
ok()   { printf '\033[1;32m  ok:\033[0m %s\n' "$1"; }

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IAM_API_DIR="$BASE_DIR/frs-iam-api/backend/api"
FE_API_DIR="$BASE_DIR/frs-fe-api"
EDGE_API_DIR="$BASE_DIR/frs-edge-api"
WEB_UI_DIR="$BASE_DIR/frs-web-ui"

LOGS_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --logs-only) LOGS_ONLY=true ;;
    *) fail "Unknown flag: $arg (only --logs-only is supported)" ;;
  esac
done

# ── 0. Sanity: every repo present, every required .env present ──────────────
step "0. Checking repos and env files"

for d in "$IAM_API_DIR" "$FE_API_DIR" "$EDGE_API_DIR" "$WEB_UI_DIR"; do
  [ -d "$d" ] || fail "Expected directory missing: $d"
done

require_env() {
  local envfile="$1" example="$2" label="$3"
  if [ -f "$envfile" ]; then
    ok "$label: $envfile present"
  else
    fail "$label is missing $envfile — copy $example to it and fill in real values (see the repo's README), then re-run."
  fi
}
require_env "$IAM_API_DIR/.env"         "$IAM_API_DIR/.env.example"         "frs-iam-api/backend/api (IAM)"
require_env "$FE_API_DIR/.env"          "$FE_API_DIR/.env.example"          "frs-fe-api"
require_env "$EDGE_API_DIR/.env"        "$EDGE_API_DIR/.env.example"        "frs-edge-api"
require_env "$EDGE_API_DIR/.env.retail" "$EDGE_API_DIR/.env.retail.example" "frs-edge-api (retail)"
require_env "$WEB_UI_DIR/.env"          "$WEB_UI_DIR/.env.example"          "frs-web-ui"

# Fail fast on the known port misconfiguration instead of letting whichever
# service starts last crash with an opaque EADDRINUSE.
iam_port="$(grep -E '^PORT=' "$IAM_API_DIR/.env" | head -1 | cut -d= -f2 | tr -d '[:space:]')"
edge_port="$(grep -E '^PORT=' "$EDGE_API_DIR/.env" | head -1 | cut -d= -f2 | tr -d '[:space:]')"
[ "$iam_port" = "8082" ] || fail "frs-iam-api/backend/api/.env has PORT=$iam_port, but frs-web-ui's vite.config.ts expects IAM on 8082 — fix that .env's PORT first."
[ "$edge_port" != "8082" ] || fail "frs-edge-api/.env has PORT=8082, which now collides with frs-iam-api/backend/api — change it to a free port (e.g. 8081) first."
ok "port config: IAM on $iam_port, edge on $edge_port — no collision"

# frs-fe-api's analytics config loader needs conf/*.json (rule/model/smart-search
# configs) at its repo root — copy from frs-iam-api/backend/api if missing.
if [ ! -f "$FE_API_DIR/conf/config.json" ]; then
  warn "frs-fe-api/conf/ missing — copying from frs-iam-api/backend/api/conf/"
  mkdir -p "$FE_API_DIR/conf"
  cp "$IAM_API_DIR/conf/"*.json "$FE_API_DIR/conf/" 2>/dev/null \
    || warn "Could not copy conf/*.json — frs-fe-api will run with degraded defaults (see its startup log)."
fi

# ── 1. Install dependencies (skips cleanly if already installed) ────────────
step "1. Installing dependencies (skipped where node_modules already exists)"
install_if_needed() {
  local dir="$1" label="$2"
  if [ -d "$dir/node_modules" ]; then
    ok "$label: node_modules present, skipping install"
  else
    echo "  - installing $label..."
    npm --prefix "$dir" install
  fi
}
install_if_needed "$IAM_API_DIR" "frs-iam-api/backend/api"
install_if_needed "$FE_API_DIR"  "frs-fe-api"
install_if_needed "$EDGE_API_DIR" "frs-edge-api"
install_if_needed "$WEB_UI_DIR"   "frs-web-ui"

# ── 2. Free up ports 5173/8080/8081/8082 if something stale is still on them ─
step "2. Freeing ports (5173, 8080, 8081, 8082) if occupied"
free_port() {
  local port="$1"
  if command -v lsof &>/dev/null; then
    local pid
    pid="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [ -n "$pid" ]; then echo "  - killing PID $pid on :$port"; kill -9 $pid 2>/dev/null || true; fi
  elif command -v netstat &>/dev/null && command -v taskkill &>/dev/null; then
    # Windows / git-bash
    local pid
    pid="$(netstat -ano 2>/dev/null | grep ":$port " | grep LISTENING | awk '{print $5}' | head -1 || true)"
    if [ -n "$pid" ]; then echo "  - killing PID $pid on :$port"; taskkill //F //PID "$pid" //T &>/dev/null || true; fi
  fi
}
free_port 5173
free_port 8080
free_port 8081
free_port 8082

# ── 3. IAM backend prerequisites: Kafka topics (best-effort, non-fatal) ─────
step "3. Preparing frs-iam-api/backend/api (create-topics, best-effort)"
(cd "$IAM_API_DIR" && npm run create-topics) \
  || warn "create-topics failed — is Kafka running on localhost:9092? Continuing without it; the IAM backend degrades gracefully if Kafka is unreachable."

# ── 4. Start all four, foreground with a trap so Ctrl+C stops everything ────
step "4. Starting services"
echo "  - frs-iam-api/backend/api (IAM): http://localhost:$iam_port"
echo "  - frs-fe-api:                    http://localhost:8080"
echo "  - frs-edge-api:                  http://localhost:$edge_port"
echo "  - frs-web-ui:                    http://localhost:5173"
echo "  - not started: frs-iam-api/backend/api-retail, backend/api-transport (Java) — see header comment"

cleanup() {
  # Detach the trap first — kill 0 below sends SIGTERM to this script's own
  # process group (itself included), and without this a still-armed trap
  # re-enters cleanup on that self-signal, looping "Shutting down..." forever.
  trap - SIGINT SIGTERM EXIT
  echo -e "\nShutting down..."
  kill 0 2>/dev/null || true
}
trap cleanup SIGINT SIGTERM EXIT

if [ "$LOGS_ONLY" = true ]; then
  (cd "$IAM_API_DIR"  && node src/server.js) > /tmp/frs-iam-api.log 2>&1 &
  (cd "$FE_API_DIR"   && node src/server.js) > /tmp/frs-fe-api.log 2>&1 &
  (cd "$EDGE_API_DIR" && node src/server.js) > /tmp/frs-edge-api.log 2>&1 &
  (cd "$WEB_UI_DIR"   && npx vite --port 5173) > /tmp/frs-web-ui.log 2>&1 &
  echo "  - logs: /tmp/frs-iam-api.log, /tmp/frs-fe-api.log, /tmp/frs-edge-api.log, /tmp/frs-web-ui.log"
else
  (cd "$IAM_API_DIR"  && node src/server.js) &
  (cd "$FE_API_DIR"   && node src/server.js) &
  (cd "$EDGE_API_DIR" && node src/server.js) &
  (cd "$WEB_UI_DIR"   && npx vite --port 5173) &
fi

wait
