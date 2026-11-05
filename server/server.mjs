// 雪林营地 · 多人权威服务器：WebSocket 房间/会话/重连 + 20Hz 固定步长模拟 + 10Hz 按阵营过滤快照。
// 仅依赖 ws；同时静态托管 game/ 目录，客户端与 WS 同源即可联机。
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatch, advance, snapshot, tickTimeouts, moveCmd, claimCamp, buildCmd, upgradeCmd, repairCmd, stopCmd, blinkCmd, castSkillCmd, recruitCmd, buyCmd, sellCmd, useItemCmd, trollAttackCmd, trollSkillCmd, CFG } from '../game/mp/mp-sim.mjs';
import { CAMPS } from '../game/mp/map-data.mjs';
import { ALL_ITEMS, SHOP_LIST } from '../game/mp/mp-items.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.join(__dirname, '..', 'game');
const PORT = Number(process.env.PORT ?? 8080);
const VERSION = 'mp-1.0.0';
const TICK_MS = 50, SNAP_MS = 100;

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const rooms = new Map();
const code4 = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return rooms.has(s) ? code4() : s; };
const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

class Room {
  constructor(hostName) {
    this.code = code4();
    this.host = null;            // pid
    this.phase = 'lobby';        // lobby | playing | ended
    this.seats = [];             // [{pid,name,faction,ready,token,connected,ws,lastSeq,disconnectedAt}]
    this.match = null;
    this.loop = null;
    this.createdAt = Date.now();
    this.nextPid = 1;
    this.endedAt = 0;
  }
  info() {
    return {
      type: 'lobby', code: this.code, phase: this.phase, host: this.host,
      players: this.seats.map(p => ({ pid: p.pid, name: p.name, faction: p.faction, ready: p.ready, connected: p.connected })),
      canStart: this.seats.some(p => p.faction === 'troll') && this.seats.some(p => p.faction === 'elf'),
      mapName: '雪林大地图 · 10 营地', version: VERSION,
      shops: SHOP_LIST, itemDb: ALL_ITEMS, cfg: { prepTime: CFG.prepTime, maxTime: CFG.maxTime, growthInterval: CFG.growthInterval },
    };
  }
  seat(ws) { return this.seats.find(p => p.ws === ws) ?? null; }
  byPid(pid) { return this.seats.find(p => p.pid === pid) ?? null; }
  join(name) {
    if (this.seats.length >= 6) return { error: '房间已满（6 人）' };
    if (this.phase !== 'lobby') return { error: '对局已开始，只能通过重连返回' };
    const seat = { pid: 'p' + this.nextPid++, name: String(name ?? '旅人').slice(0, 12) || '旅人', faction: null, ready: false, token: token(), connected: true, ws: null, lastSeq: 0 };
    this.seats.push(seat);
    if (!this.host) this.host = seat.pid;
    return { seat };
  }
  reclaim(seat) {
    seat.connected = true; seat.disconnectedAt = null;
    seat.lastSeq = 0; // 重连是新会话:重置命令序号基线,避免新会话命令被当作重复而静默丢弃
    if (this.match) this.match.players[seat.pid].connected = true;
    return seat;
  }
  removeSeat(seat) {
    this.seats = this.seats.filter(p => p !== seat);
    if (this.host === seat.pid) this.host = this.seats[0]?.pid ?? null;
    if (!this.seats.length) rooms.delete(this.code);
  }
  start() {
    if (this.phase === 'playing') return '对局已在进行';
    if (!(this.seats.some(p => p.faction === 'troll') && this.seats.some(p => p.faction === 'elf'))) return '需要至少 1 名巨魔和 1 名精灵';
    const roster = this.seats.map(p => ({ pid: p.pid, name: p.name, faction: p.faction }));
    // 对局参数可用环境变量覆盖（SF_PREP/SF_MAXTIME/SF_GROWTH），默认值见 mp-sim CFG
    this.match = createMatch(roster, {
      ...(process.env.SF_PREP && { prepTime: Number(process.env.SF_PREP) }),
      ...(process.env.SF_MAXTIME && { maxTime: Number(process.env.SF_MAXTIME) }),
      ...(process.env.SF_GROWTH && { growthInterval: Number(process.env.SF_GROWTH) }),
    });
    this.phase = 'playing';
    this.startLoop();
    return '';
  }
  startLoop() {
    this.stopLoop();
    let lastTick = Date.now();
    this.loop = setInterval(() => {
      const now = Date.now();
      const s = this.match;
      if (!s) return this.stopLoop();
      const elapsed = Math.min(250, now - lastTick);
      lastTick = now;
      let left = elapsed;
      while (left > 0) { const step = Math.min(left, TICK_MS); advance(s, step / 1000); left -= step; }
      tickTimeouts(s, now);
      // 快照按 SNAP_MS(10Hz) 节流；模拟与事件保持 20Hz
      if (now - (this.lastSnapAt ?? 0) >= SNAP_MS) {
        this.lastSnapAt = now;
        for (const p of this.seats) {
          if (p.ws && p.ws.readyState === 1) {
            const snap = snapshot(s, p.pid);
            if (snap) send(p.ws, { type: 'snap', ...snap });
          }
        }
      }
      sendEvents(this, s);
      if (s.phase === 'ended') {
        this.phase = 'ended'; this.endedAt = now;
        for (const p of this.seats) if (p.ws && p.ws.readyState === 1) send(p.ws, { type: 'end', result: s.result, stats: s.stats });
        this.stopLoop();
      }
    }, TICK_MS);
  }
  stopLoop() { if (this.loop) { clearInterval(this.loop); this.loop = null; } }
  again() {
    if (this.phase !== 'ended') return '对局尚未结束';
    this.phase = 'lobby';
    for (const p of this.seats) p.ready = false;
    this.match = null;
    return '';
  }
}
// 事件路由：按阵营/玩家过滤后发送
function sendEvents(room, s) {
  if (!s.events.length) return;
  const list = s.events.splice(0, s.events.length);
  for (const p of room.seats) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const team = p.faction === 'troll' ? 'troll' : 'elf';
    const mine = list.filter(e => (e.team ?? 'all') === 'all' || e.team === team || e.pid === p.pid);
    if (mine.length) send(p.ws, { type: 'events', list: mine });
  }
}

