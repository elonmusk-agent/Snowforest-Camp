# IMPLEMENTATION_STATUS · Snowforest Camp 多人升级

## 目标与验收清单
单机守卫战 → 多人实时在线非对称对抗（1 巨魔 vs 1–5 精灵），双方玩家操控、双方装备商店、10 营地大地图、战争迷雾、公网可玩。原单机/练习模式不回归。

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 房间创建/加入/阵营/准备/开始 | ✅ | server/test-server.mjs 12 项；e2e-browsers |
| 真人巨魔（移动/攻击/技能/商店） | ✅ | mp-sim 测试 3/6 组；e2e 截图 /tmp/e2e-troll-*.png |
| 真人精灵（占领/建造/升级/修理/技能） | ✅ | mp-sim 测试 2/9 组；e2e /tmp/e2e-elf-*.png |
| 双方 ≥6 件有效装备、服务器权威购买 | ✅ | 精灵 8 件 / 巨魔 7 件（mp-items.mjs）；测试 6 组（原子性/唯一/出售/使用） |
| 10 营地大地图 + 迷雾 + 小地图一致 | ✅ | map-data 校验；快照按阵营过滤（测试 5 组）；小地图遵守迷雾 |
| 断线重连 120s / 房主转移 / 再来一局 | ✅ | test-server 7 项（重连恢复会话与快照流）；规则测试 7 组；**test-room 34 项**（房主转交/再来一局/多轮重开清理，见下） |
| 对局结束后迟到命令 / 多次重开资源清理 | ✅ | **server/test-room.mjs 34 项**：结束后 move/buy 均被拒（"当前不在对局中"）；end 仅发送一次；连续 3 轮 again→start 后资源重置 30/0、建筑清空、玩家复活、营地占领清空、属性重置、服务器无房间泄漏（rooms=1）；超频 60 条/秒被限速且连接保持 |
| 原单机与练习模式不回归 | ✅ | node game/test.mjs 通过（单机代码零修改，仅 index.html 加入口链接） |
| 视觉统一升级 | ✅ | 程序化分块地形（雪松/冰湖/山石/火塘/遗迹/地标）、迷雾柔边、营地暖光光照层、屏幕雪花、暗角；截图 /tmp/sf-visual.png |
| 公网入口完成对局 | ✅ | ngrok 双浏览器 E2E 7 项（占领/建造/快照流）；入口见"部署状态" |
| 性能/网络记录（§16） | ✅ | **server/perf-sample.mjs 60 秒 CDP 采样**（/tmp/sf-perf.json）：Apple M4 Pro / Chrome 156 headless 1280×800 / 2 玩家 / 2 建筑 / 巨魔 1 阶 / 本机回环 WS；精灵端 FPS 稳态 60–62（每秒采样 min=60）、巨魔端同；快照 10.7/s（10Hz 节流）；下行精灵 18.7KB/s、巨魔 14.7KB/s；上行 ≈12B/s（命令约 55B/条）；ngrok 公网链路 E2E 通过（延迟实测可见于 net-pill） |

## 已实现
- 阶段1：基线核验（master@9bf8e08）、分支 `multiplayer`
- 阶段2：`game/mp/`（大地图/多人模拟/装备）+ `server/server.mjs`（房间/会话/重连/限速/静态托管）+ `game/mp-client.mjs`（大厅/渲染/迷雾/商店/重连）
- 阶段3：并入阶段2 一并实现（多营地/双方商店/迷雾/小地图/重连）
- 阶段4：视觉升级（分块地形、光照层、雾柔边、山石重绘、雪、暗角）
- 阶段5：公网部署（本机服务器 + ngrok WSS，静态与 WS 同源）+ 运维脚本

## 已验证（四层）
1. 自动化规则：`game/mp/test-mp.mjs` 10 组全过；`game/test.mjs`（单机回归）通过
2. 本机多客户端：`server/test-server.mjs`（真实 WS×2）12 项；`server/test-room.mjs`（房间生命周期：房主转交/再来一局/迟到命令/多轮重开清理/限速）34 项；`server/e2e-browsers.mjs`（双无头 Chrome）10 项
3. 公网入口：`server/e2e-public.mjs` 7 项通过（两个独立 Chrome 经 https 公网 URL 同房间对局：身份/快照流/占领/建造）
4. 性能采样：`server/perf-sample.mjs` 60 秒 CDP 采样（FPS/快照频率/上下行流量，数据见验证表与 /tmp/sf-perf.json）
5. 真人试玩：未执行（无第二设备/真人配合）——**不冒充已完成**

## 当前任务 / 下一步可执行
- （可选）6 人房间与多房间并发压测（容量按设计目标，实测以 2 人对局为主）；手机横屏专项调优
- （可选）云托管替换 ngrok 免费隧道，获得固定域名
- （可选）对局录像/战绩；音效扩展（当前为合成音，默认关）

## 局部阻塞
无硬阻塞。注意项：ngrok 免费隧道重启后公网地址会变；免费额度/速率以当前账号为准。

## 分支与关键提交
- `multiplayer`：dd16a0d 基线 → mp-sim → server → client → visual → 部署脚本与文档（见 git log）
- master 未动（草稿 PR 交付）

## 启动 / 测试 / 停止 / 恢复
- 启动：`./scripts/serve-start.sh`（服务器 8080 + ngrok；幂等）
- 状态：`./scripts/serve-status.sh`（healthz / 房间列表 / 隧道地址）
- 停止：`./scripts/serve-stop.sh`
- 故障恢复：隧道断开重跑 serve-start.sh 即可（地址可能变化）；服务器崩溃重跑同脚本；进行中对局随进程结束而终止（第一版明确行为）
- 测试：见 README-MP.md 第 2 节

## 部署状态
- GitHub Pages：master 自动发布流程未触碰
- 公网联机：本机 `node server/server.mjs` + `ngrok http 8080`（WSS 同源）
