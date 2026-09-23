# Device JWT Setup — Jetson → AWS Event Pushing
**FRS-RB-012 | v1.0 | 2026-07-23**

## When to Use
- Onboarding a new Jetson edge node so it can push face/attendance events to the backend.
- Re-issuing a token for a device that was registered but never provisioned (`token_issued_at` empty).
- Rotating a token that's expiring, leaked, or suspected compromised.

Related: [JETSON_RECOVERY.md](JETSON_RECOVERY.md) (device offline / cache corruption), [[jetson-device-identity-mismatch]] (root-caused an earlier phantom-JWT incident this runbook now prevents).

## How It Works
- The Jetson is always the TCP initiator — AWS never calls the Jetson.
- Every request from the device carries `Authorization: Bearer <token>`, verified by `authenticateDevice.js` (`backend/api/src/middleware/authenticateDevice.js`) against `DEVICE_JWT_SECRET`.
- The token's claims (`device_id`, `device_code`/`external_device_id`, `tenant_id`) must resolve to a **live** row in `facility_device` (not decommissioned). The middleware re-reads `tenant_id` from the DB on every request, so a stale tenant claim in the token is not fatal — but a missing device row is (`401 device not found`).
- Event-push endpoints live in `backend/api/src/routes/deviceEventsRoutes.js`:
  - `POST /api/events` — single event (`heartbeat`, `face.recognized`, `face.unknown`, `access.granted`, `access.denied`, `enrollment.completed`, `enrollment.failed`)
  - `POST /api/events/batch` — up to 100 events (offline-queue drain)
  - `GET /api/events/commands` — device polls for pending commands

## Prerequisites
- `DEVICE_JWT_SECRET` set in `backend/api/.env` (not the placeholder value — the app refuses to boot / the script refuses to run otherwise).
- Know the device's **tenant** (`frs_tenant.pk_tenant_id` — same UUID as `tenants.pk_tenant_id`, kept in sync by trigger).
- Know the device's `external_device_id` (the code baked into the Jetson's own config, e.g. `jetson-09`).

```bash
# Find or confirm the tenant
psql $DATABASE_URL -c "SELECT pk_tenant_id, tenant_name FROM frs_tenant WHERE tenant_name ILIKE '%<customer>%';"

# Check whether the device is already registered
psql $DATABASE_URL -c "
  SELECT pk_device_id, external_device_id, tenant_id, decommissioned_at, token_issued_at, token_expires_at
  FROM facility_device WHERE external_device_id = '<device-code>';
"
```

## Step 1 — Register the device (skip if it already has a `facility_device` row)
Two ways to create the row; use whichever fits the situation.

**A. Admin API (preferred — requires a Keycloak admin JWT with `devices.write`):**
```bash
curl -X POST https://<backend-host>/api/device-management/devices \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "external_device_id": "jetson-09",
    "device_type_code": "jetson_orin_nx",
    "name": "Jetson Orin - Entrance",
    "location_label": "Entrance Cameras",
    "ip_address": "10.0.0.42"
  }'
```
Valid `device_type_code` values: `jetson_orin_nx`, `jetson_xavier_nx`, `hikvision_camera` (see `device_type` table — extend there if a new model shows up).

**B. PIN-based self-activation (no admin token needed on the device side):**
1. Admin generates a short-lived PIN: `POST /api/device-management/devices/activation-code` (`{ siteId, deviceRole, zoneName }`) → 30-minute PIN.
2. Device calls `POST /api/device-management/devices/activate` with the PIN + its own metadata — this both registers **and** provisions the device in one call, returning a token directly. Best for zero-touch fleet rollout.

## Step 2 — Provision (mint the JWT)
Two supported paths — prefer (A) for anything beyond a one-off/local test, since it also queues the token for the device to self-fetch and best-effort pushes it via Kafka.

**A. Provisioning API (production path):**
```bash
curl -X POST https://<backend-host>/api/device-management/devices/jetson-09/provision \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "token_validity_days": 365 }'
```
Response includes the token, `bootstrap_url`, and manual-SSH fallback instructions. This path also stamps `facility_device.token_issued_at` / `token_expires_at`, so `Step 1`'s lookup query reflects reality afterward.

