# 30 · SOC Metrics Dashboard（SOC 指标看板）

## 作品定位

SOC 负责人的周报/值班看板。它把「一堆告警与处置记录」压成五个可汇报的数字：**MTTD（发现有多快）、MTTC（遏制有多快）、MTTR（闭环有多快）、SLA 达标率、Top 技术点与 IOC**，并给出待处置队列与每日处置量，输出 ASCII 看板（贴工单/终端）、Markdown（贴周报/Wiki）与 JSON（喂 BI/告警）。

数据来源三选一：SIEM 导出的告警记录、样本目录（平台分析后自动生成记录）、或平台报告直接 `recordFromReport()` 映射（流水线集成）。

## 工作流

1. **摄入**：`--input records.json`（数组或 `{records:[...]}`）、`--samples a.js b.js`（跑 `analyzeSample` 后按分数推导时间线）、或 `--demo`。
2. **规范化**：`normalizeRecord` 校验判定/级别/时间顺序（`detectedAt ≥ firstSignalAt`、`resolvedAt ≥ containedAt|detectedAt`），并从时间戳推导 MTTD/MTTC/MTTR，调用方无法自带算错的持续时间。
3. **计算**：`computeMetrics(records, {asOf})` 产出窗口、总数、三组时延统计（mean/median/P90/min/max + 样本数）、SLA、判定与级别分布、来源分布、Top 技术点、Top IOC、每日处置量、积压与风险队列。
4. **呈现**：`renderAscii` / `renderMarkdown` / `JSON.stringify(metrics)`。
5. **判定口径**：MTTD 从「首个信号」到「告警」；MTTC 从「告警」到「遏制」；MTTR 从「告警」到「闭环」。SLA 只在已闭环记录上评估，未闭环且已超过 SLA 的记录进入 `overdueOpen`（积压风险）。

## 核心能力

- **百分比自洽**：所有占比统一按告警总数计算（`percent(count, total)`，保留一位小数），判定占比之和恒为 100%（自检断言）。
- **分位数口径固定**：P90 使用 nearest-rank（`ceil(0.9n)`），样本数随指标一起输出，避免「用 3 个样本的 P90 冒充整体」。
- **SLA 双视角**：`compliance`（已闭环达标率）+ `overdueOpen`（超期未闭环），并给出 `breachedIds` / `overdueIds` 便于点名。
- **风险队列**：未闭环且非 benign 的记录按「级别 → 分数」排序，值班员直接照单处理。
- **平台结果直采**：`recordFromReport(report, {detectedAfterMinutes, containedAfterMinutes, resolvedAfterMinutes})` 把 `verdict.level/score`、`static.techniques`、`static.iocs.urls[].host` 映射为记录，时间线由 SOC 管道提供（平台只知道「发生了什么」，不知道「什么时候被发现」）。
- **输出确定性**：所有输入为显式时间戳，`asOf` 可指定；同一份记录任何时候渲染结果一致。

## 快速开始

```bash
cd examples/suite/30-soc-metrics-dashboard

node app.mjs --demo --as-of 2024-03-05T06:40:00Z            # ASCII 看板
node app.mjs --demo --as-of 2024-03-05T06:40:00Z --markdown # Markdown 周报
node app.mjs --demo --json | jq '.mttr, .sla'
node app.mjs --input records.json --as-of 2024-04-01T03:00:00Z
node app.mjs --samples ./s1.js ./s2.js --json               # 样本直采
```

示例输出（截取）：

```
┌──────────────────────────────────────────────────────────────────┐
│ SOC METRICS DASHBOARD                                06:40Z      │
│ window 2024-03-05 → 2024-03-05 · 5 alerts                        │
├──────────────────────────────────────────────────────────────────┤
│ Alerts              5  resolved 4  open 1                        │
│ Malicious           3 (60%)  suspicious 1 (20%)                  │
│ MTTD signal→alert   mean 22m  median 20m  p90 40m  n=5           │
│ MTTR alert→close    mean 46.3m  median 45m  p90 80m  n=4         │
│ SLA compliance      75%  (3/4)  breached 1  overdue-open 1       │
└──────────────────────────────────────────────────────────────────┘
```

记录格式：

