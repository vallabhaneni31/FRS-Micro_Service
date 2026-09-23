# Disaster Recovery Drill Procedure
## FRS (Facial Recognition System) — Enterprise SaaS Platform

**Document Reference:** FRS-RB-001  
**Version:** 1.0  
**Date:** 2026-05-24  
**Classification:** INTERNAL — RESTRICTED  
**Owner:** DevOps / SRE Team  
**Review Cycle:** Before each drill; annually at minimum

---

## 1. Purpose

This runbook defines the procedures for conducting a Disaster Recovery (DR) drill for the FRS platform. A DR drill validates that:

- Recovery Time Objective (**RTO: 4 hours**) is achievable
- Recovery Point Objective (**RPO: 1 hour**) is met by backup frequency
- All team members know their roles
- Runbook steps are accurate and executable
- Monitoring and alerting fire as expected during failure

---

## 2. Drill Frequency and Schedule

| Drill Type | Frequency | Lead |
|-----------|-----------|------|
| Tabletop (no actual failover) | Quarterly | Engineering Lead |
| Full failover drill | Annually | DevOps + Engineering Lead |
| Backup restoration test | Monthly | DevOps |

**Next scheduled full drill:** 2026-11-24

---

## 3. Pre-Drill Checklist

Complete at least 5 business days before the drill:

- [ ] Notify all on-call team members of drill date/time
- [ ] Confirm DR environment is provisioned and up-to-date
- [ ] Verify last successful backup restoration test
- [ ] Review any changes to production since the last drill
- [ ] Confirm PagerDuty escalation policy is configured correctly
- [ ] Pre-create all required credentials in DR environment secrets manager
- [ ] Set `DRILL_MODE=true` env var so drill alerts don't page customers

---

## 4. Roles and Responsibilities

| Role | Person | Contact |
|------|--------|---------|
| Drill Commander | Engineering Lead | ___________ |
| Database Recovery | DBA / Backend Lead | ___________ |
| Infrastructure | DevOps | ___________ |
| Communications | Engineering Manager | ___________ |
| Observer / Auditor | Security / QA | ___________ |

---

## 5. Scenario: Complete Region Failure

### 5.1 Simulation Trigger (Tabletop)

> *"AWS ap-south-1 region has become unavailable. All production services are unreachable. RDS primary and all read replicas are inaccessible."*

### 5.2 Recovery Steps

#### Step 1: Incident Declaration (T+0)
```
[ ] Drill Commander declares incident in #incidents Slack channel
[ ] PagerDuty incident created — verify alert fires correctly
[ ] All roles confirmed assembled
[ ] Status page set to "Investigating"
```

#### Step 2: Assess Blast Radius (T+0 to T+15 min)
```bash
# Verify production is down
curl -o /dev/null -s -w "%{http_code}" https://api.frs.example.com/api/health
# Expected: connection refused or 503

# Confirm last successful backup timestamp
aws s3 ls s3://${BACKUP_BUCKET}/postgres/ --recursive | tail -5
aws s3 ls s3://${BACKUP_BUCKET}/embeddings/ --recursive | tail -5
```

#### Step 3: Provision DR Database (T+15 to T+60 min)
```bash
# Restore PostgreSQL from latest backup to DR region
cd scripts/backup/

# 1. Download latest backup
./verify_backup.sh latest
BACKUP_FILE=$(./verify_backup.sh --list | head -1)

# 2. Decrypt and restore
./restore_backup.sh $BACKUP_FILE $DR_DB_HOST

# 3. Verify row counts
psql $DR_DATABASE_URL -c "
  SELECT 'frs_tenant' AS t, COUNT(*) FROM frs_tenant
  UNION ALL SELECT 'hr_employee', COUNT(*) FROM hr_employee
  UNION ALL SELECT 'face_embedding', COUNT(*) FROM face_embedding
  UNION ALL SELECT 'attendance_record', COUNT(*) FROM attendance_record;
"
```

#### Step 4: Deploy Backend to DR Environment (T+45 to T+90 min)
```bash
# Point to DR database
export DATABASE_URL="$DR_DATABASE_URL"
export REDIS_URL="$DR_REDIS_URL"
export NODE_ENV=production

# Run migrations on DR DB
cd backend && node scripts/migrate.js

# Deploy via Docker / ECS / K8s — use DR manifests
kubectl apply -f infra/k8s/dr/ --context=$DR_KUBE_CONTEXT

# Wait for pods ready
kubectl rollout status deployment/frs-backend --context=$DR_KUBE_CONTEXT
```

#### Step 5: Validate Core Functions (T+90 to T+120 min)
```bash
# Health check
curl https://api-dr.frs.example.com/api/health

# Verify authentication works
TOKEN=$(curl -s -X POST https://auth-dr.frs.example.com/token \
  -d "client_id=$KC_CLIENT_ID&client_secret=$KC_SECRET&grant_type=client_credentials" \
  | jq -r .access_token)

# Check a tenant exists
curl -H "Authorization: Bearer $TOKEN" https://api-dr.frs.example.com/api/app-admin/tenants

# Verify audit log is writable
curl -H "Authorization: Bearer $TOKEN" https://api-dr.frs.example.com/api/health
```

#### Step 6: DNS Cutover (T+120 min)
```
[ ] Update DNS CNAME: api.frs.example.com → api-dr.frs.example.com (TTL: 60s)
[ ] Notify tenant admins of temporary regional failover
[ ] Update status page: "Service restored in DR region"
[ ] Monitor error rates for 15 minutes post-cutover
```

#### Step 7: Jetson Device Reconnection (T+120 to T+180 min)
```
[ ] Push new API endpoint to all Jetson devices via device management API
[ ] Verify heartbeats resume from edge devices
[ ] Confirm attendance events flowing through Kafka (if Kafka survived)
[ ] Issue new device tokens via /api/device-tokens/:id/rotate
```

---

## 6. Rollback Procedure

If DR environment is unstable:
```
[ ] Revert DNS to original production endpoints
[ ] Communicate updated ETA to stakeholders
[ ] Escalate to Engineering Lead + VP Engineering
```

---

## 7. Post-Drill Actions

Complete within 48 hours of drill:

- [ ] Document actual RTO achieved vs. 4h target
- [ ] Document actual RPO (data loss) vs. 1h target
- [ ] List any steps that failed or were unclear
- [ ] File tickets for all improvements identified
- [ ] Update this runbook with corrections
- [ ] Schedule re-drill if RTO was not met

### Drill Results Log

| Date | RTO Achieved | RPO Achieved | Issues Found | Pass/Fail |
|------|-------------|-------------|-------------|-----------|
| ___________ | ___________ | ___________ | ___________ | ___________ |

---

## 8. Related Runbooks

- [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md)
- [DB_FAILOVER.md](DB_FAILOVER.md)
- [BACKUP_PROCEDURE.md](BACKUP_PROCEDURE.md)
- [JETSON_RECOVERY.md](JETSON_RECOVERY.md)
- [GDPR_BREACH_RESPONSE.md](GDPR_BREACH_RESPONSE.md)

---

*FIX-041 — Reviewed by Security Engineering. Next review: 2027-05-24.*
