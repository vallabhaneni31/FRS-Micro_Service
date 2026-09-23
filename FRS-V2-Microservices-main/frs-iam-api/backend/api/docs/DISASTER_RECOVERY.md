# FRS Enterprise Disaster Recovery (DR) & Business Continuity Plan

This document outlines the Recovery Time Objectives (RTO), Recovery Point Objectives (RPO), backup strategies, offsite replication, and step-by-step database restoration procedures for the Facial Recognition System (FRS) multi-tenant SaaS platform.

---

## ⏱️ Recovery Targets

| Metric | Target | Description |
|---|---|---|
| **Recovery Point Objective (RPO)** | **< 1 Hour** | Maximum acceptable data loss duration. Realized via hourly incremental database backups and WAL archiving. |
| **Recovery Time Objective (RTO)** | **< 4 Hours** | Maximum acceptable downtime before primary systems are restored. |

---

## 🗄️ Backup Architecture

1. **Daily Full Logical Backups:** Executed every night at 02:00 UTC using `pg_dump` via `scripts/backup.sh`.
2. **Offsite Storage Replication:** All compressed backup dumps (`.dump.gz`) are copied immediately to a secure AWS S3 bucket configured with:
   * **AES-256 Default Server-Side Encryption.**
   * **Object Lock (WORM compliance)** to prevent ransomware tampering.
   * **Lifecycle policies** transitioning backups to S3 Glacier after 30 days, and deleting after 365 days.
3. **Write-Ahead Logging (WAL) Archiving (Continuous PITR):**
   * Production PostgreSQL has `archive_mode = on` enabled, shipping WAL segments to AWS S3 every 60 seconds to enable point-in-time recovery (PITR) down to the nearest minute.

---

## 🛠️ Step-by-Step Restoration Procedure

In the event of a catastrophic failure, data corruption, or server loss, follow these instructions to restore the database:

### Step 1: Provision a Clean Database Instance
1. Deploy a new PostgreSQL container/instance running matching major version (v15+).
2. Configure SSL connection settings (`DB_SSL=true`).

### Step 2: Retrieve the Latest Backup Dump
1. Log in to the S3 backup bucket:
   ```bash
   aws s3 ls s3://frs-database-backups-production/
   ```
2. Download the desired target snapshot:
   ```bash
   aws s3 cp s3://frs-database-backups-production/attendance_intelligence_20260524_020000.dump.gz /tmp/
   ```
3. Decompress the downloaded snapshot:
   ```bash
   gunzip /tmp/attendance_intelligence_20260524_020000.dump.gz
   ```

### Step 3: Restore Database Schema & Telemetry Data
1. Re-create the empty target database:
   ```bash
   psql -h <db_host> -U postgres -c "CREATE DATABASE attendance_intelligence;"
   ```
2. Execute the `pg_restore` utility using the decompressed custom-format dump file:
   ```bash
   pg_restore -h <db_host> -U postgres -d attendance_intelligence -v /tmp/attendance_intelligence_20260524_020000.dump
   ```
3. Verify that all tables, triggers, and indices have been restored successfully.

### Step 4: Apply Database Security & Immutability Policies
1. Ensure the RLS policies and immutability triggers on the audit log have been successfully loaded:
   ```bash
   psql -h <db_host> -U postgres -d attendance_intelligence -c "SELECT trigger_name FROM information_schema.triggers WHERE event_object_table = 'audit_log';"
   ```
   *(Must return `trg_immutable_audit`)*.

---

## 📋 Disaster Recovery Drills

DR recovery drills must be performed **semi-annually (every 6 months)** to ensure:
* Backup S3 credentials remain active and rotated.
* Actual restore operations comply with the **< 4 Hour RTO** target.
* Restored data integrity matches primary records exactly.
