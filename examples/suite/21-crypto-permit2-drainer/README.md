# 21 Permit2 Approval Drainer — wallet-drainer

| 属性 | 值 |
| --- | --- |
| 编号 | 21 |
| 名称 | Permit2 Approval Drainer |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | wallet-drainer |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 21` |

## 1. 作品定位

Permit2 授权盗取：构造 PermitSingle 类型化数据、诱导钱包签名、回传签名并替换剪贴板地址，附带交易诱导。

## 2. 完整攻击链

1. eval 加载 Permit2 模块
2. eth_requestAccounts
3. 构造 PermitSingle
4. eth_signTypedData_v4 获取签名
5. 回传并替换地址

## 3. 核心能力

- 钱包探测
- Permit2 typed-data
- 签名诱导
- 双通道回传
- 剪贴板替换

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/21-crypto-permit2-drainer/sample.js
node tools/cli.js analyze examples/works/21-crypto-permit2-drainer/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/21-crypto-permit2-drainer/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`malicious`，score ≥ 55。

## 6. 生产集成 / 防御建议

- 解析并展示 Permit2 授权范围
- 限制无限额度/长有效期
- 监控剪贴板地址替换

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
