# 20 WASM Cryptominer — cryptominer

| 属性 | 值 |
| --- | --- |
| 编号 | 20 |
| 名称 | WASM Cryptominer |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | cryptominer |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 20` |

## 1. 作品定位

WASM 挖矿样本：加载 wasm 内核、实例化 WebAssembly、创建 Worker 线程并按心跳上报矿池份额。

## 2. 完整攻击链

1. eval 设置内核 URL
2. fetch wasm 并 instantiate
3. 创建 Worker 执行哈希
4. 定时上报份额/心跳

## 3. 核心能力

- WASM 加载/实例化
- Worker 线程池
- 矿池心跳
- 本地钱包配置
- eval 引导

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/20-wasm-cryptominer/sample.js
node tools/cli.js analyze examples/works/20-wasm-cryptominer/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/20-wasm-cryptominer/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 45。

## 6. 生产集成 / 防御建议

- 监控 wasm 实例化与 Worker 数量
- 阻断矿池域名
- 检测高 CPU 空闲页面

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
