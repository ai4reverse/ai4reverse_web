# 23 SOC Triage Console — soc-triage

| 属性 | 值 |
| --- | --- |
| 编号 | 23 |
| 名称 | SOC Triage Console |
| 类型 | 完整应用 |
| 等级 | 商业级 |
| 分类 | soc-triage |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

面向 SOC L1/L2 的样本分诊台：一次分析输出判定、置信度、IOC、kill chain、artifact 与处置建议，并生成 Markdown/JSON 报告。

## 2. 工作流

1. 读取样本 → 严格沙箱分析
2. 聚合静态/动态/取证结果
3. 输出分诊表与报告
4. 交付 L2 深入分析

## 3. 核心能力

- 批量/单样本分诊
- Markdown/JSON 报告
- IOC/kill-chain 摘要
- 处置建议
- 自检

## 4. 快速开始

```bash
node examples/works/23-soc-triage-console/app.mjs --self-test
node examples/works/23-soc-triage-console/app.mjs --help
```

## 5. 验证与预期结果

`--self-test` 在临时目录中运行完整流程并校验输出，成功时打印 `SELFTEST OK`；`run-all.mjs` 要求退出码为 0。

## 6. 生产集成 / 防御建议

- 作为 SOC 一线标准入口
- 固定 seed 保证可复现
- 报告归档与工单联动

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
