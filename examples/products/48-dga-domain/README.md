# 48 DGAFALL — dga

| 属性 | 值 |
| --- | --- |
| 编号 | 48 |
| 代号 | DGAFALL |
| 等级 | 军工级 |
| 严重度 | HIGH |
| 行业 | command-and-control |
| 类别 | dga |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

域名生成算法：以日期/种子生成候选 C2 域，逐个解析并回退；用于抗封锁与基础设施轮换。

## 2. 完整攻击链

1. 按日期与种子生成 32 个候选域
2. 逐个构造 HTTPS 探测
3. 记录可达域并持久化
4. 回退到备用 TLD 集
5. 定期重新生成

## 3. 关键能力与实现

- DGA
- 候选域探测
- 抗封锁
- 状态持久化
- 定时轮换

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/48-dga-domain/sample.js
node tools/cli.js analyze examples/products/48-dga-domain/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/48-dga-domain/sample.js --events | head -40
node tools/cli.js restore examples/products/48-dga-domain/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：DGA 生成、多域 fetch、localStorage、定时器
- **技术标签**：network-communication、web-storage

## 6. 检测与处置建议

- DGA 检测与域名信誉
- 阻断高熵随机域
- 关联历史解析

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
