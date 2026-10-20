# 37 SANDBOXGHOST — sandbox-evasion

| 属性 | 值 |
| --- | --- |
| 编号 | 37 |
| 代号 | SANDBOXGHOST |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | evasion |
| 类别 | sandbox-evasion |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

沙箱规避器：延时执行、指针/可见性/开发者工具检测，只有“真实用户”交互后才解密并执行第二阶段。

## 2. 完整攻击链

1. 检测 visibility/pointer/用户激活
2. 测量计时与开发者工具窗口差
3. 延时等待分析窗口
4. 条件满足后 eval 解密阶段
5. 回传环境判定结果

## 3. 关键能力与实现

- 延时执行
- 交互检测
- devtools 检测
- 条件载荷
- 环境回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/37-sandbox-evasion/sample.js
node tools/cli.js analyze examples/products/37-sandbox-evasion/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/37-sandbox-evasion/sample.js --events | head -40
node tools/cli.js restore examples/products/37-sandbox-evasion/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：定时器、visibility/pointer、eval、fetch、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 沙箱内模拟真实交互与可见性
- 检测延时+交互门控
- 对 eval 阶段做行为阻断

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
