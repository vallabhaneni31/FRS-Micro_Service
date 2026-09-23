# Backup and Restore Procedure — FRS Platform
**FRS-RB-005 | v1.0 | 2026-05-24**

## Backup Schedule
| Data | Frequency | Retention | Location |
|------|-----------|-----------|---------|
| PostgreSQL full dump | Daily 02:00 UTC | 30 days | S3 frs-backups-prod/postgres/ |
| Enrollment photos | Daily 02:30 UTC | 30 days | S3 frs-backups-prod/embeddings/ |
| Kubernetes config | On change | 90 days | S3 frs-backups-prod/k8s/ |

## Run Manual Backup
```bash
cd backend/api/scripts/backup/
BACKUP_S3_BUCKET=frs-backups-prod \
BACKUP_ENCRYPTION_KEY=$(aws secretsmanager get-secret-value \
  --secret-id frs/backup-key --query SecretString --output text) \
DATABASE_URL=$DATABASE_URL \
bash backup.sh
```

## Verify Backup Integrity
```bash
# Verify most recent backup
BACKUP_S3_BUCKET=frs-backups-prod \
BACKUP_ENCRYPTION_KEY=$ENC_KEY \
bash verify_backup.sh latest

# List available backups
bash verify_backup.sh --list
```

## Restore Procedure
```bash
# Interactive restore (requires typing 'RESTORE' to confirm)
BACKUP_S3_BUCKET=frs-backups-prod \
BACKUP_ENCRYPTION_KEY=$ENC_KEY \
DATABASE_URL=$DR_DATABASE_URL \
bash verify_backup.sh restore postgres/frs_20260524T020000Z.sql.gz.enc
```

## Monthly Backup Test
1. Download latest backup to test environment
2. Run `verify_backup.sh restore` against test DB
3. Verify row counts match production snapshot
4. Document result in this runbook's test log below

| Date | Backup File | Row Counts Match | Tester |
|------|------------|-----------------|--------|
| ___________ | ___________ | ☐ Yes ☐ No | ___________ |
