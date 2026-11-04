// 雪林大地图：手工设计的 10 处营地、道路网络、地形分区与地标。
// 坐标为世界像素；walkable = 空地(圆形) ∪ 道路(胶囊) ∪ 出生区 − 湖泊 − 山石。
export const MAP = { w: 3200, h: 1800, cell: 16 };
export const TROLL_SPAWN = { x: 2980, y: 900, r: 220, shopR: 190 };
export const ELF_SPAWN = { x: 170, y: 900, r: 190 };
export const PREP_MOVE_LIMIT = 520; // 准备期精灵可离开出生区探索的距离上限（不限制，仅用于出生点标记）

// 十处营地：safe 靠近精灵出生区、central 在主干道沿线、risky 靠近巨魔一侧或支路尽头。
// 所有营地共用同一相对槽位布局（门朝东），兼顾实现简单与视觉统一。
export const SLOT_LAYOUT = {
  house: { dx: -62, dy: -46 },
  grove: { dx: -96, dy: 42 },
  tech: { dx: -34, dy: 88 },
  mine: { dx: 26, dy: 96 },
  tower: [{ dx: 74, dy: -84 }, { dx: 96, dy: 8 }, { dx: 40, dy: -104 }],
  gate: { dx: 132, dy: 0 },
};
export const CAMPS = [
  { id: 'c1',  name: '迎宾营地', kind: 'safe',    x: 430,  y: 660 },
  { id: 'c2',  name: '南桦营地', kind: 'safe',    x: 520,  y: 1210 },
  { id: 'c3',  name: '古松营地', kind: 'central', x: 940,  y: 520 },
  { id: 'c4',  name: '湖畔营地', kind: 'central', x: 1010, y: 1300 },
  { id: 'c5',  name: '遗迹营地', kind: 'central', x: 1480, y: 880 },
  { id: 'c6',  name: '北岭营地', kind: 'risky',   x: 1900, y: 420 },
  { id: 'c7',  name: '深林营地', kind: 'risky',   x: 1990, y: 1380 },
  { id: 'c8',  name: '冰湖营地', kind: 'risky',   x: 2360, y: 620 },
  { id: 'c9',  name: '断崖营地', kind: 'risky',   x: 2450, y: 1250 },
  { id: 'c10', name: '前哨营地', kind: 'risky',   x: 2760, y: 900 },
].map(c => ({
  ...c,
  slots: Object.fromEntries(Object.entries(SLOT_LAYOUT).map(([k, v]) =>
    [k, Array.isArray(v) ? v.map(p => ({ x: c.x + p.dx, y: c.y + p.dy })) : { x: c.x + v.dx, y: c.y + v.dy }])),
}));
export const campSlots = (camp, type) => type === 'wall' ? [camp.slots.gate] : type === 'tower' ? camp.slots.tower : [camp.slots[type]];

// 可行走区域：空地圆 + 道路胶囊 + 出生区；障碍：冰湖 + 山石。
export const CLEARINGS = [
  ...CAMPS.map(c => ({ x: c.x, y: c.y, r: 205 })),
  { x: ELF_SPAWN.x, y: ELF_SPAWN.y, r: ELF_SPAWN.r },
  { x: TROLL_SPAWN.x, y: TROLL_SPAWN.y, r: TROLL_SPAWN.r },
  { x: 700, y: 900, r: 130 }, { x: 1220, y: 900, r: 130 }, { x: 1740, y: 900, r: 130 },
  { x: 2200, y: 900, r: 130 }, { x: 2620, y: 900, r: 130 },
  { x: 660, y: 420, r: 110 }, { x: 1240, y: 1520, r: 110 }, { x: 1760, y: 1240, r: 110 },
  { x: 2160, y: 240, r: 100 }, { x: 2620, y: 1520, r: 100 },
];
export const ROADS = [
  { x1: ELF_SPAWN.x, y1: 900, x2: TROLL_SPAWN.x, y2: 900, r: 52 }, // 主干道
  ...CAMPS.map(c => roadBranch(c)),
];
function roadBranch(c) {
  // 从营地门口向东/西接入主干道 y=900：门口 (cx+132, cy) → (cx+132, 900) → 沿主路
  const gx = c.x + SLOT_LAYOUT.gate.dx, gy = c.y + SLOT_LAYOUT.gate.dy;
  if (Math.abs(gy - 900) < 8) return { x1: gx, y1: gy, x2: gx + (gx < 1600 ? -0.1 : 0.1) * 0, y2: gy, r: 52 };
  return { x1: gx, y1: gy, x2: gx, y2: 900, r: 46 };
}
export const LAKES = [
  { x: 1180, y: 1060, rx: 190, ry: 130 }, { x: 2250, y: 1060, rx: 160, ry: 110 },
  { x: 760, y: 300, rx: 170, ry: 110 }, { x: 2900, y: 1420, rx: 180, ry: 120 },
];
export const ROCKS = [
  { x: 560, y: 940, r: 56 }, { x: 1360, y: 760, r: 48 }, { x: 1680, y: 1120, r: 60 },
  { x: 2120, y: 700, r: 50 }, { x: 2560, y: 480, r: 44 }, { x: 900, y: 1080, r: 42 },
  { x: 2020, y: 940, r: 46 }, { x: 2700, y: 1120, r: 40 },
];
export const LANDMARKS = [
  { x: 1480, y: 760, name: '风蚀遗迹' }, { x: 2160, y: 240, name: '瞭望残塔' },
  { x: 1240, y: 1520, name: '冻结渡口' }, { x: 320, y: 1180, name: '精灵哨树' },
];
export const DECOR_SEED = 20261104;

const segDist = (px, py, s) => {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, t = Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - s.x1 - dx * t, py - s.y1 - dy * t);
};
export function ground(x, y) {
  if (x < 24 || y < 24 || x > MAP.w - 24 || y > MAP.h - 24) return false;
  for (const l of LAKES) if (((x - l.x) / l.rx) ** 2 + ((y - l.y) / l.ry) ** 2 <= 1) return false;
  for (const r of ROCKS) if (Math.hypot(x - r.x, y - r.y) < r) return false;
  for (const c of CLEARINGS) if (Math.hypot(x - c.x, y - c.y) <= c.r) return true;
  for (const s of ROADS) if (segDist(x, y, s) <= s.r) return true;
  return false;
}
export function terrainFree(x, y) {
  return [[-12, -12], [12, -12], [-12, 12], [12, 12]].every(([dx, dy]) => ground(x + dx, y + dy));
}
export const inCircle = (p, c) => Math.hypot(p.x - c.x, p.y - c.y) <= (c.r ?? 1e9);
export const inTrollShop = p => Math.hypot(p.x - TROLL_SPAWN.x, p.y - TROLL_SPAWN.y) <= TROLL_SPAWN.shopR;
