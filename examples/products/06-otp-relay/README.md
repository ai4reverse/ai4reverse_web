# 06 OTPRELAY — otp-relay

| 属性 | 值 |
| --- | --- |
| 编号 | 06 |
| 代号 | OTPRELAY |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | financial-services |
| 类别 | otp-relay |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 60） |

## 1. 产品定位

实时 OTP 中继产品：拦截短信/令牌验证码，通过 WebSocket 实时转发给操作员，支持 HTTP 回退与重连。

## 2. 完整攻击链

1. 注入 OTP 输入浮层
2. 监听输入并去抖
3. 通过 WebSocket 实时转发验证码
4. 连接失败时降级为 HTTPS 回传
5. 记录会话并在成功后跳转

## 3. 关键能力与实现

- WebSocket 实时中继
- OTP 捕获
- 自动重连与降级
- DOM 注入
- 本地会话缓存

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/06-otp-relay/sample.js
node tools/cli.js analyze examples/products/06-otp-relay/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/06-otp-relay/sample.js --events | head -40
node tools/cli.js restore examples/products/06-otp-relay/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 60
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：eval 解密端点、WebSocket 发送、fetch 回退、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- OTP 页面禁止第三方脚本并启用 CSP
- 监控异常 WebSocket 连接与非业务域名
- 对验证码输入使用隔离 iframe 与来源校验

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
