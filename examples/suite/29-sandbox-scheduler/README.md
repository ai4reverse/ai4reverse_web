# 29 · Sandbox Scheduler（沙箱调度器）

## 作品定位

把「一个沙箱一次执行」升级成「一台分析集群该有的调度层」。在提供恶意脚本分析能力的环境里，稀缺资源是**并发隔离实例**与**执行预算**；调度器负责在有限容量下决定「先跑谁、跑多久、失败怎么办、跑完是否干净」。

典型使用方：多租户样本分析平台（MSSP/集团 SOC）、病毒样本提交接口、批量回溯扫描。军事/关基场景下的重点是配额隔离（一个租户不能占满集群）与可核查的销毁记录。

## 工作流

1. **提交**：`submit({id, tenant, priority, source, timeoutMs, maxAttempts})`。提交即校验（空样本、重复 ID、非法优先级直接抛错）。
2. **准入**：`run()` 循环从队列取出「优先级最高且未超租户并发上限」的任务；准入顺序逐条记录在 `admissionOrder`（形如 `t-critical#1`），并发完成顺序不会污染这个判断。
3. **执行**：每次尝试新建一个 `TracelessSandbox`（`limits.timeoutMs` 为该任务实际获批预算），跑完立即 `dispose()`；运行结果分类为 `completed` / `limit:timeout` / `limit:<other>` / `error` / `host-error`。
4. **重试**：失败且属于 `retryOn`（默认 timeout/error/host-error）时，按 `baseMs * 2^(n-1)`（上限 `maxBackoffMs`）退避后重新排队；超过 `maxAttempts` 记为 `failed`。
5. **聚合**：输出计数器、租户视图（提交/接收/拒绝/运行/重试/完成/失败/超时/平均虚拟耗时/并发峰值）、拒绝清单、逐任务尝试明细。
6. **隔离**：任何一次尝试都必须 `disposed=true`，`disposalFailures>0` 会让 `allDisposed` 变 false。

## 核心能力

- **确定性优先级准入**：排序键 `(priority, submittedAt, id)`，priority 0=critical … 3=low；`capacity=1` 时准入顺序完全可预测，便于测试与审计。
- **租户配额**：`tenants: { acme: { concurrency: 1, queueLimit: 2, budgetMs: 400 } }` 可分别覆盖全局默认值；并发配额在准入时实时检查，避免「一个租户打满集群」。
- **排队上限与显式拒绝**：租户待跑任务数达 `queueLimit` 时 `submit` 返回 `{accepted:false, reason:'tenant-queue-full'}`，拒绝也进报告，不会静默丢弃。
- **超时预算裁剪**：`effectiveTimeoutMs = min(请求值, maxTimeoutMs, 租户 budgetMs)`，并下限保护到 50ms；报告里同时保留请求值与获批值，预算是否被削减一目了然。
- **退避策略**：指数退避、每次尝试单独记录 `backoffMs`（第 1 次失败 20ms、第 2 次 40ms…），总量汇总到任务与租户。
- **公平的并发核算**：`peakConcurrency` 分全局与租户两级，任何一次准入都会更新；`counters.attempts === counters.disposed` 是「无泄漏」的机器可校验条件。

## 快速开始

```bash
cd examples/suite/29-sandbox-scheduler

node app.mjs sample1.js sample2.js sample3.js \
  --tenant acme --priority high --timeout 150 --attempts 2

node app.mjs sample1.js --capacity 1 --quota 1 --queue-limit 4 --json

node app.mjs --self-test
```

示例输出：

```
b1.js     acme  high  completed  runs=1 retries=0 completed      budget=150ms disposed=true
spin.js   acme  high  failed     runs=2 retries=1 limit:timeout  budget=150ms disposed=true
c2.js     acme  high  completed  runs=1 retries=0 completed      budget=150ms disposed=true
completed=2 failed=1 rejected=0 attempts=4 retries=1 disposed=4 peak=1
```

作为库使用：

