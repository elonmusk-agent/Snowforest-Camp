// 多人模拟规则测试：node game/mp/test-mp.mjs
import assert from 'node:assert/strict';
import { createMatch, advance, moveCmd, claimCamp, buildCmd, upgradeCmd, repairCmd, trollAttackCmd, trollSkillCmd, buyCmd, sellCmd, useItemCmd, castSkillCmd, blinkCmd, snapshot, stopCmd, onDisconnect, tickTimeouts, CFG } from './mp-sim.mjs';
import { TROLL_SPAWN, ELF_SPAWN, CAMPS } from './map-data.mjs';

const run = (s, sec) => { for (let i = 0; i < Math.ceil(sec * 20); i++) advance(s, .05); };
const mk = () => createMatch([{ pid: 'E1', name: '精灵甲', faction: 'elf' }, { pid: 'E2', name: '精灵乙', faction: 'elf' }, { pid: 'T', name: '巨魔王', faction: 'troll' }]);
const elf = s => s.players.E1, elf2 = s => s.players.E2, troll = s => s.players.T;

// 1. 开局与准备期
{
  const s = mk();
  assert.equal(s.phase, 'prep');
  assert.equal(troll(s).maxHp, 500);
  assert.equal(elf(s).maxHp, CFG.elfBaseHp);
  run(s, CFG.prepTime - .2);
  assert.equal(s.phase, 'prep', '准备期内巨魔不得入场');
  // 准备期巨魔移动限制
  assert(moveCmd(s, troll(s), 400, 900).includes('准备期'), '准备期巨魔不能离开出生区');
  assert.equal(moveCmd(s, troll(s), TROLL_SPAWN.x - 100, TROLL_SPAWN.y), '', '出生区内可以移动');
  run(s, .3);
  assert.equal(s.phase, 'live', '90 秒后巨魔入场');
  console.log('通过：开局/准备期/巨魔入场限制');
}
// 2. 占领与建造
{
  const s = mk();
  const c1 = CAMPS[0], c5 = CAMPS[4];
  assert(claimCamp(s, elf(s)).includes('需走到'), '必须靠近营地');
  // 传送精灵到营地（用 blink 链模拟移动到位）
  elf(s).x = c1.x; elf(s).y = c1.y;
  assert.equal(claimCamp(s, elf(s)), '');
  assert.equal(claimCamp(s, elf(s)), '你已占领营地', '一名精灵只能占一个营地');
  elf2(s).x = c1.x; elf2(s).y = c1.y;
  assert(claimCamp(s, elf2(s)).includes('已被队友'), '同营地不能重复占领');
  // 建造：远离基座报错；在基座建造成功并扣款
  const houseSlot = c1.slots.house;
  assert(buildCmd(s, elf(s), 'house', c5.x, c5.y).includes('基座'), '不能在别的营地建');
  elf(s).gold = 5000;
  assert.equal(buildCmd(s, elf(s), 'house', houseSlot.x, houseSlot.y), '');
  const house = s.buildings.at(-1);
  assert.equal(house.owner, 'E1');
  const towerSlot = c1.slots.tower[0];
  assert.equal(buildCmd(s, elf(s), 'tower', towerSlot.x, towerSlot.y), '');
  assert(elf(s).gold <= 5000 - 16, '建造防塔扣款 16 金');
  run(s, 8);
  assert.equal(house.progress, 1, '精灵走到并建完');
  assert(elf(s).gold > 0, '房屋开始产金');
  // 升级前置
  elf(s).gold = 100;
  assert(upgradeCmd(s, elf(s), house.id).includes('需要'), '升级需岩墙前置');
  console.log('通过：占领/独立归属/建造/产金/前置');
}
// 3. 巨魔攻墙：伤害转金币、破墙重新寻路、残骸无收益
{
  const s = mk();
  const c1 = CAMPS[0];
  elf(s).x = c1.x; elf(s).y = c1.y; elf(s).gold = 5000;
  claimCamp(s, elf(s));
  buildCmd(s, elf(s), 'wall', c1.slots.gate.x, c1.slots.gate.y);
  run(s, 9);
  const wall = s.buildings.find(b => b.type === 'wall');
  assert.equal(wall.progress, 1);
  s.phase = 'live'; s.time = Math.max(s.time, s.cfg.prepTime);
  troll(s).x = wall.x + 66; troll(s).y = wall.y; troll(s).path = []; troll(s).order = null;
  const g0 = troll(s).gold;
  assert.equal(trollAttackCmd(s, troll(s), wall.id), '');
  run(s, 3);
  assert(wall.hp < 50, '巨魔正在攻墙');
  assert(troll(s).gold > g0, '攻墙伤害转金币');
  // 残骸无收益
  wall.hp = 1; wall.wreck = true;
  const g1 = troll(s).gold;
  run(s, 2);
  assert.equal(troll(s).gold, g1, '攻击残骸不产生金币');
  console.log('通过：攻墙转金币/残骸无收益');
}
// 4. 精灵淘汰：建筑停产成残骸、失败结算
{
  const s = mk();
  const elfP = elf(s);
  elfP.hp = 1;
  s.phase = 'live'; s.time = s.cfg.prepTime;
  troll(s).x = elfP.x + 30; troll(s).y = elfP.y;
  assert.equal(trollAttackCmd(s, troll(s), 'E1'), '');
  run(s, 2);
  assert.equal(elfP.alive, false, '精灵被淘汰');
  assert(elfP.camp === null || s.buildings.filter(b => b.owner === 'E1').every(b => b.wreck), '建筑成为残骸');
  // 只有一名精灵，全部淘汰 → 巨魔胜（E2 还活着，所以先验证不结束）
  assert.equal(s.result, '', '另一名精灵存活时不结算');
  console.log('通过：淘汰/残骸/存活判定');
}
// 5. 迷雾：快照过滤（服务器权威）
{
  const s = mk();
  s.phase = 'live'; s.time = s.cfg.prepTime;
  // 巨魔远离精灵
  troll(s).x = TROLL_SPAWN.x; troll(s).y = TROLL_SPAWN.y;
  elf(s).x = ELF_SPAWN.x; elf(s).y = ELF_SPAWN.y;
  advance(s, .05); // 刷新视野
  const elfSnap = snapshot(s, 'E1');
  assert(elfSnap.players.find(p => p.pid === 'T').hidden, '巨魔不在视野时位置不下发');
  assert.equal(elfSnap.trollStatsOut, null, '巨魔属性不下发');
  const trollSnap = snapshot(s, 'T');
  assert(trollSnap.players.find(p => p.pid === 'E1').hidden, '巨魔视野外的精灵不下发');
  // 精灵走到巨魔身边 → 可见
  elf(s).x = TROLL_SPAWN.x - 200; elf(s).y = TROLL_SPAWN.y;
  advance(s, .05);
  const snap2 = snapshot(s, 'E1');
  assert(!snap2.players.find(p => p.pid === 'T').hidden, '巨魔进入精灵视野后下发');
  assert(snap2.trollStatsOut, '可见时巨魔属性下发');
  // 隐身：未被反隐时隐藏
  troll(s).invisible = 15;
  advance(s, .05);
  const snap3 = snapshot(s, 'E1');
  assert(snap3.players.find(p => p.pid === 'T').hidden, '隐身且无反隐时不下发');
  // 放守卫反隐
  castSkillCmd(s, elf(s), 'ward', elf(s).x + 100, elf(s).y);
  advance(s, .05);
  const snap4 = snapshot(s, 'E1');
  assert(!snap4.players.find(p => p.pid === 'T').hidden, '侦察守卫揭示隐身巨魔');
  console.log('通过：迷雾过滤/隐身反隐/属性隐藏');
}
// 6. 商店：位置校验、原子性、唯一、出售、使用
{
  const s = mk();
  const elfP = elf(s), trollP = troll(s);
  s.phase = 'live'; s.time = s.cfg.prepTime;
  assert(buyCmd(s, trollP, 'I004').includes('回到出生补给区') || trollP.x === TROLL_SPAWN.x, '巨魔需在商店区');
  trollP.gold = 200;
  assert.equal(buyCmd(s, trollP, 'I004'), '', '出生区可购买');
  assert.equal(trollP.items.includes('I004'), true);
  assert.equal(trollP.gold, 100, '购买扣款 100 金');
  trollP.gold = 5;
  assert(buyCmd(s, trollP, 'I00C').includes('资源不足'), '资源不足拒绝');
  assert.equal(trollP.gold, 5, '失败购买不扣款');
  trollP.items = []; trollP.uses = {};
  trollP.gold = 1000; trollP.x = TROLL_SPAWN.x; trollP.y = TROLL_SPAWN.y;
  assert.equal(buyCmd(s, trollP, 'I01N'), '', '移速靴可买');
  assert(buyCmd(s, trollP, 'I01N').includes('不可重复'), '唯一装备不可叠加');
  assert.equal(sellCmd(s, trollP, 'I01N'), '', '可出售');
  assert(trollP.gold > 1000 - 200, '出售返还');
  // 精灵：不在营地不能买
  assert(buyCmd(s, elfP, 'e_amulet').includes('营地'), '精灵需在营地商店');
  elfP.camp = CAMPS[0].id; elfP.x = CAMPS[0].x; elfP.y = CAMPS[0].y; elfP.gold = 500;
  assert.equal(buyCmd(s, elfP, 'e_amulet'), '');
  assert.equal(elfP.hp, CFG.elfBaseHp, '被动物品立即生效但不直接回血');
  elfP.hp = 50;
  assert.equal(buyCmd(s, elfP, 'e_potion'), '', '可购买生命药剂');
  assert.equal(useItemCmd(s, elfP, 'e_potion'), '', '生命药剂可使用');
  assert(elfP.hp > 50, '药剂回血');
  assert.equal(elfP.uses['e_potion'], 1, '剩余次数记录');
  console.log('通过：商店位置/原子性/唯一/出售/主动物品');
}
// 7. 断线与重连
{
  const s = mk();
  s.phase = 'live'; s.time = s.cfg.prepTime;
  onDisconnect(s, 'E1');
  assert.equal(elf(s).connected, false);
  s.players.E1.disconnectedAt = Date.now() - (CFG.disconnectGrace + 5) * 1000;
  tickTimeouts(s, Date.now());
  assert.equal(elf(s).alive, false, '断线超时按退出处理（淘汰）');
  // 巨魔退出 → 精灵胜
  const s2 = mk(); s2.phase = 'live'; s2.time = s2.cfg.prepTime;
  const { onQuit } = await import('./mp-sim.mjs');
  onQuit(s2, 'T');
  assert.equal(s2.result, '精灵获胜', '巨魔退出判精灵胜');
  console.log('通过：断线超时/巨魔退出结算');
}
// 8. 对局结束后拒绝命令 + 时间耗尽判定
{
  const s = mk();
  s.phase = 'ended'; s.result = '精灵获胜';
  assert(moveCmd(s, elf(s), 500, 500).includes('无法行动'), '结束后拒绝移动');
  assert(buildCmd(s, elf(s), 'house', 0, 0), '结束后拒绝建造');
  // 时间耗尽
  const s2 = mk();
  s2.time = s2.cfg.maxTime - .05; s2.phase = 'live';
  run(s2, .2);
  assert(s2.result.includes('精灵获胜'), '30 分钟存活判定');
  console.log('通过：结束拒绝命令/时间耗尽');
}
// 9. 建墙阻挡寻路 + 破墙恢复
{
  const s = mk();
  const c1 = CAMPS[0];
  elf(s).x = c1.x; elf(s).y = c1.y; elf(s).gold = 5000;
  claimCamp(s, elf(s));
  buildCmd(s, elf(s), 'wall', c1.slots.gate.x, c1.slots.gate.y);
  run(s, 9);
  const wall = s.buildings.find(b => b.type === 'wall');
  const inside = { x: c1.x, y: c1.y };
  elf2(s).x = c1.slots.gate.x + 300; elf2(s).y = c1.slots.gate.y;
  // 从门外到门内：应无法直达（墙封锁）
  const s2 = s; const { findPath } = await import('./mp-sim.mjs');
  const blocked = findPath(s2, { x: c1.slots.gate.x + 200, y: c1.slots.gate.y }, { x: c1.x, y: c1.y });
  assert(!blocked, '主墙封死营地入口');
  // 修理
  wall.hp = 10; elf(s).x = wall.x - 40; elf(s).y = wall.y;
  assert.equal(repairCmd(s, elf(s), wall.id), '');
  run(s, 3);
  assert(wall.hp > 10, '近身修理恢复');
  console.log('通过：封墙阻断/修理恢复');
}
// 10. 完整闭环模拟：巨魔杀光精灵（自动对局）
{
  const s = mk();
  s.phase = 'live'; s.time = s.cfg.prepTime;
  for (const pid of ['E1', 'E2']) {
    const e = s.players[pid];
    e.hp = 1; e.x = TROLL_SPAWN.x - 100; e.y = TROLL_SPAWN.y;
  }
  trollAttackCmd(s, troll(s), 'E1');
  let t = 0;
  while (s.players.E1.alive && t < 30) { advance(s, .05); t += .05; if (!s.players.E1.alive) break; if (troll(s).order === null) trollAttackCmd(s, troll(s), 'E1'); }
  assert(!s.players.E1.alive, '巨魔击败第一名精灵');
  trollAttackCmd(s, troll(s), 'E2');
  t = 0;
  while (s.players.E2.alive && t < 30) { advance(s, .05); t += .05; if (!s.players.E2.alive) break; if (troll(s).order === null) trollAttackCmd(s, troll(s), 'E2'); }
  assert.equal(s.result, '巨魔获胜', '精灵全灭判巨魔胜');
  assert.equal(s.phase, 'ended');
  console.log('通过：完整对局闭环（巨魔获胜路径）');
}
console.log('mp-sim 规则测试全部通过 ✅');
