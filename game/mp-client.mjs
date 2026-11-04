// 雪林营地 · 联机客户端：大厅 UI、权威快照渲染（平滑插值）、迷雾、命令发送。
// 渲染素材与帧表复用单机版 assets；地形为程序化分块缓存（无大图）。
import { MAP, CAMPS, TROLL_SPAWN, ELF_SPAWN, LAKES, ROCKS, LANDMARKS, DECOR_SEED, ground } from './mp/map-data.mjs';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
// 服务器地址：?server=wss://… 优先，其次同源；本地文件打开时回退本机端口
const serverUrl = qs.get('server') ?? ((location.protocol === 'https:' ? 'wss://' : location.protocol === 'http:' ? 'ws://' : 'ws://127.0.0.1:8080') + location.host);

let ws = null, myToken = sessionStorage.getItem('sf_token') ?? '', myPid = null, roomCode = qs.get('room') ?? '', myName = sessionStorage.getItem('sf_name') ?? '', myFaction = null;
let itemDb = {}, shops = { elf: [], troll: [] };
let seq = 0, ping = 0, lastPong = 0, alive = false;
const cmd = (action, ...args) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'cmd', seq: ++seq, action, args })); };

// ---------- 音效 ----------
let audioOn = localStorage.getItem('sf_sound') === '1', audioCtx = null;
function tone(kind = 'click') {
  if (!audioOn) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), now = audioCtx.currentTime;
    o.type = kind === 'impact' ? 'triangle' : 'sine';
    o.frequency.setValueAtTime(kind === 'impact' ? 120 : kind === 'spark' ? 880 : 520, now);
    o.frequency.exponentialRampToValueAtTime(70, now + .1);
    g.gain.setValueAtTime(.03, now); g.gain.exponentialRampToValueAtTime(.001, now + .12);
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(now + .13);
  } catch { }
}

// ---------- 网络连接 ----------
function connect(isReconnect = false) {
  ws = new WebSocket(serverUrl);
  $('net-pill').textContent = '连接中…'; $('net-pill').className = '';
  ws.onopen = () => {
    alive = true;
    $('net-pill').textContent = '已连接'; $('net-pill').className = '';
    if (isReconnect && myToken && roomCode) ws.send(JSON.stringify({ type: 'reconnect', code: roomCode, token: myToken }));
    if (!window._pingTimer) window._pingTimer = setInterval(() => { if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'ping', t: performance.now() })); if (lastPong && performance.now() - lastPong > 15000) markDead(); } }, 5000);
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'pong') { lastPong = performance.now(); ping = Math.round(lastPong - m.t); $('net-pill').textContent = '延迟 ' + ping + 'ms'; return; }
    handleMsg(m);
  };
  ws.onclose = () => {
    alive = false; markDead();
  };
  ws.onerror = () => { };
}
function markDead() {
  if (!alive && inGame) {
    $('dc-ov').classList.add('on');
    let left = 120;
    $('reconnect-left').textContent = left;
    clearInterval(dcTimer);
    dcTimer = setInterval(() => { $('reconnect-left').textContent = Math.max(0, --left); if (left <= 0) { clearInterval(dcTimer); location.href = 'multi.html'; } }, 1000);
  } else if (!inGame) {
    $('net-pill').textContent = '未连接'; $('net-pill').className = 'bad';
    $('menu-err').textContent = '无法连接服务器，请确认服务器已启动或 ?server= 地址正确';
  }
}
let dcTimer = null;
$('btn-retry').addEventListener('click', () => { $('dc-ov').classList.remove('on'); connect(true); });
$('btn-dc-exit').addEventListener('click', () => location.href = 'multi.html');

// ---------- 消息处理 ----------
let inGame = false;
function handleMsg(m) {
  switch (m.type) {
    case 'welcome': {
      myPid = m.you.pid; myToken = m.you.token; myName = m.you.name;
      sessionStorage.setItem('sf_token', myToken); sessionStorage.setItem('sf_name', myName);
      itemDb = m.itemDb; shops = m.shops; roomCode = m.code;
      $('menu').style.display = 'flex'; $('game').classList.remove('on'); $('result-ov').classList.remove('on'); $('dc-ov').classList.remove('on');
      $('lobby').style.display = 'block';
      $('room-code').textContent = m.code;
      $('invite').textContent = location.origin + location.pathname + '?room=' + m.code;
      renderLobby(m);
      if (inGame) toast('已重新连接');
      inGame = false;
      break;
    }
    case 'lobby': renderLobby(m); break;
    case 'begin': startGame(m); break;
    case 'snap': onSnap(m); break;
    case 'events': for (const ev of m.list) onEvent(ev); break;
    case 'end': endGame(m); break;
    case 'cmderr': toast('⚠ ' + m.msg); tone('impact'); break;
    case 'error': if (m.msg.includes('重连') || m.msg.includes('解散')) { myToken = ''; } toast('⚠ ' + m.msg); $('menu-err').textContent = m.msg; break;
    case 'bye': inGame = false; $('game').classList.remove('on'); break;
  }
}
function renderLobby(m) {
  const list = $('player-list');
  list.replaceChildren(...m.players.map(p => {
    const d = document.createElement('div'); d.className = 'p';
    d.innerHTML = `<span>${p.name}${p.pid === myPid ? '（你）' : ''}</span><span class="fac ${p.faction ?? ''}">${p.faction === 'elf' ? '精灵' : p.faction === 'troll' ? '巨魔' : '未选择'}</span><span class="pill ${p.ready ? 'on' : ''}">${p.ready ? '已准备' : '未准备'}</span><span class="pill ${p.connected ? '' : ''}">${p.connected ? '在线' : '离线'}</span>`;
    return d;
  }));
  const me = m.players.find(p => p.pid === myPid);
  myFaction = me?.faction ?? null;
  $('btn-fac-elf').style.borderColor = myFaction === 'elf' ? 'var(--teal)' : '';
  $('btn-fac-troll').style.borderColor = myFaction === 'troll' ? 'var(--red)' : '';
  const canStart = m.host === myPid && m.canStart;
  $('btn-start').disabled = !canStart;
  $('btn-start').textContent = m.host === myPid ? '开始对局' : '等待房主开始';
}
$('btn-create').addEventListener('click', () => { myName = $('nickname').value.trim() || myName || '旅人'; ws.send(JSON.stringify({ type: 'create', name: myName })); });
$('btn-join').addEventListener('click', () => { myName = $('nickname').value.trim() || myName || '旅人'; ws.send(JSON.stringify({ type: 'join', code: $('join-code').value.trim().toUpperCase(), name: myName })); });
$('btn-fac-elf').addEventListener('click', () => ws.send(JSON.stringify({ type: 'faction', faction: 'elf' })));
$('btn-fac-troll').addEventListener('click', () => ws.send(JSON.stringify({ type: 'faction', faction: 'troll' })));
$('btn-ready').addEventListener('click', () => ws.send(JSON.stringify({ type: 'ready' })));
$('btn-start').addEventListener('click', () => ws.send(JSON.stringify({ type: 'start' })));
$('btn-leave').addEventListener('click', () => ws.send(JSON.stringify({ type: 'leave' })));

