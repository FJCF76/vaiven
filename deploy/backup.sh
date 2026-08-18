#!/usr/bin/env bash
# Hot backup, verified. Run from cron.
#
# `.backup` is safe against a live WAL writer, unlike copying the file. The integrity check
# is the part people skip: an unverified backup is a guess, and you find out which it was on
# the day you need it.
set -euo pipefail

DB=${VAIVEN_DB:-/var/lib/vaiven/db.sqlite}
DIR=${VAIVEN_BACKUP_DIR:-/var/lib/vaiven/backups}
KEEP=${VAIVEN_BACKUP_KEEP:-14}

mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/db-$STAMP.sqlite"

sqlite3 "$DB" ".backup '$OUT'"

RESULT=$(sqlite3 "$OUT" "PRAGMA integrity_check;" | head -1)
if [ "$RESULT" != "ok" ]; then
	echo "BACKUP FAILED INTEGRITY CHECK: $RESULT" >&2
	mv "$OUT" "$OUT.corrupt"
	exit 1
fi

# Prove it is a database and not just a well-formed file.
DOCS=$(sqlite3 "$OUT" "SELECT count(*) FROM docs;")
echo "$STAMP  ok  ${DOCS} documents  $(du -h "$OUT" | cut -f1)"

ls -1t "$DIR"/db-*.sqlite 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --
