# New Tenant Onboarding Runbook — FRS Platform
**FRS-RB-011 | v1.0 | 2026-05-24**

## Prerequisites Checklist
- [ ] Contract signed
- [ ] DPA (Data Processing Agreement) signed — required for GDPR
- [ ] Biometric consent form approved by tenant's legal team
- [ ] Network details for Jetson device provisioning

## Step 1: Create Tenant in FRS
```bash
curl -X POST https://api.frs.example.com/api/app-admin/tenants \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corp",
    "contactEmail": "admin@acme.com",
    "plan": "enterprise"
  }'
# Save returned tenant_id
```

## Step 2: Create Tenant Admin User
```bash
curl -X POST https://api.frs.example.com/api/app-admin/tenants/<tenant-id>/users \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -d '{"email": "admin@acme.com", "role": "tenant_admin"}'
# User receives invite email with temp password
```

## Step 3: Configure RLS Session Variable
After tenant is created, verify RLS works:
```sql
SET app.tenant_id = '<new-tenant-id>';
SELECT COUNT(*) FROM hr_employee;  -- Should return 0 (new tenant)
RESET app.tenant_id;
```

## Step 4: Provision Jetson Device
```bash
# Register device in FRS
curl -X POST https://api.frs.example.com/api/device-management/register \
  -H "Authorization: Bearer $TENANT_ADMIN_TOKEN" \
  -d '{"external_device_id": "ACME001", "ip_address": "192.168.1.100", "site_id": "<site-uuid>"}'

# Issue device token
curl -X POST https://api.frs.example.com/api/device-tokens/<device-id>/rotate \
  -H "Authorization: Bearer $TENANT_ADMIN_TOKEN"
# Push returned token to Jetson device via Kafka or manual config
```

## Step 5: Verify Tenant Isolation
```bash
# Confirm tenant cannot see other tenant data
TENANT_A_TOKEN="..." TENANT_B_ID="..."
curl https://api.frs.example.com/api/employees \
  -H "Authorization: Bearer $TENANT_A_TOKEN" \
  -H "x-tenant-id: $TENANT_B_ID"
# Expected: 403 Forbidden
```

## Step 6: Send Welcome Kit
- [ ] Portal login URL + credentials
- [ ] Device JWT token (encrypted email or secure channel)
- [ ] Privacy notice for employees (biometric consent)
- [ ] Admin user guide PDF
