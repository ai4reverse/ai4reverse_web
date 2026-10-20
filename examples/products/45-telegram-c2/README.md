# 45 TELEBOT — telegram-c2

| 属性 | 值 |
| --- | --- |
| 编号 | 45 |
| 代号 | TELEBOT |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | remote-access |
| 类别 | telegram-c2 |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 50） |

## 1. 产品定位

Telegram Bot C2：使用 bot token 与 chat_id 拉取/发送消息，命令 Base64 解码后 eval，结果以消息回传。

## 2. 完整攻击链

1. 携带 bot token 调用 getUpdates
2. 解析命令并去重
3. Base64 解码命令并 eval
4. sendMessage 回传结果
5. 本地缓存 offset

## 3. 关键能力与实现

- Telegram Bot API
- 命令轮询
- eval 执行
- 消息回传
- offset 持久化

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/45-telegram-c2/sample.js
node tools/cli.js analyze examples/products/45-telegram-c2/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/45-telegram-c2/sample.js --events | head -40
node tools/cli.js restore examples/products/45-telegram-c2/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 50
- **IOC 类别**：urls、telegram
- **Artifact**：eval-payload、decoded-string
- **关键行为**：Telegram API fetch、eval、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 监控 Telegram Bot API 域名与 token 模式
- 阻断 eval 外部命令
- 情报关联 bot token/chat id

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
