#!/bin/sh
# Install, update and start OpenIllusion. Options: --update (git pull first), --no-open,
# --port 7871. See scripts/launch.py.
cd "$(dirname "$0")" || exit 1
if [ -x .venv/bin/python ]; then PY=.venv/bin/python
elif command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "[OpenIllusion] Python 3.10 or newer is needed: https://www.python.org/downloads/"
  exit 1
fi
exec "$PY" scripts/launch.py "$@"
