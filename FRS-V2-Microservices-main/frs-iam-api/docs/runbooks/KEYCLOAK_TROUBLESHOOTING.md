# Keycloak / Auth Troubleshooting Runbook — FRS Platform
**FRS-RB-009 | v1.0 | 2026-05-24**

## Common Auth Failures

### Issue: 503 on all API endpoints (JWKS unreachable)
```bash
# Check Keycloak health
curl https://auth.frs.example.com/health/ready

# Check JWKS endpoint manually
curl https://auth.frs.example.com/realms/frs/protocol/openid-connect/certs | jq .

# Check backend Keycloak verifier cache
grep "JWKS" /var/log/frs/app.log | tail -20

# Stale JWKS cache will keep serving for up to 1 hour — check env
echo $KEYCLOAK_STALE_TTL_SECONDS
```

### Issue: "invalid token claims" for device JWT
```bash
# Decode token (header.payload only — never log signature)
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq .

# Check required claims: device_id, device_code/external_device_id, tenant_id
# If jti is present, check revocation table
psql $DATABASE_URL -c "
  SELECT * FROM device_token_revocations WHERE jti = '<jti-value>';"
```

### Issue: "scope access denied" (403)
```bash
# Check what scope the token has vs what is required
psql $DATABASE_URL -c "
  SELECT ur.*, rr.role_name, rp.permission_name
  FROM user_role ur
  JOIN rbac_role rr ON rr.pk_role_id = ur.fk_role_id
  JOIN rbac_role_permission rrp ON rrp.fk_role_id = rr.pk_role_id
  JOIN rbac_permission rp ON rp.pk_permission_id = rrp.fk_permission_id
  WHERE ur.fk_user_id = '<user-id>'::uuid AND ur.is_active = true;"
```

### Issue: Users created in Keycloak but not in DB
```bash
# Sync user from Keycloak to FRS DB
curl -X POST https://api.frs.example.com/api/users/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"keycloakId": "<kc-user-id>"}'
```
