# 14 Prototype Pollution Rootkit — prototype-pollution

| 属性 | 值 |
| --- | --- |
| 编号 | 14 |
| 名称 | Prototype Pollution Rootkit |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | prototype-pollution |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 14` |

## 1. 作品定位

原型污染 rootkit：篡改 Object/Array 原型以劫持序列化与数组操作，并回传植入状态。

## 2. 完整攻击链

1. 定义 Object.prototype.toJSON
2. 包装 Array.prototype.push
3. 触发序列化验证
4. 回传 hooked 状态

## 3. 核心能力

- Object.prototype 污染
- Array.prototype 劫持
- 序列化拦截
- C2 回传
- 本地标记

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/14-prototype-pollution-rootkit/sample.js
node tools/cli.js analyze examples/works/14-prototype-pollution-rootkit/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/14-prototype-pollution-rootkit/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 30。

## 6. 生产集成 / 防御建议

- 冻结关键原型/使用 null 原型对象
- 完整性基线监控原型漂移
- 检测异常 toJSON/push

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
