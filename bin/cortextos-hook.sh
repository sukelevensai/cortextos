#!/usr/bin/env bash
# Stable Claude hook entrypoint. Hooks launched from Windows services can lose
# the npm shim PATH, so call the built CLI through node with explicit paths.

set -euo pipefail

ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
if command -v cygpath >/dev/null 2>&1; then
  ROOT="$(cygpath -u "$ROOT" 2>/dev/null || printf '%s' "$ROOT")"
fi

if [ ! -f "$ROOT/dist/cli.js" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

if [ ! -f "$ROOT/dist/cli.js" ]; then
  echo "cortextos-hook: cannot find dist/cli.js under $ROOT" >&2
  exit 127
fi

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/c/Program Files/nodejs/node.exe" ]; then
  NODE_BIN="/c/Program Files/nodejs/node.exe"
else
  echo "cortextos-hook: cannot find node" >&2
  exit 127
fi

exec "$NODE_BIN" "$ROOT/dist/cli.js" "$@"
