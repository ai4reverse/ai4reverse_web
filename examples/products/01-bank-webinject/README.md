# 01 HELIOS-WEBINJECT — banking-trojan

| 属性 | 值 |
| --- | --- |
| 编号 | 01 |
| 代号 | HELIOS-WEBINJECT |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | financial-services |
| 类别 | banking-trojan |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 60） |

## 1. 产品定位

面向零售银行的浏览器注入产品：按目标银行匹配页面，注入虚假登录/OTP 浮层，捕获凭据并通过加密信道回传。

## 2. 完整攻击链

1. 加载器解密注入模板与目标银行清单
2. 匹配当前页面域名并渲染仿冒浮层
3. 监听 submit/输入事件获取账号、密码、OTP
4. Base64 编码后 POST 到 C2，并写入 localStorage 作为离线缓存
5. 提交成功后跳转到真实银行页面以降低受害者警觉

## 3. 关键能力与实现

- DOM 注入与样式伪装
- 表单/OTP 捕获
- 动态代码执行（注入模板探针）
- HTTPS C2 回传
- 本地持久化
- 反调试与异常吞噬

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/01-bank-webinject/sample.js
node tools/cli.js analyze examples/products/01-bank-webinject/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/01-bank-webinject/sample.js --events | head -40
node tools/cli.js restore examples/products/01-bank-webinject/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 60
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string、network-body
- **关键行为**：DOM 注入、localStorage 写入、fetch POST、eval 执行
- **技术标签**：dynamic-code-execution、dom-injection、network-communication

## 6. 检测与处置建议

- 对登录页做 DOM 完整性与 CSP 校验，禁止第三方脚本注入表单域
- 监控页面内动态创建的固定定位浮层与跨域 POST
- 对 OTP 页面启用 Trusted Types 与 SRI

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
