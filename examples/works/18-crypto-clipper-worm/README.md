# 18 Crypto Clipper Worm — clipboard-hijacker

| 属性 | 值 |
| --- | --- |
| 编号 | 18 |
| 名称 | Crypto Clipper Worm |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | clipboard-hijacker |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 18` |

## 1. 作品定位

加密地址剪贴板蠕虫：轮询剪贴板、替换 BTC/ETH 地址、持久化传播标记并回传窃取地址。

## 2. 完整攻击链

1. eval 加载剪贴板钩子
2. 正则识别 BTC/ETH
3. 替换为攻击者地址
4. 回传并持久化计数

## 3. 核心能力

- 剪贴板轮询
- 多链地址识别
- 地址替换
- 传播标记
- C2 回传

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/18-crypto-clipper-worm/sample.js
node tools/cli.js analyze examples/works/18-crypto-clipper-worm/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/18-crypto-clipper-worm/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 45。

## 6. 生产集成 / 防御建议

- 剪贴板地址二次确认
- 监控高频 readText/writeText
- 对加密地址做校验提示

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
