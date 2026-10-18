#!/usr/bin/env bash
# Post-deploy smoke check (S00.T09). The requests go through the real assets router, which the
# workerd tests can't reach. S00.T11 replaces this check with the Playwright suite.
#
# Usage: scripts/smoke-check.sh <base-url>
# Example: scripts/smoke-check.sh http://localhost:8787 (after `pnpm --filter @soldock/dock dev`)
set -euo pipefail

base="${1:?usage: scripts/smoke-check.sh <base-url>}"
base="${base%/}"
failures=0
page=$(mktemp)
trap 'rm -f "$page"' EXIT

pass() { echo "ok: $1"; }
fail() {
	echo "::error::smoke check: $1"
	failures=$((failures + 1))
}

# A first deploy to a new workers.dev host can take a minute or more to answer, so this first request
# retries for up to two minutes.
if ! ping=$(curl --silent --show-error --fail --max-time 10 --retry 24 --retry-delay 5 --retry-all-errors \
	"$base/api/v1/system/ping"); then
	fail "GET /api/v1/system/ping did not return a 2xx response"
	exit 1
fi
if [[ "$(jq -c . <<< "$ping" 2> /dev/null)" == '{"ok":true}' ]]; then
	pass "GET /api/v1/system/ping returns {\"ok\":true}"
else
	fail "GET /api/v1/system/ping returned: ${ping:0:200}"
fi

# These requests retry only a transient error (no --fail), so a wrong status is reported at once. A
# curl error is reported as a failed check, not as an exit of the script.
navigate() {
	curl --silent --show-error --max-time 10 --retry 3 --retry-delay 2 --retry-connrefused \
		-o "$page" -w '%{http_code} %{content_type}' -H "Sec-Fetch-Mode: navigate" -H "Accept: text/html" "$base$1" ||
		echo "curl exit $?"
}

# A browser navigation to a Worker-owned path must get the Worker's problem+json 404, not the SPA.
for path in /api/v1/nope /mcp; do
	result=$(navigate "$path")
	if [[ "$result" == "404 application/problem+json"* ]]; then
		pass "navigation to $path returns a problem+json 404"
	else
		fail "navigation to $path returned \"$result\", not a problem+json 404"
	fi
done

# A navigation to an app route must get the shell (index.html) from the assets router.
result=$(navigate /mail)
if [[ "$result" == "200 text/html"* ]] && grep -q "data-soldock-shell" "$page"; then
	pass "navigation to /mail returns the shell"
else
	fail "navigation to /mail returned \"$result\" without the shell (data-soldock-shell)"
fi

if ((failures > 0)); then
	echo "Smoke check failed: $failures check(s)."
	exit 1
fi
echo "Smoke check passed."
