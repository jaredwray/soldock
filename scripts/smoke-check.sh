#!/usr/bin/env bash
# Post-deploy smoke check. The requests go through the real assets router, which the
# workerd tests can't reach. The Playwright suite will replace this check.
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

# A new host can take some minutes to answer: a new custom domain needs its DNS record and its
# certificate. So this first request retries for up to five minutes.
if ! ping=$(curl --silent --show-error --fail --max-time 10 --retry 60 --retry-delay 5 --retry-max-time 300 \
	--retry-all-errors "$base/api/v1/system/ping"); then
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

# The health endpoint must also bypass the SPA for a browser navigation.
result=$(navigate /healthz)
if [[ "$result" == "200 application/json"* ]] && jq -e '. == {"ok":true}' "$page" > /dev/null 2>&1; then
	pass "GET /healthz returns JSON for a browser navigation"
else
	fail "GET /healthz returned \"$result\" without a health response"
fi

# A browser navigation to a Worker-owned path must get the Worker's problem+json, not the SPA.
# /mcp takes POST only, so a navigation gets 405.
for check in "/api/v1/nope 404" "/hooks/nope 404" "/mcp 405"; do
	read -r path status <<< "$check"
	result=$(navigate "$path")
	if [[ "$result" == "$status application/problem+json"* ]]; then
		pass "navigation to $path returns a problem+json $status"
	else
		fail "navigation to $path returned \"$result\", not a problem+json $status"
	fi
done

# The API must refuse a request without a credential, with a Bearer challenge.
result=$(curl --silent --show-error --max-time 10 --retry 3 --retry-delay 2 --retry-connrefused \
	-o /dev/null -w '%{http_code}' "$base/api/v1/mail/profile" || echo "curl exit $?")
if [[ "$result" == "401" ]]; then
	pass "GET /api/v1/mail/profile without a credential returns 401"
else
	fail "GET /api/v1/mail/profile without a credential returned \"$result\", not 401"
fi

# The first-run setup status comes from the Worker as JSON, before and after setup.
result=$(curl --silent --show-error --max-time 10 --retry 3 --retry-delay 2 --retry-connrefused \
	-o "$page" -w '%{http_code} %{content_type}' "$base/auth/setup" || echo "curl exit $?")
if [[ "$result" == "200 application/json"* ]] && jq -e '.setup_needed | type == "boolean"' "$page" > /dev/null 2>&1; then
	pass "GET /auth/setup returns the setup status"
else
	fail "GET /auth/setup returned \"$result\" without a setup status"
fi

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
