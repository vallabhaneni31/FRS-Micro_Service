#!/bin/bash
# create-keycloak-users.sh
# Creates all FRS users in Keycloak with correct tenant_id attributes and realm roles.
# Data sourced from the FRS database (frs_user + frs_tenant_user_map + user_role).
#
# Run from: FRS--Main-App/backend/
#   chmod +x scripts/create-keycloak-users.sh
#   ./scripts/create-keycloak-users.sh
#
# After this script succeeds:
#   1. Go to Keycloak Admin → Users → each user → Credentials → Set Password
#   2. Change AUTH_MODE=keycloak in .env and restart backend

set -euo pipefail

KC_URL="${KEYCLOAK_URL:-http://localhost:9090}"
KC_REALM="${KEYCLOAK_REALM:-attendance}"
KC_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
KC_ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"

# ── Get admin token ─────────────────────────────────────────────────────────
echo "Authenticating with Keycloak admin API..."
TOKEN=$(curl -s -X POST \
  "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=${KC_ADMIN_USER}&password=${KC_ADMIN_PASS}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('access_token','ERROR'))")

if [ "$TOKEN" = "ERROR" ] || [ -z "$TOKEN" ]; then
  echo "❌ Failed to get admin token. Check KEYCLOAK_URL/KEYCLOAK_ADMIN_USER/KEYCLOAK_ADMIN_PASSWORD"
  exit 1
fi
echo "✅ Token obtained."

# Tenant UUIDs from frs_tenant table
TENANT_IVIS="e2d95e78-91c6-4d33-9127-b3390826f50d"
TENANT_MOTIVITY="04ef798b-bc62-4708-a4f2-60cbe78996d8"
TENANT_NARAYANA="e3bd157f-a99a-47ca-b84b-9b18f5a59f84"
TENANT_TVS="8008db39-9de7-4be1-bfa7-238a1e3da484"

# ── Ensure realm roles exist ────────────────────────────────────────────────
ensure_role() {
  local ROLE_NAME="$1"
  local EXISTS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "${KC_URL}/admin/realms/${KC_REALM}/roles/${ROLE_NAME}")
  if [ "$EXISTS" != "200" ]; then
    curl -s -X POST \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${KC_REALM}/roles" \
      -d "{\"name\":\"${ROLE_NAME}\"}" > /dev/null
    echo "  ✅ Role created: ${ROLE_NAME}"
  else
    echo "  ✓  Role exists: ${ROLE_NAME}"
  fi
}

echo ""
echo "── Ensuring realm roles ──────────────────────────────────────────"
ensure_role "super_admin"
ensure_role "tenant_admin"
ensure_role "hr_manager"
ensure_role "site_admin"
ensure_role "viewer"

