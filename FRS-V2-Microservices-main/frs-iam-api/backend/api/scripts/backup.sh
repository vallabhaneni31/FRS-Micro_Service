#!/bin/bash
# ------------------------------------------------------------------------------
# FRS Enterprise PostgreSQL Backup Script
# Automatically dumps the FRS database, compresses it, uploads it to AWS S3/Object Storage,
# and rotates local retention logs.
# ------------------------------------------------------------------------------

# Configurable environment variables (fall back to production .env defaults)
DB_HOST=${DB_HOST:-"localhost"}
DB_PORT=${DB_PORT:-"5432"}
DB_NAME=${DB_NAME:-"attendance_intelligence"}
DB_USER=${DB_USER:-"postgres"}
DB_PASSWORD=${DB_PASSWORD:-"postgres123"}
S3_BUCKET=${S3_BUCKET:-"frs-database-backups-production"}

# Local retention configurations
BACKUP_DIR="/tmp/frs_backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.dump"
GZIP_FILE="${BACKUP_FILE}.gz"

echo "[$(date)] Starting FRS Database Backup..."
mkdir -p "${BACKUP_DIR}"

# Run pg_dump in custom compressed format
export PGPASSWORD="${DB_PASSWORD}"
pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -F c -b -v -f "${BACKUP_FILE}" "${DB_NAME}"

if [ $? -eq 0 ]; then
  echo "[$(date)] Database dump successfully created: ${BACKUP_FILE}"
  
  # Compress backup to save network/storage resources
  gzip -9 "${BACKUP_FILE}"
  echo "[$(date)] Backup compressed successfully: ${GZIP_FILE}"
  
  # Secure transfer to AWS S3/Object Storage
  if command -v aws &> /dev/null; then
    echo "[$(date)] AWS CLI detected. Uploading backup to s3://${S3_BUCKET}..."
    aws s3 cp "${GZIP_FILE}" "s3://${S3_BUCKET}/${DB_NAME}_${TIMESTAMP}.dump.gz"
    if [ $? -eq 0 ]; then
      echo "[$(date)] Backup successfully uploaded to secure offsite S3 storage."
    else
      echo "⚠️ [$(date)] WARNING: AWS S3 copy failed. Check IAM permissions and network connectivity."
    fi
  else
    echo "ℹ️ AWS CLI not installed on this node. Backup preserved locally at ${GZIP_FILE}"
  fi
  
  # Rotate local backups (keep last 7 days of snapshots locally)
  find "${BACKUP_DIR}" -name "*.dump.gz" -mtime +7 -delete
  echo "[$(date)] Completed local 7-day retention cleanup."
else
  echo "❌ [$(date)] ERROR: pg_dump execution failed. Backup terminated."
  exit 1
fi