// ---------- 素材 ----------
const background = new Image(), atlas = new Image(), actors = new Image(), walls = new Image(), elfWork = new Image(), trollAttack = new Image();
background.src = 'assets/snow-map.png'; atlas.src = 'assets/atlas.png'; actors.src = 'assets/actors.png';
walls.src = 'assets/walls.png'; elfWork.src = 'assets/elf-work.png'; trollAttack.src = 'assets/troll-attack.png';
const workFrames = [[59, 212, 392, 491, 280, 702], [579, 75, 393, 629, 798, 703], [1078, 221, 535, 483, 1292, 703], [1621, 213, 393, 490, 1838, 702]];
const attackFrames = [[50, 264, 492, 410, 247, 673], [614, 16, 416, 653, 812, 668], [1035, 281, 581, 388, 1398, 668], [1691, 259, 468, 412, 1846, 670]];
const elfWalkFrames = [[84, 41, 198, 246, 196, 286], [381, 43, 194, 243, 487, 285], [681, 44, 178, 245, 788, 288], [961, 43, 196, 242, 1071, 284]];
const trollWalkFrames = [[33, 639, 250, 252, 182, 890], [374, 639, 239, 243, 489, 881], [649, 641, 230, 254, 772, 894], [942, 639, 258, 255, 1094, 893]];
const wallFrames = [];
const sizes = { house: [106, 108], tower: [91, 122], grove: [110, 102], wall: [90, 100], tech: [110, 112], lab: [95, 120], guild: [102, 95], mine: [90, 80] };
const cell = { house: [2, 0], tower: [1, 1], grove: [2, 1], wall: [0, 1], tech: [2, 0], lab: [1, 1], guild: [2, 1], mine: [0, 1] };
const effectColors = { arrow: '#e3cd99', arcane: '#d59cff', fire: '#ff974e', lightning: '#e8c1ff', frost: '#8dedff', poison: '#9bee68', chaos: '#ff726f', heal: '#88edb5', life: '#80e8bd' };
const statusColors = { root: '#94c171', silence: '#d3a0f2', frost: '#9be8ff', poison: '#a3e36d' };
const itemIcon = { attack: '⚔', haste: '⚡', hp: '❤', armor: '🛡', regen: '✚', move: '👣', sight: '👁', repair: '⚒', ward: '👁', shield: '🛡', heal: '✚' };
const buildNames = { house: '建房屋', wall: '建主墙', tower: '建防塔', grove: '建远古之树', tech: '建大厅', mine: '建金矿', guild: '建工人行会' };
const skillNames = { root: '缠绕 E', shield: '护盾 Z', silence: '沉默 W', ward: '守卫 V', stars: '星辰 N' };
const trollSkillNames = { invisible: '隐身', teleport: '传送回城', reveal: '揭示' };

Promise.all([background, atlas, actors, walls, elfWork, trollAttack].map(i => i.decode())).then(() => {
  // 墙体三档帧：按透明边界裁切
  const sheet = document.createElement('canvas'); sheet.width = walls.width; sheet.height = walls.height;
  const sc = sheet.getContext('2d'); sc.drawImage(walls, 0, 0);
  const px = sc.getImageData(0, 0, sheet.width, sheet.height).data;
  for (let col = 0; col < 3; col++) {
    const start = Math.floor(col * sheet.width / 3), end = Math.floor((col + 1) * sheet.width / 3);
    let left = end, top = sheet.height, right = start, bottom = 0;
    for (let y = 0; y < sheet.height; y++) for (let x = start; x < end; x++) if (px[(y * sheet.width + x) * 4 + 3] > 40) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    wallFrames.push([left, top, right - left + 1, bottom - top + 1]);
  }
  assetsReady = true;
  buildTerrain();
  buildMiniTerrain();
});
let miniTerrain = null;
function buildMiniTerrain() {
  miniTerrain = document.createElement('canvas'); miniTerrain.width = 224; miniTerrain.height = 126;
  const mc = miniTerrain.getContext('2d');
  mc.fillStyle = '#8ba3b0'; mc.fillRect(0, 0, 224, 126);
  mc.drawImage(document.createElement('canvas'), 0, 0);
  const off = document.createElement('canvas'); off.width = MAP.w / 4; off.height = MAP.h / 4;
  const oc = off.getContext('2d');
  for (let i = 0; i < chunks.length; i++) if (chunks[i]) oc.drawImage(chunks[i], (i % chunkCols) * CHUNK / 4, Math.floor(i / chunkCols) * CHUNK / 4, CHUNK / 4, CHUNK / 4);
  mc.drawImage(off, 0, 0, 224, 126);
}
let assetsReady = false;

