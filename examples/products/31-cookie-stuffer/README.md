# 31 COOKIESTUFF — cookie-stuffing

| 属性 | 值 |
| --- | --- |
| 编号 | 31 |
| 代号 | COOKIESTUFF |
| 等级 | 商业级 |
| 严重度 | MEDIUM |
| 行业 | affiliate-fraud |
| 类别 | cookie-stuffing |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

联盟 Cookie 填充：隐藏 iframe/像素加载联盟链接，写入跟踪 Cookie，回传统计并定期刷新以延长归因。

## 2. 完整攻击链

1. 加载隐藏 iframe/像素
2. 访问联盟跟踪链接写入 Cookie
3. 定期刷新延长归因窗口
4. 回传填充次数与来源
5. 规避可见性检测

## 3. 关键能力与实现

- 隐藏 iframe
- Cookie 填充
- 归因延长
- 统计回传
- 可见性规避

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/31-cookie-stuffer/sample.js
node tools/cli.js analyze examples/products/31-cookie-stuffer/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/31-cookie-stuffer/sample.js --events | head -40
node tools/cli.js restore examples/products/31-cookie-stuffer/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：隐藏 iframe、Cookie/存储写入、fetch、定时器
- **技术标签**：network-communication、web-storage

## 6. 检测与处置建议

- 监控隐藏 iframe 与联盟域请求
- 校验归因来源与用户意图
- Cookie 分区与第三方限制

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
