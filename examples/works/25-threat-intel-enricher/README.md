# 25 Threat-Intel Enricher — threat-intelligence

| 属性 | 值 |
| --- | --- |
| 编号 | 25 |
| 名称 | Threat-Intel Enricher |
| 类型 | 完整应用 |
| 等级 | 商业级 |
| 分类 | threat-intelligence |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

离线 IOC 富化器：从分析报告提取域名/URL，匹配本地情报源，输出家族、置信度、信誉与标签。

## 2. 工作流

1. 分析样本得到 IOC
2. 匹配 feed（含父域）
3. 计算信誉/置信度
4. 输出富化结果

## 3. 核心能力

- IOC 提取
- 本地情报匹配
- 父域回退
- 信誉分级
- JSON/表格输出

## 4. 快速开始

```bash
node examples/works/25-threat-intel-enricher/app.mjs --self-test
node examples/works/25-threat-intel-enricher/app.mjs --help
```

## 5. 验证与预期结果

`--self-test` 在临时目录中运行完整流程并校验输出，成功时打印 `SELFTEST OK`；`run-all.mjs` 要求退出码为 0。

## 6. 生产集成 / 防御建议

- 定期更新离线 feed
- 对 unknown 做人工复核
- 与 SIEM/TIP 对接

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
