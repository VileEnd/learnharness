#!/usr/bin/env bash
# Start the web app on http://localhost:8000 (works from the Windows browser too when run in WSL).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$DIR/.venv/bin/uvicorn" ]; then
  python3 -m venv "$DIR/.venv"
  "$DIR/.venv/bin/pip" install -q -e "$DIR[dev]"
fi
exec "$DIR/.venv/bin/uvicorn" app.main:app --app-dir "$DIR" --port "${PORT:-8000}"
