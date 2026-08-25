#!/bin/sh
set -eu

PORT="${HALO_PORT:-11435}"
MODEL="${HALO_MODEL:-auto}"
BASE_URL="${HALO_OLLAMA_URL:-http://ollama:11434}"
CWD="${HALO_CWD:-/workspace}"
NUM_CTX="${HALO_NUM_CTX:-16384}"

if [ "$#" -eq 0 ] || [ "$1" = "serve" ]; then
  if [ "${1:-}" = "serve" ]; then
    shift
  fi
  exec node /app/src/cli.mjs serve \
    --port "$PORT" \
    --model "$MODEL" \
    --base-url "$BASE_URL" \
    --cwd "$CWD" \
    --num-ctx "$NUM_CTX" \
    --mode agent \
    "$@"
fi

exec node /app/src/cli.mjs \
  --model "$MODEL" \
  --base-url "$BASE_URL" \
  --cwd "$CWD" \
  --num-ctx "$NUM_CTX" \
  --mode agent \
  "$@"
