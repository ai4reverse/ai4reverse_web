# 28 Detection Rule Generator — detection-engineering

| 属性 | 值 |
| --- | --- |
| 编号 | 28 |
| 名称 | Detection Rule Generator |
| 类型 | 完整应用 |
| 等级 | 商业级 |
| 分类 | detection-engineering |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

检测规则生成器：从分析报告生成 YARA、Sigma 风格规则与 JSON IOC 包，缩短从样本到检测的路径。

## 2. 工作流

1. 分析样本
2. 提取 URL/域名/哈希/技术
3. 生成规则与元数据
4. 写入检测仓库

## 3. 核心能力

- YARA 生成
- Sigma 生成
- IOC JSON 包
- 规则元数据
- 自检

## 4. 快速开始

```bash
node examples/works/28-detection-rule-generator/app.mjs --self-test
node examples/works/28-detection-rule-generator/app.mjs --help
```

## 5. 验证与预期结果

`--self-test` 在临时目录中运行完整流程并校验输出，成功时打印 `SELFTEST OK`；`run-all.mjs` 要求退出码为 0。

## 6. 生产集成 / 防御建议

- 规则先测试后上线
- 定期评估误报
- 与样本哈希绑定溯源

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