// ---------- 程序化地形分块 ----------
const CHUNK = 512, chunkCols = Math.ceil(MAP.w / CHUNK), chunkRows = Math.ceil(MAP.h / CHUNK);
const chunks = [];
function buildTerrain() {
  const t0 = performance.now();
  for (let cy = 0; cy < chunkRows; cy++) for (let cx = 0; cx < chunkCols; cx++) {
    const cv = document.createElement('canvas'); cv.width = Math.min(CHUNK, MAP.w - cx * CHUNK); cv.height = Math.min(CHUNK, MAP.h - cy * CHUNK);
    const c = cv.getContext('2d');
    drawChunk(c, cx * CHUNK, cy * CHUNK, cv.width, cv.height);
    chunks[cy * chunkCols + cx] = cv;
  }
  console.log('[terrain] 分块生成完成', Math.round(performance.now() - t0) + 'ms');
}
let seedState = DECOR_SEED;
const rnd = () => (seedState = (seedState * 1664525 + 1013904223) >>> 0) / 4294967296;
function drawChunk(c, ox, oy, w, h) {
  // 雪地底色
  const g = c.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#b9c8d4'); g.addColorStop(1, '#a9bcc9');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  // 雪面噪点
  for (let i = 0; i < w * h / 380; i++) { c.fillStyle = rnd() < .5 ? '#ffffff' + (rnd() < .5 ? 'aa' : '55') : '#93a7b533'; c.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 3, 2 + rnd() * 2); }
  // 可行走区域 → 踩实的小路与营地空地
  const step = 6;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (ground(ox + x + step / 2, oy + y + step / 2)) { c.fillStyle = '#c7d3d0aa'; c.beginPath(); c.ellipse(x + step / 2, y + step / 2, step * .8, step * .55, 0, 0, 7); c.fill(); }
  }
  // 冰湖
  for (const l of LAKES) {
    c.save(); c.translate(l.x - ox, l.y - oy);
    if (Math.abs(l.x - ox - w / 2) < w + l.rx && Math.abs(l.y - oy - h / 2) < h + l.ry) {
      const grad = c.createRadialGradient(0, 0, 10, 0, 0, Math.max(l.rx, l.ry));
      grad.addColorStop(0, '#a8d8e8'); grad.addColorStop(.8, '#8cc3d8'); grad.addColorStop(1, '#7fb3c8');
      c.fillStyle = grad; c.beginPath(); c.ellipse(0, 0, l.rx, l.ry, 0, 0, 7); c.fill();
      c.strokeStyle = '#ffffffcc'; c.lineWidth = 3; c.stroke();
      c.strokeStyle = '#ffffff55'; c.lineWidth = 1.5;
      for (let i = 0; i < 5; i++) { c.beginPath(); c.moveTo(-l.rx * .7 * rnd(), -l.ry * .6 * rnd()); c.lineTo(l.rx * .7 * rnd(), l.ry * .6 * rnd()); c.stroke(); }
    }
    c.restore();
  }
  // 山石（多面体岩块 + 顶部积雪）
  for (const r of ROCKS) {
    const x = r.x - ox, y = r.y - oy;
    if (x < -80 || y < -80 || x > w + 80 || y > h + 80) continue;
    c.fillStyle = '#0e1a2280';
    c.beginPath(); c.ellipse(x, y + r.r * .45, r.r * 1.15, r.r * .4, 0, 0, 7); c.fill();
    const pts = [[-1, .1], [-.6, -.75], [.1, -1], [.85, -.55], [1, .15], [.3, .5], [-.5, .45]];
    c.fillStyle = '#55646f';
    c.beginPath(); pts.forEach(([px, py], i) => { const vx = x + px * r.r, vy = y + py * r.r * .8; i ? c.lineTo(vx, vy) : c.moveTo(vx, vy); }); c.closePath(); c.fill();
    c.fillStyle = '#6d7e8a';
    c.beginPath(); c.moveTo(x - r.r * .6, y - r.r * .75 * .8); c.lineTo(x + r.r * .1, y - r.r * .8); c.lineTo(x + r.r * .85, y - r.r * .55 * .8); c.lineTo(x + r.r * .2, y - r.r * .1); c.lineTo(x - r.r * .5, y - r.r * .05); c.closePath(); c.fill();
    c.fillStyle = '#e9eef2ee';
    c.beginPath(); c.moveTo(x - r.r * .55, y - r.r * .72 * .8); c.lineTo(x + r.r * .08, y - r.r * .92); c.lineTo(x + r.r * .8, y - r.r * .6 * .8); c.lineTo(x + r.r * .3, y - r.r * .55 * .8); c.lineTo(x - r.r * .2, y - r.r * .66 * .8); c.closePath(); c.fill();
  }
  // 雪松（非行走区，密林）
  for (let y = 0; y < h; y += 26) for (let x = 0; x < w; x += 26) {
    const wx = ox + x + rnd() * 20, wy = oy + y + rnd() * 20;
    if (ground(wx, wy) || rnd() > .34) continue;
    if (LAKES.some(l => ((wx - l.x) / (l.rx * 1.6)) ** 2 + ((wy - l.y) / (l.ry * 1.6)) ** 2 < 1)) continue;
    drawPine(c, wx - ox, wy - oy, 16 + rnd() * 22);
  }
  // 地标遗迹
  for (const lm of LANDMARKS) {
    const x = lm.x - ox, y = lm.y - oy;
    if (x < -60 || y < -60 || x > w + 60 || y > h + 60) continue;
    c.fillStyle = '#8d9aa5';
    for (let i = 0; i < 3; i++) { const bx = x - 26 + i * 26, bh = 26 + rnd() * 18; c.fillRect(bx, y - bh, 12, bh); c.fillStyle = '#e5ebefdd'; c.fillRect(bx, y - bh, 12, 5); c.fillStyle = '#8d9aa5'; }
    c.font = '12px system-ui'; c.fillStyle = '#4a5c68'; c.textAlign = 'center'; c.fillText(lm.name, x, y + 20);
  }
  // 营地装饰：石环火塘 + 灯柱 + 营名
  for (const camp of CAMPS) {
    const x = camp.x - ox, y = camp.y - oy;
    if (x < -220 || y < -220 || x > w + 220 || y > h + 220) continue;
    c.strokeStyle = '#6d7f8b'; c.lineWidth = 5;
    for (let i = 0; i < 7; i++) { const a = i * Math.PI * 2 / 7; c.beginPath(); c.ellipse(x + Math.cos(a) * 20, y + Math.sin(a) * 12, 6, 4, a, 0, 7); c.stroke(); }
    c.fillStyle = '#3d2c22'; c.beginPath(); c.ellipse(x, y, 12, 7, 0, 0, 7); c.fill();
    c.fillStyle = '#ff9d4d'; c.beginPath(); c.ellipse(x, y - 3, 5, 3, 0, 0, 7); c.fill();
    // 灯柱（西北）
    c.strokeStyle = '#4a3b2d'; c.lineWidth = 3; c.beginPath(); c.moveTo(x - 150, y - 130); c.lineTo(x - 150, y - 162); c.stroke();
    c.fillStyle = '#ffcf7d'; c.beginPath(); c.arc(x - 150, y - 166, 5, 0, 7); c.fill();
    c.font = 'bold 13px system-ui'; c.textAlign = 'center';
    c.strokeStyle = '#24344088'; c.lineWidth = 3; c.strokeText(camp.name, x, y + 44); c.fillStyle = '#31424e'; c.fillText(camp.name, x, y + 44);
  }
  // 出生区标记
  const zones = [[TROLL_SPAWN, '巨魔补给区', '#e08573'], [ELF_SPAWN, '精灵出发区', '#7adfbe']];
  for (const [z, name, color] of zones) {
    const x = z.x - ox, y = z.y - oy;
    if (x < -260 || y < -260 || x > w + 260 || y > h + 260) continue;
    c.strokeStyle = color + '77'; c.lineWidth = 2; c.setLineDash([8, 8]); c.beginPath(); c.arc(x, y, z.r, 0, 7); c.stroke(); c.setLineDash([]);
    c.font = 'bold 14px system-ui'; c.textAlign = 'center'; c.fillStyle = color; c.fillText(name, x, y - z.r - 10);
  }
}
function drawPine(c, x, y, h) {
  c.fillStyle = '#2e3f36';
  c.beginPath(); c.moveTo(x, y - h); c.lineTo(x - h * .34, y - h * .25); c.lineTo(x + h * .34, y - h * .25); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(x, y - h * 1.35); c.lineTo(x - h * .27, y - h * .6); c.lineTo(x + h * .27, y - h * .6); c.closePath(); c.fill();
  c.fillStyle = '#e8eef1cc';
  c.beginPath(); c.moveTo(x, y - h * 1.35); c.lineTo(x - h * .14, y - h * 1.02); c.lineTo(x + h * .14, y - h * 1.02); c.closePath(); c.fill();
  c.fillStyle = '#242f28'; c.fillRect(x - 2, y - 6, 4, 6);
}

