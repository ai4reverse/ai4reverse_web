# 29 CLICKFARM — click-fraud

| 属性 | 值 |
| --- | --- |
| 编号 | 29 |
| 代号 | CLICKFARM |
| 等级 | 商业级 |
| 严重度 | MEDIUM |
| 行业 | adtech-fraud |
| 类别 | click-fraud |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

点击欺诈引擎：隐藏 iframe 加载广告位、自动点击与刷新，伪造 referrer 与交互，回传点击统计。

## 2. 完整攻击链

1. 创建隐藏 iframe 与广告容器
2. 定时触发点击/滚动伪造互动
3. 轮换广告位参数规避去重
4. 回传点击与收益统计
5. 根据可见性调整频率

## 3. 关键能力与实现

- 隐藏 iframe
- 自动点击
- 参数轮换
- 收益统计
- 可见性规避

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/29-clickfraud/sample.js
node tools/cli.js analyze examples/products/29-clickfraud/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/29-clickfraud/sample.js --events | head -40
node tools/cli.js restore examples/products/29-clickfraud/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：iframe/广告 DOM、自动点击、fetch、定时器
- **技术标签**：network-communication、dom-injection

## 6. 检测与处置建议

- 监控隐藏 iframe 与自动点击
- 对广告域做可见性/交互校验
- 识别参数轮换模式

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
