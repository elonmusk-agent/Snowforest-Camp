// 房间生命周期集成测试：房主转交 / 再来一局 / 结束后迟到命令 / 多轮重开资源清理。
// 运行：node server/test-room.mjs（自起独立服务器，SF_DEV=1 启用快速结算）
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8092, URL = `ws://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (cond, name) => { if (!cond) throw new Error('失败：' + name); passed++; console.log('通过：' + name); };

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    const client = { ws, inbox: [], waiters: [], seq: 0, send: o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }, cmd: (action, ...args) => client.send({ type: 'cmd', seq: ++client.seq, action, args }) };
    ws.on('message', raw => { const m = JSON.parse(raw); const w = client.waiters.find(w => w.type === m.type); if (w) { client.waiters.splice(client.waiters.indexOf(w), 1); w.res(m); } else client.inbox.push(m); });
    ws.on('open', () => res(client));
    ws.on('error', e => { if (connect.retries-- > 0) setTimeout(() => connect().then(res, rej), 400); else rej(e); });
  });
}
connect.retries = 8;
const waitFor = async (c, type, timeout = 8000, pred = () => true) => {
  const hit = c.inbox.find(m => m.type === type && pred(m));
  if (hit) { c.inbox.splice(c.inbox.indexOf(hit), 1); return hit; }
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('等待 ' + type + ' 超时')), timeout);
    c.waiters.push({ type, res: m => { clearTimeout(t); res(m); } });
  });
};
const latestLobby = (c, code) => c.inbox.filter(m => m.type === 'lobby' && m.code === code).at(-1);
const clearInbox = c => { c.inbox.length = 0; };

// 独立服务器（SF_DEV=1）
const server = spawn('node', ['server/server.mjs'], { env: { ...process.env, PORT: String(PORT), SF_DEV: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
server.stderr.on('data', d => process.stdout.write('[srv!] ' + d));
await sleep(1000);

try {
  // ---- 1. 等待房间中房主退出 → 房主转交 ----
  const A = await connect(), B = await connect(), C = await connect();
  A.send({ type: 'create', name: '房主甲' });
  const wa = await waitFor(A, 'welcome');
  const code = wa.code;
  B.send({ type: 'join', code, name: '乙' });
  await waitFor(B, 'welcome');
  C.send({ type: 'join', code, name: '丙' });
  await waitFor(C, 'welcome');
  await sleep(200);
  ok(latestLobby(B, code).host === wa.you.pid, '初始房主为创建者');
  A.send({ type: 'leave' });
  await sleep(300);
  const lb1 = latestLobby(B, code);
  ok(lb1.host === (await (await Promise.resolve(wa)) && lb1.players[0]?.pid), '房主退出后转交给剩余玩家');
  ok(lb1.players.length === 2 && !lb1.players.some(p => p.pid === wa.you.pid), '退出者已从房间移除');
  // 新房主可以开始对局
  clearInbox(B); clearInbox(C);
  B.send({ type: 'faction', faction: 'elf' });
  C.send({ type: 'faction', faction: 'troll' });
  await sleep(300); // 跨连接消息顺序不保证，等待双方阵营生效
  B.send({ type: 'ready' }); C.send({ type: 'ready' });
  await sleep(150);
  B.send({ type: 'start' });
  await waitFor(B, 'begin'); await waitFor(C, 'begin');
  ok(true, '转交后的新房主能开始对局');

  // ---- 2. 对局结束后：迟到命令被拒 + end 只发一次 ----
  await sleep(500);
  clearInbox(B); clearInbox(C);
  C.cmd('devend'); // 巨魔真实死亡路径 → 精灵获胜
  const endMsg = await waitFor(B, 'end', 6000);
  ok(endMsg.result === '精灵获胜', 'devend 走正常结算：' + endMsg.result);
  await sleep(400);
  const endCount = B.inbox.filter(m => m.type === 'end').length;
  ok(endCount === 0, 'end 不重复发送（结算一次）');
  B.cmd('move', 500, 500); // 结束后的迟到命令
  const late = await waitFor(B, 'error', 4000);
  ok(late.msg.includes('对局'), '迟到命令被拒：' + late.msg);
  C.cmd('buy', 'I004');
  const late2 = await waitFor(C, 'error', 4000);
  ok(late2.msg.includes('对局') || late2.msg.includes('淘汰'), '结束后购买同样被拒：' + late2.msg);

  // ---- 3. 再来一局 + 多轮重开资源清理（3 轮） ----
  for (let round = 1; round <= 3; round++) {
    clearInbox(B); clearInbox(C);
    B.send({ type: 'again' });
    const lb2 = await waitFor(B, 'lobby', 4000, m => m.phase === 'lobby');
    ok(lb2.phase === 'lobby' && lb2.players.every(p => !p.ready), `第${round}轮：回到大厅且准备状态清空`);
    ok(lb2.players.length === 2, `第${round}轮：玩家名单保留`);
    // 阵营保留、直接重开
    B.send({ type: 'ready' }); C.send({ type: 'ready' });
    await sleep(150);
    B.send({ type: 'start' });
    await waitFor(B, 'begin'); await waitFor(C, 'begin');
    const snapB = await waitFor(B, 'snap', 5000);
    const snapC = await waitFor(C, 'snap', 5000);
    ok(snapB.phase === 'prep' && snapB.you.gold === 30 && snapB.you.wood === 0, `第${round}轮：精灵资源重置 30/0`);
    ok(snapC.you.gold === 30, `第${round}轮：巨魔资源重置`);
    ok(snapB.buildings.length === 0, `第${round}轮：建筑全部清空`);
    ok(snapB.players.every(p => p.alive), `第${round}轮：玩家全部复活`);
    ok(snapB.you.maxHp === 150 && snapC.stats.maxHp === 500, `第${round}轮：单位属性重置`);
    ok(snapB.camps.every(c => c.claimedBy === null), `第${round}轮：营地占领清空`);
    // 快速打完一局再进入下一轮
    await sleep(300);
    C.cmd('devend');
    await waitFor(B, 'end', 6000);
  }
  // 服务器房间数量：仅本测试 1 个房间（旧对局房间不泄漏）
  const roomsRes = await (await fetch(`http://127.0.0.1:${PORT}/api/rooms`)).json();
  ok(roomsRes.rooms.length === 1, `服务器无房间泄漏（rooms=${roomsRes.rooms.length}）`);

  // ---- 4. 消息频率限制不崩溃 ----
  for (let i = 0; i < 60; i++) B.cmd('move', 500 + i, 500);
  await sleep(600);
  ok(B.ws.readyState === 1, '超频命令被限速且连接保持');

  console.log(`—— 房间生命周期集成测试通过 ${passed} 项 ——`);
} finally {
  server.kill();
}
process.exit(0);
