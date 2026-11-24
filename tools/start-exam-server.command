#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${EXAM_ASSISTANT_DATA_DIR:-$HOME/.exam-assistant}"

src_server=""
if [ -f "$DIR/exam-server.js" ]; then
  src_server="$DIR/exam-server.js"
elif [ -f "$DIR/tools/exam-server.js" ]; then
  src_server="$DIR/tools/exam-server.js"
fi
if [ -z "$src_server" ]; then
  echo "找不到 exam-server.js 模板"
  exit 1
fi
mkdir -p "$ROOT/sessions" "$ROOT/pages" "$ROOT/assignments" "$ROOT/reports"
ROOT="$(cd "$ROOT" && pwd)"

for template in home.html practice.html; do
  if [ -f "$DIR/../templates/$template" ]; then
    source="$(cd "$DIR/../templates" && pwd)/$template"
  elif [ -f "$DIR/templates/$template" ]; then
    source="$DIR/templates/$template"
  elif [ -f "$DIR/$template" ]; then
    source="$DIR/$template"
  else
    echo "找不到 $template 模板"
    exit 1
  fi
  if [ "$source" != "$ROOT/$template" ]; then
    cp "$source" "$ROOT/$template"
  fi
done

# Always overwrite data-dir copies from the script's companion templates.
if [ "$(cd "$(dirname "$src_server")" && pwd)/$(basename "$src_server")" != "$(cd "$ROOT" && pwd)/exam-server.js" ]; then
  cp "$src_server" "$ROOT/exam-server.js"
else
  # Script already lives in the data directory; keep its companion copy as the server.
  :
fi

cd "$ROOT"
PORT_ARGS=()
if [ -n "${EXAM_ASSISTANT_PORT:-}" ]; then
  PORT_ARGS=(--port "$EXAM_ASSISTANT_PORT")
fi
exec node "$ROOT/exam-server.js" --data-dir "$ROOT" "${PORT_ARGS[@]}"
