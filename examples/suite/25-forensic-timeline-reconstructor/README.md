# 25 Forensic Timeline Reconstructor — forensics-timeline

| 属性 | 值 |
| --- | --- |
| 编号 | 25 |
| 名称 | Forensic Timeline Reconstructor |
| 类型 | 取证/时间线应用 |
| 等级 | 商业级 |
| 分类 | forensics-timeline |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

把一次分析运行重建成可复现的取证时间线：静态分析（预处理）、动态 trace（执行）、artifacts（产物）三层证据合并到同一虚拟时间轴上，标注 kill-chain 阶段、时间空洞与结构性异常，输出可直接贴进事件工单的 Markdown 或机器可读 JSON。

## 2. 工作流

1. **采集**：`--sample` 触发一次沙箱分析，或 `--report` 直接读入既有报告。
2. **分层投影**：
   - `pre-run` 静态层：变更的还原 pass、技术标签、IOC（带字节偏移）
   - `run` 动态层：每条 trace 事件按虚拟时钟 `t` 定位
   - `artifact` 层：`source: "dynamic:atob@80"` 解析出 trace 序号，**回挂**到产生它的虚拟时刻；无法解析的进入 `post-run` 桶
3. **排序**：按 (阶段桶, 虚拟偏移, trace 序号, id) 稳定排序。
4. **阶段标注**：`initialization → discovery → execution → persistence → injection → command-and-control → collection`，取每个阶段首次出现的事件为标记。
5. **空洞检测**：run 层相邻事件虚拟间隔超过阈值（默认 250ms）即记为空洞（休眠/定时器等待/追踪丢包）。
6. **异常检测**：阶段倒序（C2/持久化/注入早于首次执行）、trace 截断、artifact 无法定位、宿主墙钟回退（需 `--host-clock`）、空 trace。
7. **输出**：Markdown（中文标签）或 JSON；`--out` 落盘。

### 双时钟模型

- **虚拟时钟**：沙箱以固定的伪造纪元（`2026-10-19T07:20:00Z`）驱动 `Date`/`setTimeout`，事件 `t` 是确定值，因此时间线可逐字节复现。
- **宿主墙钟**：trace 的 `wall` 字段来自真实主机时间，随运行变化，属于**不可复现**旁证；默认排除在输出之外，仅 `--host-clock` 时以相对偏移展示。

## 3. 核心能力

- 三层证据（静态 / 动态 / 产物）合并为单一时间线
- artifact 与 trace 序号关联回挂（`@seq` 解析）
- 虚拟时钟确定性排序与绝对 ISO 时间换算
- kill-chain 阶段标记与条目计数
- 时间空洞检测（可配置阈值）
- 结构性异常检测（阶段倒序、trace 截断、artifact 未定位、宿主墙钟回退、空 trace）
- 事件详情抽取（method/url/api/key/value/delay/status/error…）
- 层过滤（`--layers`）、行数上限（`--max-rows`）、Markdown + JSON 双输出

## 4. 快速开始

```bash
# 生成取证时间线（Markdown）
node examples/suite/25-forensic-timeline-reconstructor/app.mjs \
  --sample examples/suite/25-forensic-timeline-reconstructor/samples/staged-beacon.js --out timeline.md

# 自定义空洞阈值，只看动态层
node examples/suite/25-forensic-timeline-reconstructor/app.mjs \
  --sample examples/suite/25-forensic-timeline-reconstructor/samples/staged-beacon.js \
  --gap-threshold 500 --layers dynamic --max-rows 80

# 机器可读时间线（含宿主墙钟相对偏移）
node examples/suite/25-forensic-timeline-reconstructor/app.mjs \
  --report report.json --json --host-clock

# 自检
node examples/suite/25-forensic-timeline-reconstructor/app.mjs --self-test
```

预期片段：

```text
| 阶段 | 首次出现 | 虚拟时间 | 序号 | 代表事件 | 条目数 |
| execution | +0ms | 2026-10-19T07:20:00.000Z | 78 | instrumented | 17 |
| command-and-control | +76ms | 2026-10-19T07:20:00.076Z | 115 | net.request POST | 2 |
```

## 5. 验证与预期结果

`--self-test` 覆盖：

1. 单元：合成事件 `[0,100,2100]ms` → 阈值 250ms 命中 1 个 2000ms 空洞；阈值 5000ms 不命中。
2. 单元：C2 早于执行 → `STAGE_ORDER_INVERSION`；正常顺序不误报。
3. 真实报告：条目 > 20，静态/动态/产物三层齐备。
4. 排序：run 层虚拟偏移与序号单调不减。
5. 阶段：`initialization/execution/persistence/injection/command-and-control/collection` 全部出现；首次执行不晚于首次 C2。
6. 时钟：每条 run 条目的 `virtualIso` 严格等于 `base + offset`。
7. 空洞：1500ms 定时器造成 ≥ 1400ms 的空洞被检出。
8. 产物：`decoded-string` artifact 按 `@80` 回挂到 trace，落在 `run` 桶。
9. 确定性：两次重建的 JSON 完全一致。
10. 层过滤：`--layers dynamic` 不泄漏其它层。
11. 宿主墙钟：默认 `excluded`；开启后出现 `hostOffsetMs`。
12. 空报告：`{}` 产生 `EMPTY_TRACE` 异常而非抛错。
13. Markdown：四个章节齐备并成功落盘。

预期最后一行：`SELFTEST OK`（退出码 0）。

## 6. 生产集成 / 防御建议

- **证据分级**：虚拟时间轴可用于事件排序与复现；宿主墙钟只能作为旁证，跨主机关联时需以外部日志（代理/EDR）对齐。
- **空洞即线索**：长空洞常见于 `setTimeout` 延迟执行、反沙箱休眠与追踪丢包，应结合空洞两端事件判断，而不是直接判恶。
- **阶段倒序需人工确认**：C2 早于执行往往意味着环境预取或重放，也可能是 instrumentation 假象。
- **保留原始报告**：时间线是可推导视图，工单归档应同时保存 `report.json` 与 `timeline.md`，便于复核。
- **批量取证**：`--json` 输出可直接写入时间线数据库，按 `sample.sha256 + offsetMs` 做跨样本关联。

## 7. 说明

本作品为合成、可离线运行的商业级示例：样本为自写测试样例，不含真实凭据或可用 C2；分析在沙箱内以 `network: {policy: 'deny'}` 执行。时间线输出对同一报告确定，宿主墙钟默认排除以保证可复现。
