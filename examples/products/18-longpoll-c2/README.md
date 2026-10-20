# 18 POLLC2 — http-c2

| 属性 | 值 |
| --- | --- |
| 编号 | 18 |
| 代号 | POLLC2 |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | remote-access |
| 类别 | http-c2 |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 55） |

## 1. 产品定位

HTTP 长轮询 C2：周期拉取任务、执行、确认；带退避、任务去重与离线队列，适合受限网络。

## 2. 完整攻击链

1. 拉取 /task 长轮询接口
2. 解析并去重任务
3. Base64 解码并 eval
4. 提交 ACK 与结果
5. 按退避策略进入下一轮

## 3. 关键能力与实现

- 长轮询
- 任务去重
- eval 执行
- ACK
- 退避

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/18-longpoll-c2/sample.js
node tools/cli.js analyze examples/products/18-longpoll-c2/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/18-longpoll-c2/sample.js --events | head -40
node tools/cli.js restore examples/products/18-longpoll-c2/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 55
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：fetch 轮询、eval、ACK、localStorage、定时器
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 监控周期性 task 拉取
- 关联 ACK 与命令通道
- 对 eval 外部内容阻断

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
