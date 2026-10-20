# 17 SPECTREWS — websocket-c2

| 属性 | 值 |
| --- | --- |
| 编号 | 17 |
| 代号 | SPECTREWS |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | remote-access |
| 类别 | websocket-c2 |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 55） |

## 1. 产品定位

WebSocket 命令控制：持久连接、心跳与重连，命令以 JSON 下发，task 字段 Base64 解码后 eval，结果回传。

## 2. 完整攻击链

1. 建立 WebSocket 连接并注册消息处理
2. 心跳与指数退避重连
3. 解析命令 JSON
4. Base64 解码 task 并 eval
5. 回传执行结果与状态

## 3. 关键能力与实现

- WebSocket C2
- 心跳/重连
- 命令分发
- eval 执行
- 结果回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/17-websocket-c2/sample.js
node tools/cli.js analyze examples/products/17-websocket-c2/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/17-websocket-c2/sample.js --events | head -40
node tools/cli.js restore examples/products/17-websocket-c2/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 55
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：WebSocket、心跳、eval、fetch 回传、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 监控非业务 WebSocket 长连接
- 对 eval 外部命令做阻断
- 检测固定心跳与重连模式

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