**B. Direct script (local/dev, or when you already have DB + shell access and don't want to go through Keycloak auth):**
```bash
cd backend/api
node src/scripts/generateDeviceJWT.js --code jetson-09 --tenant <tenant-uuid> --expires 365d
```
This is a thin wrapper: it looks up the device's `pk_device_id` in `facility_device`, then signs `{ device_id, device_code, tenant_id, type: 'jetson' }` with `DEVICE_JWT_SECRET`. It does **not** update `token_issued_at`/`device_secret_hash`, so a device provisioned this way will still show blank in the Step 1 lookup — that's expected, not a bug.

Either path fails loudly if the device isn't registered yet: *"Device 'X' not found for tenant 'Y'. Register the device first via POST /api/device-management/devices"* — go back to Step 1.

## Step 3 — Deploy the token to the Jetson
- **Auto (Kafka + bootstrap):** if the provisioning API's Kafka push succeeds, the device picks up the new token within ~5 minutes with no manual step. If Kafka is unreachable, the device self-fetches on next boot from `GET /api/bootstrap/<device_code>`.
- **Manual:**
  ```bash
  ssh <user>@<jetson-local-ip>
  echo '<token>' > /opt/frs/device_token.txt   # or DEVICE_JWT_TOKEN=<token> in the Jetson's .env
  sudo systemctl restart frs-runner
  ```

## Step 4 — Verify end-to-end
Don't consider the setup done until a real event round-trips:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<backend-host>/api/events \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"heartbeat","payload":{"status":"online","metrics":{"cpu_percent":10}}}'
# Expect: 200 {"success":true,"received":"heartbeat"}
```
Then confirm it actually persisted (200 from the endpoint is not sufficient proof — a stale/phantom device claim can still return 200 while silently writing nothing):
```bash
psql $DATABASE_URL -c "
  SELECT external_device_id, status, last_heartbeat FROM facility_device WHERE external_device_id = 'jetson-09';
"
psql $DATABASE_URL -c "
  SELECT device_code, event_type, received_at FROM device_events
  WHERE device_code = 'jetson-09' ORDER BY received_at DESC LIMIT 3;
"
```
`status` should flip to `online`, `last_heartbeat` should be current, and the event should show up in `device_events`.

## Token Lifecycle — Rotation & Revocation
Tokens are long-lived (365d default) by design (edge devices, infrequent redeploys), which makes rotation on suspicion of leak important:
```bash
# Rotate: revokes the old JTI, issues + persists a new one
curl -X POST https://<backend-host>/api/device-tokens/<device-id>/rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Revoke without replacement (decommissioning / incident response)
curl -X POST https://<backend-host>/api/device-tokens/<device-id>/revoke \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason": "suspected leak"}'

# Check status
curl https://<backend-host>/api/device-tokens/<device-id>/status -H "Authorization: Bearer $ADMIN_TOKEN"
```
Note: tokens minted via `generateDeviceJWT.js` (Step 2B) carry no `jti`, so the revocation table can't target them individually — revoking effectively means changing `DEVICE_JWT_SECRET` (invalidates every device) or decommissioning the device row. Prefer the rotate/revoke API (Step 2A path) for any device where individual revocation might matter.

## Troubleshooting (401s)
| Response | Cause | Fix |
|---|---|---|
| `device token expired` | past `exp` claim | re-provision (Step 2) |
| `invalid device token` | wrong `DEVICE_JWT_SECRET`, or corrupted token | confirm secret matches the backend that will verify it; regenerate |
| `invalid token claims` | payload missing `device_id`/`device_code`/`tenant_id` | regenerate with the current script/API — don't hand-craft payloads |
| `device not found` | `pk_device_id` in the token doesn't exist in `facility_device` | Step 1 — register first. This was the root cause of the [[jetson-device-identity-mismatch]] incident: a JWT was minted for a `device_id`/`tenant_id` that existed nowhere in `facility_device`, so heartbeats returned 200 but persisted nothing |
| `device has been decommissioned` | `decommissioned_at` is set | reactivate via PIN re-activation (revives the row) or register a new device code |
| `device token has been revoked` | `jti` is in `device_token_revocations` | rotate (Step "Token Lifecycle") |

## Security Notes
- Never commit a generated token or `DEVICE_JWT_SECRET` to git, chat logs meant for sharing, or this runbook.
- `DEVICE_JWT_SECRET` is shared across **all** devices on a backend instance — rotating it invalidates every device's token at once. Prefer per-device revocation (JTI) over secret rotation unless the secret itself is compromised.
- The token authorizes event-push and command-poll endpoints only — it is not a user session token and carries no RBAC/scope claims.
