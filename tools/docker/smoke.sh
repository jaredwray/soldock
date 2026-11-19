#!/usr/bin/env bash
# Starts the local development image and runs the smoke check against the Worker in it.
#
# Usage: tools/docker/smoke.sh <image>
# Example: tools/docker/smoke.sh asterra:local
# Build the image first: docker build --file tools/docker/Dockerfile --tag asterra:local .
set -euo pipefail

image="${1:?usage: tools/docker/smoke.sh <image>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
name="asterra-smoke-$$"
url="http://127.0.0.1:8787"

stop() {
	docker rm --force --volumes "$name" > /dev/null 2>&1 || true
}
trap stop EXIT

fail() {
	echo "::error::$1"
	docker logs "$name" || true
	exit 1
}

# The token is random and has no use after the check. It makes the entrypoint pass a token to the Worker.
docker run --detach --name "$name" --publish 127.0.0.1:8787:8787 --env "SETUP_TOKEN=$(openssl rand -hex 32)" \
	"$image" > /dev/null

# The entrypoint applies the migrations first, so the Worker answers after some seconds.
ready=false
for _ in $(seq 60); do
	if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" != "true" ]]; then
		fail "The container stopped."
	fi
	if curl --silent --fail --max-time 2 --output /dev/null "$url/healthz"; then
		ready=true
		break
	fi
	sleep 2
done
[[ "$ready" == "true" ]] || fail "The Worker did not answer in 120 seconds."

"$root/scripts/smoke-check.sh" "$url" || fail "The smoke check failed."
