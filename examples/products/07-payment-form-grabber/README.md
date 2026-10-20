# 07 PAYGRAB — form-grabber

| 属性 | 值 |
| --- | --- |
| 编号 | 07 |
| 代号 | PAYGRAB |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | e-commerce |
| 类别 | form-grabber |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 60） |

## 1. 产品定位

支付表单抓取产品：全局键盘监听 + 表单序列化，采集卡号、有效期、CVV、账单地址，加密后经 fetch 回传。

## 2. 完整攻击链

1. 全局注入 keydown/keyup 监听
2. 按字段名与 autocomplete 线索归类按键
3. 在提交时序列化表单并合并键击缓存
4. Base64 加密打包后回传
5. 失败载荷落盘 localStorage

## 3. 关键能力与实现

- 键击记录
- 表单序列化
- 支付字段识别
- 加密回传
- 本地重试

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/07-payment-form-grabber/sample.js
node tools/cli.js analyze examples/products/07-payment-form-grabber/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/07-payment-form-grabber/sample.js --events | head -40
node tools/cli.js restore examples/products/07-payment-form-grabber/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 60
- **IOC 类别**：urls
- **Artifact**：eval-payload
- **关键行为**：eval 配置、键盘监听、fetch 回传、localStorage
- **技术标签**：dynamic-code-execution、keylogging

## 6. 检测与处置建议

- 支付页使用受控 iframe 与最小化键盘监听面
- 监控全局 keydown 与异常表单序列化
- 对卡号/CVV 输入域启用浏览器隔离

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
