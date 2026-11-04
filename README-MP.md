# Snowforest Camp · 多人对战版（multiplayer 分支）

单机雪林营地 → **多人实时在线非对称对抗**：1 名玩家扮演巨魔，1–5 名玩家扮演精灵，大地图 10 营地、战争迷雾、双方商店装备、断线重连。服务器权威模拟（20Hz 固定步长），客户端只发意图、只收己方视野内的快照。

- 原单机版**完全保留**（`index.html`，规则与测试基线不变），多人版入口在单机开场界面。
- 分支：`multiplayer`（不改 master，以草稿 PR 交付）。

## 1. 公网试玩（方案 C：本机服务器 + ngrok）

```bash
./scripts/serve-start.sh     # 启动游戏服务器(8080) + ngrok 隧道，输出公网地址
./scripts/serve-status.sh    # 查看服务器/房间/隧道状态
./scripts/serve-stop.sh      # 全部停止
```

试玩入口：`https://<ngrok地址>/multi.html`（首次访问点击 ngrok 的 “Visit Site”，免费隧道限制所致）。
注意：免费隧道**不是**无限流量/无限在线的保证；电脑需保持联网与唤醒，隧道重启后公网地址会变化。ngrok 免费版不允许代理环境变量，脚本已自动剥离（`env -u HTTP_PROXY …`），错误码 ERR_NGROK_9009 即此原因。

局域网试玩：同网段直接访问 `http://<电脑IP>:8080/multi.html`。

## 2. 本地启动与测试

```bash
npm install          # 仅 ws 一个依赖
node server/server.mjs           # 服务器（静态 + WS 同源 8080；SF_PREP/SF_MAXTIME/SF_GROWTH 可覆盖对局参数）
node game/mp/test-mp.mjs         # 多人模拟规则测试（10 组）
node server/test-server.mjs      # 真实 WS 双客户端联机闭环（12 项）
node server/test-room.mjs        # 房间生命周期：房主转交/再来一局/迟到命令/多轮重开资源清理/限速（34 项）
node server/e2e-browsers.mjs     # 双无头浏览器 E2E（10 项，需服务器运行中）
BASE_URL=https://xxx.ngrok-free.dev node server/e2e-public.mjs   # 公网双浏览器 E2E（7 项）
node server/perf-sample.mjs      # 60 秒性能采样：FPS/快照频率/流量（写入 /tmp/sf-perf.json）
node game/test.mjs               # 单机回归（不变）
```

## 3. 玩法与操作

- 房间：游客昵称 → 创建/加入（4 位房间码）→ 选阵营（巨魔名额 1 名）→ 准备 → 房主开始；邀请链接 `multi.html?room=CODE`。
- 精灵：找营地中心**占领**（每人一营地）→ 建房产金 → 窄口筑墙 → 塔/技能/商店防守；队友可修墙；死亡即淘汰，建筑停产成残骸。
- 巨魔：准备期 90s 后入场；沿路侦察、选择营地进攻；**攻墙伤害转为金币**，回出生补给区买装备；技能：隐身/传送/揭示。
- 胜负：巨魔死亡→精灵胜；精灵全灭→巨魔胜；30 分钟仍有精灵存活→精灵胜。巨魔死亡优先判定。
- 快捷键：`1/2/3/4` 建造，`Q` 闪烁，`E/Z/W/V/N` 技能，`R` 修理，`U` 升级，`B` 商店，`A` 攻击（巨魔），空格定位，Esc 取消。
- 断线 120 秒内自动重连保留身份；房主在房间阶段退出自动转移。

## 4. 架构

```
server/server.mjs        WS 房间/会话/重连/频率限制 + 20Hz 模拟 + 10Hz 按阵营过滤快照
game/mp/map-data.mjs     3200×1800 大地图：10 营地、道路、冰湖山石、地标
game/mp/mp-sim.mjs       多人模拟：归属/迷雾/装备/技能/胜负（无 DOM，服务器权威）
game/mp/mp-items.mjs     双方装备数据（精灵 8 件 / 巨魔 7 件，复用 classic-data）
game/mp-client.mjs       联机客户端：大厅、快照插值渲染、迷雾、小地图、商店
game/multi.html + mp.css 对局界面
scripts/serve-*.sh       服务器与隧道运维
```

安全边界：客户端提交的仅是"意图"（动作名+参数），资源扣减、建造合法性、伤害、迷雾过滤全部由服务器计算；隐藏实体不下发；命令带序号去重、45 条/秒限速、消息 ≤4KB。

## 5. 素材说明

全部沿用项目内原创素材（`game/assets/`，AI 生成流程见 `game/ART_NOTES.md`）；多人版地形为**程序化分块绘制**（雪地/雪松/冰湖/山石/营地火塘灯柱/遗迹），未新增大图，无第三方素材。

## 6. 已验证（详见 IMPLEMENTATION_STATUS.md）

- 规则 10 组 / WS 联机 12 项 / 房间生命周期 34 项（房主转交·再来一局·迟到命令·多轮重开清理·限速）/ 本机双浏览器 E2E 10 项 / 公网双浏览器 E2E 7 项 / 单机回归不变
- 性能（60 秒 CDP 采样，Apple M4 Pro + Chrome 156 headless，2 玩家 2 建筑）：双端稳态 60–62 FPS；快照 10.7/s；下行精灵 18.7KB/s、巨魔 14.7KB/s；上行约 12B/s（命令约 55B/条）
- 公网实测：ngrok 隧道 healthz、静态页、WS 房间、双客户端对局交互全部通过

## 7. 已知问题与后续项

- 手机横屏可玩但未专项调优；迷雾为 16px 网格 + 模糊柔边。
- 房间容量按 6 人设计，实测主要覆盖 2 人对局；更大容量需进一步压测。
- 公网地址依赖 ngrok 免费隧道（有带宽/连接数限制，重启后地址变化）；接入云托管或固定域名属后续工作。
- 服务器重启会结束进行中对局（第一版明确不支持跨重启续局，页面会提示重连失败返回大厅）。