const wss = new WebSocketServer({ noServer: true });
const rateMap = new WeakMap();

wss.on('connection', (ws, req) => {
  ws.room = null; ws.seat = null;
  ws.on('message', raw => {
    if (raw.length > 4096) return;
    const now = Date.now();
    let bucket = rateMap.get(ws);
    if (!bucket) rateMap.set(ws, bucket = { n: 0, ts: now });
    if (now - bucket.ts > 1000) { bucket.ts = now; bucket.n = 0; }
    if (++bucket.n > 45) return; // 命令频率限制
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(ws, msg); } catch (e) { send(ws, { type: 'error', msg: '服务器处理异常：' + e.message }); }
  });
  ws.on('close', () => {
    const seat = ws.seat, room = ws.room;
    if (!room || !seat) return;
    seat.connected = false; seat.ws = null; seat.disconnectedAt = Date.now();
    if (room.match) {
      const mp = room.match.players[seat.pid];
      if (mp && mp.alive) { mp.connected = false; mp.disconnectedAt = Date.now(); room.match.events.push({ kind: 'msg', team: 'all', text: seat.name + ' 断线，120 秒内可重连' }); }
    } else if (room.phase === 'lobby') {
      room.removeSeat(seat);
      broadcastLobby(room);
    }
  });
});

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcastLobby(room) { for (const p of room.seats) if (p.ws && p.ws.readyState === 1) send(p.ws, room.info()); }

