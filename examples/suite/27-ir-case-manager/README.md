# 27 · IR Case Manager（事件响应案件管理）

## 作品定位

面向蓝队值班组的事件响应（IR）案件台。它把「一次入侵事件」当作可审计的资产来管理：案件本身是 JSON 记录，证据按 SHA-256 内容寻址落盘，所有状态变化进入哈希链审计轨迹，处置结束后一键导出可交付的 Markdown 案件档案。

适用场景：SOC 一级值班受理 → 二级分析 → 处置闭环；军工/关基环境中需要「谁在什么时候改了哪个字段」可举证追溯的流程。

## 工作流

1. `create` 建案：登记标题、严重级别（P1–P4）、负责人、标签。级别决定 SLA 预算（P1 4h / P2 24h / P3 72h / P4 168h）。
2. `attach` 收证：任意文本/日志/报告按内容寻址写入 `objects/`，相同内容自动去重（同一字节流只有一份、只有一个摘要）。
3. `analyze` 取证：把样本交给平台 `analyzeSample` 跑完整流水线（静态 + 还原 + 无痕沙箱 + IOC + 杀伤链），报告 JSON 与原始样本同时入证据库，并在案件上写入判定摘要。
4. `update` 流转：`new → triaged → contained → eradicated`，状态机拒绝非法跳转；每次流转重算 SLA 状态（ok / at-risk / breached），违约即写入告警条目。
5. `close` 结案：必须给出处置结论，记录结案时间与事件驻留时长（dwell time），超时结案额外生成 `CLOSED_LATE` 告警。
6. `export` 出档：生成含概述、分析结论、证据表、处置时间线与审计链摘要的 Markdown 档案。

## 核心能力

- **内容寻址证据库**：`objects/<前两位>/<sha256>`，写入前先探测已存在文件，天然去重；同一案件内重复附件返回 `duplicate: true` 且不新增证据行。
- **SLA 计时**：以注入时钟计算 `dueAt`，用量超过预算 75% 记为 `at-risk`，过期为 `breached`，结案时回判并留痕。
- **队列优先级**：`优先级 = 级别权重 + 高危标签加成 + SLA 压力`，`list` 默认按该分数降序，值班员看到的就是「下一个该处理的」。
- **哈希链审计**：每条记录 `hash = SHA-256(seq, at, actor, action, caseId, dataHash, prev)`，`audit` 会重算整条链；只要有一个字段被改写，定位到具体下标与原因（`sequence` / `link` / `payload` / `hash`）。
- **数据完整性**：`store.json` 先写临时文件再 `rename`，避免半写状态；同一进程内的写操作串行化。
- **不可变结案**：已关闭案件禁止再改字段、再挂证据，必须先 `reopen`（重开本身也进审计链）。

## 快速开始

```bash
cd examples/suite/27-ir-case-manager

node app.mjs create --title '工作站勒索软件横向移动' --severity P1 \
  --assignee zhang.li --tags ransomware,lateral-movement --dir store

node app.mjs list --dir store
node app.mjs analyze IR-XXXXXXXXXX --file ./sample.js --dir store
node app.mjs attach  IR-XXXXXXXXXX --kind log --name proxy.log --file ./proxy.log --dir store
node app.mjs update  IR-XXXXXXXXXX --status triaged --dir store
node app.mjs close   IR-XXXXXXXXXX --resolution '隔离主机并轮换凭据' --dir store
node app.mjs export  IR-XXXXXXXXXX --dir store            # 打印档案
node app.mjs export  IR-XXXXXXXXXX --out case.md --dir store
node app.mjs audit --case IR-XXXXXXXXXX --dir store
```

案件 ID 由 `标题 + 序号 + 建立时间` 的内容摘要派生（`IR-` + 10 位十六进制），因此在同一时钟与同一建案顺序下可复现。

## 验证与预期结果

```bash
node app.mjs --self-test
```

自检在临时目录内使用固定的注入时钟（`2024-03-01T08:00:00Z`）建立两个案件并逐项断言：

| 断言 | 预期 |
| --- | --- |
| 建案 | 两个案件，ID 形如 `IR-[0-9A-F]{10}`，初始状态 `new`，SLA `ok` |
| 分析归档 | 判定为 `suspicious`/`malicious`，IOC 主机含 `c2.example.test`，写入 2 条证据 |
| 内容寻址去重 | 相同内容返回同一摘要且 `duplicate: true`，回读字节一致 |
| 优先级排序 | P1 勒索案件排在 P3 钓鱼案件之前，分数严格更高 |
| 状态机 | `triaged → eradicated` 被拒绝并提示 `illegal transition` |
| SLA | 推进 5 小时后状态变 `breached`，结案时写入 `CLOSED_LATE` 告警 |
| 结案 | 重复结案被拒绝（`already closed`） |
| 档案 | Markdown 含标题/分析结论/证据清单/处置时间线/审计链，含 IOC 与证据摘要前缀 |
| 审计链 | `ok=true`，条目数 ≥ 10，链头为 64 位十六进制 |
| 篡改检测 | 改写第 3 条记录 payload 后 `ok=false`，`brokenAt=2`，`reason=payload` |

通过时输出：

```
ir-case: cases=2 audit=10 chain=ok sla={"ok":1,"closed":1} tamper=payload@2
SELFTEST OK
```

## 生产集成与防御建议

- **接入点**：上游对接 SIEM/EDR 告警（建案）、邮件网关与代理日志（收证）；下游对接工单系统与对象存储（`objects/` 可直接换成 S3/MinIO，键名保持 SHA-256）。
- **审计链外锚**：把每日链头 `head` 推送到 WORM 存储或外部时间戳服务，本地库被整库替换时仍可举证。
- **权限**：`actor` 字段应来自网关认证身份而非客户端自述；结案与重开建议双人复核（maker-checker）。
- **时钟**：CLI 使用系统时钟；生产环境应注入 NTP 校准时钟，避免 SLA 判定漂移。
- **数据卫生**：证据对象可能含凭据/个人信息，导出档案前按密级裁剪；沙箱执行已固定 `network: deny`，不会产生真实外联。

## 说明

- 存储布局：`store.json`（案件 + 审计链）+ `objects/`（证据字节）。备份两者即可完整恢复。
- 已关闭案件的证据与字段只读，是刻意设计：IR 档案的价值在于事后可举证。
- 归档的分析报告保留平台生成时的真实时间戳与耗时，因此不同时刻运行会得到不同的证据摘要（审计链头不同），但自检断言与终端输出稳定；需要可复现的证据摘要时，请用固定输入加固定时钟入库。
- `--self-test` 不触碰真实网络，仅在 `os.tmpdir()` 下建临时库，结束后递归清理。
