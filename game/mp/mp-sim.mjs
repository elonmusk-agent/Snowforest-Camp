// 雪林营地 · 多人对局模拟：服务器权威，无 DOM 依赖，1 名玩家巨魔 vs 1-5 名玩家精灵。
// 复用 classic-data/simulation 的等级、技能与伤害公式；地图、阵营归属与胜负为本模块实现。
import { LEVELS, INDEX, SKILLS, damageAfterArmor, WORKERS } from '../simulation.mjs';
import { MAP, CAMPS, campSlots, terrainFree, TROLL_SPAWN, ELF_SPAWN, inTrollShop } from './map-data.mjs';
import { ALL_ITEMS, itemStats, SHOP_LIST } from './mp-items.mjs';

export const CFG = {
  prepTime: 90, maxTime: 1800, growthInterval: 90, disconnectGrace: 120,
  tick: 1 / 20, snapshotHz: 10, bagSize: 6, startGold: 30, startWood: 0,
  elfBaseHp: 150, elfBaseSpeed: 150, trollBaseSpeed: 105, claimRange: 150,
  campShopRange: 140, attackRange: 62, sellRatio: 1, // sell 价已写死在物品表
};
const cell = MAP.cell, width = Math.ceil(MAP.w / cell), height = Math.ceil(MAP.h / cell), gridSize = width * height;
export const footprint = type => ({ house: 26, tower: 22, grove: 26, wall: 32, tech: 25, lab: 25, guild: 25, mine: 25 })[type];
const buildTime = type => ({ house: 4, wall: 5, tower: 6, grove: 6, tech: 5, lab: 5, guild: 5, mine: 5 })[type];
export const UPGRADE_TIME = 2.5;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const info = b => LEVELS[b.type][b.level];
const centerOf = id => ({ x: id % width * cell + 8, y: Math.floor(id / width) * cell + 8 });
const cellAt = p => Math.floor(p.y / cell) * width + Math.floor(p.x / cell);

// ---------- 视野网格：每步为两个阵营盖章圆形视野；explored 单调保留 ----------
function makeFog() { return { elf: new Uint8Array(gridSize), troll: new Uint8Array(gridSize), explored: { elf: new Uint8Array(gridSize), troll: new Uint8Array(gridSize) } }; }
function stamp(grid, x, y, r) {
  const r2 = r * r, x0 = Math.max(0, Math.floor((x - r) / cell)), x1 = Math.min(width - 1, Math.ceil((x + r) / cell)), y0 = Math.max(0, Math.floor((y - r) / cell)), y1 = Math.min(height - 1, Math.ceil((y + r) / cell));
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
    const dx = gx * cell + 8 - x, dy = gy * cell + 8 - y;
    if (dx * dx + dy * dy <= r2) grid[gy * width + gx] = 1;
  }
}
function updateFog(s) {
  const g = s.fog;
  for (const team of ['elf', 'troll']) g[team].fill(0);
  for (const p of Object.values(s.players)) {
    if (!p.alive) continue;
    const team = p.faction, st = itemStats(p.items);
    if (team === 'elf') stamp(g.elf, p.x, p.y, 260 + st.sight);
    else stamp(g.troll, p.x, p.y, 300);
  }
  for (const b of s.buildings) {
    if (b.hp <= 0 || !b.started) continue;
    if (b.faction === 'elf') { stamp(g.elf, b.x, b.y, b.type === 'tower' && b.progress === 1 ? 320 : 200); if (b.addon?.id === 'n001') stamp(g.elf, b.x, b.y, 350); }
  }
  for (const w of s.wards) if (w.until > s.time) stamp(g.elf, w.x, w.y, 350);
  for (const team of ['elf', 'troll']) {
    const ex = g.explored[team]; for (let i = 0; i < gridSize; i++) if (g[team][i]) ex[i] = 1;
  }
}
export const cellVisible = (s, team, x, y) => s.fog[team][cellAt({ x, y })] === 1;
function detectorNear(s, x, y) {
  for (const p of Object.values(s.players)) {
    if (p.faction !== 'elf' || !p.alive) continue;
    const sight = itemStats(p.items).sight;
    if (sight > 0 && dist(p, { x, y }) < Math.max(350, sight)) return true;
  }
  for (const w of s.wards) if (w.until > s.time && dist(w, { x, y }) < 350) return true;
  for (const b of s.buildings) if (b.faction === 'elf' && b.hp > 0 && b.progress === 1 && b.addon?.id === 'n001' && dist(b, { x, y }) < 350) return true;
  return false;
}

