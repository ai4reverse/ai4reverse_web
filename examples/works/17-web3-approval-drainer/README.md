# 17 Web3 Approval Drainer — wallet-drainer

| 属性 | 值 |
| --- | --- |
| 编号 | 17 |
| 名称 | Web3 Approval Drainer |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | wallet-drainer |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 17` |

## 1. 作品定位

ERC-20 permit 钓鱼：连接注入式钱包、请求 permit 签名、回传账户与签名材料，并替换剪贴板地址。

## 2. 完整攻击链

1. eval 加载 permit 构建模块
2. 检测 window.ethereum
3. eth_requestAccounts 获取账户
4. eth_signTypedData_v4 请求授权
5. 回传签名并替换剪贴板

## 3. 核心能力

- 钱包探测
- 账户请求
- permit/typed-data 签名诱导
- 双通道回传
- 剪贴板地址替换

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/17-web3-approval-drainer/sample.js
node tools/cli.js analyze examples/works/17-web3-approval-drainer/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/17-web3-approval-drainer/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 45。

## 6. 生产集成 / 防御建议

- 对 permit/permit2 显示完整 spender/额度
- 限制无限授权
- 监控剪贴板地址替换

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
