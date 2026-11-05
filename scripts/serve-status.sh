#!/bin/bash
echo "—— 服务器 ——"
curl -s -m 2 http://127.0.0.1:8080/healthz && echo || echo "本地服务器未运行"
echo "—— 房间列表 ——"
curl -s -m 2 http://127.0.0.1:8080/api/rooms && echo
echo "—— 公网隧道 ——"
curl -s -m 2 http://127.0.0.1:4040/api/tunnels | python3 -c "import json,sys;d=json.load(sys.stdin);print('\n'.join(t['public_url'] for t in d['tunnels']) if d['tunnels'] else '无隧道')" 2>/dev/null || echo "ngrok 未运行"
