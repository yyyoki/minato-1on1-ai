#!/usr/bin/env bash
# Codespaces用：サーバーが動いていなければ、バックグラウンドで起動する（何度実行しても安全）
cd "$(dirname "$0")/.." || exit 1
[ -f config.json ] || cp config.example.json config.json
if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8001/static/turn.js; then
  exit 0
fi
LAUNCH=(nohup)
command -v setsid >/dev/null 2>&1 && LAUNCH=(setsid nohup)
"${LAUNCH[@]}" python3 -m uvicorn main:app --host 127.0.0.1 --port 8001 > "$HOME/minato.log" 2>&1 < /dev/null &
disown
exit 0