function handle(ws, msg) {
  const room = ws.room, seat = ws.seat;
  switch (msg.type) {
    case 'ping': send(ws, { type: 'pong', t: msg.t }); return;
    case 'create': {
      const r = new Room();
      const { seat: s2, error } = r.join(msg.name);
      if (error) return send(ws, { type: 'error', msg: error });
      s2.ws = ws; s2.faction = 'elf';
      ws.room = r; ws.seat = s2;
      rooms.set(r.code, r);
      send(ws, { ...r.info(), type: 'welcome', you: { pid: s2.pid, token: s2.token, name: s2.name } });
      return;
    }
    case 'join': {
      const r = rooms.get(String(msg.code ?? '').toUpperCase());
      if (!r) return send(ws, { type: 'error', msg: '房间不存在，请核对房间码' });
      if (r.phase !== 'lobby') return send(ws, { type: 'error', msg: '该房间对局已开始' });
      const { seat: s2, error } = r.join(msg.name);
      if (error) return send(ws, { type: 'error', msg: error });
      s2.ws = ws;
      ws.room = r; ws.seat = s2;
      send(ws, { ...r.info(), type: 'welcome', you: { pid: s2.pid, token: s2.token, name: s2.name } });
      broadcastLobby(r);
      return;
    }
    case 'reconnect': {
      const r = rooms.get(String(msg.code ?? '').toUpperCase());
      if (!r) return send(ws, { type: 'error', msg: '房间已解散' });
      const s2 = r.seats.find(p => p.token === msg.token);
      if (!s2) return send(ws, { type: 'error', msg: '重连凭据无效' });
      s2.ws = ws; ws.room = r; ws.seat = s2;
      r.reclaim(s2);
      send(ws, { ...r.info(), type: 'welcome', you: { pid: s2.pid, token: s2.token, name: s2.name } });
      if (r.match) send(ws, { type: 'begin', roster: r.seats.map(p => ({ pid: p.pid, name: p.name, faction: p.faction })) });
      return;
    }
    case 'faction': {
      if (!seat) return;
      if (room.phase !== 'lobby') return send(ws, { type: 'error', msg: '对局开始后不能换阵营' });
      if (msg.faction === 'troll' && room.seats.some(p => p !== seat && p.faction === 'troll')) return send(ws, { type: 'error', msg: '巨魔名额已被占用' });
      seat.faction = msg.faction === 'troll' ? 'troll' : 'elf';
      seat.ready = false;
      broadcastLobby(room);
      return;
    }
    case 'ready': {
      if (!seat || room.phase !== 'lobby') return;
      seat.ready = !seat.ready;
      broadcastLobby(room);
      return;
    }
    case 'start': {
      if (!seat) return;
      if (room.host !== seat.pid) return send(ws, { type: 'error', msg: '只有房主能开始对局' });
      const err = room.start();
      if (err) return send(ws, { type: 'error', msg: err });
      for (const p of room.seats) if (p.ws?.readyState === 1) send(p.ws, { type: 'begin', roster: room.seats.map(k => ({ pid: k.pid, name: k.name, faction: k.faction })) });
      return;
    }
    case 'again': {
      if (!seat || room.host !== seat.pid) return send(ws, { type: 'error', msg: '只有房主能开始新一局' });
      const err = room.again();
      if (err) return send(ws, { type: 'error', msg: err });
      broadcastLobby(room);
      return;
    }
    case 'leave': {
      if (!seat) return;
      if (room.phase === 'lobby') { room.removeSeat(seat); ws.room = null; ws.seat = null; broadcastLobby(room); send(ws, { type: 'bye' }); }
      else { if (room.match) { const mp = room.match.players[seat.pid]; if (mp?.alive) room.match.events.push({ kind: 'msg', team: 'all', text: seat.name + ' 退出了对局' }); seat.connected = false; }
        send(ws, { type: 'bye' }); }
      return;
    }
    case 'cmd': {
      if (!room?.match || room.phase !== 'playing' || !seat) return send(ws, { type: 'error', msg: '当前不在对局中' });
      if (typeof msg.seq !== 'number' || msg.seq <= seat.lastSeq) return; // 重复/过期命令
      seat.lastSeq = msg.seq;
      const s = room.match, mp = s.players[seat.pid];
      if (!mp) return;
      if (!mp.alive || !mp.connected) return send(ws, { type: 'error', msg: '你已淘汰或断线，无法操作' });
      if (s.phase === 'ended') return send(ws, { type: 'error', msg: '对局已结束' });
      const a = msg.args ?? [];
      let error = '';
      switch (msg.action) {
        case 'move': error = moveCmd(s, mp, a[0], a[1]); break;
        case 'claim': error = claimCamp(s, mp); break;
        case 'build': error = buildCmd(s, mp, a[0], a[1], a[2]); break;
        case 'upgrade': error = upgradeCmd(s, mp, a[0], a[1]); break;
        case 'repair': error = repairCmd(s, mp, a[0]); break;
        case 'stop': error = stopCmd(s, mp); break;
        case 'blink': error = blinkCmd(s, mp, a[0], a[1]); break;
        case 'skill': error = castSkillCmd(s, mp, a[0], a[1], a[2]); break;
        case 'recruit': error = recruitCmd(s, mp, a[0] ?? 0); break;
        case 'buy': error = buyCmd(s, mp, a[0]); break;
        case 'sell': error = sellCmd(s, mp, a[0]); break;
        case 'use': error = useItemCmd(s, mp, a[0], a[1], a[2]); break;
        case 'attack': error = trollAttackCmd(s, mp, a[0]); break;
        case 'trollSkill': error = trollSkillCmd(s, mp, a[0]); break;
        case 'devend': {
          // 测试专用（SF_DEV=1 时启用）：巨魔按真实死亡路径倒下，走正常胜负结算
          if (process.env.SF_DEV !== '1') { error = '未启用'; break; }
          if (mp.faction !== 'troll') { error = '仅巨魔会话可触发'; break; }
          s.troll.hp = 0; s.troll.alive = false; s.troll.path = []; s.troll.order = null;
          s.events.push({ kind: 'msg', team: 'all', text: '巨魔倒下了，精灵获胜！' });
          break;
        }
        default: error = '未知指令';
      }
      if (error) send(ws, { type: 'cmderr', action: msg.action, msg: error });
      return;
    }
    default: send(ws, { type: 'error', msg: '未知消息类型' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size, version: VERSION, uptime: process.uptime() })); return; }
  if (url.pathname === '/api/rooms') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rooms: [...rooms.values()].map(r => ({ code: r.code, phase: r.phase, players: r.seats.length })) })); return; }
  let p = url.pathname === '/' ? '/multi.html' : url.pathname;
  p = p.replace(/\.\./g, '');
  const file = path.join(GAME_DIR, p);
  if (!file.startsWith(GAME_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
// 每 30s 清理空房间 + 结束后 10 分钟未活动的房间
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const empty = !r.seats.length || r.seats.every(p => !p.connected);
    if (empty && now - r.createdAt > 60_000) { r.stopLoop(); rooms.delete(code); }
    if (r.phase === 'ended' && now - r.endedAt > 600_000) { r.stopLoop(); rooms.delete(code); }
  }
}, 30_000).unref();

server.listen(PORT, () => console.log(`[snowforest-mp] 服务器已启动: http://127.0.0.1:${PORT}/multi.html  (WS 同源 /  版本 ${VERSION})`));
