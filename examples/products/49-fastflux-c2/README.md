# 49 FASTFLUX — fast-flux

| 属性 | 值 |
| --- | --- |
| 编号 | 49 |
| 代号 | FASTFLUX |
| 等级 | 军工级 |
| 严重度 | HIGH |
| 行业 | command-and-control |
| 类别 | fast-flux |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

Fast-flux C2 轮换：维护多 IP/域名端点池，按请求失败率轮换并回退，降低基础设施被封禁的影响。

## 2. 完整攻击链

1. 加载端点池
2. 按健康度排序并选择端点
3. 失败时轮换到备用端点
4. 回传健康度统计
5. 持久化端点状态

## 3. 关键能力与实现

- 端点池
- 健康度轮换
- 失败回退
- 状态持久化
- 统计

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/49-fastflux-c2/sample.js
node tools/cli.js analyze examples/products/49-fastflux-c2/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/49-fastflux-c2/sample.js --events | head -40
node tools/cli.js restore examples/products/49-fastflux-c2/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls、ips
- **Artifact**：decoded-string
- **关键行为**：多端点 fetch、IP/域名、localStorage
- **技术标签**：network-communication、web-storage

## 6. 检测与处置建议

- 快速轮换域名/IP 关联分析
- 阻断已知 fast-flux 网段
- TLS 指纹关联

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
