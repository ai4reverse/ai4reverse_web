# 02 MAGEPAY-SKIMMER — card-skimming

| 属性 | 值 |
| --- | --- |
| 编号 | 02 |
| 代号 | MAGEPAY-SKIMMER |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | e-commerce |
| 类别 | card-skimming |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 60） |

## 1. 产品定位

电商结账页面窃取产品：Magecart 风格，监听结算表单与输入事件，提取卡号/CVV/有效期，通过图片像素与 fetch 双通道外传。

## 2. 完整攻击链

1. 注入结账页脚本并绑定表单与键盘事件
2. 读取卡号/CVV/有效期字段（多选择器回退）
3. 本地拼接载荷并以 Image 像素 + fetch 双通道外传
4. 使用无害外观的 favicon/图片请求规避日志审查
5. 缓存失败载荷到 localStorage 以重试

## 3. 关键能力与实现

- 表单抓取与键盘记录
- 图片像素隐蔽外传
- 失败重试与本地缓存
- 代码解混淆加载（eval）
- CSP 宽松路径利用

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/02-card-skimmer/sample.js
node tools/cli.js analyze examples/products/02-card-skimmer/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/02-card-skimmer/sample.js --events | head -40
node tools/cli.js restore examples/products/02-card-skimmer/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 60
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string、network-body
- **关键行为**：eval 加载、键盘监听、图片外传、localStorage 重试缓存
- **技术标签**：dynamic-code-execution、network-communication、web-storage

## 6. 检测与处置建议

- 结账页启用严格 CSP 与 Subresource Integrity，禁止内联脚本
- 监控指向非支付域的 Image/fetch 请求与 Base64 长参数
- 对输入域使用 Shadow DOM 隔离并校验脚本来源

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
