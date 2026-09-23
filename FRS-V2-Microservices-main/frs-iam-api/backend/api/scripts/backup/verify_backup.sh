#!/usr/bin/env bash
# verify_backup.sh — FIX-042: Verify and optionally restore FRS S3 backup
#
# Usage:
#   ./verify_backup.sh latest           — verify most recent backup integrity
#   ./verify_backup.sh --list           — list available backups
#   ./verify_backup.sh <s3-key>         — verify a specific backup file
#   ./verify_backup.sh restore <s3-key> — decrypt and restore to DB
#
# Required env vars:
#   BACKUP_S3_BUCKET      — S3 bucket name
#   BACKUP_ENCRYPTION_KEY — AES passphrase used during backup
#   DATABASE_URL          — (for restore only) target DB connection string

set -euo pipefail

S3_BUCKET=${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}
ENC_KEY=${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}
PREFIX=${BACKUP_PREFIX:-postgres}
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
die()  { echo "[ERROR] $*" >&2; exit 1; }

# ── List backups ──────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--list" ]]; then
  aws s3 ls "s3://${S3_BUCKET}/${PREFIX}/" | sort -r | head -20
  exit 0
fi

# ── Resolve target backup ─────────────────────────────────────────────────────
if [[ "${1:-}" == "latest" ]]; then
  S3_KEY=$(aws s3 ls "s3://${S3_BUCKET}/${PREFIX}/" | sort -r | head -1 | awk '{print $4}')
  [[ -z "$S3_KEY" ]] && die "No backups found in s3://${S3_BUCKET}/${PREFIX}/"
  S3_KEY="${PREFIX}/${S3_KEY}"
elif [[ "${1:-}" == "restore" ]]; then
  S3_KEY="${2:?Usage: verify_backup.sh restore <s3-key>}"
  RESTORE_MODE=true
else
  S3_KEY="${1:?Usage: verify_backup.sh <latest|--list|s3-key>}"
fi

log "Target backup: s3://${S3_BUCKET}/${S3_KEY}"

# ── Download backup ───────────────────────────────────────────────────────────
LOCAL_ENC="$WORKDIR/$(basename "$S3_KEY")"
log "Downloading..."
aws s3 cp "s3://${S3_BUCKET}/${S3_KEY}" "$LOCAL_ENC" --no-progress

# ── Verify SHA-256 against S3 metadata ───────────────────────────────────────
STORED_SHA256=$(aws s3api head-object \
  --bucket "$S3_BUCKET" \
  --key    "$S3_KEY" \
  --query  "Metadata.sha256" \
  --output text 2>/dev/null || echo "")

if [[ -n "$STORED_SHA256" ]]; then
  ACTUAL_SHA256=$(sha256sum "$LOCAL_ENC" | awk '{print $1}')
  if [[ "$STORED_SHA256" == "$ACTUAL_SHA256" ]]; then
    log "✅ SHA-256 checksum verified: ${ACTUAL_SHA256:0:16}..."
  else
    die "SHA-256 MISMATCH — backup may be corrupted or tampered!\n  Expected: $STORED_SHA256\n  Got:      $ACTUAL_SHA256"
  fi
else
  log "⚠️  No SHA-256 metadata found — skipping checksum verification"
fi

# ── Decrypt and verify ────────────────────────────────────────────────────────
LOCAL_DEC="$WORKDIR/decrypted.dump.gz"
log "Decrypting..."
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -d \
  -pass "pass:${ENC_KEY}" \
  -in  "$LOCAL_ENC" \
  -out "$LOCAL_DEC" \
  || die "Decryption failed — wrong key or corrupted file"

# ── Verify dump integrity (pg_restore --list is non-destructive) ──────────────
log "Verifying dump structure..."
LOCAL_DUMP="$WORKDIR/decrypted.dump"
gunzip -c "$LOCAL_DEC" > "$LOCAL_DUMP"

TABLE_COUNT=$(pg_restore --list "$LOCAL_DUMP" | grep -c "TABLE DATA" || true)
log "✅ Dump verified — ${TABLE_COUNT} TABLE DATA entries found"

# ── Restore (only in restore mode) ───────────────────────────────────────────
if [[ "${RESTORE_MODE:-false}" == "true" ]]; then
  DB_URL=${DATABASE_URL:?DATABASE_URL is required for restore}

  log "⚠️  RESTORE MODE — this will overwrite the target database"
  log "Target: $DB_URL"
  read -r -p "Type 'RESTORE' to confirm: " CONFIRM
  [[ "$CONFIRM" != "RESTORE" ]] && die "Restore cancelled"

  log "Restoring..."
  pg_restore \
    --no-password \
    --clean \
    --if-exists \
    --dbname="$DB_URL" \
    --verbose \
    "$LOCAL_DUMP" \
    || die "pg_restore failed"

  log "✅ Restore complete"
fi

log "✅ Backup verification passed: $(basename "$S3_KEY")"