// ---------- 地形与寻路：与单机同款的 BFS + 直线合并，网格换成本图 ----------
function staticGround(x, y) { return terrainFree(x, y); }
export function free(s, x, y) {
  if (!staticGround(x, y)) return false;
  for (const b of s.buildings) {
    if (b.hp <= 0 || !b.started) continue;
    if (b.type === 'wall') { if (Math.abs(x - b.x) < 40 && Math.abs(y - b.y) < 58) return false; }
    else if (Math.hypot(x - b.x, y - b.y) < footprint(b.type) + 13) return false;
  }
  return true;
}
function clearLine(s, a, b) {
  const steps = Math.ceil(dist(a, b) / 5);
  for (let i = 1; i <= steps; i++) if (!free(s, a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps)) return false;
  return true;
}
export function findPath(s, from, to) {
  if (!free(s, to.x, to.y)) return null;
  if (clearLine(s, from, to)) return [{ x: to.x, y: to.y }];
  const start = cellAt(from), goal = cellAt(to);
  const parents = new Int32Array(gridSize).fill(-1), queue = new Int32Array(gridSize), valid = new Int8Array(gridSize);
  let head = 0, tail = 0;
  queue[tail++] = start; parents[start] = start;
  while (head < tail && parents[goal] === -1) {
    const id = queue[head++], x = id % width, y = Math.floor(id / width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (parents[next] !== -1) continue;
      if (!valid[next]) { const p = centerOf(next); valid[next] = free(s, p.x, p.y) ? 1 : -1; }
      if (valid[next] < 0) continue;
      parents[next] = id; queue[tail++] = next;
    }
  }
  if (parents[goal] < 0) return null;
  const points = [{ x: to.x, y: to.y }];
  for (let at = goal; at !== start; at = parents[at]) points.push(centerOf(at));
  points.reverse();
  const path = []; let previous = from, i = 0;
  while (i < points.length) {
    let next = i;
    while (next + 1 < points.length && clearLine(s, previous, points[next + 1])) next++;
    path.push(points[next]); previous = points[next]; i = next + 1;
  }
  return path;
}
function route(s, unit, dest) { const path = findPath(s, unit, dest); if (!path) return false; unit.goal = { ...dest }; unit.path = path; unit.nav = s.nav; return true; }
function stepUnit(s, u, dt, speed) {
  u.moving = false;
  if (!u.path?.length) return;
  if (u.nav !== s.nav) { const path = findPath(s, u, u.goal); u.nav = s.nav; if (!path) { u.path = []; return; } u.path = path; }
  const p = u.path[0], length = dist(u, p), move = Math.min(speed * dt, length);
  if (length < .01) { u.path.shift(); return; }
  const nx = u.x + (p.x - u.x) / length * move, ny = u.y + (p.y - u.y) / length * move;
  if (!clearLine(s, u, { x: nx, y: ny })) { u.path = []; return; }
  if (Math.abs(nx - u.x) > .1) u.facing = nx > u.x ? 1 : -1;
  u.x = nx; u.y = ny; u.moving = true; u.anim += dt; u.step += move; u.walkDistance = (u.walkDistance || 0) + move;
  if (u.step >= 26) { u.step = 0; fx(s, u.faction === 'troll' ? 'all' : 'elf', 'foot', u.x, u.y, { life: 2.5, side: Math.floor(u.anim * 7) % 2 }); }
  if (move >= length - .01) u.path.shift();
}
function fx(s, team, kind, x, y, extra = {}) { s.events.push({ kind: 'fx', fx: kind, x, y, team, ...extra }); }
function notify(s, text, opt = {}) { s.events.push({ kind: 'msg', text, team: opt.team ?? 'all', pid: opt.pid, t: s.time }); }
const err = (s, p, text) => notify(s, text, { team: p.faction === 'troll' ? 'troll' : 'elf', pid: p.pid });

// ---------- 开局 ----------
function actor(pid, name, faction, x, y) {
  return { pid, name, faction, x, y, hp: 1, maxHp: 1, path: [], goal: null, order: null, orders: [], moving: false, action: 'idle', facing: faction === 'troll' ? -1 : 1, anim: 0, step: 0, walkDistance: 0, workPhase: 0, mana: 200, cooldowns: {}, blink: 0, casting: 0, invisible: 0, statuses: {}, spellCooldowns: {}, connected: true, lastSeen: 0, hit: 0, attackPeriod: 1.2 };
}
export function createMatch(roster, cfgOverride = {}) {
  const cfg = { ...CFG, ...cfgOverride };
  const s = {
    cfg, time: 0, nav: 1, phase: 'prep', result: '', players: {}, buildings: [], wards: [], projectiles: [], events: [], nextId: 1,
    fog: makeFog(), encounter: { tier: 0, growthAt: cfg.prepTime + cfg.growthInterval }, camps: {}, stats: { upgrades: 0, spells: 0, purchases: 0 },
  };
  for (const c of CAMPS) s.camps[c.id] = { id: c.id, claimedBy: null };
  let ei = 0;
  for (const r of roster) {
    const base = r.faction === 'troll'
      ? { x: TROLL_SPAWN.x, y: TROLL_SPAWN.y + 40 }
      : { x: ELF_SPAWN.x + (ei % 3) * 46 - 46, y: ELF_SPAWN.y + Math.floor(ei / 3) * 50 - 40 };
    const p = { ...actor(r.pid, r.name, r.faction, base.x, base.y), gold: cfg.startGold, wood: cfg.startWood, items: [], camp: null, alive: true, bagSize: cfg.bagSize, uses: {} };
    if (r.faction === 'troll') { s.troll = p; Object.assign(p, trollStats(s)); p.hp = p.maxHp; }
    else { ei++; p.hp = p.maxHp = cfg.elfBaseHp; }
    s.players[p.pid] = p;
  }
  updateFog(s);
  return s;
}
export function trollStats(s) {
  const t = s.troll, tier = s.encounter?.tier ?? 0, st = itemStats(t?.items ?? []);
  const stats = { maxHp: Math.round(500 * Math.pow(1.25, tier)) + st.hp, attack: Math.round(9 * Math.pow(1.17, tier)) + st.attack, armor: tier + st.armor, regen: st.regen, haste: Math.min(1.2, Math.min(.6, tier * .035) + st.haste), move: CFG.trollBaseSpeed + Math.min(130, st.move) };
  return stats;
}
const refreshTroll = (s, keepRatio = true) => {
  const t = s.troll, ratio = keepRatio && t.maxHp ? t.hp / t.maxHp : 1, old = t.maxHp;
  Object.assign(t, trollStats(s));
  t.hp = keepRatio ? Math.max(1, Math.round(ratio * t.maxHp)) : t.maxHp;
  if (!keepRatio && old === 1) t.hp = t.maxHp;
};

