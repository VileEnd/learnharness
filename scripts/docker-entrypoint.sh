#!/bin/sh
# Container entrypoint: the data volume is usually a bind mount whose files
# belong to whoever copied them in (e.g. a migrated desktop data dir). Hand
# everything under /data to the app user, then drop root for the server.
set -eu
if [ "$(id -u)" = "0" ]; then
	mkdir -p /data
	find /data ! -user node -exec chown node:node {} +
	# setpriv keeps root's HOME; tools that write under HOME (Chromium) need the node user's own.
	export HOME=/home/node
	exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
