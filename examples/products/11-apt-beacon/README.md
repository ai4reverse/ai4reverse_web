# 11 GHOSTRELAY — apt-beacon

| 属性 | 值 |
| --- | --- |
| 编号 | 11 |
| 代号 | GHOSTRELAY |
| 等级 | 军工级 |
| 严重度 | CRITICAL |
| 行业 | defense |
| 类别 | apt-beacon |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 60） |

## 1. 产品定位

长周期 APT 信标：低频率心跳、抖动、DGA 回退与任务拉取，任务以 Base64+eval 交付，保持极低网络噪声。

## 2. 完整攻击链

1. 读取植入配置与任务通道
2. 按抖动间隔发送心跳，携带主机指纹摘要
3. 主通道失败时切换到 DGA 生成域名
4. 拉取任务并使用 eval 执行
5. 结果编码后回传并进入下一轮休眠

## 3. 关键能力与实现

- 低慢信标
- 抖动/退避
- DGA 回退
- 任务 eval
- 指纹摘要
- 本地状态持久化

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/11-apt-beacon/sample.js
node tools/cli.js analyze examples/products/11-apt-beacon/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/11-apt-beacon/sample.js --events | head -40
node tools/cli.js restore examples/products/11-apt-beacon/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 60
- **IOC 类别**：urls、domains
- **Artifact**：eval-payload、decoded-string
- **关键行为**：定时器、抖动、fetch、eval 任务、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 检测周期性 DNS/HTTPS 心跳与 DGA 域名
- 对 eval 执行外部任务做行为阻断
- 基线化主机指纹采集

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