// ---------- 快照状态 ----------
let snap = null, snapPrev = null, snapAt = 0;
const smooth = new Map(); // id -> {x,y}
function onSnap(m) {
  snapPrev = snap; snap = m; snapAt = performance.now();
  // 首帧把相机对准自己
  if (!camInit) { camInit = true; camera.x = m.you.x - view.w / zoom / 2; camera.y = m.you.y - view.h / zoom / 2; clampCam(); }
  for (const p of m.players) track(p.pid, p.x, p.y);
  track('you', m.you.x, m.you.y);
  for (const b of m.buildings) track(b.id, b.x, b.y);
  updateFogCanvas(m);
  if ((frameCount & 7) === 0) hud(m);
}
const track = (id, x, y) => { let e = smooth.get(id); if (!e) smooth.set(id, e = { x, y }); e.tx = x; e.ty = y; };
const lerpTo = (id, dt) => { const e = smooth.get(id); if (!e) return null; const k = Math.min(1, dt * 10); e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k; return e; };

// ---------- 迷雾 ----------
const FW = Math.ceil(MAP.w / 16), FH = Math.ceil(MAP.h / 16);
const explored = new Uint8Array(FW * FH);
const fogCanvas = document.createElement('canvas'); fogCanvas.width = FW; fogCanvas.height = FH;
const fogCtx = fogCanvas.getContext('2d');
function updateFogCanvas(m) {
  const vis = new Uint8Array(FW * FH);
  for (const src of m.sources) {
    const r = src.r / 16, x0 = Math.max(0, src.x / 16 - r), x1 = Math.min(FW, src.x / 16 + r), y0 = Math.max(0, src.y / 16 - r), y1 = Math.min(FH, src.y / 16 + r);
    for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) {
      const dx = x * 16 + 8 - src.x, dy = y * 16 + 8 - src.y;
      if (dx * dx + dy * dy <= src.r * src.r) { vis[y * FW + x] = 1; explored[y * FW + x] = 1; }
    }
  }
  const img = fogCtx.createImageData(FW, FH), d = img.data;
  for (let i = 0; i < FW * FH; i++) {
    const o = i * 4;
    if (!explored[i]) { d[o] = 4; d[o + 1] = 10; d[o + 2] = 16; d[o + 3] = 255; }
    else if (!vis[i]) { d[o] = 10; d[o + 1] = 22; d[o + 2] = 30; d[o + 3] = 150; }
    else d[o + 3] = 0;
  }
  fogCtx.putImageData(img, 0, 0);
  snap._vis = vis;
}

// ---------- 对局渲染 ----------
const canvas = $('field'), ctx = canvas.getContext('2d');
let camera = { x: 400, y: 760 }, zoom = 1, view = { w: 0, h: 0 };
let mode = '', selected = null, effects = [], shakeT = 0, frameCount = 0, camInit = false;
function resize() {
  view.w = innerWidth; view.h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = view.w * dpr; canvas.height = view.h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!inited) { zoom = view.w < 900 ? .8 : 1.05; inited = true; }
}
let inited = false;
addEventListener('resize', resize); resize();
const toWorld = e => { const r = canvas.getBoundingClientRect(); return { x: camera.x + (e.clientX - r.left) / zoom, y: camera.y + (e.clientY - r.top) / zoom }; };
const clampCam = () => { camera.x = Math.max(0, Math.min(MAP.w - view.w / zoom, camera.x)); camera.y = Math.max(0, Math.min(MAP.h - view.h / zoom, camera.y)); };

function startGame(m) {
  inGame = true; camInit = false;
  $('menu').style.display = 'none'; $('game').classList.add('on'); $('result-ov').classList.remove('on'); $('dc-ov').classList.remove('on');
  effects = []; snap = snapPrev = null; selected = null; mode = '';
  explored.fill(0); smooth.clear();
  $('shop').classList.remove('on');
  toast('对局开始！' + (myFaction === 'troll' ? '准备期后入场，沿主干道侦察' : '快去找营地占领并建设'));
  if (!requesting) { requesting = true; requestAnimationFrame(frame); }
}
let requesting = false;

function onEvent(ev) {
  if (ev.kind === 'msg') { toast(ev.text); tone(ev.text.includes('摧毁') || ev.text.includes('淘汰') ? 'impact' : 'spark'); return; }
  if (ev.kind === 'fx') {
    effects.push({ ...ev, age: 0, life: ev.life ?? .7 });
    if (['impact', 'debris', 'spark'].includes(ev.fx)) tone(ev.fx);
    if (ev.fx === 'debris' && $('opt-shake').checked) shakeT = .25;
  }
}
function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }

function endGame(m) {
  $('result-ov').classList.add('on');
  $('result-title').textContent = m.result ?? '对局结束';
  $('result-title').style.color = m.result?.startsWith('精灵') === (myFaction === 'elf') ? 'var(--teal)' : 'var(--red)';
  $('result-detail').textContent = `建造升级 ${m.stats?.upgrades ?? 0} 次 · 施法 ${m.stats?.spells ?? 0} 次 · 购买 ${m.stats?.purchases ?? 0} 次`;
  tone('complete');
}
$('btn-again').addEventListener('click', () => ws.send(JSON.stringify({ type: 'again' })));
$('btn-exit').addEventListener('click', () => location.reload());

// ---------- 输入 ----------
let pointer = null;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (e.button === 2) { mode = ''; hud(snap); return; }
  canvas.setPointerCapture(e.pointerId);
  pointer = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, dragged: false };
});
canvas.addEventListener('pointermove', e => {
  if (!pointer) return;
  const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
  if (Math.hypot(dx, dy) > 8) pointer.dragged = true;
  if (pointer.dragged) { camera.x = pointer.cx - dx / zoom; camera.y = pointer.cy - dy / zoom; clampCam(); }
});
canvas.addEventListener('pointerup', e => {
  if (pointer && !pointer.dragged) mapClick(toWorld(e), e.button === 2);
  pointer = null;
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = toWorld(e), old = zoom;
  zoom = Math.max(.55, Math.min(1.7, zoom * (e.deltaY > 0 ? .9 : 1.1)));
  camera.x = p.x - (p.x - camera.x) * old / zoom; camera.y = p.y - (p.y - camera.y) * old / zoom;
  clampCam();
}, { passive: false });
$('minimap').addEventListener('pointerdown', e => {
  const r = e.target.getBoundingClientRect();
  camera.x = (e.clientX - r.left) / r.width * MAP.w - view.w / zoom / 2;
  camera.y = (e.clientY - r.top) / r.height * MAP.h - view.h / zoom / 2;
  clampCam();
});