```json
{
  "id": "AL-0001",
  "title": "钓鱼凭据回传",
  "severity": "critical",
  "verdict": "malicious",
  "source": "email",
  "score": 78,
  "firstSignalAt": "2024-03-05T00:00:00.000Z",
  "detectedAt": "2024-03-05T00:05:00.000Z",
  "containedAt": "2024-03-05T00:15:00.000Z",
  "resolvedAt": "2024-03-05T01:05:00.000Z",
  "slaMinutes": 120,
  "techniques": ["T1566.002"],
  "iocHosts": ["sso-verify.example.test"]
}
```

## 验证与预期结果

```bash
node app.mjs --self-test
```

自检使用 5 条手写记录（时间偏移可心算：MTTD 5/15/20/30/40 分钟，MTTR 60/80/30/15 分钟，其中 1 条未闭环）：

| 断言 | 预期 |
| --- | --- |
| 总量 | 告警 5，已闭环 4，未闭环 1 |
| 判定占比 | malicious 60% / suspicious 20% / benign 20%，合计 100% |
| 级别 | critical 2 |
| MTTD | mean 22m，median 20m，P90 40m，样本 5 |
| MTTR | mean 46.3m（46.25），median 45m，P90 80m，样本 4 |
| MTTC | 样本 3（仅含遏制时间的记录） |
| SLA | 已闭环达标 3/4 = 75%，违约点名为 `AL-0002`（80m > 60m） |
| 超期未闭环 | `overdueOpen=1`，`AL-0005` 积压 120m > SLA 60m |
| Top 技术点 | `T1566.002` ×2，占告警 40% |
| Top IOC | `c2.example.test` ×2，占告警 40% |
| 来源分布 | `email.malicious=1`，`manual.resolved=0` |
| 每日处置量 | 单日 5 条 |
| 风险队列 | 仅 `AL-0005` |
| 非法记录 | 未知判定、`detectedAt` 早于 `firstSignalAt`、`resolvedAt` 早于告警、重复 ID 全部抛错 |
| 平台摄取 | 真实分析报告的 `verdict/score/IOC` 映射一致，`mttdMinutes=7` |
| 样本生成 | 2 个样本生成 2 条已闭环记录，IOC 含 `c2.example.test` |
| 渲染 | ASCII 含标题/MTTD/MTTR/SLA/Top/柱状图，Markdown 含各分节与明细，JSON 往返总量与 SLA 不变 |

通过时输出：

```
soc-metrics: alerts=5 verdicts={"malicious":60,"suspicious":20,"benign":20} mttd(mean/p90)=22/40 mttr(mean/p90)=46.3/80 sla=75%
top: technique=T1566.002 ioc=c2.example.test backlog=AL-0005
SELFTEST OK
```

## 生产集成与防御建议

- **接入**：`--input` 直接吃 SIEM 导出（可加一层字段映射成 `records`）；在线路径用 `recordFromReport()` 把 `analyzeSample` 的结果接进告警流，`detectedAfterMinutes` 由告警时间戳计算。
- **口径治理**：MTTD 的「首个信号」定义必须全组织统一（邮件网关首见 / EDR 首见 / 情报首见），否则跨团队数字不可比；建议把 `asOf` 固定为报表生成时刻，避免回溯改写历史看板。
- **阈值告警**：对 `mttd.p90Minutes`、`sla.compliance`、`overdueOpen` 设阈值告警，比单条告警更能反映团队是否在退化。
- **防御建议**：Top 技术点即检测规则的缺口清单 —— 若 `T1566.002` 持续居首，应优先在邮件网关做附件/链接策略；`topIocs` 应自动推送到阻断列表（防火墙/代理/DNS）。
- **数据卫生**：IOC 主机可能含内部资产名，导出前按密级裁剪；`renderMarkdown` 不含原始样本内容，只有统计与标识。

## 说明

- 时间线全部来自输入记录，看板本身不取系统时钟（`asOf` 显式传入），因此同一数据集在任何时候渲染一致。
- 「从样本生成记录」时的时间线是按判定分推导的**合成数据**，用于演示与容量评估，不应当作真实处置时效汇报。
- 百分比、均值均保留一位小数；样本数为 0 的指标返回 0 且 `samples: 0`，不做除零特判外的任何隐藏假设。
