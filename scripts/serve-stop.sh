#!/bin/bash
# 停止服务器与 ngrok 隧道
for f in /tmp/sf-server.pid /tmp/sf-ngrok.pid; do
  if [ -f "$f" ]; then kill "$(cat $f)" 2>/dev/null && echo "[stop] 已停止 $(cat $f)"; rm -f "$f"; fi
done
pkill -f "node server/server.mjs" 2>/dev/null
pkill -f "ngrok http 8080" 2>/dev/null
echo "[stop] 完成"