// ---------- 移动 / 占领 / 建造 / 升级 / 修理 ----------
export function moveCmd(s, p, x, y) {
  if (!canAct(s, p)) return '当前无法行动';
  if (s.phase === 'prep' && p.faction === 'troll' && Math.hypot(x - TROLL_SPAWN.x, y - TROLL_SPAWN.y) > TROLL_SPAWN.r) return '准备期结束前巨魔只能在出生区活动';
  x = clamp(Math.round(x), 8, MAP.w - 8); y = clamp(Math.round(y), 8, MAP.h - 8);
  if (!free(s, x, y)) return '树林、冰湖和建筑不能穿行';
  if (!route(s, p, { x, y })) return '通路被封住了；精灵可用闪烁越过墙体';
  p.order = null; p.orders = []; p.action = 'idle';
  fx(s, p.faction === 'troll' ? 'all' : 'elf', 'command', x, y, { life: .9 });
  return '';
}
function canAct(s, p) { return s.phase !== 'ended' && p.alive && p.connected; }
export function claimCamp(s, p) {
  if (!canAct(s, p) || p.faction !== 'elf') return '只有精灵能占领营地';
  if (p.camp) return '你已占领营地';
  const camp = CAMPS.find(c => dist(p, c) <= CFG.claimRange);
  if (!camp) return '需走到营地中心 ' + CFG.claimRange + ' 范围内才能占领';
  if (s.camps[camp.id].claimedBy) return '营地已被队友占领';
  s.camps[camp.id].claimedBy = p.pid; p.camp = camp.id;
  notify(s, p.name + ' 占领了' + camp.name);
  fx(s, 'elf', 'complete', camp.x, camp.y, { life: 1.2 });
  return '';
}
function approach(s, u, b) {
  const points = b.type === 'wall'
    ? [{ x: b.x - 64, y: b.y }, { x: b.x + 64, y: b.y }]
    : Array.from({ length: 12 }, (_, i) => ({ x: b.x + Math.cos(i * Math.PI / 6) * (footprint(b.type) + 31), y: b.y + Math.sin(i * Math.PI / 6) * (footprint(b.type) + 31) }));
  points.sort((a, c) => dist(u, a) - dist(u, c));
  for (const p of points) { const path = findPath(s, u, p); if (path) return { point: p, path }; }
  return null;
}
function assignWork(s, p, b, kind) {
  if (p.order?.id === b.id && p.order.kind === kind) return '';
  const arrival = approach(s, p, b);
  if (!arrival) return '无法靠近建筑，请先恢复通路';
  if (kind === 'repair' || p.order?.kind === 'repair') stopCmd(s, p, true);
  else if (p.order) { if (!p.orders.some(o => o.id === b.id && o.kind === kind)) p.orders.push({ kind, id: b.id }); return ''; }
  p.order = { kind, id: b.id, point: arrival.point };
  p.workPhase = 0; p.goal = arrival.point; p.path = arrival.path; p.nav = s.nav;
  return '';
}
export function buildCmd(s, p, type, x, y) {
  if (!canAct(s, p) || p.faction !== 'elf') return '只有精灵能建造';
  if (!LEVELS[type]) return '未知建筑';
  if (!p.camp) return '先占领一处营地才能建造';
  const camp = CAMPS.find(c => c.id === p.camp);
  const slot = campSlots(camp, type).map(d => ({ ...d })).sort((a, b) => dist(a, { x, y }) - dist(b, { x, y }))[0];
  if (dist(slot, { x, y }) > 110) return '请点击' + camp.name + '的建筑基座';
  const alive = s.buildings.filter(b => b.hp > 0);
  let error = '';
  if (type === 'wall') {
    if (alive.some(b => b.faction === 'elf' && b.camp === p.camp && b.type === 'wall')) error = '每个营地同时只能有一堵主墙';
    else if ([...Object.values(s.players).filter(u => u.alive), ...Object.values(s.players).flatMap(u => u.workers ?? [])].some(u => Math.abs(u.x - slot.x) < 45 && Math.abs(u.y - slot.y) < 65)) error = '入口有人，暂时不能封墙';
  } else if (type !== 'tower' && alive.some(b => b.owner === p.pid && b.type === type)) error = '这类建筑同时只能有一座';
  else if (type === 'tower' && alive.filter(b => b.owner === p.pid && b.type === 'tower').length >= 3) error = '每位精灵最多三座防御塔';
  if (!error && alive.some(b => dist(slot, b) < footprint(type) + footprint(b.type) + 22)) error = '建筑占地重叠，请留出行走空间';
  if (error) return error;
  const price = LEVELS[type][0];
  const missing = requirement(s, p, price);
  if (missing) return missing;
  if (p.gold < price.gold || p.wood < price.wood) return '资源不足';
  const b = { id: 'b' + s.nextId++, owner: p.pid, faction: 'elf', camp: p.camp, type, level: 0, x: slot.x, y: slot.y, hp: 1, started: false, progress: 0, fire: 0, pulse: 0, upgrade: null, addon: null, wreck: false };
  const e2 = assignWork(s, p, b, 'build');
  if (e2) return e2;
  p.gold -= price.gold; p.wood -= price.wood;
  s.buildings.push(b);
  fx(s, 'elf', 'command', b.x, b.y, { life: .8 });
  notify(s, p.order.id === b.id ? '精灵正在前往施工位置' : info(b).name + '已加入施工队列', { pid: p.pid, team: 'elf' });
  return '';
}
export function requirement(s, p, data) {
  const owned = new Set(s.buildings.filter(b => b.owner === p.pid && b.hp > 0 && b.progress === 1).map(b => b.type + b.level));
  const missing = (data.requires ?? []).filter(id => { const w = INDEX[id]; return w && !owned.has(w.type + w.level); });
  return missing.length ? '需要：' + missing.map(id => INDEX[id] ? LEVELS[INDEX[id].type][INDEX[id].level].name : id).join('、') : '';
}
export function upgradeOptionsOf(s, p, b) {
  const next = LEVELS[b.type][b.level + 1];
  const ids = b.type === 'mine' && next ? [next.id] : info(b).next ?? [];
  return ids.filter(id => INDEX[id]?.type === b.type && INDEX[id].level === b.level + 1).map(id => LEVELS[b.type][b.level + 1]);
}
export function upgradeCmd(s, p, bid, targetId) {
  const b = s.buildings.find(v => v.id === bid);
  if (!canAct(s, p) || p.faction !== 'elf') return '当前无法升级';
  if (!b || b.owner !== p.pid) return '只能升级自己的建筑';
  if (b.hp <= 0 || b.wreck) return '建筑已损毁';
  if (b.progress < 1) return '建筑建成后才能升级';
  if (b.upgrade) return '正在升级中';
  const options = upgradeOptionsOf(s, p, b);
  const next = options.find(d => d.id === targetId) ?? (!targetId ? options[0] : null);
  if (!next) return '没有该升级选择';
  const missing = requirement(s, p, next);
  if (missing) return missing;
  if (p.gold < next.gold || p.wood < next.wood) return '升级资源不足';
  p.gold -= next.gold; p.wood -= next.wood;
  b.upgrade = { progress: 0, target: INDEX[next.id].level };
  fx(s, 'elf', 'spark', b.x, b.y - 25, { life: .7 });
  notify(s, '开始升级：' + next.name, { pid: p.pid, team: 'elf' });
  return '';
}
export function repairCmd(s, p, bid) {
  const b = s.buildings.find(v => v.id === bid);
  if (!canAct(s, p) || p.faction !== 'elf') return '当前无法修理';
  if (!b) return '请先选中建筑';
  if (b.faction !== 'elf') return '只能修理精灵建筑';
  if (b.owner !== p.pid && b.type !== 'wall') return '只能协助修理队友的主墙';
  if (b.wreck || b.hp <= 0) return '建筑已损毁';
  if (b.progress < 1) return assignWork(s, p, b, 'build');
  if (b.type !== 'wall') return '墙体之外的建筑不必手工修理';
  return assignWork(s, p, b, 'repair');
}
export function stopCmd(s, p, silent = false) {
  p.path = []; p.goal = null; p.order = null; p.orders = []; p.action = 'idle';
  if (!silent) notify(s, '已停止当前指令', { pid: p.pid, team: p.faction === 'troll' ? 'troll' : 'elf' });
  return '';
}
export function blinkCmd(s, p, x, y) {
  if (!canAct(s, p) || p.faction !== 'elf') return '当前无法闪烁';
  if (p.blink > 0) return '闪烁冷却中';
  if (dist(p, { x, y }) > 250) return '闪烁距离不能超过 250';
  if (!free(s, x, y)) return '落点被地形或建筑占据';
  fx(s, 'elf', 'blink', p.x, p.y, { life: .8 });
  stopCmd(s, p, true); p.x = x; p.y = y; p.blink = 19;
  fx(s, 'elf', 'blink', x, y, { life: .8 });
  return '';
}

