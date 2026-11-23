#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${EXAM_ASSISTANT_DATA_DIR:-$HOME/.exam-assistant}"
SCRIPT="$DIR/exam-server.js"
if [ ! -f "$SCRIPT" ]; then
  SCRIPT="$ROOT/exam-server.js"
fi
if [ ! -f "$SCRIPT" ]; then
  echo "找不到 exam-server.js"
  exit 1
fi
mkdir -p "$ROOT/sessions" "$ROOT/pages" "$ROOT/assignments" "$ROOT/reports"
if [ -f "$DIR/../templates/home.html" ] && [ ! -f "$ROOT/home.html" ]; then
  cp "$DIR/../templates/home.html" "$ROOT/home.html"
fi
if [ -f "$DIR/home.html" ] && [ ! -f "$ROOT/home.html" ]; then
  cp "$DIR/home.html" "$ROOT/home.html"
fi
cd "$ROOT"
exec node "$SCRIPT" --data-dir "$ROOT"
