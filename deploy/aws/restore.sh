#!/usr/bin/env bash
# Restore a backup into a NEW, empty database (never over the live one), check it, then switch DATABASE_URL.
#   ./restore.sh db/2026-11-22T041500Z.dump postgresql://user:pass@new-host:5432/dental
set -euo pipefail
cd "$(dirname "$0")"
set -a; source ./.env; set +a
KEY="$1"; TARGET="$2"
aws s3 cp "s3://${BACKUP_BUCKET}/${KEY}" /tmp/restore.dump --only-show-errors
pg_restore --no-owner --clean --if-exists --dbname="$TARGET" /tmp/restore.dump
rm -f /tmp/restore.dump
psql "$TARGET" -c "select count(*) as clinics from clinics; select count(*) as appointments from appointments;"
echo "Restored. Point api/.env DATABASE_URL at the new database and restart: docker compose -f docker-compose.prod.yml up -d"
