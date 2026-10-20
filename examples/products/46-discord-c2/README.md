# 46 DISCORDHOOK — discord-c2

| 属性 | 值 |
| --- | --- |
| 编号 | 46 |
| 代号 | DISCORDHOOK |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | remote-access |
| 类别 | discord-c2 |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 50） |

## 1. 产品定位

Discord Webhook C2：把主机信息与命令结果封装为 embed 消息投递到 webhook，并轮询死信箱获取命令。

## 2. 完整攻击链

1. 收集主机信息
2. 构造 Discord embed 消息
3. POST 到 webhook 回传
4. 从死信箱拉取命令并 eval
5. 本地缓存消息 id

## 3. 关键能力与实现

- Webhook 回传
- Embed 封装
- 命令 eval
- 死信箱轮询
- 本地缓存

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/46-discord-c2/sample.js
node tools/cli.js analyze examples/products/46-discord-c2/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/46-discord-c2/sample.js --events | head -40
node tools/cli.js restore examples/products/46-discord-c2/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 50
- **IOC 类别**：urls、discordWebhooks
- **Artifact**：eval-payload、decoded-string
- **关键行为**：Discord webhook fetch、eval、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 监控 Discord webhook 域名与异常 embeds
- 阻断 eval 外部命令
- 情报关联 webhook id/token

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
