# 43 TRAPDOOR — anti-debugging

| 属性 | 值 |
| --- | --- |
| 编号 | 43 |
| 代号 | TRAPDOOR |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | evasion |
| 类别 | anti-debugging |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

反调试器：debugger 陷阱、计时差、函数栈/原生品牌检查与定时自毁逻辑，检测到分析后停止载荷。

## 2. 完整攻击链

1. 插入 debugger/计时陷阱
2. 检查 Error.stack 与原生函数品牌
3. 检测 devtools 窗口差
4. 判定分析环境后停止或继续
5. 回传判定结果

## 3. 关键能力与实现

- debugger 陷阱
- 计时检测
- 栈/品牌检查
- 条件执行
- 判定回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/43-anti-debug/sample.js
node tools/cli.js analyze examples/products/43-anti-debug/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/43-anti-debug/sample.js --events | head -40
node tools/cli.js restore examples/products/43-anti-debug/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：debugger、计时、栈检查、fetch、localStorage
- **技术标签**：network-communication、web-storage

## 6. 检测与处置建议

- 沙箱内保持正常计时与栈形态
- 检测 debugger 密集与计时异常
- 关联反调试模式

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
