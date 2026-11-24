#!/usr/bin/env bash
# Nightly logical backup of the database to S3, encrypted with KMS. RDS automated backups are the
# first line of recovery; this copy protects against a deleted instance or a bad migration.
# Cron (as ec2-user):  15 4 * * * /home/ec2-user/dental-ai-receptionist/deploy/aws/backup.sh >> /home/ec2-user/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
trap 'msg="[dental-ai] Nightly database backup FAILED on $(hostname)"; [ -n "${ALERT_WEBHOOK_URL:-}" ] && curl -s -X POST -H "Content-Type: application/json" -d "{\"text\":\"$msg\",\"content\":\"$msg\"}" "$ALERT_WEBHOOK_URL" >/dev/null' ERR
set -a; source ./.env; source ../../api/.env; set +a
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
FILE="/tmp/dental-${STAMP}.dump"
# Custom format = compressed, restorable table by table
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$FILE"
aws s3 cp "$FILE" "s3://${BACKUP_BUCKET}/db/${STAMP}.dump" --sse aws:kms --sse-kms-key-id "$BACKUP_KMS_KEY_ID" --only-show-errors
rm -f "$FILE"
echo "$(date -u) backup ok: db/${STAMP}.dump"
