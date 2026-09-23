#!/usr/bin/env bash
# deploy.sh — rebuild and redeploy the live FRS app after `git pull`.
#
# Usage:  ./deploy.sh
#
# This repo is NOT a single service. In the FRS_micro estate it manages the IAM
# backend (backend/api, frs-backend) plus the sibling repos ../frs-fe-api
# (frs-fe-api) and ../frs-edge-api (frs-edge-api), all under pm2. Legacy
# backend/api-retail/ and frontend/ are handled only if they exist. This script
# re-installs deps, applies DB migrations, syntax-checks, and reloads the
# backends so a `git pull` actually takes effect everywhere.
#
# Deliberately NOT done here (needs a human, not routine per-pull work):
#   - nginx config changes: infra/nginx/nginx.conf.template is a starting
#     point, not what's live — the deployed /etc/nginx/sites-available/default
#     has hand-applied fixes (see git log) that a template regen would clobber.
#   - .env changes: secrets aren't in git; if a pull adds a new required var
#     (see backend/api/.env.example / backend/api-retail/.env.retail.example),
#     add it to the live .env files by hand first, or the health check below
#     will catch the resulting boot failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[1;31mFAILED:\033[0m %s\n' "$1"; exit 1; }

# ── 0. Sanity: required env files must already exist (secrets aren't in git) ──
step "Checking required .env files are present"
[ -f backend/api/.env ] || fail "backend/api/.env is missing. Copy backend/api/.env.example, fill in real values, then re-run."
echo "backend/api/.env present."

# Sibling repos in the FRS_micro estate (each is optional — skipped if absent)
FE_DIR="$REPO_ROOT/../frs-fe-api"
EDGE_DIR="$REPO_ROOT/../frs-edge-api"
HAS_FE=false;   [ -f "$FE_DIR/src/server.js" ]   && [ -f "$FE_DIR/.env" ]   && HAS_FE=true
HAS_EDGE=false; [ -f "$EDGE_DIR/src/server.js" ] && [ -f "$EDGE_DIR/.env" ] && HAS_EDGE=true
HAS_RETAIL=false; [ -f backend/api-retail/.env.retail ] && HAS_RETAIL=true
HAS_FRONTEND=false; [ -f frontend/.env ] && HAS_FRONTEND=true
echo "frs-fe-api: $HAS_FE | frs-edge-api: $HAS_EDGE | retail: $HAS_RETAIL | frontend: $HAS_FRONTEND"

# ── 1. Install dependencies (safe/no-op if package.json didn't change) ──────
step "Installing dependencies"
npm --prefix backend/api install
$HAS_FE       && npm --prefix "$FE_DIR" install
$HAS_EDGE     && npm --prefix "$EDGE_DIR" install
$HAS_RETAIL   && npm --prefix backend/api-retail install
$HAS_FRONTEND && npm --prefix frontend install

# ── 2. Apply DB migrations ───────────────────────────────────────────────────
# migrate.js short-circuits once the schema is already current, so this is
# safe to run on every deploy even when there's nothing new to apply.
step "Applying database migrations"
(cd backend/api && node scripts/migrate.js)

# ── 3. Syntax-check backend source before restarting anything ───────────────
step "Syntax-checking backend entrypoints"
node --check backend/api/src/server.js || fail "backend/api/src/server.js has a syntax error — not restarting."
$HAS_FE && { node --check "$FE_DIR/src/server.js" || fail "frs-fe-api/src/server.js has a syntax error — not restarting."; }
$HAS_EDGE && { node --check "$EDGE_DIR/src/server.js" || fail "frs-edge-api/src/server.js has a syntax error — not restarting."; }
$HAS_RETAIL && { node --check backend/api-retail/src/index.js || fail "backend/api-retail/src/index.js has a syntax error — not restarting."; }

# ── 4. Build the frontend (only if a frontend/ exists in this repo) ─────────
# In FRS_micro the UI lives in the sibling frs-web-ui repo and is built there.
if $HAS_FRONTEND; then
  step "Building frontend"
  npm run build:frontend
  [ -f frontend/dist/index.html ] || fail "frontend/dist/index.html missing after build — check the build output above."
else
  step "Skipping frontend build (no frontend/ in this repo — build frs-web-ui separately)"
fi

# ── 5. Reload backends (brief restart, not zero-downtime — fork mode) ───────
step "Reloading frs-backend (IAM)"
pm2 reload frs-backend --update-env

# Start-or-reload helper for the sibling services (name, dir, instances)
deploy_sibling() {
  local name="$1" dir="$2" instances="$3"
  step "Ensuring $name is running"
  if pm2 describe "$name" &>/dev/null; then
    pm2 reload "$name" --update-env
  else
    (cd "$dir" && pm2 start src/server.js --name "$name" -i "$instances")
    pm2 save
  fi
}
$HAS_FE   && deploy_sibling frs-fe-api   "$FE_DIR"   3
$HAS_EDGE && deploy_sibling frs-edge-api "$EDGE_DIR" 2

if $HAS_RETAIL; then
  step "Reloading retail-backend"
  pm2 reload frs-retail-backend --update-env