# ── Create or update a user ─────────────────────────────────────────────────
create_or_update_user() {
  local EMAIL="$1"
  local FIRST_NAME="$2"
  local LAST_NAME="$3"
  local TENANT_ID="$4"   # empty string = super_admin/global
  local ROLE_NAME="$5"

  echo ""
  echo "  Processing: ${EMAIL}  role=${ROLE_NAME}  tenant=${TENANT_ID:-GLOBAL}"

  # Check if user exists
  EXISTING=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "${KC_URL}/admin/realms/${KC_REALM}/users?email=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${EMAIL}'))")&exact=true")

  USER_ID=$(echo "$EXISTING" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null || echo "")

  # Build tenant attribute JSON
  if [ -n "$TENANT_ID" ]; then
    ATTR_JSON="{\"tenant_id\":[\"${TENANT_ID}\"]}"
  else
    ATTR_JSON="{\"tenant_id\":[]}"
  fi

  if [ -z "$USER_ID" ]; then
    # Create user
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${KC_REALM}/users" \
      -d "{
        \"username\": \"${EMAIL}\",
        \"email\": \"${EMAIL}\",
        \"firstName\": \"${FIRST_NAME}\",
        \"lastName\": \"${LAST_NAME}\",
        \"enabled\": true,
        \"emailVerified\": true,
        \"attributes\": ${ATTR_JSON},
        \"requiredActions\": [\"UPDATE_PASSWORD\"]
      }")

    if [ "$HTTP_STATUS" != "201" ] && [ "$HTTP_STATUS" != "204" ]; then
      echo "  ❌ Create failed (HTTP ${HTTP_STATUS})"
      return
    fi

    # Fetch the created user's ID
    USER_ID=$(curl -s \
      -H "Authorization: Bearer $TOKEN" \
      "${KC_URL}/admin/realms/${KC_REALM}/users?email=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${EMAIL}'))")&exact=true" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null || echo "")

    if [ -z "$USER_ID" ]; then
      echo "  ❌ Could not retrieve user id after create"
      return
    fi
    echo "  ✅ Created (id: ${USER_ID})"
  else
    # Update existing user — set tenant_id attribute
    EXISTING_USER=$(curl -s -H "Authorization: Bearer $TOKEN" \
      "${KC_URL}/admin/realms/${KC_REALM}/users/${USER_ID}")

    # Merge: keep existing attributes, overwrite tenant_id
    MERGED_ATTRS=$(echo "$EXISTING_USER" | python3 -c "
import sys, json
u = json.load(sys.stdin)
attrs = u.get('attributes', {}) or {}
attrs['tenant_id'] = ['${TENANT_ID}'] if '${TENANT_ID}' else []
print(json.dumps(attrs))
")

    curl -s -X PUT \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${KC_REALM}/users/${USER_ID}" \
      -d "$(echo "$EXISTING_USER" | python3 -c "
import sys, json
u = json.load(sys.stdin)
u['attributes'] = json.loads('${MERGED_ATTRS}')
print(json.dumps(u))
")" > /dev/null
    echo "  ✓  Updated tenant_id attribute (id: ${USER_ID})"
  fi

  # Assign realm role
  ROLE_OBJ=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "${KC_URL}/admin/realms/${KC_REALM}/roles/${ROLE_NAME}")
  ROLE_ID=$(echo "$ROLE_OBJ" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

  if [ -n "$ROLE_ID" ]; then
    ASSIGN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${KC_REALM}/users/${USER_ID}/role-mappings/realm" \
      -d "[{\"id\":\"${ROLE_ID}\",\"name\":\"${ROLE_NAME}\"}]")
    if [ "$ASSIGN_STATUS" = "204" ] || [ "$ASSIGN_STATUS" = "200" ]; then
      echo "  ✓  Role assigned: ${ROLE_NAME}"
    fi
  fi

  echo "  USER_ID=${USER_ID}  (write this to frs_user.keycloak_sub for ${EMAIL})"
}

# ── Create all FRS users ─────────────────────────────────────────────────────
echo ""
echo "── Creating / updating users ─────────────────────────────────────"

# pk_user_id=1: Super Admin (karthik) — no tenant_id
create_or_update_user \
  "karthik.vallabhaneni@motivitylabs.com" \
  "Karthik" "Vallabhaneni" \
  "" "super_admin"

# pk_user_id=3: Motivity Labs tenant_admin
create_or_update_user \
  "yeshwanth.mudimala@motivitylabs.com" \
  "Yeshwanth" "Mudimala" \
  "$TENANT_MOTIVITY" "tenant_admin"

# pk_user_id=4: Super Admin (phani) — no tenant_id
create_or_update_user \
  "phani.kumar@motivitylabs.com" \
  "Phani Kumar" "Gongura" \
  "" "super_admin"

# pk_user_id=9: hr_manager (Karthik gmail) — no tenant mapping → Motivity Labs fallback
create_or_update_user \
  "karthikvallabhaneni3712@gmail.com" \
  "Karthik" "V" \
  "$TENANT_MOTIVITY" "hr_manager"

# pk_user_id=12: dinesh (Motivity Labs employee — shown as "Sai Dinesh") — narayana tenant in DB
create_or_update_user \
  "dinesh.bejjanki@motivitylabs.com" \
  "Sai" "Dinesh" \
  "$TENANT_NARAYANA" "tenant_admin"

# pk_user_id=13: lelouch — IVIS tenant
create_or_update_user \
  "lelouchvibritannia2124@gmail.com" \
  "lelouch" "v" \
  "$TENANT_IVIS" "tenant_admin"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "✅  All users processed."
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Set passwords for each user in Keycloak Admin Console:"
echo "   → ${KC_URL}/admin → Realm: ${KC_REALM} → Users → [user] → Credentials → Set Password"
echo "   OR force a password reset: each user sees a 'Update Password' prompt on next login."
echo ""
echo "2. Update frs_user.keycloak_sub with each user's Keycloak ID:"
echo "   Run the DB update script printed below, filling in the USER_IDs from above."
echo ""
echo "   UPDATE frs_user SET keycloak_sub = '<KC_USER_ID>' WHERE email = '<email>';"
echo ""
echo "3. Verify JWT claim:"
echo "   curl -s -X POST ${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token \\"
echo "     -d 'grant_type=password&client_id=attendance-frontend&username=lelouchvibritannia2124@gmail.com&password=<pw>' \\"
echo "     | python3 -c \"import sys,json,base64; t=json.load(sys.stdin)['access_token']; p=t.split('.')[1]+'=='; print(json.dumps(json.loads(base64.b64decode(p)),indent=2))\""
echo ""
echo "4. Change in .env:  AUTH_MODE=api  →  AUTH_MODE=keycloak"
echo "5. Restart:  pm2 restart all"
echo "══════════════════════════════════════════════════════════════════"