function hit(p) {
  if (!snap) return null;
  const objs = [];
  for (const b of snap.buildings) objs.push({ kind: 'b', o: b });
  for (const pl of snap.players) if (!pl.hidden) objs.push({ kind: 'p', o: pl });
  for (const it of objs) {
    const o = it.o;
    const w = it.kind === 'b' ? sizes[o.type]?.[0] ?? 90 : 76, h = it.kind === 'b' ? sizes[o.type]?.[1] ?? 90 : 88;
    if (p.x >= o.x - w * .48 && p.x <= o.x + w * .48 && p.y >= o.y - h * .8 && p.y <= o.y + 15) return it;
  }
  return null;
}
function mapClick(p) {
  if (!snap || snap.result) return;
  const me = snap.you;
  if (mode.startsWith('build:')) { cmd('build', mode.slice(6), p.x, p.y); tone('click'); return; }
  if (mode.startsWith('skill:')) { cmd('skill', mode.slice(6), p.x, p.y); mode = ''; tone('click'); return; }
  if (mode.startsWith('use:')) { cmd('use', mode.slice(4), p.x, p.y); mode = ''; tone('click'); return; }
  if (mode === 'blink') { cmd('blink', p.x, p.y); mode = ''; tone('click'); return; }
  if (mode === 'attack') { const h = hit(p); if (h?.kind === 'b') cmd('attack', h.o.id); else if (h?.kind === 'p') cmd('attack', h.o.pid); else cmd('move', p.x, p.y); tone('click'); return; }
  const h = hit(p);
  if (h?.kind === 'b') {
    selected = { type: 'b', o: h.o };
    if (h.o.owner === me.pid && h.o.type === 'wall' && h.o.progress === 1) toast('已选中主墙 · 按 R 或升级按钮操作');
    hud(snap); tone('click'); return;
  }
  if (h?.kind === 'p') { selected = { type: 'p', o: h.o }; hud(snap); tone('click'); return; }
  selected = null;
  cmd('move', p.x, p.y);
  tone('click'); hud(snap);
}

addEventListener('keydown', e => {
  if (!inGame || e.repeat) return;
  const k = e.key.toLowerCase();
  const builds = { '1': 'house', '2': 'wall', '3': 'tower', '4': 'grove' };
  if (builds[k] && snap?.you.faction === 'elf') { mode = 'build:' + builds[k]; toast('选择基座位置点击建造'); }
  else if (k === 'q' && snap?.you.faction === 'elf') mode = 'blink';
  else if (k === 'e') mode = 'skill:root';
  else if (k === 'z') mode = 'skill:shield';
  else if (k === 'w') mode = 'skill:silence';
  else if (k === 'v') mode = 'skill:ward';
  else if (k === 'r' && selected?.type === 'b') cmd('repair', selected.o.id);
  else if (k === 'u' && selected?.type === 'b') cmd('upgrade', selected.o.id);
  else if (k === 'b') $('shop').classList.toggle('on');
  else if (k === 'a' && snap?.you.faction === 'troll') { mode = 'attack'; toast('点击敌人建筑或精灵发动攻击'); }
  else if (k === ' ') { const me = smooth.get('you'); camera.x = me.tx - view.w / zoom / 2; camera.y = me.ty - view.h / zoom / 2; clampCam(); e.preventDefault(); }
  else if (k === 'escape') { mode = ''; $('shop').classList.remove('on'); }
  hud(snap);
});

// ---------- HUD ----------
$('btn-shop').addEventListener('click', () => $('shop').classList.toggle('on'));
$('btn-settings').addEventListener('click', () => $('settings').classList.toggle('on'));
$('opt-sound').checked = audioOn;
$('opt-sound').addEventListener('change', e => { audioOn = e.target.checked; localStorage.setItem('sf_sound', audioOn ? '1' : '0'); });

