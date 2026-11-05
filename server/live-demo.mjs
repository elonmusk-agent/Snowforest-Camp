// Computer Use 实机演示辅助:通过 CDP 驱动两个可见 Chrome 窗口完成建房→加入→对局操作,并抓取画面。
// 用法:node server/live-demo.mjs <步骤>
import WebSocket from 'ws';
import fs from 'node:fs';

const [, , step] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdp(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && (t.url ?? '').includes('multi.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  await new Promise(r => ws.on('open', r));
  const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  return {
    eval: async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value,
    shot: async path => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path, Buffer.from(s.data, 'base64')); },
  };
}

if (step === 'setup') {
  const E = await cdp(9471), T = await cdp(9472);
  await sleep(1500);
  // 玩家1 创建房间(精灵)
  await E.eval(`(function(){ document.getElementById('nickname').value='Jakie·精灵'; document.getElementById('btn-create').click(); return 'ok'; })()`);
  await sleep(1800);
  const room = await E.eval(`document.getElementById('room-code').textContent`);
  console.log('ROOM=' + room);
  // 玩家2 加入(巨魔)
  await T.eval(`(function(){ document.getElementById('nickname').value='Jakie·巨魔'; document.getElementById('join-code').value='${room}'; document.getElementById('btn-join').click(); return 'ok'; })()`);
  await sleep(1500);
  await T.eval(`(function(){ [...document.querySelectorAll('button')].find(b=>b.textContent.includes('巨魔阵营'))?.click(); return 'ok'; })()`);
  await sleep(300);
  await T.eval(`(function(){ document.getElementById('btn-ready').click(); return 'ok'; })()`);
  await sleep(300);
  await E.eval(`(function(){ document.getElementById('btn-ready').click(); return 'ok'; })()`);
  await sleep(300);
  await E.eval(`(function(){ document.getElementById('btn-start').click(); return 'ok'; })()`);
  await sleep(2000);
  console.log('phase=' + await E.eval(`(window.SF && SF.snap && SF.snap.phase) || 'loading'`));
  process.exit(0);
}
if (step === 'elf') {
  const E = await cdp(9471);
  // 精灵:走位 → 占领 → 建屋 → 建墙(全部走真实命令通道)
  console.log('claim=' + await E.eval(`(function(){ SF.cmd('move', 400, 660); return 'moved'; })()`));
  await sleep(6500);
  await E.eval(`SF.cmd('claim')`);
  await sleep(600);
  console.log('camp=' + await E.eval(`SF.snap?.you.camp`));
  await E.eval(`(function(){ const c = SF.snap.camps.find(c=>c.id===SF.snap.you.camp); SF.cmd('build','house', c.slots.house.x, c.slots.house.y); return 1; })()`);
  await sleep(700);
  await E.eval(`(function(){ const c = SF.snap.camps.find(c=>c.id===SF.snap.you.camp); SF.cmd('build','wall', c.slots.gate.x, c.slots.gate.y); return 1; })()`);
  await sleep(700);
  console.log('buildings=' + await E.eval(`SF.snap?.buildings.length`));
  await E.shot('/tmp/live-elf.png');
  console.log('精灵画面已存 /tmp/live-elf.png');
  process.exit(0);
}
if (step === 'troll') {
  const T = await cdp(9472);
  // 巨魔:走向迎宾营地门口并攻墙
  await T.eval(`SF.cmd('move', 694, 660)`);
  await sleep(9000);
  await T.eval(`(function(){ const w = (SF.snap.buildings||[]).find(b=>b.type==='wall'&&b.hp>0); if (w) SF.cmd('attack', w.id); return w ? 'attack ' + w.id : 'no-wall-visible'; })()`);
  await sleep(6000);
  console.log('troll gold=' + await T.eval(`SF.snap?.you.gold`) + ' order=' + JSON.stringify(await T.eval(`SF.snap?.you.order`)));
  await T.shot('/tmp/live-troll.png');
  console.log('巨魔画面已存 /tmp/live-troll.png');
  process.exit(0);
}
if (step === 'status') {
  const E = await cdp(9471), T = await cdp(9472);
  console.log('elf:', JSON.stringify(await E.eval(`({phase: SF.snap?.phase, camp: SF.snap?.you.camp, gold: Math.round(SF.snap?.you.gold), hp: SF.snap?.you.hp, buildings: SF.snap?.buildings?.length, result: SF.snap?.result})`)));
  console.log('troll:', JSON.stringify(await T.eval(`({phase: SF.snap?.phase, gold: Math.round(SF.snap?.you.gold), hp: SF.snap?.you.hp, order: SF.snap?.you.order, result: SF.snap?.result})`)));
  process.exit(0);
}
if (step === 'end') {
  const T = await cdp(9472);
  await T.eval(`SF.cmd('devend')`);
  await sleep(2500);
  const E = await cdp(9471);
  console.log('result=' + await E.eval(`SF.snap?.result`));
  await E.shot('/tmp/live-result.png');
  process.exit(0);
}