// ---------- 精灵技能（复用单机数据） ----------
export function castSkillCmd(s, p, key, x, y) {
  if (!canAct(s, p) || p.faction !== 'elf') return '当前无法施法';
  const skill = SKILLS[key];
  if (!skill) return '未知技能';
  if ((p.cooldowns[key] ?? 0) > 0) return '技能冷却中';
  if (p.mana < skill.mana) return '魔法不足';
  const trollSeen = s.troll.alive && cellVisible(s, 'elf', s.troll.x, s.troll.y) && (s.troll.invisible <= 0 || detectorNear(s, s.troll.x, s.troll.y));
  if (key === 'shield') {
    const wall = s.buildings.find(b => b.owner === p.pid && b.type === 'wall' && b.hp > 0 && b.started);
    if (!wall) return '没有可保护的主墙';
    if (dist(p, wall) > 700) return '目标不在施法范围内';
    p.mana -= skill.mana; p.cooldowns[key] = skill.cd; p.casting = .45;
    wall.shield = 10; fx(s, 'elf', 'shield', wall.x, wall.y - 25, { life: 1 });
  } else if (key === 'root' || key === 'silence') {
    if (!s.troll.alive) return '没有活着的巨魔';
    if (!trollSeen) return '巨魔不可见或正在隐身，先用侦察守卫';
    if (dist(p, s.troll) > 500) return '目标不在施法范围内';
    p.mana -= skill.mana; p.cooldowns[key] = skill.cd; p.casting = .45;
    s.troll.statuses[key] = skill.duration; fx(s, 'all', key, s.troll.x, s.troll.y - 25, { life: 1 });
  } else if (key === 'ward') {
    const tx = clamp(Math.round(x ?? p.x + 40), 8, MAP.w - 8), ty = clamp(Math.round(y ?? p.y - 20), 8, MAP.h - 8);
    if (dist(p, { x: tx, y: ty }) > 500) return '守卫放置距离不能超过 500';
    p.mana -= skill.mana; p.cooldowns[key] = skill.cd;
    s.wards.push({ id: 'w' + s.nextId++, pid: p.pid, x: tx, y: ty, until: s.time + 200 });
    fx(s, 'elf', 'cast', p.x, p.y - 22, { life: .6 });
  } else if (key === 'stars') {
    p.mana -= skill.mana; p.cooldowns[key] = skill.cd;
    s.night = !s.night;
    notify(s, skill.name + '：夜间光照切换', { team: 'elf' });
  }
  s.stats.spells++;
  notify(s, skill.name + '已释放', { pid: p.pid, team: 'elf' });
  return '';
}
export function recruitCmd(s, p, tier = 0) {
  if (!canAct(s, p) || p.faction !== 'elf') return '当前无法训练';
  const data = WORKERS[tier];
  if (!data) return '无此单位';
  const guild = s.buildings.find(b => b.owner === p.pid && b.type === 'guild' && b.hp > 0 && b.progress === 1);
  if (!guild) return '先建工人行会';
  if ((p.workers?.length ?? 0) >= 12) return '修理工上限 12';
  if (p.gold < data.gold) return '资源不足';
  p.gold -= data.gold;
  p.workers = p.workers ?? [];
  const w = { ...actor('w' + s.nextId++, p.name + '·修理工', 'elf', guild.x + 40, guild.y), ownerPid: p.pid, worker: true, hp: 80, maxHp: 80, tier };
  p.workers.push(w);
  return '';
}

