# IMPLEMENTATION_STATUS · Snowforest Camp 多人升级

## 目标
单机守卫战 → 多人实时在线非对称对抗(1 巨魔 vs 1-5 精灵),双方玩家操控、双方装备商店、10 营地大地图、战争迷雾、公网可玩。

## 验收清单
- [ ] 真实 WS 服务器房间创建/加入/阵营/准备/开始
- [ ] 真人巨魔(移动/攻击/技能/商店)与真人精灵(建家/经济/防守)
- [ ] 双方各 ≥6 件有效装备,服务器权威购买
- [ ] ~10 营地大地图 + 迷雾 + 小地图一致
- [ ] 断线重连 120s / 房主转移 / 再来一局
- [ ] 原单机与练习模式不回归(node game/test.mjs 通过)
- [ ] 视觉统一升级(程序化分块地形/光照/雪/粒子)
- [ ] 公网入口完成一整局

## 已完成
- [阶段1] 基线: master@9bf8e08,单机测试通过,Pages 流程确认(发布 game/ 静态目录)
- [阶段1] 分支 `multiplayer` 建立

## 当前任务
多人模拟核心 mp-sim + 大地图数据

## 启动方法
- 单机(不变): `python3 -m http.server 8765 --directory game`
- 多人(开发): `node server/server.mjs` → http://127.0.0.1:8080/multi.html

## 部署状态
- GitHub Pages: master 分支自动部署(未动)
- 公网联机: 待定(本机服务器+ngrok WSS,静态与 WS 同源)

## 分支与提交
- `multiplayer`(基线 9bf8e08)
