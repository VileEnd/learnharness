#!/bin/sh
# A bind-mounted /data is created by Docker as root; hand it to the app user, then drop root.
set -e
if [ "$(id -u)" = 0 ]; then
  mkdir -p "${OUT_DIR:-/data/out}" "${CACHE_DIR:-/data/cache}"
  chown ocr:ocr /data "${OUT_DIR:-/data/out}" "${CACHE_DIR:-/data/cache}"
  exec setpriv --reuid=10001 --regid=10001 --clear-groups "$@"
fi
exec "$@"