fi
step "Ensuring frs-device-event-consumer is running"
# Runs from frs-edge-api (DeviceEventService lives there since the split; the copy
# in backend/api crashes on a missing import). KAFKA_GROUP_ID is pinned so it keeps
# the committed offsets of the existing consumer group instead of joining a new one.
if $HAS_EDGE; then
  if pm2 describe frs-device-event-consumer &>/dev/null; then
    pm2 reload frs-device-event-consumer --update-env
  else
    (cd "$EDGE_DIR" && KAFKA_GROUP_ID=frs2-consumer-group pm2 start src/workers/deviceEventConsumer.js \
      --name frs-device-event-consumer -i 3)
    pm2 save
  fi
else
  echo "Skipping frs-device-event-consumer (frs-edge-api not present)."
fi

# ── 5b. VLM visitor-photo quality gate (backend/api/scripts/vlm_quality_service.py) ──
# Optional, opt-in sidecar (self-hosted moondream2) — only managed here once a
# host has actually turned it on via VLM_QUALITY_GATE_ENABLED=true in
# backend/api/.env, since the torch/transformers deps are heavy and not every
# host will have installed them. Skips cleanly (non-fatal) otherwise, same
# convention as the Transport section further down.
step "VLM quality-gate service (backend/api/scripts/vlm_quality_service.py)"
(
  set +e
  if ! grep -qE '^VLM_QUALITY_GATE_ENABLED=true' backend/api/.env 2>/dev/null; then
    echo "VLM_QUALITY_GATE_ENABLED is not 'true' in backend/api/.env — skipping (not configured on this host)."
    exit 0
  fi

  # Prefer a dedicated venv for this service if one exists (see the venv
  # instructions at the top of backend/api/scripts/requirements.txt);
  # otherwise fall back to whatever python3 is on PATH.
  VLM_PYTHON="python3"
  for candidate in backend/api/scripts/venv-vlm/bin/python3 backend/api/scripts/venv/bin/python3; do
    if [ -x "$candidate" ]; then
      VLM_PYTHON="$REPO_ROOT/$candidate"
      break
    fi
  done

  if pm2 describe frs-vlm-quality-gate &>/dev/null; then
    pm2 reload frs-vlm-quality-gate --update-env
  else
    (cd backend/api/scripts && pm2 start vlm_quality_service.py \
      --name frs-vlm-quality-gate \
      --interpreter "$VLM_PYTHON")
    pm2 save
  fi
  echo "VLM quality-gate service deployed."
) || echo "VLM quality-gate deploy step reported a problem (see output above). Not fatal — core backends deployed successfully above and are unaffected."

# ── 6. nginx: validate only — config isn't touched by a normal deploy ───────
step "Validating nginx config (not reloading unless you changed it yourself)"
sudo nginx -t

# ── 7. Health check ──────────────────────────────────────────────────────────
step "Health check"
sleep 2
pm2 list
SITE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' https://frs.motivitylabs.com/)
if [ "$SITE_STATUS" != "200" ]; then
  fail "https://frs.motivitylabs.com/ returned $SITE_STATUS instead of 200 — check 'pm2 logs frs-backend' / 'pm2 logs retail-backend'."
fi
echo "Site responded 200 OK."

# ── 8. Transport service (backend/api-transport) — separate Java/Spring Boot ──
# Deliberately last and isolated from everything above: corporate/education/
# retail have already been deployed and confirmed healthy by the health check
# above, unconditionally. A problem in this section is reported but does not
# fail the script (see the `|| echo` below) and never touches frs-backend,
# frs-retail-backend, or frs-device-event-consumer. Skips cleanly on a host
# that hasn't been set up for the Transport vertical yet.
step "Transport service (backend/api-transport)"
(
  set +e
  if [ ! -f backend/api-transport/.env.transport.local ]; then
    echo "backend/api-transport/.env.transport.local not found — skipping (Transport not configured on this host)."
    exit 0
  fi
  if ! command -v mvn &>/dev/null; then
    echo "mvn not found on PATH — skipping Transport service deploy."
    exit 0
  fi

  cd backend/api-transport
  mvn -q clean package -DskipTests
  if [ $? -ne 0 ]; then
    echo "Transport service build FAILED — leaving the previously running process untouched."
    exit 1
  fi

  if pm2 describe frs-transport-backend &>/dev/null; then
    pm2 reload frs-transport-backend --update-env
  else
    pm2 start ./start.sh --name frs-transport-backend --interpreter bash
  fi

  if pm2 describe frs-transport-realtime-consumer &>/dev/null; then
    pm2 reload frs-transport-realtime-consumer --update-env
  else
    (cd ../api && pm2 start src/workers/transportRealtimeConsumer.js \
      --name frs-transport-realtime-consumer \
      --node-args="--experimental-vm-modules" \
      --env NODE_ENV=production)
  fi
  pm2 save
  echo "Transport service deployed."
) || echo "Transport service deploy step reported a problem (see output above). Not fatal — corporate/education/retail deployed successfully above and are unaffected."

step "Deploy complete"
if $HAS_FRONTEND; then
  echo "Bundle live: $(grep -oE 'index-[A-Za-z0-9_]+\.js' frontend/dist/index.html)"
fi