function hud(m) {
  if (!m) return;
  const you = m.you;
  $('res-gold').textContent = you.gold.toLocaleString();
  $('res-wood').textContent = you.wood.toLocaleString();
  $('res-rate').textContent = you.faction === 'troll' ? `攻击 ${m.stats?.attack ?? 0} · 护甲 ${m.stats?.armor ?? 0}` : `营地 ${you.camp ? '已占领' : '未占领'}`;
  $('phase-pill').textContent = m.phase === 'prep' ? `准备期 ${m.prepLeft}s` : m.phase === 'ended' ? '对局结束' : `对局 ${Math.floor(m.timeLeft / 60)}:${String(m.timeLeft % 60).padStart(2, '0')}${myFaction === 'elf' ? ' · 巨魔' + (m.tier + 1) + '阶' + m.growthIn + 's后强化' : ''}`;
  // 命令面板
  const isElf = you.faction === 'elf';
  const btns = isElf ? [
    ...Object.keys(buildNames).map(t => ({ id: 'build:' + t, label: buildNames[t], dis: !you.camp })),
    { id: 'upgrade', label: '升级 U', dis: selected?.type !== 'b' },
    { id: 'repair', label: '修理 R', dis: selected?.type !== 'b' },
    { id: 'blink', label: '闪烁 Q', dis: you.blinkCd > 0 },
    ...Object.keys(skillNames).map(k => ({ id: 'skill:' + k, label: skillNames[k], dis: (you.cooldowns?.[k] ?? 0) > 0 })),
    { id: 'claim', label: '占领营地', dis: !!you.camp },
    { id: 'stop', label: '停止' },
  ] : [
    { id: 'attack', label: '攻击 A', dis: false },
    ...Object.keys(trollSkillNames).map(k => ({ id: 'trollSkill:' + k, label: trollSkillNames[k], dis: (you.statuses?.silence ?? 0) > 0 })),
    { id: 'shop', label: '商店 B', dis: false },
    { id: 'stop', label: '停止' },
  ];
  $('cmdpanel').replaceChildren(...btns.map(b => {
    const el = document.createElement('button');
    el.textContent = b.label;
    el.disabled = b.dis;
    if (mode === b.id) el.className = 'active';
    el.addEventListener('click', () => {
      if (b.id === 'stop') { cmd('stop'); mode = ''; }
      else if (b.id === 'claim') cmd('claim');
      else if (b.id === 'upgrade' && selected?.type === 'b') cmd('upgrade', selected.o.id);
      else if (b.id === 'repair' && selected?.type === 'b') cmd('repair', selected.o.id);
      else if (b.id === 'shop') $('shop').classList.toggle('on');
      else if (b.id.startsWith('trollSkill:')) cmd('trollSkill', b.id.slice(11));
      else mode = b.id === mode ? '' : b.id;
      hud(snap);
    });
    return el;
  }));
  // 选中面板
  if (selected?.type === 'b') {
    const b = snap.buildings.find(v => v.id === selected.o.id) ?? selected.o;
    $('sel-name').textContent = { house: '房屋', wall: '主墙', tower: '防御塔', grove: '远古之树', tech: '大厅', mine: '金矿', guild: '工人行会' }[b.type] + ' · ' + (b.level + 1) + ' 阶';
    $('sel-hp').style.width = (b.hp / b.hpMax * 100) + '%';
    $('sel-detail').textContent = b.wreck ? '残骸（停产）' : b.progress < 1 ? '施工中 ' + Math.round(b.progress * 100) + '%' : b.type === 'tower' ? `攻击范围 ${b.effect ?? ''}` : `耐久 ${b.hp}/${b.hpMax}` + (b.shield ? ' · 护盾中' : '');
  } else if (selected?.type === 'p' || selected?.type === 't') {
    const p = selected.o;
    $('sel-name').textContent = p.name + (p.faction === 'troll' ? '（巨魔）' : '（精灵）');
    $('sel-hp').style.width = (p.hp / p.maxHp * 100) + '%';
    $('sel-detail').textContent = p.alive ? `生命 ${p.hp}/${p.maxHp}` : '已被淘汰';
  } else {
    $('sel-name').textContent = you.name + (you.faction === 'elf' ? '（精灵）' : '（巨魔）');
    $('sel-hp').style.width = Math.max(0, you.hp / you.maxHp * 100) + '%';
    $('sel-detail').textContent = you.faction === 'troll'
      ? `生命 ${you.hp}/${you.maxHp}` + (you.invisible ? ` · 隐身 ${you.invisible}s` : '') + Object.entries(you.statuses ?? {}).map(([k, v]) => ` · ${statusColors[k] ? { root: '缠绕', silence: '沉默', frost: '冰', poison: '毒' }[k] : k} ${v}s`).join('')
      : (you.alive ? `生命 ${you.hp}/${you.maxHp} · 魔法 ${you.mana}` : '已淘汰 · 观战中');
  }
  $('sel-hp').className = you.hp / you.maxHp < .35 ? 'danger' : '';
  renderShop(m);
}
function renderShop(m) {
  const you = m.you, faction = you.faction;
  $('shop-title').textContent = faction === 'troll' ? '巨魔商店（补给区）' : '精灵商店（营地）';
  const bag = $('bag');
  const bagChildren = you.items.length ? you.items.map((id, i) => {
    const d = itemDb[id];
    const s = document.createElement('div'); s.className = 'slot'; s.title = d ? d.name + '：' + d.tip : id;
    s.textContent = (d ? d.name : id).slice(0, 4) + (d?.uses ? `×${you.uses?.[id] ?? 0}` : '');
    s.addEventListener('click', () => {
      if (d?.kind === 'active' && (d.effect === 'ward' || d.effect === 'shield')) { mode = 'use:' + id; toast('点击目标位置使用'); }
      else if (d?.kind === 'active') { cmd('use', id); }
      else if (confirm('出售 ' + d.name + '（返还 ' + d.sell + ' 金）？')) cmd('sell', id);
      hud(snap);
    });
    return s;
  }) : (() => { const e = document.createElement('div'); e.className = 'slot'; e.style.borderStyle = 'dashed'; e.textContent = '空'; return [e]; })();
  bag.replaceChildren(...bagChildren);
  const list = $('shop-list');
  list.replaceChildren(...(shops[faction] ?? []).map(id => {
    const d = itemDb[id];
    const row = document.createElement('div'); row.className = 'item';
    const afford = you.gold >= d.gold && you.wood >= (d.wood ?? 0) && you.items.length < you.bagSize;
    row.innerHTML = `<span style="font-size:20px">${itemIcon[Object.keys(d.bonus ?? {})[0] ?? d.effect] ?? '◆'}</span><span class="info"><b>${d.name}</b><small>${d.tip}</small><small>${d.gold} 金${d.wood ? ' / ' + d.wood + ' 木' : ''}${d.unique ? ' · 唯一' : ''}${d.uses ? ' · ' + d.uses + ' 次' : ''}${d.cd ? ' · 冷却 ' + d.cd + 's' : ''}</small></span>`;
    const btn = document.createElement('button'); btn.textContent = '购买'; btn.disabled = !afford;
    if (!afford) btn.title = you.items.length >= you.bagSize ? '背包已满' : '资源不足';
    btn.addEventListener('click', () => { cmd('buy', id); hud(snap); });
    row.append(btn);
    return row;
  }));
}

