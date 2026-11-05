// 公网双浏览器 E2E：两个无头 Chrome 经公网 URL(ngrok)进入同一房间对局。
// 运行：BASE_URL=https://xxx.ngrok-free.dev node server/e2e-public.mjs
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const WS = process.env.SF_WS ?? BASE.replace(/^http/, 'ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (c, n) => { if (!c) throw new Error('失败：' + n); passed++; console.log('通过：' + n); };

// 起房（经公网 WS）
const seed = new WebSocket(WS);
let code = '', tokens = {};
seed.on('open', () => seed.send(JSON.stringify({ type: 'create', name: '公网房主' })));
seed.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'welcome' && !code) {
    code = m.code; tokens.elf = m.you.token;
    const w2 = new WebSocket(WS);
    w2.on('open', () => w2.send(JSON.stringify({ type: 'join', code, name: '公网巨魔' })));
    w2.on('message', r2 => {
      const m2 = JSON.parse(r2);
      if (m2.type === 'welcome') { tokens.troll = m2.you.token;
        w2.send(JSON.stringify({ type: 'faction', faction: 'troll' }));
        setTimeout(() => { w2.send(JSON.stringify({ type: 'ready' })); seed.send(JSON.stringify({ type: 'ready' })); seed.send(JSON.stringify({ type: 'start' })); }, 250);
        setTimeout(() => { w2.close(); seed.close(); }, 900);
      }
    });
  }
});
await sleep(4000);
ok(code.length === 4, '公网房间已开始 ' + code);

const port1 = 9451, port2 = 9452;
const mk = (port, url, tag) => {
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/sf-pub-${tag}`, '--window-size=1280,800', url], { stdio: 'ignore' });
  let id = 0; const pend = new Map(); let ws;
  const out = {
    chrome,
    connect: async () => {
      await sleep(3500); // 等拦截页出现
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      ws = new WebSocket(page.webSocketDebuggerUrl);
      ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
      await new Promise(r => ws.on('open', r));
      const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
      out.send = send;
      await send('Page.enable');
      // 点掉 ngrok 拦截页（若有）
      await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('a,button')].find(e=>/visit site/i.test(e.textContent))?.click(); 'ok'`, returnByValue: true });
      out.eval = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
      out.shot = async path => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path, Buffer.from(s.data, 'base64')); };
    },
  };
  return out;
};
const E = mk(port1, `${BASE}/multi.html?room=${code}&token=${tokens.elf}`, 'elf');
const T = mk(port2, `${BASE}/multi.html?room=${code}&token=${tokens.troll}`, 'troll');
await E.connect(); await T.connect();
let elfIn = false, trollIn = false;
for (let i = 0; i < 24 && !(elfIn && trollIn); i++) {
  await sleep(1000);
  if (!elfIn) elfIn = !!await E.eval('window.SF && SF.snap');
  if (!trollIn) trollIn = !!await T.eval('window.SF && SF.snap');
}
ok(elfIn, '公网精灵客户端进入对局并收到快照');
ok(trollIn, '公网巨魔客户端进入对局并收到快照');
ok(await E.eval('SF.snap.you.faction') === 'elf' && await T.eval('SF.snap.you.faction') === 'troll', '公网双方身份正确');
ok((await E.eval('window._msgLog.filter(t=>t==="snap").length')) > 3, '公网快照流持续');

// 精灵移动 + 占领最近营地
await E.eval(`SF.cmd('move', 400, 660)`);
await sleep(7500);
const pos = await E.eval('[Math.round(SF.snap.you.x), Math.round(SF.snap.you.x), SF.snap.phase].join(",")');
console.log('精灵位置/阶段：', pos);
await E.eval(`SF.cmd('claim')`);
await sleep(800);
const camp = await E.eval('SF.snap?.you.camp');
ok(camp === 'c1', '公网对局中精灵占领营地: ' + camp);
const goldAfterBuild = await E.eval(`(function(){ SF.cmd('build','house', 368, 614); return SF.snap.you.gold; })()`);
await sleep(600);
ok(await E.eval('SF.snap?.buildings.some(b=>b.owner===SF.snap.you.pid)'), '公网对局中建造成功');
console.log('建造后金币：', goldAfterBuild);
await E.shot('/tmp/e2e-public-elf.png');
await T.shot('/tmp/e2e-public-troll.png');

console.log('—— 公网双浏览器 E2E 完成 ' + passed + ' 项 ——');
E.chrome.kill(); T.chrome.kill();
process.exit(0);
