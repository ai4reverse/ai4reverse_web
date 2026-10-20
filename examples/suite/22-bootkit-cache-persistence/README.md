# 22 Cache Bootkit Persistence — persistence

| 属性 | 值 |
| --- | --- |
| 编号 | 22 |
| 名称 | Cache Bootkit Persistence |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | persistence |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 22` |

## 1. 作品定位

缓存 bootkit：注册 Service Worker、污染 app-shell 缓存、注入恶意更新并持久化版本标记与心跳。

## 2. 完整攻击链

1. eval 加载 bootkit 模块
2. 注册/触发 SW 更新
3. 向 Cache 写入恶意 app-shell
4. 回传版本并持久化

## 3. 核心能力

- SW 注册/更新
- Cache 污染
- app-shell 劫持
- 心跳持久化
- 版本标记

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/22-bootkit-cache-persistence/sample.js
node tools/cli.js analyze examples/works/22-bootkit-cache-persistence/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/22-bootkit-cache-persistence/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 35。

## 6. 生产集成 / 防御建议

- SW 脚本签名与来源校验
- Cache 完整性与写入监控
- 定期清理/注销 SW

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
