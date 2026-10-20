# 10 Anti-Cheat Integrity SDK — anti-cheat-integrity

| 属性 | 值 |
| --- | --- |
| 编号 | 10 |
| 名称 | Anti-Cheat Integrity SDK |
| 类型 | JS 安全 SDK |
| 等级 | 军工级 |
| 分类 | anti-cheat-integrity |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

面向在线游戏与高价值客户端运行时的完整性 SDK：对射击、物理、渲染、结算等关键函数建立源码、
属性描述符与原型链基线，在运行期以确定性抽样守卫持续复核；同时检测热补丁、函数替换、
`Function.prototype.toString` 篡改、原型污染与稳健统计下的计时异常。所有命中会去重计数、
生成带摘要的遥测事件，并聚合为可用 ECDSA P-256 签名的完整性报告。

## 2. 架构与数据流

1. `captureBaseline(targets)` 记录每个关键函数的源码哈希、长度、属性描述符、自有属性、原型链，
   以及 Object/Array/Function/String 原型与自定义原型的属性集合和描述符指纹。
2. `createIntegrityMonitor` 绑定实时目标与基线，使用 mulberry32 确定性随机数控制抽样节奏，
   并通过 `maxInterval` 保证最长检测间隔。
3. 每次抽样检查源码哈希、描述符、自有属性、原型链、`Function.prototype.toString` 与原型快照。
4. 计时画像使用 median + MAD 计算预算，`timing(sample)` 仅在超出预算时产生 `TIMING_ANOMALY`。
5. 命中项按 `type::target` 去重计数；`createTelemetryEvent` 生成带 `digest`/`id` 的事件。
6. `buildIntegrityReport` 聚合严重度/类型统计与摘要，`signIntegrityReport` 输出 ES256 信封，
   服务端 `verifyIntegrityReport` 验签后方可采信。

## 3. 核心能力

- 源码基线：`hashFunctionSource` 使用启动时保存的原始 `Function.prototype.toString`，避免被篡改后失真。
- 描述符基线：writable/enumerable/configurable/getter/setter 与函数自有属性变更均可定位。
- 原型安全：内置原型 + 自定义原型快照，区分新增属性（污染）、删除属性（篡改）与描述符替换。
- 抽样守卫：`sampleRate` + `maxInterval` + 确定性种子，统计 `checks/skips`，可复现实验。
- 计时画像：median + MAD + 可调预算，`assessTiming` 与 `monitor.timing` 双层 API。
- 遥测：`anti-cheat.event.v1` 事件带序号、会话、严重度、证据与内容摘要。
- 报告：`anti-cheat.report.v1` 含 bySeverity/byType 汇总与 SHA-256 digest，可签名验签。
- 防误报：基线/计时测试覆盖 200–300 次良性抖动，0 误报预算内不产生任何 finding。

## 4. 快速开始

```bash
node examples/suite/10-anti-cheat-integrity-sdk/verify.mjs
```

```js
import { captureBaseline, createIntegrityMonitor, createTimingProfile } from './src/index.js'

const targets = [{ name: 'game.fireWeapon', fn: game.fireWeapon, owner: game, key: 'fireWeapon' }]
const monitor = createIntegrityMonitor({
  targets,
  baseline: captureBaseline(targets),
  sampleRate: 0.35,
  maxInterval: 8,
  seed: 0x5eed,
  timingProfile: createTimingProfile(calibrationSamples),
})
const { findings } = monitor.check()
const report = monitor.report({ sessionId: 'match-42' })
```

## 5. 验证与预期结果

`verify.mjs` 共 13 项检查：基线采集与序列化、200 次抽样零误报、热补丁检测与恢复后清零、
函数替换与自有属性篡改、描述符篡改、Object.prototype 污染与清理、自定义原型删除检测、
`Function.prototype.toString` 篡改、计时画像 300 次良性样本零误报、监控器 250 次计时/检查零误报、
遥测事件摘要稳定性、报告聚合与 ES256 签名/验签/篡改拒绝、监控器报告去重计数。
输出 `checks: 13/13`，退出码 0；`run-all.mjs` 要求检查数 ≥ 5 且全部通过。

## 6. 生产集成 / 防御建议

- 基线应在可信构建产物中生成并签名下发，避免攻击者替换基线本身。
- 抽样频率与性能预算需实机标定；检查函数应简短、无分配，避免影响帧率。
- 关键逻辑放入 Worker/WASM 并交叉校验，JS 层检测仅作为多层防御的一环。
- 遥测上报应批量、异步、失败可重试；报告签名私钥保存在服务端 HSM/KMS。
- 对命中事件设置分级处置：critical 立即断线/封禁，medium 采样复核并累计风控分。
- 定期用真实设备抖动数据回归计时预算，防止 GC/降频造成误报。

## 7. 说明

本作品为合成、可离线运行的军工级示例，不包含真实玩家数据、游戏客户端或网络访问；
所有基线、计时样本与签名密钥均在本地生成，仅用于反作弊完整性与遥测链路的教学、集成参考与验收测试。
