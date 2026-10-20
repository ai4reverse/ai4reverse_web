# 16 SIGPROF — sigint-profiling

| 属性 | 值 |
| --- | --- |
| 编号 | 16 |
| 代号 | SIGPROF |
| 等级 | 军工级 |
| 严重度 | MEDIUM |
| 行业 | intelligence |
| 类别 | sigint-profiling |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

SIGINT 目标画像：采集设备、语言、时区、屏幕、字体、网络与交互节奏，生成稳定指纹并回传用于目标排序。

## 2. 完整攻击链

1. 采集设备与浏览器指纹
2. 测量交互节奏与页面停留
3. 生成稳定目标 ID
4. 编码回传并本地缓存
5. 按画像结果决定后续任务

## 3. 关键能力与实现

- 多维指纹
- 交互节奏测量
- 目标 ID 生成
- 低频回传
- 本地画像缓存

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/16-sigint-profiler/sample.js
node tools/cli.js analyze examples/products/16-sigint-profiler/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/16-sigint-profiler/sample.js --events | head -40
node tools/cli.js restore examples/products/16-sigint-profiler/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：指纹采集、定时器、fetch 回传、localStorage
- **技术标签**：network-communication、web-storage

## 6. 检测与处置建议

- 最小化暴露设备指纹
- 监控画像型 beacon
- 对敏感岗位终端做网络分段

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
