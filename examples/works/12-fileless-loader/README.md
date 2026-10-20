# 12 Fileless Memory Loader — fileless-malware

| 属性 | 值 |
| --- | --- |
| 编号 | 12 |
| 名称 | Fileless Memory Loader |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | fileless-malware |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 12` |

## 1. 作品定位

无文件加载器：远程拉取编码阶段，在内存中解码/执行，不落盘、不持久化，仅回传执行状态。

## 2. 完整攻击链

1. fetch 编码阶段
2. atob/Function 解码执行
3. 内存中运行载荷
4. 回传结果并清理

## 3. 核心能力

- 远程阶段拉取
- Base64 解码
- Function/eval 内存执行
- 无文件持久化规避
- 执行回传

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/12-fileless-loader/sample.js
node tools/cli.js analyze examples/works/12-fileless-loader/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/12-fileless-loader/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`malicious`，score ≥ 50。

## 6. 生产集成 / 防御建议

- 阻断远程 eval/Function 链
- 监控下载后立即执行
- 内存扫描与行为检测

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
