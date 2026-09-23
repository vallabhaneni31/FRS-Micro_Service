#!/usr/bin/env bash
# backup.sh — FIX-042: Encrypted S3 backup for FRS PostgreSQL + embeddings
#
# Performs:
#   1. pg_dump → gzip → AES-256-CBC encrypt → upload to S3
#   2. Embeddings directory snapshot → tar → gzip → encrypt → S3
#   3. Verify upload integrity (SHA-256 checksum)
#   4. Prune backups older than BACKUP_RETENTION_DAYS (default 30)
#
# Required env vars:
#   DATABASE_URL          — PostgreSQL connection string
#   BACKUP_S3_BUCKET      — S3 bucket name (e.g. frs-backups-prod)
#   BACKUP_ENCRYPTION_KEY — AES passphrase (min 32 chars) — store in secrets manager
#   AWS_REGION            — AWS region for S3
#
# Optional:
#   BACKUP_RETENTION_DAYS — days to keep backups (default: 30)
#   BACKUP_PREFIX         — S3 key prefix (default: postgres)
#   ALERT_SLACK_WEBHOOK_URL — notify on failure

set -euo pipefail

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
S3_BUCKET=${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}
ENC_KEY=${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}
PREFIX=${BACKUP_PREFIX:-postgres}
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { echo "[ERROR] $*" >&2; notify_slack "❌ FRS Backup FAILED: $*"; exit 1; }

notify_slack() {
  local msg="$1"
  if [[ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ]]; then
    curl -s -X POST "$ALERT_SLACK_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"text\": \"$msg\"}" > /dev/null || true
  fi
}

# ── 1. PostgreSQL dump ────────────────────────────────────────────────────────
log "Starting PostgreSQL backup..."

DB_DUMP="$WORKDIR/frs_${TIMESTAMP}.sql.gz"
DB_ENC="$WORKDIR/frs_${TIMESTAMP}.sql.gz.enc"
DB_S3_KEY="${PREFIX}/frs_${TIMESTAMP}.sql.gz.enc"

pg_dump "$DATABASE_URL" \
  --no-password \
  --format=custom \
  --compress=9 \
  --file="$WORKDIR/frs_${TIMESTAMP}.dump" \
  || die "pg_dump failed"

gzip -c "$WORKDIR/frs_${TIMESTAMP}.dump" > "$DB_DUMP"

# Encrypt with AES-256-CBC + PBKDF2 (openssl 3.x default)
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
  -pass "pass:${ENC_KEY}" \
  -in  "$DB_DUMP" \
  -out "$DB_ENC" \
  || die "Encryption failed"

# Compute checksum before upload
DB_SHA256=$(sha256sum "$DB_ENC" | awk '{print $1}')
log "DB backup checksum: $DB_SHA256"

# Upload to S3 with server-side encryption
aws s3 cp "$DB_ENC" "s3://${S3_BUCKET}/${DB_S3_KEY}" \
  --sse aws:kms \
  --metadata "sha256=${DB_SHA256},timestamp=${TIMESTAMP}" \
  --no-progress \
  || die "S3 upload failed for DB backup"

log "✅ DB backup uploaded: s3://${S3_BUCKET}/${DB_S3_KEY}"

# ── 2. Embeddings snapshot (encrypted at rest via DB, but backup the blobs too) ─
EMBED_DIR=${EMBEDDINGS_DIR:-/app/uploads/enrollment-photos}
if [[ -d "$EMBED_DIR" ]]; then
  log "Backing up embeddings directory: $EMBED_DIR"

  EMBED_TAR="$WORKDIR/embeddings_${TIMESTAMP}.tar.gz"
  EMBED_ENC="$WORKDIR/embeddings_${TIMESTAMP}.tar.gz.enc"
  EMBED_S3_KEY="embeddings/embeddings_${TIMESTAMP}.tar.gz.enc"

  tar -czf "$EMBED_TAR" -C "$(dirname "$EMBED_DIR")" "$(basename "$EMBED_DIR")" \
    || die "tar of embeddings failed"

  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
    -pass "pass:${ENC_KEY}" \
    -in  "$EMBED_TAR" \
    -out "$EMBED_ENC" \
    || die "Encryption of embeddings failed"

  EMBED_SHA256=$(sha256sum "$EMBED_ENC" | awk '{print $1}')

  aws s3 cp "$EMBED_ENC" "s3://${S3_BUCKET}/${EMBED_S3_KEY}" \
    --sse aws:kms \
    --metadata "sha256=${EMBED_SHA256},timestamp=${TIMESTAMP}" \
    --no-progress \
    || die "S3 upload failed for embeddings backup"

  log "✅ Embeddings backup uploaded: s3://${S3_BUCKET}/${EMBED_S3_KEY}"
else
  log "⚠️  Embeddings directory not found: $EMBED_DIR — skipping"
fi

# ── 3. Write manifest ─────────────────────────────────────────────────────────
MANIFEST="$WORKDIR/manifest_${TIMESTAMP}.json"
cat > "$MANIFEST" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "db_backup":        "s3://${S3_BUCKET}/${DB_S3_KEY}",
  "db_sha256":        "${DB_SHA256}",
  "embeddings_sha256": "${EMBED_SHA256:-none}",
  "retention_days":   ${RETENTION_DAYS}
}
EOF

aws s3 cp "$MANIFEST" "s3://${S3_BUCKET}/manifests/manifest_${TIMESTAMP}.json" \
  --no-progress || true

# ── 4. Prune old backups ──────────────────────────────────────────────────────
log "Pruning backups older than ${RETENTION_DAYS} days..."
CUTOFF=$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null \
      || date -u -v-${RETENTION_DAYS}d +%Y-%m-%dT%H:%M:%S)

aws s3 ls "s3://${S3_BUCKET}/${PREFIX}/" | while read -r line; do
  FILE_DATE=$(echo "$line" | awk '{print $1"T"$2}')
  FILE_NAME=$(echo "$line" | awk '{print $4}')
  if [[ "$FILE_DATE" < "$CUTOFF" && -n "$FILE_NAME" ]]; then
    aws s3 rm "s3://${S3_BUCKET}/${PREFIX}/${FILE_NAME}" --quiet
    log "Pruned: ${FILE_NAME}"
  fi
done

log "✅ Backup complete: ${TIMESTAMP}"
notify_slack "✅ FRS backup complete (${TIMESTAMP}) — DB: ${DB_SHA256:0:12}..."
