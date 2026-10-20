# 19 MAILSPY — email-exfiltration

| 属性 | 值 |
| --- | --- |
| 编号 | 19 |
| 代号 | MAILSPY |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | enterprise |
| 类别 | email-exfiltration |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

邮件信道外传：把采集内容编码为表单字段，通过 sendBeacon/fetch 投递到 webmail 收集端，模拟邮件外发。

## 2. 完整攻击链

1. 采集表单/会话摘要
2. 编码为邮件正文与主题字段
3. 通过 sendBeacon 投递 webmail 端点
4. 失败时 fetch 回退
5. 记录投递状态

## 3. 关键能力与实现

- sendBeacon 外传
- 表单编码
- 失败回退
- 会话摘要
- 本地缓存

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/19-email-exfil/sample.js
node tools/cli.js analyze examples/products/19-email-exfil/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/19-email-exfil/sample.js --events | head -40
node tools/cli.js restore examples/products/19-email-exfil/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：sendBeacon、fetch、localStorage、DOM 数据采集
- **技术标签**：network-communication

## 6. 检测与处置建议

- 限制页面向 webmail 域投递数据
- 监控 sendBeacon 频率与负载
- 对浏览器会话数据做最小化

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
