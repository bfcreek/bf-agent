#!/bin/sh
# halo-agent launcher: validates Node.js, then forwards to the CLI.
# Usage: ./bin/halo-agent.sh "your goal" [options]

if ! command -v node >/dev/null 2>&1; then
    echo "halo-agent needs Node.js 20 or newer, and 'node' was not found on PATH." >&2
    echo "Install it with your package manager (e.g. 'brew install node') or from https://nodejs.org," >&2
    echo "then rerun this script." >&2
    exit 10
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    echo "halo-agent needs Node.js 20 or newer; found $(node -v)." >&2
    echo "Update Node and rerun this script." >&2
    exit 10
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../src/cli.mjs" "$@"
