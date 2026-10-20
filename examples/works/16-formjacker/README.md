# 16 Formjacker — formjacking

| 属性 | 值 |
| --- | --- |
| 编号 | 16 |
| 名称 | Formjacker |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | formjacking |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 16` |

## 1. 作品定位

表单劫持器：监听提交、改写 action 到攻击者端点，并把字段镜像到第二 C2。

## 2. 完整攻击链

1. 监听 document submit
2. 序列化表单字段
3. 改写 action 到收集端
4. 回传 C2 并缓存

## 3. 核心能力

- 表单提交钩子
- action 改写
- 字段序列化
- 双通道外传
- 本地缓存

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/16-formjacker/sample.js
node tools/cli.js analyze examples/works/16-formjacker/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/16-formjacker/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`malicious`，score ≥ 45。

## 6. 生产集成 / 防御建议

- CSP form-action 限制
- 监控表单 action 变更
- 对支付/登录页做 DOM 完整性

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