// ---------- 渲染主循环 ----------
let lastFrame = 0, snow = [];
for (let i = 0; i < 130; i++) snow.push({ x: Math.random() * 2000, y: Math.random() * 1200, v: 18 + Math.random() * 40, d: .5 + Math.random() * 1.6 });
function frame(now) {
  requestAnimationFrame(frame);
  frameCount++;
  const dt = Math.min(.1, (now - lastFrame) / 1000 || 0); lastFrame = now;
  if (!assetsReady || !snap) return;
  let sx = 0, sy = 0;
  if (shakeT > 0) { shakeT -= dt; sx = (Math.random() - .5) * 7 * shakeT; sy = (Math.random() - .5) * 7 * shakeT; }
  ctx.save();
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.translate(sx, sy);
  ctx.scale(zoom, zoom);
  ctx.translate(-camera.x, -camera.y);
  // 地形分块（视口裁剪）
  const x0 = Math.max(0, Math.floor(camera.x / CHUNK)), x1 = Math.min(chunkCols - 1, Math.floor((camera.x + view.w / zoom) / CHUNK));
  const y0 = Math.max(0, Math.floor(camera.y / CHUNK)), y1 = Math.min(chunkRows - 1, Math.floor((camera.y + view.h / zoom) / CHUNK));
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) ctx.drawImage(chunks[cy * chunkCols + cx], cx * CHUNK, cy * CHUNK);
  // 本营地槽位提示
  const myCamp = snap.camps.find(c => c.claimedBy === snap.you.pid);
  if (myCamp && snap.you.faction === 'elf') {
    const camp = CAMPS.find(c => c.id === myCamp.id);
    ctx.strokeStyle = mode.startsWith('build:') ? '#e6d18a' : '#a0bfbe66';
    ctx.setLineDash([5, 5]); ctx.lineWidth = 1;
    for (const b of snap.buildings.filter(b => b.owner === snap.you.pid && b.hp > 0)) { /* 已建 */ }
    const slots = { house: [camp.slots.house], wall: [camp.slots.gate], grove: [camp.slots.grove], tech: [camp.slots.tech], mine: [camp.slots.mine], tower: camp.slots.tower };
    const cur = mode.slice(6);
    for (const [t, list] of Object.entries(slots)) {
      if (mode.startsWith('build:') && t !== cur) continue;
      for (const s of list) {
        const taken = snap.buildings.some(b => b.hp > 0 && Math.hypot(b.x - s.x, b.y - s.y) < 26);
        if (taken) continue;
        ctx.beginPath(); ctx.ellipse(s.x, s.y, 26, 15, 0, 0, 7); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }
  // 守卫
  for (const w of snap.wards) { ctx.strokeStyle = '#efc77b'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(w.x, w.y, 16, 9, 0, 0, 7); ctx.stroke(); ctx.fillStyle = '#edcb81'; ctx.fillRect(w.x - 2, w.y - 26, 4, 26); ctx.beginPath(); ctx.arc(w.x, w.y - 28, 4, 0, 7); ctx.fill(); }
  // 实体按 y 排序
  const draw = [];
  for (const b of snap.buildings) draw.push({ y: b.y, f: () => drawBuilding(b) });
  for (const p of snap.players) if (!p.hidden) draw.push({ y: p.y, f: () => drawActor(p, smooth.get(p.pid), p.faction === 'troll') });
  draw.push({ y: snap.you.y, f: () => drawYou() });
  draw.sort((a, b) => a.y - b.y).forEach(d => d.f());
  // 弹道
  const trollPid = snap.players.find(p => p.faction === 'troll')?.pid;
  for (const s of snap.shots ?? []) {
    const t = Math.min(1, s.age / s.flight), color = effectColors[s.effect] ?? '#bff4ff';
    const te = trollPid ? smooth.get(trollPid) : null;
    const tx = te?.tx ?? s.tx, ty = te?.ty ?? s.ty;
    const px = s.x + (tx - s.x) * t, py = s.y + (ty - 40 - s.y) * t - Math.sin(t * Math.PI) * 25;
    ctx.strokeStyle = color; ctx.lineWidth = s.effect === 'arrow' ? 2 : 4;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(px, py); ctx.stroke();
  }
  // 特效
  for (const e of effects) { e.age += dt; drawEffect(e); }
  effects = effects.filter(e => e.age < (e.life ?? .7));
  ctx.restore();
  // 迷雾（屏幕空间按世界变换绘制，边缘柔化）
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'blur(' + Math.max(4, 6 * zoom) + 'px)';
  ctx.drawImage(fogCanvas, 0, 0, FW, FH, -camera.x * zoom, -camera.y * zoom, FW * 16 * zoom, FH * 16 * zoom);
  ctx.filter = 'none';
  ctx.restore();
  // 营地暖光 + 巨魔营地红光（光照层，lighter 合成）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const c of CAMPS) {
    const x = (c.x - camera.x) * zoom, y = (c.y - camera.y) * zoom;
    if (x < -300 || y < -300 || x > view.w + 300 || y > view.h + 300) continue;
    if (SF.explored[c.y / 16 * FW + c.x / 16 >> 0] !== 1) continue;
    const flick = .82 + Math.sin(now() / 260 + c.x) * .18;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 120 * zoom);
    g.addColorStop(0, `rgba(255,168,82,${.28 * flick})`); g.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = g; ctx.fillRect(x - 130 * zoom, y - 130 * zoom, 260 * zoom, 260 * zoom);
  }
  ctx.restore();
  // 夜晚
  if (snap.night) { ctx.fillStyle = '#15235055'; ctx.fillRect(0, 0, view.w, view.h); }
  // 雪花（屏幕空间）
  const snowN = Math.floor(snow.length * parseFloat($('opt-snow').value));
  for (let i = 0; i < snowN; i++) {
    const f = snow[i];
    f.x += Math.sin(now / 900 + i) * 12 * dt + 8 * dt; f.y += f.v * dt;
    if (f.y > view.h) { f.y = -4; f.x = Math.random() * view.w; }
    if (f.x > view.w) f.x = 0;
    ctx.fillStyle = '#ebf5f5' + (i % 3 ? '44' : '88');
    ctx.fillRect(f.x % view.w, f.y, f.d, f.d * 1.4);
  }
  // 暗角
  const vg = ctx.createRadialGradient(view.w * .5, view.h * .45, view.h * .3, view.w * .5, view.h * .5, view.w * .72);
  vg.addColorStop(0, '#00121b00'); vg.addColorStop(1, '#04131a90');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, view.w, view.h);
  drawMinimap();
  if ((frameCount & 7) === 0) hud(snap);
}
function drawMinimap() {
  if (!miniTerrain || !snap) return;
  const mc = $('minimap').getContext('2d');
  mc.clearRect(0, 0, 224, 126);
  mc.drawImage(miniTerrain, 0, 0);
  const sx = 224 / MAP.w, sy = 126 / MAP.h;
  // 营地（已探索的显示归属）
  for (const c of snap.camps) {
    if (!explored[c.y / 16 * FW + c.x / 16 >> 0]) continue;
    mc.fillStyle = c.claimedBy ? (c.claimedBy === snap.you.pid ? '#7adfbe' : '#e8c887') : '#5d7686';
    mc.fillRect(c.x * sx - 2, c.y * sy - 2, 4, 4);
  }
  // 建筑（服务器只发可见/己方）
  for (const b of snap.buildings) { mc.fillStyle = b.faction === snap.you.faction ? '#9fe8d2' : '#e08573'; mc.fillRect(b.x * sx - 1.5, b.y * sy - 1.5, 3, 3); }
  // 单位
  for (const p of snap.players) if (!p.hidden) { mc.fillStyle = p.faction === snap.you.faction ? '#7adfbe' : '#ff9a7d'; mc.fillRect(p.x * sx - 1.5, p.y * sy - 1.5, 3, 3); }
  mc.fillStyle = '#ffffff'; mc.fillRect(snap.you.x * sx - 2, snap.you.y * sy - 2, 4, 4);
  // 视口框
  mc.strokeStyle = '#e8d29a'; mc.lineWidth = 1;
  mc.strokeRect(camera.x * sx, camera.y * sy, view.w / zoom * sx, view.h / zoom * sy);
}
function drawYou() {
  const e = smooth.get('you'); if (!e) return;
  const you = snap.you;
  drawUnit(e.x, e.y, 'elf', you.faction === 'troll', you.name, you.hp / you.maxHp, you.alive !== false);
}
function drawActor(p, e, isTroll) {
  if (!e) return;
  drawUnit(e.x, e.y, isTroll ? 'troll' : 'elf', isTroll, p.name, p.maxHp ? p.hp / p.maxHp : 1, p.alive);
}
function drawUnit(x, y, kind, isTroll, name, hpRatio, show) {
  if (!show) return;
  const troll = isTroll;
  ctx.fillStyle = '#12202a55';
  ctx.beginPath(); ctx.ellipse(x + 2, y + 2, troll ? 26 : 14, troll ? 10 : 6, 0, 0, 7); ctx.fill();
  const frames = troll ? trollWalkFrames : elfWalkFrames;
  const moving = Math.hypot(smooth.get('you')?.tx - smooth.get('you')?.x ?? 0, 0) > 0;
  const fi = Math.floor(now() / 160) % 4;
  const sheet = troll ? actors : actors, f = frames[fi];
  ctx.save(); ctx.translate(x, y);
  if (troll) ctx.scale(-1, 1);
  const scale = troll ? .39 : .29;
  ctx.drawImage(sheet, f[0], f[1], f[2], f[3], (f[0] - f[4]) * scale, (f[1] - f[5]) * scale, f[2] * scale, f[3] * scale);
  ctx.restore();
  // 血条与名字
  ctx.font = '11px system-ui'; ctx.textAlign = 'center';
  ctx.fillStyle = troll ? '#f0b5a0' : '#bdf0dd'; ctx.fillText(name, x, y + 18);
  const bw = troll ? 46 : 34;
  ctx.fillStyle = '#0c1727d9'; ctx.fillRect(x - bw / 2 - 1, y - (troll ? 100 : 78), bw + 2, 6);
  ctx.fillStyle = hpRatio < .35 ? '#d66351' : '#74c564';
  ctx.fillRect(x - bw / 2, y - (troll ? 99 : 77), Math.max(0, hpRatio) * bw, 4);
}
const now = () => performance.now();
function drawBuilding(b) {
  const [w, h] = sizes[b.type] ?? [90, 100];
  ctx.save();
  ctx.globalAlpha = b.started ? 1 : .4;
  if (b.wreck) ctx.globalAlpha = .5;
  ctx.fillStyle = '#13223050';
  ctx.beginPath(); ctx.ellipse(b.x + 7, b.y + 4, w * .4, 12, 0, 0, 7); ctx.fill();
  if (b.pulse > 0) ctx.translate(Math.sin(b.pulse * 80) * 2, 0);
  if (b.type === 'wall') {
    const frame = wallFrames[Math.min(2, Math.floor(b.level / 6))] ?? wallFrames[0];
    if (frame) {
      const hh = 120 + Math.min(b.level, 12) * 1.4, ww = 82;
      if (b.hp / b.hpMax < .35) ctx.filter = 'brightness(.72) saturate(.6)';
      ctx.drawImage(walls, ...frame, b.x - ww / 2, b.y + 44 - hh, ww, hh);
      ctx.filter = 'none';
    }
  } else {
    const [col, row] = cell[b.type] ?? [0, 0];
    const grown = 1 + Math.min(4, b.level) * .025;
    const hh = h * (b.progress < 1 ? b.progress : 1);
    if (b.type === 'tower' && b.level > 0) ctx.filter = 'hue-rotate(' + ({ arcane: 35, fire: 175, lightning: 285, poison: 240, heal: 235, life: 220 }[b.effect] ?? 0) + 'deg)';
    ctx.drawImage(atlas, col * 512, row * 512, 512, 512, b.x - w * grown / 2, b.y + h * .13 - hh * grown, w * grown, h * grown);
    ctx.filter = 'none';
    if (b.progress < 1) { // 施工脚手架
      ctx.strokeStyle = '#806e4d'; ctx.lineWidth = 2;
      ctx.strokeRect(b.x - w * .4, b.y - h * .5, w * .8, h * .55);
    }
  }
  ctx.restore();
  if (b.shield) { ctx.strokeStyle = '#d2d5ff'; ctx.lineWidth = 2.5; ctx.shadowColor = '#8291ff'; ctx.shadowBlur = 12; ctx.beginPath(); ctx.ellipse(b.x, b.y - 26, 44, 62, 0, 0, 7); ctx.stroke(); ctx.shadowBlur = 0; }
  if (b.progress < 1 || b.upgradeP != null) bar(b.x, b.y - h * .8 - 8, b.upgradeP ?? b.progress, 1, 54, '#d6b769');
  else if (b.hp < b.hpMax) bar(b.x, b.y - h * .8 - 8, b.hp, b.hpMax, 50);
  if (b.type === 'tower' && b.progress === 1) { // 塔顶光点
    const color = effectColors[b.effect] ?? '#79eaff', r = 14 + Math.sin(performance.now() / 300) * 2;
    const g = ctx.createRadialGradient(b.x, b.y - 60, 0, b.x, b.y - 60, r);
    g.addColorStop(0, color + 'aa'); g.addColorStop(1, color + '00');
    ctx.fillStyle = g; ctx.fillRect(b.x - 18, b.y - 80, 36, 36);
  }
}
function bar(x, y, v, max, w, color) {
  ctx.fillStyle = '#0c1727d9'; ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 7);
  ctx.fillStyle = color ?? (v / max < .35 ? '#d66351' : '#74c564');
  ctx.fillRect(x - w / 2, y, Math.max(0, Math.min(1, v / max)) * w, 4);
}
function drawEffect(e) {
  const a = 1 - e.age / (e.life ?? .7);
  ctx.save(); ctx.globalAlpha = Math.max(0, a);
  const kind = e.fx ?? e.kind;
  if (kind === 'foot') { ctx.fillStyle = '#5c768633'; ctx.beginPath(); ctx.ellipse(e.x + (e.side ? 4 : -4), e.y, 2.5, 4.5, .6, 0, 7); ctx.fill(); }
  else if (['command', 'blink', 'complete', 'cast'].includes(kind)) {
    ctx.strokeStyle = ['blink', 'cast'].includes(kind) ? '#82dfff' : '#e5cb87'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(e.x, e.y, 12 + a * 34, (12 + a * 34) * .5, 0, 0, 7); ctx.stroke();
  } else if (kind === 'muzzle') { ctx.fillStyle = effectColors[e.color] ?? '#dcf6ff'; ctx.beginPath(); ctx.arc(e.x, e.y, 8 * a, 0, 7); ctx.fill(); }
  else if (kind === 'healbeam') { ctx.strokeStyle = '#8eeeaf'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.tx, e.ty); ctx.stroke(); }
  else if (kind === 'damage') { ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#1e1d25'; ctx.fillStyle = '#edb094'; ctx.strokeText(e.text, e.x, e.y - e.age * 22); ctx.fillText(e.text, e.x, e.y - e.age * 22); }
  else {
    const color = effectColors[kind] ?? statusColors[kind] ?? (kind === 'repair' ? '#a4e3bc' : kind === 'debris' ? '#8d9fa8' : '#e6c987');
    if (['fire', 'frost', 'chaos', 'impact', 'spark', 'shield', 'root', 'silence', 'chaos', 'reveal'].includes(kind)) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(e.x, e.y, 6 + a * 26, (6 + a * 26) * .55, 0, 0, 7); ctx.stroke(); }
    for (let i = 0; i < 7; i++) { const ang = i * .9, r = a * 26; ctx.fillStyle = color; ctx.fillRect(e.x + Math.cos(ang) * r, e.y + Math.sin(ang) * r * .6 - a * 10, 2, 2); }
  }
  ctx.restore();
}

// ---------- 启动 ----------
$('nickname').value = myName;
// 调试句柄（自动化验证用）
window.SF = { get assetsReady() { return assetsReady; }, get snap() { return snap; }, get chunks() { return chunks; }, explored, get camera() { return camera; }, get ws() { return ws; }, get effects() { return effects; }, cmd, get mode() { return mode; }, set mode(v) { mode = v; } };
// ?room=XXXX&token=… 直接恢复会话（邀请链接/自动化验证用）
if (qs.get('room') && qs.get('token')) { roomCode = qs.get('room').toUpperCase(); myToken = qs.get('token'); }
connect(roomCode && myToken);
