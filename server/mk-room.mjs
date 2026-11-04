// 创建房间→第二客户端选巨魔→开始→输出 ROOM/T1/T2
import WebSocket from 'ws';
const URL = process.env.SF_URL ?? 'ws://127.0.0.1:8080';
const ws = new WebSocket(URL);
ws.on('open', () => ws.send(JSON.stringify({ type: 'create', name: '房主' })));
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'welcome') {
    console.log('ROOM=' + m.code); console.log('T1=' + m.you.token);
    const ws2 = new WebSocket(URL);
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join', code: m.code, name: '巨魔' })));
    ws2.on('message', r2 => {
      const m2 = JSON.parse(r2);
      if (m2.type === 'welcome') {
        console.log('T2=' + m2.you.token);
        ws2.send(JSON.stringify({ type: 'faction', faction: 'troll' }));
        setTimeout(() => { ws2.send(JSON.stringify({ type: 'ready' })); ws.send(JSON.stringify({ type: 'ready' })); ws.send(JSON.stringify({ type: 'start' })); }, 250);
        setTimeout(() => { ws2.close(); ws.close(); process.exit(0); }, 1000);
      }
    });
  }
});
setTimeout(() => process.exit(1), 6000);
