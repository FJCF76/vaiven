#!/usr/bin/env bash
# The restore, rehearsed and timed, against a scratch copy.
#
# Deferring replication is a decision. Deferring the drill is an untested recovery path,
# which is a different thing and a worse one.
set -euo pipefail

DIR=${VAIVEN_BACKUP_DIR:-/var/lib/vaiven/backups}
LATEST=$(ls -1t "$DIR"/db-*.sqlite 2>/dev/null | head -1)
[ -n "$LATEST" ] || { echo "No backup in $DIR. Run backup.sh first." >&2; exit 1; }

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

echo "restoring $LATEST"
START=$(date +%s%N)
cp "$LATEST" "$SCRATCH/db.sqlite"

sqlite3 "$SCRATCH/db.sqlite" "PRAGMA integrity_check;" | head -1
TENANTS=$(sqlite3 "$SCRATCH/db.sqlite" "SELECT count(*) FROM tenants;")
DOCS=$(sqlite3 "$SCRATCH/db.sqlite" "SELECT count(*) FROM docs;")
EVENTS=$(sqlite3 "$SCRATCH/db.sqlite" "SELECT count(*) FROM events;")

# The restored copy has to actually serve, not merely open.
VAIVEN_DB="$SCRATCH/db.sqlite" VAIVEN_APP_HOST=vaiven.localhost \
VAIVEN_SANDBOX_HOST=uc.vaiven.localhost VAIVEN_SCHEME=http \
VAIVEN_PORT=8099 VAIVEN_BIND=127.0.0.1 VAIVEN_PUBLIC_PORT=8099 \
	/usr/local/bin/bun run "$(dirname "$0")/../src/index.ts" >"$SCRATCH/log" 2>&1 &
PID=$!
sleep 2
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: vaiven.localhost' http://127.0.0.1:8099/ || echo 000)
kill "$PID" 2>/dev/null || true

END=$(date +%s%N)
echo "tenants=$TENANTS docs=$DOCS events=$EVENTS  served=$CODE  in $(( (END-START)/1000000 ))ms"
[ "$CODE" = "200" ] || { echo "RESTORE DRILL FAILED: the restored database did not serve" >&2; exit 1; }
echo "restore drill passed"
