# Enrollment Troubleshooting Runbook — FRS Platform
**FRS-RB-008 | v1.0 | 2026-05-24**

## Common Enrollment Failures

### Issue: Photos uploaded but embedding not created
```bash
# Check embedding_status on invitation
psql $DATABASE_URL -c "
  SELECT pk_invitation_id, embedding_status, photos_purged_at, approved_at
  FROM enrollment_invitations
  WHERE fk_employee_id = '<employee-id>'::uuid
  ORDER BY created_at DESC LIMIT 5;"

# Check if Jetson device is online for this tenant
psql $DATABASE_URL -c "
  SELECT external_device_id, status, last_heartbeat
  FROM facility_device
  WHERE tenant_id = '<tenant-id>'::uuid
  ORDER BY last_heartbeat DESC LIMIT 5;"

# Trigger manual embedding creation
curl -X POST https://api.frs.example.com/api/enroll/<invitation-id>/create-embeddings \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Issue: Photo quality rejected
```bash
# Check face quality service
curl http://localhost:5050/health

# Check quality scores in invitation record
psql $DATABASE_URL -c "
  SELECT photo_paths, photo_integrity_tokens
  FROM enrollment_invitations
  WHERE pk_invitation_id = '<invitation-id>'::uuid;"
```

### Issue: Duplicate enrollment detected
```bash
# View duplicate check results
psql $DATABASE_URL -c "
  SELECT edc.*, e.full_name AS duplicate_employee
  FROM enrollment_duplicate_checks edc
  JOIN hr_employee e ON e.pk_employee_id = edc.duplicate_emp_id
  WHERE edc.invitation_id = '<invitation-id>'::uuid;"

# HR review: dismiss false positive
psql $DATABASE_URL -c "
  UPDATE enrollment_duplicate_checks
  SET status = 'dismissed', reviewed_at = NOW(), notes = 'Different person confirmed by HR'
  WHERE pk_check_id = '<check-id>'::uuid;"
```

### Issue: ENROLLMENT_TOKEN_SECRET missing
```bash
# Check env var is set (length only — never log the value)
node -e "console.log(process.env.ENROLLMENT_TOKEN_SECRET?.length)"

# Rotate secret (requires re-generating all HMAC tokens)
kubectl create secret generic frs-secrets \
  --from-literal=ENROLLMENT_TOKEN_SECRET=$(openssl rand -hex 32) \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/frs-backend
```

## Integrity Token Verification
```bash
# Verify photo integrity (dev tool — never in production with real data)
node -e "
  import { verifyPhotoIntegrityToken } from './backend/api/src/utils/photoIntegrity.js';
  // Test with known values
"
```
