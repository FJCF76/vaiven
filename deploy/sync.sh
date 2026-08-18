#!/usr/bin/env bash
# Push the working tree to /opt/vaiven and restart the service.
#
# The service runs as its own user under ProtectHome, so it cannot read the repo where
# it is developed. This is the one step between editing and running.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST=/opt/vaiven

sudo -n install -d -o vaiven -g vaiven -m 0755 "$DEST"
sudo -n install -d -o vaiven -g vaiven -m 0750 /var/lib/vaiven
sudo -n install -d -o root -g root -m 0755 /etc/vaiven

# Source only. node_modules is dev tooling (playwright); the service needs no packages.
sudo -n rsync -a --delete \
	--exclude ".git" \
	--exclude "node_modules" \
	--exclude "experiments" \
	--exclude "docs" \
	--exclude "*.sqlite*" \
	--exclude "vaiven-spec.md" \
	--exclude "CLAUDE.md" \
	"$REPO"/ "$DEST"/

sudo -n chown -R vaiven:vaiven "$DEST"

sudo -n install -m 0644 "$REPO/deploy/vaiven.service" /etc/systemd/system/vaiven.service
sudo -n install -m 0644 "$REPO/deploy/vaiven-backup.service" /etc/systemd/system/vaiven-backup.service
sudo -n install -m 0644 "$REPO/deploy/vaiven-backup.timer" /etc/systemd/system/vaiven-backup.timer
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now vaiven-backup.timer
sudo -n systemctl restart vaiven

sleep 1
systemctl is-active --quiet vaiven && echo "vaiven: running" || {
	echo "vaiven: FAILED to start" >&2
	sudo -n journalctl -u vaiven -n 30 --no-pager >&2
	exit 1
}
