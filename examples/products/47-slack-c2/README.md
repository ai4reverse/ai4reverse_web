# 47 SLACKHOOK — slack-c2

| 属性 | 值 |
| --- | --- |
| 编号 | 47 |
| 代号 | SLACKHOOK |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | remote-access |
| 类别 | slack-c2 |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 45） |

## 1. 产品定位

Slack Webhook C2：利用 incoming webhook 以业务告警为掩护回传数据，并从私有频道拉取任务。

## 2. 完整攻击链

1. 伪装为监控告警构造消息
2. Webhook 回传主机/凭据摘要
3. 从频道镜像拉取任务
4. Base64 解码并 eval
5. 缓存任务 id

## 3. 关键能力与实现

- Slack Webhook
- 告警伪装
- 任务拉取
- eval
- 缓存

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/47-slack-c2/sample.js
node tools/cli.js analyze examples/products/47-slack-c2/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/47-slack-c2/sample.js --events | head -40
node tools/cli.js restore examples/products/47-slack-c2/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 45
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：Slack webhook fetch、eval、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 监控异常 Slack webhook 调用
- 审查 webhook 创建与权限
- 阻断 eval 外部内容

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
