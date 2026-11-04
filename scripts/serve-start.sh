#!/bin/bash
# 启动雪林营地多人服务器 + ngrok 公网隧道（幂等：已启动则跳过）
cd "$(dirname "$0")/.."
mkdir -p /tmp
if curl -s -m 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  echo "[start] 服务器已在运行: $(curl -s http://127.0.0.1:8080/healthz)"
else
  nohup env PORT=8080 node server/server.mjs > /tmp/sf-server.log 2>&1 &
  echo $! > /tmp/sf-server.pid
  sleep 1
  echo "[start] 服务器已启动 (PID $(cat /tmp/sf-server.pid)): http://127.0.0.1:8080/multi.html"
fi
if curl -s -m 2 http://127.0.0.1:4040/api/tunnels >/dev/null 2>&1; then
  echo "[start] ngrok 已在运行: $(curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "import json,sys;print(', '.join(t['public_url'] for t in json.load(sys.stdin)['tunnels']))")"
else
  # 免费版 ngrok 不允许代理环境变量，需剥离
  nohup env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ngrok http 8080 > /tmp/ngrok.log 2>&1 &
  echo $! > /tmp/sf-ngrok.pid
  sleep 5
  echo "[start] ngrok 已启动 (PID $(cat /tmp/sf-ngrok.pid)): $(curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "import json,sys;print(', '.join(t['public_url'] for t in json.load(sys.stdin)['tunnels']))" 2>/dev/null)"
fi
echo "[start] 试玩入口: <公网地址>/multi.html"
