// 多人对局双方商店数据：价格/属性/主动效果/唯一性与叠加规则的唯一来源（界面同用此表）。
// 巨魔复用 classic-data ITEMS 的可靠子集；精灵为新增原创条目。
import { ITEMS as CLASSIC } from '../classic-data.mjs';

const troll = ids => ids.map(id => ({ ...CLASSIC[id], faction: 'troll', sell: Math.floor(CLASSIC[id].gold * .6), unique: id === 'I01N' }));
// 精灵装备：type passive=属性加成 active=使用型消耗/冷却道具
const elfItems = [
  { id: 'e_amulet', name: '冰原护符', gold: 150, wood: 0, faction: 'elf', sell: 90, kind: 'passive', bonus: { hp: 120 }, tip: '生命 +120' },
  { id: 'e_boots', name: '雪行靴', gold: 120, wood: 0, faction: 'elf', sell: 72, kind: 'passive', bonus: { move: 40 }, unique: true, tip: '移动速度 +40（不可叠加）' },
  { id: 'e_regen', name: '暖泉坠饰', gold: 180, wood: 0, faction: 'elf', sell: 108, kind: 'passive', bonus: { regen: 6 }, tip: '每秒恢复 6 生命' },
  { id: 'e_repair', name: '匠师手套', gold: 200, wood: 0, faction: 'elf', sell: 120, kind: 'passive', bonus: { repair: .5 }, tip: '修墙与施工速度 +50%' },
  { id: 'e_sight', name: '真视宝石', gold: 250, wood: 0, faction: 'elf', sell: 150, kind: 'passive', bonus: { sight: 260 }, tip: '身边 260 范围反隐并揭示巨魔' },
  { id: 'e_ward', name: '侦察守卫', gold: 60, wood: 0, faction: 'elf', sell: 30, kind: 'active', cd: 8, uses: null, castRange: 320, effect: 'ward', tip: '在目标点放置守卫：提供视野 200 秒并反隐' },
  { id: 'e_stone', name: '壁垒石', gold: 140, wood: 0, faction: 'elf', sell: 70, kind: 'active', cd: 120, castRange: 300, effect: 'shield', tip: '主墙获得 6 秒无敌护盾（冷却 120 秒）' },
  { id: 'e_potion', name: '生命药剂', gold: 80, wood: 0, faction: 'elf', sell: 40, kind: 'active', cd: 0, uses: 2, effect: 'heal', heal: 150, tip: '恢复自身 150 生命，共 2 次使用次数' },
];
export const TROLL_ITEMS = troll(['I004', 'I00J', 'I00C', 'I00G', 'I008', 'I01N', 'I00I']);
// 补充说明：I004 攻击+2 / I00J 攻速+20% / I00C 生命+250 / I00G 护甲+1 / I008 回复4/s / I01N 移速靴(唯一) / I00I 护甲+8
export const ELF_ITEMS = elfItems;
export const ALL_ITEMS = Object.fromEntries([...ELF_ITEMS, ...TROLL_ITEMS].map(d => [d.id, d]));
export const SHOP_LIST = {
  troll: TROLL_ITEMS.map(d => d.id),
  elf: ELF_ITEMS.map(d => d.id),
};
export function itemStats(items) {
  const s = { hp: 0, move: 0, regen: 0, repair: 0, sight: 0, attack: 0, haste: 0, armor: 0 };
  for (const id of items) { const b = ALL_ITEMS[id]?.bonus ?? {}; for (const k in b) if (k in s) s[k] += b[k]; }
  return s;
}
