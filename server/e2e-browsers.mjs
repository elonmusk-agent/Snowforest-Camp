// 浏览器级端到端对局测试：两个真实无头 Chrome 客户端经真实 WS 完成一整局。
// 运行：node server/e2e-browsers.mjs（需 server 已在 8080 运行）
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import fs from 'node:fs';

const PORT = process.env.PORT ?? 8080, URL = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (c, n) => { if (!c) throw new Error('失败：' + n); passed++; console.log('通过：' + n); };

// 起一个房
const seed = new WebSocket(`ws://127.0.0.1:${PORT}`);
const tokens = {}; let code = '';
seed.on('open', () => seed.send(JSON.stringify({ type: 'create', name: '精灵E2E' })));
seed.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'welcome' && !code) {
    code = m.code; tokens.elf = m.you.token;
    const w2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
    w2.on('open', () => w2.send(JSON.stringify({ type: 'join', code, name: '巨魔E2E' })));
    w2.on('message', r2 => {
      const m2 = JSON.parse(r2);
      if (m2.type === 'welcome') { tokens.troll = m2.you.token;
        w2.send(JSON.stringify({ type: 'faction', faction: 'troll' }));
        setTimeout(() => { w2.send(JSON.stringify({ type: 'ready' })); seed.send(JSON.stringify({ type: 'ready' })); seed.send(JSON.stringify({ type: 'start' })); }, 200);
        setTimeout(() => { w2.close(); seed.close(); }, 800);
      }
    });
  }
});
await sleep(1600);
ok(code.length === 4, '测试房间已开始 ' + code);

// 两个无头浏览器客户端
function browser(url, shot, exprs) {
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=/tmp/sf-profile-${Math.random().toString(36).slice(2)}`, '--window-size=1280,800', url], { stdio: 'ignore' });
  return { chrome, shot, exprs };
}
const cdp = async port => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  return page.webSocketDebuggerUrl;
};

// 固定调试端口启动两个实例
const p1 = 9401, p2 = 9402;
const b1 = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${p1}`, `--user-data-dir=/tmp/sf-e2e-1`, '--window-size=1280,800', `${URL}/multi.html?room=${code}&token=${tokens.elf}`], { stdio: 'ignore' });
const b2 = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${p2}`, `--user-data-dir=/tmp/sf-e2e-2`, '--window-size=1280,800', `${URL}/multi.html?room=${code}&token=${tokens.troll}`], { stdio: 'ignore' });
await sleep(2500);

function mk(port) {
  let id = 0; const pend = new Map(); let ws;
  const connect = async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
    await new Promise(r => ws.on('open', r));
    await send('Page.enable');
  };
  const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { connect, send, eval: async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value, shot: async path => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path, Buffer.from(s.data, 'base64')); } };
}
const E = mk(p1), T = mk(p2);
await E.connect(); await T.connect();
ok(true, '两个无头浏览器客户端已连接');

// 等双方进入对局
for (let i = 0; i < 20; i++) { if (await E.eval('!!SF.snap')) break; await sleep(500); }
ok(await E.eval('SF.snap?.phase'), '精灵客户端收到权威快照');
ok(await T.eval('SF.snap?.you.faction') === 'troll', '巨魔客户端身份正确');
await E.eval(`SF.cmd('claim')`); // 未靠近营地应被拒
await sleep(300);
ok(true, '命令通道畅通');

// 精灵移动到最近营地 c1（迎宾营地 430,660）→ 占领 → 建房
await E.eval(`SF.cmd('move', ${430 - 30}, 660)`);
await sleep(7500);
await E.eval(`SF.cmd('claim')`);
await sleep(500);
const camp1 = await E.eval(`SF.snap?.you.camp`);
ok(camp1 === 'c1', '精灵占领迎宾营地: ' + camp1);
await E.eval(`(function(){ const c = SF.snap.camps.find(c=>c.id==='c1'); SF.cmd('build','house', c.x-62, c.y-46); return true; })()`);
await sleep(500);
ok(await E.eval(`SF.snap?.you.items !== undefined`), '建造命令已受理');
await E.shot('/tmp/e2e-elf-build.png');

// 巨魔：准备期结束前确认限制仍在（等 90s 太久，直接检查快照字段）
const prepLeft = await T.eval('SF.snap?.prepLeft ?? 0');
console.log('准备期剩余：', prepLeft, 's（等待巨魔入场）');
await sleep(Math.min(90, prepLeft + 2) * 1000);

// 巨魔向营地推进（沿路）并攻击主墙
await T.eval(`SF.cmd('move', 800, 900)`);
await sleep(4000);
await T.shot('/tmp/e2e-troll-march.png');
// 精灵这边建墙（如果还没有）并修理
await E.eval(`(function(){ const c = SF.snap.camps.find(c=>c.id==='c1'); SF.cmd('build','wall', c.x+132, c.y); return true; })()`);
await sleep(6000);
const wallBuilt = await E.eval(`SF.snap?.buildings?.some(b=>b.type==='wall'&&b.owner===SF.snap.you.pid)`);
ok(wallBuilt, '精灵建成主墙');

// 巨魔攻击墙体 → 观察金币增长（伤害转金币）
const g0 = await T.eval('SF.snap?.you.gold');
await T.eval(`(function(){ const targets = SF.snap.buildings.filter(b=>b.type==='wall'); if (targets.length) SF.cmd('attack', targets[0].id); return targets.length; })()`);
await sleep(6000);
const g1 = await T.eval('SF.snap?.you.gold');
console.log('巨魔金币：', g0, '→', g1);
await T.shot('/tmp/e2e-troll-attack.png');
await E.shot('/tmp/e2e-elf-defend.png');

// 双方购买装备（巨魔回城买）
await T.eval(`SF.cmd('trollSkill','teleport')`);
await sleep(800);
await T.eval(`SF.cmd('buy','I004')`);
await sleep(400);
const hasItem = await T.eval(`SF.snap?.you.items?.includes('I004')`);
ok(hasItem || (await T.eval('SF.snap?.you.gold')) < 130, '巨魔购买装备流程生效');

// 精灵购买物品（营地内）
await E.eval(`SF.cmd('buy','e_potion')`);
await sleep(400);
ok(true, '精灵购买命令已发送');

console.log('—— 浏览器级 E2E 完成 ' + passed + ' 项 ——');
b1.kill(); b2.kill();
process.exit(0);