// ---------- 物品：购买 / 出售 / 使用（双方，服务器权威） ----------
export function buyCmd(s, p, id) {
  if (!canAct(s, p)) return '当前无法购买';
  const d = ALL_ITEMS[id];
  if (!d || d.faction !== p.faction) return '此商品不属于你的阵营';
  if (p.faction === 'troll') {
    if (s.phase === 'prep') return '对局开始后才能购买';
    if (!inTrollShop(p)) return '巨魔需要回到出生补给区购买';
  } else {
    if (!p.camp) return '先占领营地才能购买';
    const camp = CAMPS.find(c => c.id === p.camp);
    if (dist(p, camp) > CFG.campShopRange) return '需要回到自己的营地商店';
  }
  if (p.items.length >= p.bagSize && !d.wood) return '背包已满';
  if (d.unique && p.items.includes(id)) return '该装备不可重复购买';
  if (p.gold < d.gold || p.wood < (d.wood ?? 0)) return '资源不足';
  p.gold -= d.gold; p.wood -= (d.wood ?? 0);
  p.items.push(id);
  if (d.uses) p.uses[id] = (p.uses[id] ?? 0) + d.uses;
  if (p.faction === 'troll') refreshTroll(s);
  s.stats.purchases++;
  notify(s, p.name + ' 购买了 ' + d.name, { team: p.faction === 'troll' ? 'troll' : 'elf' });
  return '';
}
export function sellCmd(s, p, id) {
  if (!canAct(s, p)) return '当前无法出售';
  const i = p.items.indexOf(id);
  if (i < 0) return '背包中没有该物品';
  const d = ALL_ITEMS[id];
  if (p.faction === 'troll' && !inTrollShop(p)) return '巨魔需要回到出生补给区出售';
  if (p.faction === 'elf') { if (!p.camp) return '未占领营地'; const camp = CAMPS.find(c => c.id === p.camp); if (dist(p, camp) > CFG.campShopRange) return '需要回到自己的营地商店'; }
  p.items.splice(i, 1);
  delete p.uses[id];
  p.gold += d.sell;
  if (p.faction === 'troll') refreshTroll(s);
  return '';
}
export function useItemCmd(s, p, id, x, y) {
  if (!canAct(s, p)) return '当前无法使用';
  const i = p.items.indexOf(id), d = ALL_ITEMS[id];
  if (i < 0 || d.kind !== 'active') return '没有可用的主动物品';
  if ((p.cooldowns['item:' + id] ?? 0) > 0) return '物品冷却中';
  if (d.uses && (p.uses[id] ?? 0) <= 0) return '使用次数已耗尽';
  if (d.castRange && dist(p, { x, y }) > d.castRange) return '距离不足';
  if (d.effect === 'ward') { s.wards.push({ id: 'w' + s.nextId++, pid: p.pid, x, y, until: s.time + 200 }); }
  else if (d.effect === 'shield') {
    const wall = s.buildings.find(b => b.owner === p.pid && b.type === 'wall' && b.hp > 0 && b.started);
    if (!wall) return '没有可保护的主墙';
    wall.shield = 6; fx(s, 'elf', 'shield', wall.x, wall.y - 25, { life: 1 });
  } else if (d.effect === 'heal') { p.hp = Math.min(p.maxHp, p.hp + d.heal); fx(s, 'elf', 'healbeam', p.x, p.y - 40, { tx: p.x, ty: p.y - 10, life: .6 }); }
  if (d.uses) { p.uses[id]--; if (p.uses[id] <= 0) { p.items.splice(p.items.indexOf(id), 1); delete p.uses[id]; } }
  else p.cooldowns['item:' + id] = d.cd;
  return '';
}

// ---------- 巨魔玩家指令 ----------
export function trollAttackCmd(s, p, targetId) {
  if (!canAct(s, p) || p.faction !== 'troll') return '当前无法攻击';
  if (s.phase !== 'live') return '对局尚未开始';
  const b = s.buildings.find(v => v.id === targetId);
  const elf = Object.values(s.players).find(v => v.pid === targetId && v.faction === 'elf' && v.alive);
  if (!b && !elf) return '目标不存在';
  if (b && (b.hp <= 0 || !b.started)) return '目标不可攻击';
  p.order = { kind: 'attack', target: targetId };
  return '';
}
export function trollSkillCmd(s, p, key) {
  if (!canAct(s, p) || p.faction !== 'troll') return '当前无法施法';
  if (p.statuses.silence > 0) return '被沉默，无法施法';
  if ((p.spellCooldowns[key] ?? 0) > s.time) return '技能冷却中';
  if (key === 'invisible') { p.invisible = 15; p.spellCooldowns[key] = s.time + 45; }
  else if (key === 'teleport') { p.x = TROLL_SPAWN.x; p.y = TROLL_SPAWN.y; p.path = []; p.order = null; p.spellCooldowns[key] = s.time + 45; fx(s, 'all', 'blink', p.x, p.y, { life: .8 }); }
  else if (key === 'reveal') { fx(s, 'troll', 'reveal', ELF_SPAWN.x, ELF_SPAWN.y, { life: 5 }); p.spellCooldowns[key] = s.time + 60; }
  else return '未知技能';
  fx(s, 'all', 'cast', p.x, p.y - 22, { life: .6 });
  return '';
}
export function trollGrowth(s) {
  s.encounter.tier++;
  s.encounter.growthAt = s.time + s.cfg.growthInterval;
  refreshTroll(s);
  fx(s, 'all', 'chaos', s.troll.x, s.troll.y - 35, { life: 1.6 });
  notify(s, '巨魔强化至 ' + (s.encounter.tier + 1) + ' 阶：攻击、生命与护甲提升');
}

