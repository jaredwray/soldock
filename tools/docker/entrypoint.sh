#!/usr/bin/env bash
# The entrypoint of the local development image (tools/docker/Dockerfile). It applies the D1 migrations
# to the local state, then starts `wrangler dev`. The Dockerfile sets ASTERRA_STATE.
# docs/development.md shows how to run the image.
set -euo pipefail

# PID 1 ignores a signal that has no trap. A stop during the migrations must end the script.
# A foreground command delays a trap until the command ends, so the migration runs in the background.
# After `exec`, wrangler is PID 1 and it handles the signal itself.
trap 'trap - TERM INT; kill -TERM 0 2>/dev/null || true; exit 143' TERM INT

state="${ASTERRA_STATE:?Set ASTERRA_STATE to the directory of the local state.}"
cd "$(dirname "$0")/../../apps/dock"

# CI=true stops the question that `wrangler d1 migrations apply` asks on a terminal.
CI=true ./node_modules/.bin/wrangler d1 migrations apply DIRECTORY --local --persist-to "$state" &
wait $!

# The image holds no setup token. The Worker gets a token only from the environment of the container.
# wrangler dev listens on each interface of the container, so Docker can publish the port.
args=(dev --ip 0.0.0.0 --port 8787 --persist-to "$state")
if [[ -n "${SETUP_TOKEN:-}" ]]; then
	args+=(--var "SETUP_TOKEN:$SETUP_TOKEN")
	if [[ ${#SETUP_TOKEN} -ge 32 ]]; then
		echo "SETUP_TOKEN is set. Setup is on."
	else
		echo "SETUP_TOKEN is set. The token has fewer than 32 characters, so setup stays off."
	fi
else
	echo "SETUP_TOKEN is not set. Setup is off."
fi
exec ./node_modules/.bin/wrangler "${args[@]}"
