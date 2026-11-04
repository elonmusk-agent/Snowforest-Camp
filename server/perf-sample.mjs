// 性能采样：双无头浏览器客户端 60 秒 FPS / 快照频率 / 流量记录。
// 运行：node server/perf-sample.mjs（自起独立服务器；SF_PREP=8 缩短准备期以覆盖对局期）
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import fs from 'node:fs';

const PORT = 8094, BASE = `http://127.0.0.1:${PORT}`, WS = `ws://127.0.0.1:${PORT}`;
const SAMPLE_SECONDS = 60, P1 = 9461, P2 = 9462;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 起服 + 起房
const server = spawn('node', ['server/server.mjs'], { env: { ...process.env, PORT: String(PORT), SF_DEV: '1', SF_PREP: '8' }, stdio: ['ignore', 'ignore', 'pipe'] });
await sleep(1000);
const seed = new WebSocket(WS);
let code = '', tokens = {};
seed.on('open', () => seed.send(JSON.stringify({ type: 'create', name: '性能精灵' })));
seed.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'welcome' && !code) {
    code = m.code; tokens.elf = m.you.token;
    const w2 = new WebSocket(WS);
    w2.on('open', () => w2.send(JSON.stringify({ type: 'join', code, name: '性能巨魔' })));
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
await sleep(1800);
console.log('房间', code, '已开始（SF_PREP=8）');

// 两个无头 Chrome
const mkBrowser = (port, url, tag) => {
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/sf-perf-${tag}`, '--window-size=1280,800', url], { stdio: 'ignore' });
  return chrome;
};
mkBrowser(P1, `${BASE}/multi.html?room=${code}&token=${tokens.elf}`, 'elf');
mkBrowser(P2, `${BASE}/multi.html?room=${code}&token=${tokens.troll}`, 'troll');

const attach = async port => {
  for (let i = 0; i < 20; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.find(t => t.type === 'page')) break; } catch { }
    await sleep(500);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  await new Promise(r => ws.on('open', r));
  const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  return {
    send,
    eval: async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result?.value; },
  };
};
const E = await attach(P1), T = await attach(P2);

// 等待进入对局
for (let i = 0; i < 24 && !(await E.eval('!!window.SF && !!SF.snap')); i++) await sleep(1000);
console.log('精灵客户端进入对局:', await E.eval('SF.snap?.phase'));
for (let i = 0; i < 20 && !(await T.eval('!!window.SF && !!SF.snap')); i++) await sleep(1000);
console.log('巨魔客户端进入对局:', await T.eval('SF.snap?.phase'));

// 精灵占营地建墙建屋，巨魔待命（准备期后自动可行动）
await E.eval(`(function(){ SF.cmd('move', 400, 660); return 1; })()`);
await sleep(6500);
await E.eval(`SF.cmd('claim')`);
await sleep(400);
await E.eval(`SF.cmd('build','house', 368, 614)`);
await E.eval(`SF.cmd('build','wall', 562, 660)`);
console.log('建造中，营地=', await E.eval('SF.snap?.you.camp'));

// 注入 FPS 计数并清零流量计数
await E.eval(`(function(){ window._fps=0; window._loop=()=>{ window._fps++; requestAnimationFrame(window._loop); }; requestAnimationFrame(window._loop); window._stats={snaps:0,bytesIn:0,bytesOut:0,cmds:0,events:0}; return 'ok'; })()`);
await T.eval(`(function(){ window._fps=0; window._loop=()=>{ window._fps++; requestAnimationFrame(window._loop); }; requestAnimationFrame(window._loop); window._stats={snaps:0,bytesIn:0,bytesOut:0,cmds:0,events:0}; return 'ok'; })()`);

// 巨魔入场后开始攻墙（对局期真实战斗负载）
await sleep(6000);
await T.eval(`(function(){ const w = SF.snap.buildings.find(b=>b.type==='wall'); if (w) SF.cmd('attack', w.id); return w ? w.id : 'no-wall'; })()`);

console.log(`开始 ${SAMPLE_SECONDS} 秒采样…`);
const series = [];
const t0 = Date.now();
let prevE = { fps: 0, snaps: 0, bytesIn: 0, bytesOut: 0 }, prevT = { fps: 0, snaps: 0, bytesIn: 0 };
let lastE = prevE, lastT = prevT;
for (let s = 1; s <= SAMPLE_SECONDS; s++) {
  if (s === 3) { const r = await E.eval(`(function(){ SF.cmd('move', 415, 660); return JSON.stringify(window._stats); })()`); console.log('  [诊断] s=3:', r); }
  if (s % 5 === 0) { await E.eval(`(function(){ SF.cmd('move', 415, 660); return 1; })()`); await T.eval(`(function(){ const w = SF.snap?.buildings.find(b=>b.type==='wall'); if (w) { SF.cmd('attack', w.id); return 1; } return 0; })()`); }
  await sleep(1000);
  const e = await E.eval(`({fps: window._fps, ...window._stats, phase: SF.snap?.phase, gold: Math.round(SF.snap?.you.gold)})`);
  const t = await T.eval(`({fps: window._fps, ...window._stats, phase: SF.snap?.phase})`);
  if (!e || !t) { series.push({ s, err: true }); continue; }
  const dE = { fps: e.fps - lastE.fps, snaps: e.snaps - lastE.snaps, bytesIn: e.bytesIn - lastE.bytesIn, bytesOut: e.bytesOut - lastE.bytesOut };
  const dT = { fps: t.fps - lastT.fps, snaps: t.snaps - lastT.snaps, bytesIn: t.bytesIn - lastT.bytesIn };
  lastE = e; lastT = t;
  series.push({ s, phase: e.phase, elf: dE, troll: dT });
  if (s % 15 === 0) console.log(`  t=${s}s phase=${e.phase} FPS E=${dE.fps} T=${dT.fps} 快照 E=${dE.snaps}/s T=${dT.snaps}/s 下行 E=${(dE.bytesIn / 1024).toFixed(2)}KB/s`);
}

// 汇总
const fpsList = series.filter(d => d.elf).map(d => d.elf.fps);
const fpsListT = series.filter(d => d.troll).map(d => d.troll.fps);
const snapList = series.filter(d => d.elf).map(d => d.elf.snaps);
const snapT = series.filter(d => d.troll).map(d => d.troll.snaps);
const inE = series.filter(d => d.elf).reduce((a, d) => a + d.elf.bytesIn, 0);
const inT = series.filter(d => d.troll).reduce((a, d) => a + d.troll.bytesIn, 0);
const outE = series.filter(d => d.elf).reduce((a, d) => a + d.elf.bytesOut, 0);
const stats = await E.eval(`({ buildings: SF.snap.buildings.length, phase: SF.snap.phase, tier: SF.snap.tier, gold: SF.snap.you.gold })`);
const version = await (await fetch(`http://127.0.0.1:${P1}/json/version`)).json();
const report = {
  sampledAt: new Date().toISOString(), durationSeconds: SAMPLE_SECONDS,
  device: { model: 'Apple M4 Pro, 48GB', os: 'macOS 25.6.0 (darwin arm64)', browser: version.Browser, userAgent: version['User-Agent']?.slice(0, 80) },
  conditions: { players: 2, buildings: stats.buildings, network: '本机回环 WS（公网 ngrok 链路另测，E2E 通过）', headless: true, windowSize: '1280x800', phase: stats.phase, trollTier: stats.tier + 1 },
  elf: { fps: { avg: +(fpsList.reduce((a, b) => a + b, 0) / fpsList.length).toFixed(1), min: Math.min(...fpsList), max: Math.max(...fpsList) }, snapshotHz: +(snapList.reduce((a, b) => a + b, 0) / snapList.length).toFixed(2), downlinkKBps: +(inE / 1024 / SAMPLE_SECONDS).toFixed(2), uplinkBps: +(outE / SAMPLE_SECONDS).toFixed(1), totalInKB: +(inE / 1024).toFixed(1) },
  troll: { fps: { avg: +(fpsListT.reduce((a, b) => a + b, 0) / fpsListT.length).toFixed(1), min: Math.min(...fpsListT), max: Math.max(...fpsListT) }, snapshotHz: +(snapT.reduce((a, b) => a + b, 0) / snapT.length).toFixed(2), downlinkKBps: +(inT / 1024 / SAMPLE_SECONDS).toFixed(2), totalInKB: +(inT / 1024).toFixed(1) },
  series,
};
fs.writeFileSync('/tmp/sf-perf.json', JSON.stringify(report, null, 1));
console.log('\n===== 60 秒性能采样结果 =====');
console.log('设备:', report.device.model, '|', report.device.browser);
console.log('对局: 2 玩家 /', stats.buildings, '建筑 / 巨魔', report.conditions.trollTier, '阶 /', report.conditions.network);
console.log(`精灵端 FPS avg=${report.elf.fps.avg} min=${report.elf.fps.min} max=${report.elf.fps.max} | 快照 ${report.elf.snapshotHz}/s | 下行 ${report.elf.downlinkKBps}KB/s | 上行 ${report.elf.uplinkBps}B/s`);
console.log(`巨魔端 FPS avg=${report.troll.fps.avg} min=${report.troll.fps.min} max=${report.troll.fps.max} | 快照 ${report.troll.snapshotHz}/s | 下行 ${report.troll.downlinkKBps}KB/s`);
const kill = () => { spawn('pkill', ['-f', 'sf-perf-elf']); spawn('pkill', ['-f', 'sf-perf-troll']); };
kill();
server.kill();
process.exit(0);
