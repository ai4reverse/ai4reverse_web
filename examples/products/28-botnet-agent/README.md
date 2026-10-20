# 28 SWARM — botnet-agent

| 属性 | 值 |
| --- | --- |
| 编号 | 28 |
| 代号 | SWARM |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | botnet |
| 类别 | botnet-agent |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 55） |

## 1. 产品定位

浏览器僵尸网络节点：注册心跳、拉取 DDoS/点击任务，使用 Worker 并发执行并上报吞吐，支持任务 eval。

## 2. 完整攻击链

1. 注册节点并上报能力
2. 拉取任务列表
3. 按任务类型启动 Worker/定时器
4. eval 任务参数并执行
5. 上报吞吐与状态

## 3. 关键能力与实现

- 节点注册
- 任务拉取
- Worker 并发
- eval 任务
- 吞吐上报

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/28-botnet-agent/sample.js
node tools/cli.js analyze examples/products/28-botnet-agent/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/28-botnet-agent/sample.js --events | head -40
node tools/cli.js restore examples/products/28-botnet-agent/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 55
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：fetch 心跳、Worker、eval、localStorage、定时器
- **技术标签**：dynamic-code-execution、network-communication、worker-thread

## 6. 检测与处置建议

- 监控异常 Worker 数量与 CPU
- 检测 bot 注册/心跳端点
- 限制页面创建 Worker

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
