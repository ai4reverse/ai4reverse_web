# 39 CLEANTRACE — anti-forensics

| 属性 | 值 |
| --- | --- |
| 编号 | 39 |
| 代号 | CLEANTRACE |
| 等级 | 军工级 |
| 严重度 | HIGH |
| 行业 | cyber-operations |
| 类别 | anti-forensics |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

反取证清理器：清空存储/Cookie/缓存、覆盖历史与页面痕迹、阻断卸载，并回传清理清单。

## 2. 完整攻击链

1. 清空 Storage 与 Cookie
2. 删除 Cache Storage 条目
3. 覆盖历史与页面标题
4. 阻断卸载/刷新
5. 回传清理清单

## 3. 关键能力与实现

- 存储清理
- 缓存清理
- 历史覆盖
- 卸载阻断
- 清理审计

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/39-anti-forensics/sample.js
node tools/cli.js analyze examples/products/39-anti-forensics/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/39-anti-forensics/sample.js --events | head -40
node tools/cli.js restore examples/products/39-anti-forensics/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：存储/Cookie/缓存清理、history、beforeunload、fetch
- **技术标签**：network-communication、web-storage

## 6. 检测与处置建议

- 限制页面清理能力
- 集中日志与网络侧证据
- 离线备份与端点取证

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
