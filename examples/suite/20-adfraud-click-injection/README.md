# 20 Ad-Fraud Click Injection — ad-fraud

| 属性 | 值 |
| --- | --- |
| 编号 | 20 |
| 名称 | Ad-Fraud Click Injection |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | ad-fraud |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 20` |

## 1. 作品定位

广告欺诈点击注入：隐藏 iframe 广告位、合成点击、Cookie 填充与收益回传，形成可计量的点击农场。

## 2. 完整攻击链

1. eval 加载点击模块
2. 创建隐藏广告 iframe
3. 合成 click/历史参数
4. 回传点击与收益并持久化

## 3. 核心能力

- 隐藏 iframe
- 合成点击
- Cookie 填充
- 收益统计
- 参数轮换

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/20-adfraud-click-injection/sample.js
node tools/cli.js analyze examples/works/20-adfraud-click-injection/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/20-adfraud-click-injection/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 45。

## 6. 生产集成 / 防御建议

- 广告域可见性/交互校验
- 监控隐藏 iframe 与合成事件
- Cookie 归因完整性

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
