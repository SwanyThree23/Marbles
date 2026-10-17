#!/bin/bash
# Nightly database backup (cron: deploy/setup-vps.sh installs it). Keeps 14 days.
#   restore: pg_restore --clean --if-exists -d "$DATABASE_URL" /var/backups/kims-marbles/<file>.dump
set -euo pipefail
DIR=${BACKUP_DIR:-/var/backups/kims-marbles}
ENV_FILE=${ENV_FILE:-/opt/kims-marbles/kims-marbles-backend/server/.env}
KEEP_DAYS=${KEEP_DAYS:-14}
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
fi
[ -n "$DATABASE_URL" ] || { echo "backup: DATABASE_URL not found" >&2; exit 1; }
mkdir -p "$DIR"
chmod 700 "$DIR"
OUT="$DIR/kims-marbles-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --file="$OUT.partial" "$DATABASE_URL"
mv "$OUT.partial" "$OUT"
find "$DIR" -name 'kims-marbles-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"
