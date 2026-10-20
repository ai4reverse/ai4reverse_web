# 13 DEADDROP — dead-drop

| 属性 | 值 |
| --- | --- |
| 编号 | 13 |
| 代号 | DEADDROP |
| 等级 | 军工级 |
| 严重度 | CRITICAL |
| 行业 | intelligence |
| 类别 | dead-drop |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 60） |

## 1. 产品定位

死信箱任务解析器：从公开文本托管读取伪装为配置的任务，Base64 解码后 eval，失败时回退到备用通道。

## 2. 完整攻击链

1. 请求伪装成静态资源的任务文档
2. 解析 JSON 中的 task 字段
3. Base64 解码并 eval 执行
4. 回传执行结果
5. 主通道失败时切换备用镜像

## 3. 关键能力与实现

- 公开服务死信箱
- 任务解析
- eval 执行
- 多通道回退
- 结果回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/13-dead-drop-resolver/sample.js
node tools/cli.js analyze examples/products/13-dead-drop-resolver/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/13-dead-drop-resolver/sample.js --events | head -40
node tools/cli.js restore examples/products/13-dead-drop-resolver/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 60
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：fetch 任务、Base64 解码、eval、回传、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 监控对公开粘贴/代码托管的任务拉取
- 对 eval 外部内容做阻断
- 关联死信箱域名与历史任务

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
