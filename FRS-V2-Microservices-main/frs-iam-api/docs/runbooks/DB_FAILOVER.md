# Database Failover Runbook — FRS Platform
**FRS-RB-003 | v1.0 | 2026-05-24**

## When to Use
- RDS primary instance unreachable for > 5 minutes
- RDS automated failover has not completed within 10 minutes
- Forced failover required for maintenance

## Automated Failover (RDS Multi-AZ)
RDS Multi-AZ promotes the standby automatically within 60-120 seconds.
Monitor in AWS Console: RDS → Instances → Events.

## Manual Failover Steps
```bash
# 1. Confirm primary is down
psql $DATABASE_URL -c "SELECT now();" || echo "Primary unreachable"

# 2. Force RDS failover (Multi-AZ only)
aws rds reboot-db-instance \
  --db-instance-identifier frs-postgres-prod \
  --force-failover \
  --region ap-south-1

# 3. Wait for new primary (check every 30s)
until psql $DATABASE_URL -c "SELECT now();" 2>/dev/null; do
  echo "Waiting for new primary..."; sleep 30
done

# 4. Verify RLS is functional
psql $DATABASE_URL -c "SHOW row_security;"

# 5. Restart backend to clear connection pool
kubectl rollout restart deployment/frs-backend
```

## Connection String Update
If DB endpoint changes (e.g. DR restore), update:
- `DATABASE_URL` in Kubernetes secrets
- Re-deploy backend pods
- Verify pool connections: check `/api/health` returns `"database":"UP"`

## Post-Failover Checks
- [ ] Audit log writes succeeding
- [ ] RLS policies active on new primary
- [ ] Attendance records visible per tenant
- [ ] Face embeddings accessible
