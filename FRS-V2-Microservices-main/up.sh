#!/usr/bin/env bash
# up.sh — bring up the FRS_Microservices stack locally, in WSL.
#
# Run this from inside a WSL shell (not Windows/git-bash — PM2 here is
# WSL-native, installed under $HOME/.npm-global):
#   cd /mnt/c/Work/FRS_Microservices && ./up.sh
#
# What this starts, and how:
#   frs-iam-api/backend/api  (IAM)      -> PM2, port 8082
#   frs-fe-api                          -> PM2, port 8080
#   frs-edge-api                        -> PM2, port 8081
#   frs-web-ui                          -> `npm run dev`, attached to THIS
#                                          terminal (not PM2 — Ctrl+C stops
#                                          only the frontend; the three
#                                          backends keep running under PM2)
#
# Each of the three PM2 apps has its own ecosystem.config.cjs living in its
# own repo (frs-iam-api, frs-fe-api, frs-edge-api) — this script only calls
# `pm2 start` from each directory, it does not define the process configs
# itself, so each repo's config stays independently owned and deployable.
#
# Note: `pm2 start ecosystem.config.cjs` restarts an app that's already
# running under that name (verified against PM2 7.0.4) rather than no-op'ing
# — so re-running this script picks up any code/.env changes in the three
# backends on every invocation. That's intentional here (e.g. right after a
# `git pull`), not an oversight.
#
# Explicitly NOT started, and not this script's concern:
#   - frs-iam-api/backend/api-retail, backend/api-transport (separate
#     verticals; api-transport is Java/Maven, a different runtime entirely)
#   - Kafka: local WSL systemd service (kafka.service), KRaft mode, 9092 —
#     already running and enabled for boot; if it's down, start it with
#     `sudo systemctl start kafka.service`
#   - Postgres: remote dev DB — not local, nothing to start
#   - Keycloak: remote dev Keycloak — not local, nothing to start
#   - Docker: not used anywhere in this stack

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

# Don't rely on the invoking shell having sourced ~/.bashrc (a non-login or
# non-interactive shell won't have). pm2 is installed natively here via
# WSL's own npm, not the leaked Windows one.
export PATH="$HOME/.npm-global/bin:$PATH"

command -v pm2 >/dev/null 2>&1 || fail "pm2 not found on PATH. It must be installed natively in WSL (npm install -g pm2) — if you're seeing a Windows path here instead, WSL's Windows-PATH interop needs disabling (see /etc/wsl.conf [interop] appendWindowsPath=false)."

# ── 0. Pre-flight: repos and .env files present ─────────────────────────────
step "0. Checking repos and env files"
for d in "$IAM_API_DIR" "$FE_API_DIR" "$EDGE_API_DIR" "$WEB_UI_DIR"; do
  [ -d "$d" ] || fail "Expected directory missing: $d"
done
for f in "$IAM_API_DIR/.env" "$FE_API_DIR/.env" "$EDGE_API_DIR/.env" "$WEB_UI_DIR/.env"; do
  [ -f "$f" ] || fail "Missing required .env: $f (copy from its .env*example and fill in real values — this script does not fabricate secrets)"
done
# .env.retail is only for frs-edge-api's retail vertical (src/retail/) routes
# — the core service boots and runs fine without it, so this is a warning,
# not a hard requirement.
[ -f "$EDGE_API_DIR/.env.retail" ] || warn "$EDGE_API_DIR/.env.retail missing — retail-vertical routes will fail if hit, core edge-api is unaffected"
ok "all repos and .env files present"

if systemctl is-active --quiet kafka.service; then
  ok "kafka.service is active"
else
  warn "kafka.service is not active — frs-edge-api / frs-iam-api-backend will degrade gracefully, but device-event features won't work. Start it with: sudo systemctl start kafka.service"
fi

# ── 1. Install dependencies (skipped where node_modules already exists) ────
step "1. Installing dependencies (skipped where node_modules already exists)"
install_if_needed() {
  local dir="$1" label="$2"
  if [ -d "$dir/node_modules" ]; then
    ok "$label: node_modules present"
  else
    echo "  - installing $label..."
    npm --prefix "$dir" install
  fi
}
install_if_needed "$IAM_API_DIR" "frs-iam-api/backend/api"
install_if_needed "$FE_API_DIR" "frs-fe-api"
install_if_needed "$EDGE_API_DIR" "frs-edge-api"
install_if_needed "$WEB_UI_DIR" "frs-web-ui"

# ── 2. Start backend services under PM2, in order ───────────────────────────
step "2. Starting backend services under PM2 (order: IAM -> fe-api -> edge-api)"
(cd "$IAM_API_DIR" && pm2 start ecosystem.config.cjs)
(cd "$FE_API_DIR" && pm2 start ecosystem.config.cjs)
(cd "$EDGE_API_DIR" && pm2 start ecosystem.config.cjs)

pm2 save >/dev/null 2>&1 || warn "pm2 save failed — the current process list won't persist across a WSL restart until you run it manually"

step "3. Backend status"
pm2 list

echo
echo "  - frs-iam-api/backend/api (IAM): http://localhost:8082  [PM2: frs-iam-api-backend]"
echo "  - frs-fe-api:                    http://localhost:8080  [PM2: frs-fe-api]"
echo "  - frs-edge-api:                  http://localhost:8081  [PM2: frs-edge-api]"
echo "  - frs-web-ui:                    http://localhost:5173  [this terminal, npm run dev]"

# ── 4. Frontend: attached, not PM2 ───────────────────────────────────────────
step "4. Starting frs-web-ui (npm run dev — Ctrl+C stops only this)"
cd "$WEB_UI_DIR"
exec npm run dev