// ---------- 主循环 ----------
function hurtBuilding(s, b, damage) {
  if (b.shield > 0) return 0;
  const actual = Math.min(b.hp, damageAfterArmor(damage, info(b).armor));
  b.hp -= actual; b.pulse = .22;
  if (!b.wreck && b.started) { s.troll.gold += Math.round(actual); } // 攻墙伤害转为巨魔金币；残骸无收益
  fx(s, 'all', 'damage', b.x, b.y - 40, { text: '−' + Math.round(actual), life: .8 });
  if (b.hp <= 0) { b.hp = 0; s.nav++; fx(s, 'all', 'debris', b.x, b.y, { life: 1.3 }); notify(s, info(b).name + '被摧毁', { team: 'elf' }); }
  return actual;
}
function trollTick(s, dt) {
  const t = s.troll;
  if (!t.alive) return;
  t.hit = Math.max(0, t.hit - dt);
  for (const k in t.statuses) t.statuses[k] = Math.max(0, t.statuses[k] - dt);
  t.invisible = Math.max(0, t.invisible - dt);
  if (t.statuses.poison > 0) t.hp = Math.max(0, t.hp - dt * 40);
  t.hp = Math.min(t.maxHp, t.hp + dt * t.regen);
  if (t.statuses.root > 0) { t.moving = false; t.action = 'idle'; return; }
  const order = t.order;
  if (order?.kind === 'attack') {
    const b = s.buildings.find(v => v.id === order.target && v.hp > 0 && v.started);
    const elf = Object.values(s.players).find(v => v.pid === order.target && v.faction === 'elf' && v.alive);
    const target = b ?? elf;
    if (!target) { t.order = null; return; }
    const reach = b ? footprint(b.type) + CFG.attackRange : CFG.attackRange;
    if (dist(t, target) > reach) {
      t.action = 'idle';
      if (!t.path.length || t.nav !== s.nav || !t.goal || dist(t.goal, { x: target.x, y: target.y }) > 40) {
        // 目标点是建筑边缘（朝向巨魔一侧），中心点不可站立
        const side = Math.sign(t.x - target.x || 1);
        const candidates = [
          { x: target.x + side * (reach - 6), y: target.y },
          { x: target.x + side * (reach - 6), y: target.y - 50 },
          { x: target.x + side * (reach - 6), y: target.y + 50 },
          { x: target.x - side * (reach - 6), y: target.y },
        ];
        let ok = false;
        for (const c of candidates) { if (route(s, t, c)) { ok = true; break; } }
        if (!ok) { t.order = null; err(s, t, '目标无法抵达'); }
      }
      stepUnit(s, t, dt, t.move);
    } else {
      t.path = []; t.action = 'attack'; t.anim += dt;
      if (t.hit <= 0) {
        t.hit = t.attackPeriod = 1.2 / (1 + t.haste);
        if (b) hurtBuilding(s, b, t.attack);
        else {
          const dmg = damageAfterArmor(t.attack, 0);
          elf.hp = Math.max(0, elf.hp - dmg);
          fx(s, 'all', 'damage', elf.x, elf.y - 50, { text: '−' + Math.round(dmg), life: .8 });
          fx(s, 'all', 'impact', elf.x, elf.y - 20, { life: .5 });
          if (elf.hp <= 0) eliminate(s, elf, t);
        }
      }
    }
  } else stepUnit(s, t, dt, t.move);
}
function eliminate(s, elf, killer) {
  elf.alive = false; elf.hp = 0; stopCmd(s, elf, true);
  for (const b of s.buildings) if (b.owner === elf.pid) { b.wreck = true; }
  s.nav++;
  notify(s, '精灵 ' + elf.name + ' 被巨魔淘汰');
  fx(s, 'all', 'debris', elf.x, elf.y, { life: 1.2 });
}
function workTick(s, p, dt) {
  const order = p.order;
  if (!order) return;
  const b = s.buildings.find(v => v.id === order.id && v.hp > 0);
  if (!b) { nextWork(s, p); return; }
  if (dist(p, order.point) > 5) {
    if (!p.path.length && !route(s, p, order.point)) { nextWork(s, p); err(s, p, '施工位置的通路被阻挡'); }
    return;
  }
  p.action = order.kind; p.anim += dt; p.facing = b.x > p.x ? 1 : -1;
  const st = itemStats(p.items), boost = 1 + (st.repair || 0);
  if (order.kind === 'build') {
    if (!b.started) { b.started = true; b.hp = info(b).hp * .15; s.nav++; }
    const delta = Math.min(dt * boost / buildTime(b.type), 1 - b.progress);
    b.progress += delta; b.hp = Math.min(info(b).hp, b.hp + info(b).hp * .85 * delta);
    if (Math.floor((p.workPhase) * 6) % 4 === 2) fx(s, 'elf', 'spark', b.x - 10, b.y - 25, { life: .5 });
    if (b.progress >= 1 - 1e-7) { b.progress = 1; nextWork(s, p); fx(s, 'elf', 'complete', b.x, b.y, { life: 1 }); notify(s, info(b).name + '建造完成', { pid: p.pid, team: 'elf' }); }
  } else {
    const amount = Math.min(dt * 28 * boost * Math.sqrt(info(b).hp / 50), info(b).hp - b.hp);
    b.hp += amount;
    if (Math.floor((p.workPhase) * 6) % 4 === 2) fx(s, 'elf', 'repair', b.x - 10, b.y - 25, { life: .5 });
  }
  p.workPhase += dt;
}
// 修理工：精灵训练的自动单位，走向己方主墙持续免费修理（复用单机规则）。
function workerTick(s, p, w, dt) {
  if (w.hp <= 0) return;
  const wall = s.buildings.find(b => b.owner === p.pid && b.type === 'wall' && b.hp > 0 && b.progress === 1);
  w.action = 'idle';
  if (!wall) { if (w.path.length) stepUnit(s, w, dt, 130); return; }
  if (dist(w, wall) > 100) {
    if (!w.path.length || w.nav !== s.nav) { const path = findPath(s, w, { x: wall.x - 60, y: wall.y }); if (path) { w.goal = { x: wall.x - 60, y: wall.y }; w.path = path; w.nav = s.nav; } else w.path = []; }
    stepUnit(s, w, dt, 130);
    return;
  }
  w.action = 'repair'; w.anim += dt;
  const ratio = Math.max(.03, WORKERS[w.tier ?? 0].ratio);
  wall.hp = Math.min(info(wall).hp, wall.hp + dt * info(wall).hp / (ratio * 10));
}
function nextWork(s, p) {  p.path = []; p.goal = null; p.order = null; p.action = 'idle';
  while (p.orders.length) {
    const order = p.orders.shift(), b = s.buildings.find(v => v.id === order.id && v.hp > 0);
    if (!b || (order.kind === 'build' && b.progress === 1)) continue;
    const error = assignWork(s, p, b, order.kind);
    if (!error) return;
    err(s, p, info(b).name + '等待施工：' + error);
  }
}
function productionTick(s, dt) {
  for (const b of s.buildings) {
    b.pulse = Math.max(0, b.pulse - dt);
    b.shield = Math.max(0, (b.shield ?? 0) - dt);
    if (b.hp <= 0 || b.wreck) continue;
    const owner = s.players[b.owner];
    if (b.upgrade) {
      b.upgrade.progress += dt / UPGRADE_TIME;
      if (b.upgrade.progress >= 1) {
        const oldMax = info(b).hp; b.level = b.upgrade.target; b.hp += info(b).hp - oldMax; b.upgrade = null;
        s.stats.upgrades++; fx(s, 'elf', 'complete', b.x, b.y, { life: 1 });
        notify(s, '升级完成：' + info(b).name, { pid: owner?.pid, team: 'elf' });
      }
    }
    if (b.progress < 1 || !owner?.alive) continue;
    if (b.type === 'house' || b.type === 'mine') owner.gold += (info(b).income ?? 0) * dt;
    if (b.type === 'grove') owner.wood += (info(b).income ?? 0) * dt;
    if (b.type === 'tower' && s.troll.alive) {
      const data = info(b);
      if (b.addon) {
        const addonFire = b.addon.fire -= dt;
        if (b.addon.heal && addonFire <= 0) {
          const target = s.buildings.find(v => v.faction === 'elf' && v.hp > 0 && v.progress === 1 && v.hp < info(v).hp && !v.wreck && dist(b, v) < 350);
          if (target) { target.hp = Math.min(info(target).hp, target.hp + b.addon.heal); fx(s, 'elf', 'healbeam', b.x + 20, b.y - 45, { tx: target.x, ty: target.y - 25, life: .65 }); b.addon.fire = 2; }
        }
        if (b.addon.damage && addonFire <= 0 && trollAttackable(s) && dist(b, s.troll) <= 300) { s.projectiles.push(mkShot(s, b.x + 20, b.y - 45, b.addon.damage, b.addon.effect)); b.addon.fire = b.addon.interval ?? 1.2; }
      }
      if (data.damage && b.fire <= 0 && trollAttackable(s) && dist(b, s.troll) <= data.range) {
        b.fire = data.interval;
        fx(s, 'all', 'muzzle', b.x, b.y - 58, { life: .18, color: data.effect });
        s.projectiles.push(mkShot(s, b.x, b.y - 58, data.damage, data.effect));
      }
      b.fire -= dt;
    }
  }
}
const trollAttackable = s => s.troll.alive && (s.troll.invisible <= 0 || detectorNear(s, s.troll.x, s.troll.y));
function mkShot(s, x, y, damage, effect) {
  return { id: 'p' + s.nextId++, fromX: x, fromY: y, age: 0, damage, effect, tx: s.troll.x, ty: s.troll.y, flight: clamp(dist({ x, y }, s.troll) / 700, .18, .8), done: false };
}
function projectilesTick(s, dt) {
  for (const shot of s.projectiles) {
    shot.age += dt;
    if (shot.age >= shot.flight && !shot.done) {
      shot.done = true;
      if (s.troll.alive && trollAttackable(s)) {
        let damage = damageAfterArmor(shot.damage, s.troll.armor);
        if (shot.effect === 'chaos') { s.seed = ((s.seed ?? 12345) * 1664525 + 1013904223) >>> 0; if (s.seed / 4294967296 < .1) damage *= 5; }
        s.troll.hp = Math.max(0, s.troll.hp - damage);
        fx(s, 'all', shot.effect, s.troll.x, s.troll.y - 38, { life: .7 });
        fx(s, 'all', 'damage', s.troll.x, s.troll.y - 58, { text: '−' + Math.round(damage), life: .8 });
        if (shot.effect === 'frost') s.troll.statuses.frost = 3;
        if (shot.effect === 'poison') s.troll.statuses.poison = 3;
        if (s.troll.hp <= 0) { s.troll.alive = false; notify(s, '巨魔倒下了，精灵获胜！'); }
      }
    }
  }
  s.projectiles = s.projectiles.filter(p => !p.done && p.age < 1.2);
}
function checkWin(s) {
  if (s.result) return;
  if (!s.troll.alive) { s.result = '精灵获胜'; s.phase = 'ended'; }
  else if (!Object.values(s.players).some(p => p.faction === 'elf' && p.alive)) { s.result = '巨魔获胜'; s.phase = 'ended'; }
  else if (s.time >= s.cfg.maxTime) { s.result = '时间耗尽，精灵获胜'; s.phase = 'ended'; }
  if (s.result) { s.resultAt = s.time; notify(s, s.result); }
}
export function advance(s, dt) {
  if (s.phase === 'ended') return;
  dt = Math.min(dt, .05); s.time += dt;
  if (s.phase === 'prep' && s.time >= s.cfg.prepTime) { s.phase = 'live'; notify(s, '巨魔进入雪林，对局开始！'); }
  if (s.phase === 'live' && s.time >= s.encounter.growthAt) trollGrowth(s);
  for (const p of Object.values(s.players)) {
    if (!p.alive) continue;
    for (const k in p.cooldowns) p.cooldowns[k] = Math.max(0, p.cooldowns[k] - dt);
    p.mana = Math.min(200, (p.mana ?? 200) + dt * 3);
    p.blink = Math.max(0, p.blink - dt);
    p.casting = Math.max(0, p.casting - dt);
    if (p.faction === 'elf') {
      const st = itemStats(p.items);
      p.speed = CFG.elfBaseSpeed + Math.min(120, st.move ?? 0);
      p.hp = Math.min(p.maxHp, p.hp + dt * (1 + (st.regen ?? 0)));
      p.action = 'idle';
      stepUnit(s, p, dt, p.speed);
      workTick(s, p, dt);
      for (const w of p.workers ?? []) workerTick(s, p, w, dt);
    }
  }
  productionTick(s, dt);
  trollTick(s, dt);
  projectilesTick(s, dt);
  updateFog(s);
  checkWin(s);
}
export function onDisconnect(s, pid, time) {
  const p = s.players[pid];
  if (!p) return;
  p.connected = false; p.lastSeen = time ?? s.time;
  notify(s, p.name + ' 断线（120 秒内可重连）', { team: 'all' });
}
export function onQuit(s, pid) {
  const p = s.players[pid];
  if (!p || !p.alive) return;
  if (p.faction === 'elf') { eliminate(s, p, null); }
  else { p.alive = false; notify(s, '巨魔离开了对局，精灵获胜'); s.result = '精灵获胜'; s.phase = 'ended'; }
}
// 每步调用：处理断线超时（由服务器以真实时间传入）
export function tickTimeouts(s, nowMs) {
  for (const p of Object.values(s.players)) {
    if (!p.connected && p.alive && nowMs - (p.disconnectedAt ?? 0) > s.cfg.disconnectGrace * 1000) onQuit(s, p.pid);
  }
}