```js
import { createScheduler } from './app.mjs'

const scheduler = createScheduler({
  capacity: 4,
  tenants: { acme: { concurrency: 2, queueLimit: 16, budgetMs: 1000 } },
  maxAttempts: 3,
  backoffBaseMs: 25,
})
scheduler.submit({ id: 'a-1', tenant: 'acme', priority: 'critical', source, timeoutMs: 800 })
const report = await scheduler.run()
```

## 验证与预期结果

```bash
node app.mjs --self-test
```

自检用 4 个样本 / 2 个租户（benign、beacon、`while(true){}`、`null.x()`），三组调度器实例：

| 断言 | 预期 |
| --- | --- |
| 准入顺序 | `capacity=1` 时严格为 `t-critical#1, t-high#1, t-normal#1, t-closure#1` |
| 全局容量 | `peakConcurrency.global === 1` |
| 完成 | 4 个任务全部 `completed`，`allDisposed=true` |
| 重试 | 超时样本尝试 3 次（`maxAttempts=3`）、重试 2 次；异常样本尝试 2 次 |
| 退避 | `[20, 40]`，最后一次尝试不退避，任务累计退避 60ms |
| 超时预算 | 超时任务每次尝试 `effectiveTimeoutMs=120`；租户预算 400ms 把 5000ms 请求裁剪为 400ms |
| 租户配额 | `acme` 峰值 ≤ 1，`globex` 峰值 ≤ 2，全局峰值 ≤ 2 |
| 销毁 | `disposalFailures=0`，`attempts === disposed`（7/7） |
| 分类 | `limit:timeout` 3 次、`error` 1 次、`completed` 4 次 |
| 租户聚合 | `acme.retries=2`、`globex.completed=1` |
| 排队上限 | 5 次提交中前 2 次接收、后 3 次以 `tenant-queue-full` 拒绝 |
| 重试重入 | 容量 2 / 租户配额 2 下，重试任务的尝试序号严格为 `1,2,3`，租户并发峰值不超过配额 |
| 运行后禁止提交 | `submit` 抛 `cannot submit after run()` |

通过时输出：

```
scheduler: order=t-critical#1,t-high#1,t-normal#1,t-closure#1 attempts=7 retries=3 timeouts=3 disposed=7 rejected=3
peaks: global=2 tenants={"acme":1,"globex":1}
SELFTEST OK
```

## 生产集成与防御建议

- **接入点**：作为样本提交 API 与执行农场之间的中间层；`submit` 对应 HTTP 入队，`run()` 对应常驻工作进程，报告可直接进 Prometheus（`counters.*`、`peakConcurrency.*`）。
- **容量设置**：`capacity` 应 ≤ 宿主机可承载的 QuickJS 实例数（每实例受 `memoryBytes`/`stackBytes` 限制），宁可排队也不要超卖。
- **预算与公平**：给批量回溯类租户设置较小的 `budgetMs` 与 `concurrency`，保证交互式分析（critical）不被批量任务拖死；`queueLimit` 防止内存被无限任务占满。
- **重试纪律**：只对超时/异常重试；不要对「确定性崩溃」无限重试。平台侧建议对同一 `sha256` 聚合重试次数，避免放大攻击成本。
- **安全边界**：每次尝试独立沙箱 + 立即销毁是隔离的前提；`disposed=false` 应触发告警，而不是忽略。
- **审计**：`admissionOrder` 与逐次尝试明细可直接作为调度公平性的证据留存。

## 说明

- 自检把 `sleep` 注入为空实现，因此断言的是**退避计划**而非墙钟等待；生产默认使用真实 `setTimeout`。
- 退避期间任务已释放隔离槽位，由单独的定时器重新入队；`run()` 的主循环同时等待在飞任务与退避定时器，因此重试不会被提前丢弃，也不会出现同一任务两次尝试同时在飞。
- 虚拟耗时（`virtualMs`）随种子与沙箱实现变化，自检只断言与调度语义相关的量（分类、次数、预算、配额、销毁）。
