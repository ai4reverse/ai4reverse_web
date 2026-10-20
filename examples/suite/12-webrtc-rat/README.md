# 12 WebRTC RAT — webrtc-rat

| 属性 | 值 |
| --- | --- |
| 编号 | 12 |
| 名称 | WebRTC RAT |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | remote-access-trojan |
| 入口 | `sample.js` |
| 验证 | `node examples/suite/run-all.mjs --filter 12` |

## 1. 作品定位

模拟以 WebRTC 数据通道为 C2 的浏览器远控：信令经 HTTPS 提交，命令从数据通道下发，结果通过通道和 HTTPS 中继双通道回传；连接失败时轮换信令端点并按指数退避重连。样本只使用浏览器 API，所有信令/中继主机为 `example.net`，网络调用在沙箱中 mock。

## 2. 完整攻击链

1. 用 `crypto.subtle.digest('SHA-256')` 对 UA/平台/屏幕做指纹摘要，得到主机 ID。
2. 安装 `keydown` 键盘记录器，并将收集缓冲暂存于内存。
3. 渲染隐藏状态节点 `<div id="rtc-rat-status">`，写入 `rtc_rat` Cookie。
4. 创建 `RTCPeerConnection`（STUN: `stun.example.net:3478`）并建立 `c2` 数据通道。
5. `createOffer` → `setLocalDescription`，将 SDP 摘要 POST 到 `signal.example.net/rtc/offer`。
6. 通过通道 `onmessage` 下发 5 条任务：`sysinfo` / `clipboard` / `eval` / `persist` / `capture`。
7. 任务执行：采集主机画像；读取剪贴板；执行远程 `eval`；写入 `localStorage`/`sessionStorage`；请求 `getDisplayMedia`（沙箱拒绝后记录 `permission-denied`）。
8. 结果 Base64 编码后经 `RTCDataChannel.send` 与 `relay.example.net/rat/report` 双通道回传。
9. 模拟 ICE 失败：关闭通道，按 160ms × 2^n 退避重连并轮换 `signal2.example.net` / `edge.example.net`，预算 3 次后停止。

## 3. 核心能力

- WebRTC 数据通道 C2：Offer/Answer + `RTCDataChannel`，无需 WebSocket 即可双向通信。
- 命令分发器：`switch` 驱动的远程任务框架，支持远程代码执行。
- 屏幕/剪贴板采集：`getDisplayMedia` 与 `navigator.clipboard.readText`，拒绝时降级记录。
- 键盘记录：捕获可打印按键并计入主机画像。
- 指纹摘要：SHA-256 主机 ID，跨通道关联同一受害者。
- 端点轮换与指数退避：信令池轮换 + ICE 失败重连。
- 双通道回传：数据通道 + HTTPS 中继，任一通道可用即可外传。

## 4. 快速开始

```bash
node tools/cli.js analyze examples/suite/12-webrtc-rat/sample.js
node tools/cli.js analyze examples/suite/12-webrtc-rat/sample.js --json | jq '.verdict, .static.techniques, .dynamic.behavior.apis'
node examples/suite/run-all.mjs --filter 12
```

## 5. 预期取证结果（验证与预期结果）

严格沙箱运行后，`run-all.mjs` 校验 `work.json.expect`，实际观测：

- 判定：`suspicious`，score 58（≥ 52）。
- IOC：`urls` 4 条（`signal.example.net`、`signal2.example.net`、`edge.example.net`、`relay.example.net`）；`domains` 6 条。
- Artifact：`eval-payload`（`[rat] remote shell ready on data channel`）、`decoded-string`（中继地址 Base64）。
- 技术标签：`dynamic-code-execution`、`network-communication`、`web-storage`、`clipboard-access`、`cryptography`、`keylogging`。
- Trace：`net` 8、`timer` 7、`storage` 3、`dom` 2；控制台可见 `task 1..5`、`ice failure ...`、`reconnect attempt 1 in 320ms`。
- 关键状态：`rtc:rat:persist`、`rtc:rat:session` 与 `rtc_rat` Cookie。

## 6. 检测与处置建议

- 监控页面创建 `RTCPeerConnection` 后立刻 POST SDP 的行为，尤其是非会议类站点。
- 对 `RTCDataChannel` 标签（`c2`）与短周期任务消息建立检测规则。
- 审计 `navigator.clipboard.readText`、`getDisplayMedia` 与键盘监听组合。
- 处置时断开信令端点、清理 WebRTC 相关存储键并复核剪贴板泄露面。

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。WebRTC/剪贴板/媒体接口均为沙箱 mock，域名均为保留示例域。
