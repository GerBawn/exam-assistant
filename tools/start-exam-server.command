#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${EXAM_ASSISTANT_DATA_DIR:-$HOME/.exam-assistant}"

src_server=""
src_home=""
if [ -f "$DIR/exam-server.js" ]; then
  src_server="$DIR/exam-server.js"
elif [ -f "$DIR/tools/exam-server.js" ]; then
  src_server="$DIR/tools/exam-server.js"
fi
if [ -f "$DIR/../templates/home.html" ]; then
  src_home="$(cd "$DIR/.." && pwd)/templates/home.html"
elif [ -f "$DIR/templates/home.html" ]; then
  src_home="$DIR/templates/home.html"
elif [ -f "$DIR/home.html" ]; then
  src_home="$DIR/home.html"
fi

if [ -z "$src_server" ]; then
  echo "找不到 exam-server.js 模板"
  exit 1
fi
if [ -z "$src_home" ]; then
  echo "找不到 home.html 模板"
  exit 1
fi

mkdir -p "$ROOT/sessions" "$ROOT/pages" "$ROOT/assignments" "$ROOT/reports"

# Always overwrite data-dir copies from the script's companion templates.
if [ "$(cd "$(dirname "$src_server")" && pwd)/$(basename "$src_server")" != "$(cd "$ROOT" && pwd)/exam-server.js" ]; then
  cp "$src_server" "$ROOT/exam-server.js"
else
  # Script already lives in the data directory; keep its companion copy as the server.
  :
fi
if [ "$src_home" != "$ROOT/home.html" ]; then
  cp "$src_home" "$ROOT/home.html"
fi

cd "$ROOT"
PORT_ARGS=()
if [ -n "${EXAM_ASSISTANT_PORT:-}" ]; then
  PORT_ARGS=(--port "$EXAM_ASSISTANT_PORT")
fi
exec node "$ROOT/exam-server.js" --data-dir "$ROOT" "${PORT_ARGS[@]}"
