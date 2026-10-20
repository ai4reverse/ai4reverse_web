# 11 APT DNS Implant — apt-dns-implant

| 属性 | 值 |
| --- | --- |
| 编号 | 11 |
| 名称 | APT DNS Implant |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | apt-implant |
| 入口 | `sample.js` |
| 验证 | `node examples/suite/run-all.mjs --filter 11` |

## 1. 作品定位

模拟 APT 组织在浏览器侧投递的 DNS 植入体：任务下发与心跳都隐藏在 DNS 子域标签中，使用抖动信标规避周期性检测，主解析池失效时切换到 DGA 域名，任务执行结果经 HTTPS 采集端外传。样本仅使用浏览器 API，所有主机位于 `example.net` / `.test`，网络请求在沙箱中被 mock。

## 2. 完整攻击链

1. 读取 `localStorage` 中的植入状态（信标序号、随机种子、任务游标），无状态时初始化。
2. 生成/复用 `sessionStorage` 会话 ID，并写入 `apt_dns` Cookie 作为辅助标记。
3. 将心跳载荷做 Base32 编码，按 26 字符切分为 DNS 标签，拼成 `c<seq>-<idx>-<sid>.<label>.dns.example.net` 查询。
4. 以 400ms 基准、±35% 抖动调度 3 轮信标；每轮写入状态，避免重复任务。
5. 第 3 轮后解析内置任务清单：先 Base64 解码，再用可打印 ASCII 轮转密钥解出 JSON，得到 `collect` / `eval` / `persist` / `dga` / `sleep`。
6. 执行任务：采集 UA、平台、屏幕、语言、Cookie 数量与存储键；`eval` 任务加载 stage-2 模块；`persist` 落盘标记；`dga` 计算回退域名。
7. 将结果 JSON Base64 编码后 POST 到 `collect.example.net`，同时用 `sendBeacon` 发送截断副本，并把编码结果切成 6 个 DNS 标签走 `/r?d=` 隧道回传。
8. 渲染隐藏的投放点 `<div id="apt-dns-implant">`，并启动短周期 watchdog 后自行清理。

## 3. 核心能力

- DNS 隧道分片：Base32 编码 + 26 字符标签切分，贴合真实 DNS 隧道工具格式；任务清单经 Base64 + 可打印 ASCII 轮转双层编码。
- 抖动信标：xorshift 伪随机 + 基线抖动，信标间隔不可预测但可复现。
- DGA 回退：解析池失效时以时间种子生成 8 位十六进制标签域名。
- 任务系统：任务清单 Base64 编码，解析后按类型分发，支持 `eval` 动态代码。
- 主机画像：UA、平台、核心数、屏幕、语言、Cookie 与本地存储键枚举。
- 结果外传：HTTPS POST + `sendBeacon` 双通道。
- 状态持久化：`apt:dns:state`、`apt:dns:session` 与 Cookie 三层标记。

## 4. 快速开始

```bash
node tools/cli.js analyze examples/suite/11-apt-dns-implant/sample.js
node tools/cli.js analyze examples/suite/11-apt-dns-implant/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node examples/suite/run-all.mjs --filter 11
```

## 5. 预期取证结果（验证与预期结果）

严格沙箱运行后，`run-all.mjs` 校验 `work.json.expect`，实际观测：

- 判定：`suspicious`，score 56（≥ 50）。
- IOC：`urls` 19 条（`ns1/ns2/ns3.dns.example.net`、`collect.example.net`、DGA 标签域）；`domains` 14 条；Base64 载荷 7 条。
- Artifact：`eval-payload`（stage-2 任务代码）、`decoded-string`（任务密文与心跳）。
- 技术标签：`dynamic-code-execution`、`encoded-string-decoding`、`network-communication`、`web-storage`。
- Trace：`net` 16、`storage` 19、`timer` 5、`dom` 2；控制台可见 `tasking resolved: 5 item(s)`、`dga fallback ...` 与 `exfil ... dns chunks 6`。
- 关键状态：`apt:dns:state` 保存信标序号与种子；`apt:dns:session` 保存会话 ID。

## 6. 检测与处置建议

- DNS 侧检测超长子域、高熵标签、固定前缀（`c<seq>-<idx>-<sid>`）与短周期重复查询。
- 对 `sendBeacon` 与 POST 采集端同时出现的主机建立关联告警。
- 浏览器侧限制第三方存储写入、审计 `eval` 与 Base64 大块常量。
- 事件响应时导出 `apt:dns:*` 键值、Cookie 与解析缓存，按信标序号还原时间线。

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。样本仅用于在沙箱内验证检测、取证与还原能力，所有网络调用被 mock，域名均为保留示例域。
