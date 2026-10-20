# 17 Botnet WebSocket C2 Node — botnet-client

| 属性 | 值 |
| --- | --- |
| 编号 | 17 |
| 名称 | Botnet WebSocket C2 Node |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | botnet-client |
| 入口 | `sample.js` |
| 验证 | `node examples/suite/run-all.mjs --filter 17` |

## 1. 作品定位

僵尸网络受控端（bot）样本：以浏览器为宿主完成节点注册、指令通道接入、任务队列调度与吞吐回传。它不是为了单次窃密，而是把被感染的浏览器变成可远程调度的工作节点——攻击者通过 WebSocket 下发 flood / click / stage 三类任务，节点用本地 worker 池并发执行并按心跳上报收益与健康度。

作品展示的是一条完整的“招募 → 建链 → 派单 → 执行 → 回传”闭环，重点在于**任务调度与信标节奏**，而不是单一破坏动作。

## 2. 完整攻击链

1. **节点标识**：从 `localStorage` 读取既有节点 ID，缺失时用 `crypto.getRandomValues` 生成 8 字节随机 ID 并落库，形成稳定的受控端身份。
2. **指纹与注册**：采集 UA、平台、CPU 核数、屏幕分辨率与时区偏移，`btoa` 编码后 `POST` 到 `/api/node/register`，附带 worker 池大小与能力列表。
3. **指令通道**：建立 `wss://panel.botnet.example.test/socket`，`onopen` 后发送 `join` 帧（节点 ID + 能力），`onmessage` 解析任务帧并 `ack`。
4. **任务入队**：任务按 `priority` 插入优先级队列，队列长度与已执行数受 `MAX_TASKS` 上限约束，防止被反制时无限膨胀。
5. **worker 池分派**：按 4 条 lane 轮转派发，向 `Worker` 投递任务消息作为遥测，同时在虚拟时钟上调度真实执行体。
6. **任务执行**：`flood` 对目标拼接随机参数发起批量 `fetch`；`click` 构造隐藏锚点并 `click()`、再用 `document.write` 写入隐藏点击器与像素请求；`stage` 用 `atob` 还原 Base64 第二阶段并 `eval` 执行。
7. **缓存指令回放**：C2 不可达时回放内置 `CACHED_TASK`，保证节点“离线也能跑”，避免因单次失联暴露空转。
8. **心跳与退避**：心跳间隔 250ms 起、连续 3 拍后指数退避到 2s 上限，最多 6 拍；每拍上报任务数、失败数与 ops/s，并把 beat 与 rate 写入 `localStorage`。

## 3. 核心能力

- 节点注册与浏览器指纹上报
- WebSocket 双向指令通道（join / task / ack）
- 优先级任务队列与任务上限保护
- worker 池任务分派与 lane 级遥测
- flood / click / stage 三类任务执行器
- C2 失联时的缓存指令回放
- 心跳指数退避与吞吐（ops/s）上报
- `localStorage` 持久化节点身份与运行指标

## 4. 快速开始

```bash
node examples/suite/run-all.mjs --filter 17
node tools/cli.js analyze examples/suite/17-botnet-ws-c2/sample.js
node tools/cli.js analyze examples/suite/17-botnet-ws-c2/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
```

分析时可由 `work.json` 的 `expect.networkRoutes` 提供离线 C2 应答（`deny` 策略下的白名单路由），从而观察到 socket 建链、任务帧解析、`ack` 与心跳回传的完整时序。

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 70（实测 74）。
- **IOC**：`urls`（`panel.botnet.example.test`、`victim-portal.example.net`、`clickfarm.example.test`）、`domains`；Base64 载荷解析为脚本片段。
- **Artifact**：`decoded-string`（阶段代码、注册/回传 JSON）、`embedded-blob`（内置 Base64 指令）、`console-output`（心跳与 lane 日志）。第二阶段 `eval` 的内容与 `atob` 解码结果同源，按内容寻址去重后归入 `decoded-string`。
- **静态技术标签**：`dynamic-code-execution`、`encoded-string-decoding`、`network-communication`、`web-storage`、`worker-thread`、`dom-injection`。
- **动态 trace**：`net`（socket/注册/心跳/洪泛请求）、`timer`（心跳与队列泵）、`storage`（节点 ID、beat、rate）、`dom`（锚点与 `document.write`）、`api`。
- **行为摘要**：kill-chain 命中 execution / command-and-control / persistence / injection；敏感 API 观测到 `document.write`。

## 6. 检测与处置建议

- **网络侧**：对非业务域名上的 `wss://` 建链 + 固定间隔心跳组合告警；对同一目标短时批量带随机参数的 GET 计为 flood 行为。
- **前端侧**：监测 4 个以上 `Worker` 同时实例化、`document.write` 写入隐藏元素、以及 `localStorage` 中出现 `bn:*` 形式的节点 ID。
- **主机/网关**：封禁面板域名与其 `/api/node/*`、`/worker/pool.js` 路径；对 Base64 请求体（`btoa` 编码 JSON）在网关侧解码审计。
- **处置**：清除 `localStorage` 节点标记，终止遗留 `Worker`，关闭页面前吊销会话；对受害站点做请求速率封禁与 WAF 规则更新。

## 7. 验证与预期结果

`run-all.mjs` 在严格沙箱、`deny` 网络策略 + 显式路由下分析样本，并校验 `work.json.expect`：判定等级、最低分、IOC 类别（`urls`、`domains`）、artifact（`eval-payload|decoded-string|console-output`）、技术标签、trace 类型以及完整性/句柄释放。预期输出：`malicious 74`。

## 8. 说明

本作品为合成、可离线运行的商业级示例：所有域名使用保留的 `.test` / `.example.net`，网络流量由沙箱路由在本地应答，不包含真实 C2、真实受害者或可造成实际洪泛的代码。样本仅使用浏览器 API（`fetch`、`WebSocket`、`Worker`、`localStorage`、`document`、`crypto`），不引用任何 Node 内置模块。
