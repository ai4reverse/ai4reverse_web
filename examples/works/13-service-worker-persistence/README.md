# 13 Service Worker Persistence — persistence

| 属性 | 值 |
| --- | --- |
| 编号 | 13 |
| 名称 | Service Worker Persistence |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | persistence |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 13` |

## 1. 作品定位

Service Worker 持久化：注册作用域 / 的 worker、预缓存资产、通过页面 beacon 建立长期驻留。

## 2. 完整攻击链

1. 注册 / 作用域 worker
2. 缓存关键资产
3. 页面与 worker 建立通信
4. 回传安装状态

## 3. 核心能力

- Service Worker 注册
- Cache Storage 预缓存
- 作用域劫持
- 页面 beacon
- 本地标记

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/13-service-worker-persistence/sample.js
node tools/cli.js analyze examples/works/13-service-worker-persistence/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/13-service-worker-persistence/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 30。

## 6. 生产集成 / 防御建议

- 限制第三方 SW 注册
- 审计 cache 内容与 scope
- 清理站点数据并注销 SW

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