// ---------- 快照（按阵营过滤，服务器权威迷雾） ----------
export function snapshot(s, viewerPid) {
  const v = s.players[viewerPid];
  if (!v) return null;
  const team = v.faction === 'troll' ? 'troll' : 'elf';
  const elfView = team === 'elf';
  const trollSeen = s.troll?.alive && cellVisible(s, 'elf', s.troll.x, s.troll.y) && (s.troll.invisible <= 0 || detectorNear(s, s.troll.x, s.troll.y));
  const vis = (x, y) => cellVisible(s, team, x, y);
  const players = Object.values(s.players).filter(p => p.pid !== v.pid).map(p => {
    const base = { pid: p.pid, name: p.name, faction: p.faction, alive: p.alive, connected: p.connected };
    if (p.faction === team) return { ...base, x: Math.round(p.x), y: Math.round(p.y), hp: Math.round(p.hp), maxHp: p.maxHp, camp: p.camp, gold: Math.floor(p.gold), wood: Math.floor(p.wood) };
    // 敌方：只有可见才发；巨魔看精灵按视野；精灵看巨魔按视野+反隐
    const seen = elfView ? trollSeen : vis(p.x, p.y) || !p.alive;
    if (!seen) return { ...base, hidden: true };
    return { ...base, x: Math.round(p.x), y: Math.round(p.y), hp: Math.round(p.hp), maxHp: p.maxHp };
  });
  const buildings = s.buildings.filter(b => {
    if (elfView) return b.faction === 'elf' || vis(b.x, b.y);
    return vis(b.x, b.y);
  }).map(b => ({ id: b.id, owner: b.owner, faction: b.faction, type: b.type, level: b.level, x: Math.round(b.x), y: Math.round(b.y), hp: Math.round(b.hp), hpMax: info(b).hp, progress: +b.progress.toFixed(2), started: b.started, upgradeP: b.upgrade ? +b.upgrade.progress.toFixed(2) : null, shield: b.shield > 0, wreck: b.wreck, effect: b.type === 'tower' ? info(b).effect : null }));
  const wards = s.wards.filter(w => w.until > s.time).filter(w => elfView || vis(w.x, w.y)).map(w => ({ id: w.id, x: Math.round(w.x), y: Math.round(w.y), left: Math.round(w.until - s.time) }));
  const shots = s.projectiles.map(p => ({ id: p.id, x: Math.round(p.fromX), y: Math.round(p.fromY), tx: Math.round(p.tx), ty: Math.round(p.ty), age: +p.age.toFixed(2), flight: p.flight, effect: p.effect }));
  const camps = Object.values(s.camps).map(c => {
    const camp = CAMPS.find(k => k.id === c.id);
    const explored = s.fog.explored[team][cellAt(camp)] === 1;
    return { id: c.id, name: camp.name, x: camp.x, y: camp.y, kind: camp.kind, claimedBy: explored ? c.claimedBy : null };
  });
  const sources = [];
  if (elfView) {
    for (const p of Object.values(s.players)) if (p.faction === 'elf' && p.alive) sources.push({ x: Math.round(p.x), y: Math.round(p.y), r: 260 + itemStats(p.items).sight });
    for (const b of s.buildings) if (b.faction === 'elf' && b.hp > 0 && b.started) sources.push({ x: Math.round(b.x), y: Math.round(b.y), r: b.type === 'tower' && b.progress === 1 ? 320 : 200 });
    for (const w of s.wards) if (w.until > s.time) sources.push({ x: Math.round(w.x), y: Math.round(w.y), r: 350 });
  } else {
    const t = s.troll; if (t.alive) sources.push({ x: Math.round(t.x), y: Math.round(t.y), r: 300 });
  }
  return {
    type: 'snap', t: s.time, phase: s.phase, result: s.result, night: !!s.night,
    tier: s.encounter.tier, growthIn: Math.max(0, Math.round(s.encounter.growthAt - s.time)),
    prepLeft: s.phase === 'prep' ? Math.max(0, Math.ceil(s.cfg.prepTime - s.time)) : 0,
    timeLeft: Math.max(0, Math.round(s.cfg.maxTime - s.time)),
    you: { pid: v.pid, name: v.name, faction: v.faction, x: Math.round(v.x), y: Math.round(v.y), hp: Math.round(v.hp), maxHp: v.maxHp, gold: Math.floor(v.gold), wood: Math.floor(v.wood), items: v.items, uses: v.uses, mana: Math.floor(v.mana ?? 200), cooldowns: Object.fromEntries(Object.entries(v.cooldowns).map(([k, t2]) => [k, Math.ceil(t2)])), blinkCd: Math.ceil(v.blink), camp: v.camp, order: v.order ? { kind: v.order.kind, id: v.order.id ?? null, target: v.order.target ?? null } : null, alive: v.alive, bagSize: v.bagSize, invisible: v.invisible > 0 ? Math.ceil(v.invisible) : 0, statuses: Object.fromEntries(Object.entries(v.statuses).filter(([, t2]) => t2 > 0).map(([k, t2]) => [k, Math.ceil(t2)])) },
    stats: v.faction === 'troll' ? { attack: s.troll.attack, armor: s.troll.armor, maxHp: s.troll.maxHp, regen: s.troll.regen, haste: +s.troll.haste.toFixed(2), move: s.troll.move } : null,
    players, buildings, wards, shots, camps, sources,
    trollStatsOut: elfView && trollSeen ? { attack: s.troll.attack, armor: s.troll.armor, hp: Math.round(s.troll.hp), maxHp: s.troll.maxHp, tier: s.encounter.tier + 1 } : null,
  };
}
export const shopList = () => SHOP_LIST;
