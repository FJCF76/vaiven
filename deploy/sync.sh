#!/usr/bin/env bash
# Push the working tree to /opt/vaiven and restart the service.
#
# The service runs as its own user under ProtectHome, so it cannot read the repo where
# it is developed. This is the one step between editing and running.
#
#   deploy/sync.sh                deploy, then verify
#   deploy/sync.sh --verify-only  verify a host without deploying to it
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST=/opt/vaiven
ENV_FILE=/etc/vaiven/vaiven.env

VERIFY_ONLY=0
case "${1:-}" in
	--verify-only) VERIFY_ONLY=1 ;;
	"") ;;
	*) echo "usage: sync.sh [--verify-only]" >&2; exit 2 ;;
esac

# Config comes from the environment when it is already set, so --verify-only runs without
# sudo and can be driven by a test.
# `-` not `:-`: an exported empty value means empty, so read_env (and its sudo) is
# reached only when the variable is genuinely unset. With `:-`, setting a key to ""
# silently fell through to sudo and the failure was swallowed by `|| true`.
read_env() { sudo -n sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1 || true; }
APP_HOST="${VAIVEN_APP_HOST-$(read_env VAIVEN_APP_HOST)}"
BIND="${VAIVEN_BIND-$(read_env VAIVEN_BIND)}"
PORT="${VAIVEN_PORT-$(read_env VAIVEN_PORT)}"

# An IPv6 literal has to be bracketed or the URL is malformed: ::1 would otherwise
# build http://::1:8080/guide.md, which curl cannot parse.
case "$BIND" in
	*:*) HEALTH_URL="http://[$BIND]:$PORT/guide.md" ;;
	*)   HEALTH_URL="http://$BIND:$PORT/guide.md" ;;
esac

diagnose() { sudo -n journalctl -u vaiven -n 30 --no-pager >&2 || true; }

# `is-active` says the process launched, not that it answers, so ask it for a real page.
# Compare the status explicitly: `curl -f` exits 0 on a 3xx, so a redirect away from the
# app would otherwise have counted as "serving". Quiet per attempt, because the service is
# normally still starting on the first try and a transient "connection refused" printed
# under a successful deploy reads as a failure. verify_running prints one clear message.
serves_a_page() {
	local code
	code=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' \
		-H "Host: $APP_HOST" "$HEALTH_URL" 2>/dev/null || true)
	[ "$code" = "200" ]
}

verify_running() {
	local attempt
	# Say which key is missing. Without this the loop below just fails N times and
	# reports "not serving http://:/guide.md as ", which names nothing.
	if [ -z "$APP_HOST" ] || [ -z "$BIND" ] || [ -z "$PORT" ]; then
		echo "vaiven: cannot check health — VAIVEN_APP_HOST, VAIVEN_BIND or VAIVEN_PORT is missing from $ENV_FILE" >&2
		return 1
	fi
	# errexit is off inside a function called on the left of `||`, so a junk value here
	# would not abort; clamp it instead. 0 or a non-number would otherwise skip the loop
	# entirely and report a health failure that was never actually checked.
	local attempts="${VAIVEN_HEALTH_ATTEMPTS:-10}"
	case "$attempts" in ''|*[!0-9]*|0) attempts=10 ;; esac
	[ "$attempts" -gt 60 ] && attempts=60

	for attempt in $(seq 1 "$attempts"); do
		if serves_a_page; then
			# One good response proves very little: Type=simple plus Restart=always means a
			# service that dies and respawns can be sampled while it happens to be up. Ask
			# again after longer than RestartSec, and only believe two in a row.
			sleep "${VAIVEN_HEALTH_SETTLE:-3}"
			if serves_a_page; then return 0; fi
			echo "vaiven: answered once and then stopped — this looks like a restart loop, not a healthy service" >&2
			return 1
		fi
		[ "$attempt" -lt "$attempts" ] && sleep 1
	done
	echo "vaiven: started but is not serving $HEALTH_URL as $APP_HOST" >&2
	return 1
}

# Running is not the same as surviving. Compare the state, do not trust the exit code:
# `systemctl is-enabled` exits 0 for `static`, `enabled-runtime`, `indirect` and
# `generated` too, and of those only a plain `enabled` starts the unit at boot. Verified
# on the production host — vaiven-backup.service has no [Install] section and
# `is-enabled --quiet` still exits 0 for it.
verify_enabled() {
	local state
	state=$(systemctl is-enabled vaiven 2>/dev/null || true)
	if [ "$state" != "enabled" ]; then
		echo "vaiven: is-enabled reports '${state:-unknown}' — it will not come back after a reboot" >&2
		return 1
	fi
}

if [ "$VERIFY_ONLY" = "0" ]; then
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

	# `restart` is guarded rather than left to `set -e`, or a failed start exits here and
	# the journal dump below — the only thing that says why — never runs.
	sudo -n systemctl restart vaiven || { echo "vaiven: FAILED to start" >&2; diagnose; exit 1; }

	verify_running || { diagnose; exit 1; }

	# Enable only once it has proved it serves, so a broken deploy is not also written
	# into the boot path. `enable` is what survives a reboot; `restart` is what picks up
	# this deploy. Without the enable, Restart=always still covers a crash, so the service
	# looks healthy for as long as the box stays up and comes back to nothing after a
	# reboot. That is how 0.3.2.0 ran on a host that had not rebooted since Phase 0.
	sudo -n systemctl enable vaiven
fi

verify_running || { [ "$VERIFY_ONLY" = "1" ] || diagnose; exit 1; }
verify_enabled || exit 1

echo "vaiven: serving, enabled at boot"
