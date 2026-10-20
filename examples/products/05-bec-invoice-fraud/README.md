# 05 LEDGERBEC — business-email-compromise

| 属性 | 值 |
| --- | --- |
| 编号 | 05 |
| 代号 | LEDGERBEC |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | enterprise |
| 类别 | business-email-compromise |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

商业邮件诈骗配套页面：在发票/付款页面替换收款账户，收集供应商与金额信息，回传并展示“付款成功”降低警觉。

## 2. 完整攻击链

1. 识别发票/付款页面结构
2. 替换 IBAN/账户与收款人名称
3. 监听提交并收集发票号、金额、供应商
4. 回传 C2 并写入本地缓存
5. 展示伪造的付款成功状态

## 3. 关键能力与实现

- DOM 表单篡改
- 发票数据采集
- HTTPS 回传
- 状态欺骗

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/05-bec-invoice-fraud/sample.js
node tools/cli.js analyze examples/products/05-bec-invoice-fraud/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/05-bec-invoice-fraud/sample.js --events | head -40
node tools/cli.js restore examples/products/05-bec-invoice-fraud/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：无强制要求
- **关键行为**：收款账户替换、表单采集、fetch 回传、localStorage
- **技术标签**：dom-injection、network-communication

## 6. 检测与处置建议

- 付款页面启用双人复核与账户白名单
- 对收款账户变更做带外验证
- 监控 DOM 中账户字段的非授权修改

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
