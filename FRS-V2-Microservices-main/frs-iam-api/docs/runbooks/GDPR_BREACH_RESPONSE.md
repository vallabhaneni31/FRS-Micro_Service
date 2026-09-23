# GDPR Data Breach Response Runbook — FRS Platform
**FRS-RB-006 | v1.0 | 2026-05-24**

## GDPR Obligations Timeline
| Hour | Obligation |
|------|-----------|
| 0 | Incident confirmed — start clock |
| +1 | DPO notified; initial containment |
| +4 | Breach assessment: personal data types, number of subjects |
| +24 | Internal incident report complete |
| +72 | **Supervisory Authority notification required** (Art. 33) |
| +72h | Data subject notification if high risk (Art. 34) |

## Breach Assessment Questions
1. What categories of personal data are involved?
   - ☐ Names / identifiers
   - ☐ **Biometric data (face embeddings / photos)** — HIGH RISK
   - ☐ Attendance records
   - ☐ Authentication credentials
2. Approximate number of data subjects affected?
3. Is the data encrypted? (Face embeddings: AES-256-GCM per FIX-021)
4. What is the likely consequence for data subjects?

## Immediate Actions
```bash
# 1. Identify affected tenant
psql $DATABASE_URL -c "SELECT tenant_id, COUNT(*) FROM audit_log
  WHERE action LIKE 'security%' AND created_at > NOW() - '1 hour'::interval
  GROUP BY tenant_id ORDER BY COUNT(*) DESC LIMIT 10;"

# 2. Revoke all device tokens for affected tenant
psql $DATABASE_URL -c "
  UPDATE facility_device SET current_jti = NULL
  WHERE tenant_id = '<affected-tenant-id>'::uuid;"

# 3. Trigger GDPR erasure if biometric data was exposed
curl -X DELETE https://api.frs.example.com/api/employees/${EMP_ID}/biometric-data \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 4. Export audit log for evidence
psql $DATABASE_URL -c "\COPY (SELECT * FROM audit_log
  WHERE created_at > '2026-05-24' ORDER BY created_at) TO '/tmp/breach_audit.csv' CSV HEADER;"
```

## SA Notification Template
- Controller: [Tenant Organisation Name]
- Processor: FRS Platform Operator
- Nature of breach: [describe]
- Categories of data: biometric identifiers / attendance records
- Approximate number of subjects: [N]
- Likely consequences: [describe]
- Measures taken: [encryption status, revocation, erasure]
- Contact: [DPO name, email]
