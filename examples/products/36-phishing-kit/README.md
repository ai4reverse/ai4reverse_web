# 36 PHISHKIT — phishing-kit

| 属性 | 值 |
| --- | --- |
| 编号 | 36 |
| 代号 | PHISHKIT |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | credential-phishing |
| 类别 | phishing-kit |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 55） |

## 1. 产品定位

钓鱼套件：仿冒登录页收集账号密码，实时中继 2FA 验证码，成功后跳转真实站点并回传凭据。

## 2. 完整攻击链

1. 渲染仿冒登录页并预填品牌元素
2. 捕获账号/密码
3. 通过 WebSocket/HTTP 中继凭据
4. 请求并转发 2FA 验证码
5. 成功后重定向真实站点

## 3. 关键能力与实现

- 仿冒登录页
- 凭据捕获
- 2FA 中继
- 双通道回传
- 成功跳转

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/36-phishing-kit/sample.js
node tools/cli.js analyze examples/products/36-phishing-kit/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/36-phishing-kit/sample.js --events | head -40
node tools/cli.js restore examples/products/36-phishing-kit/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 55
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：DOM 仿冒页、eval、WebSocket/fetch、localStorage
- **技术标签**：dynamic-code-execution、network-communication、dom-injection

## 6. 检测与处置建议

- 邮件网关与 URL 信誉
- FIDO2/抗钓鱼 MFA
- 品牌域名监控

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
