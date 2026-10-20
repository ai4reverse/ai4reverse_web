# 03 VAULTDRAIN — wallet-drainer

| 属性 | 值 |
| --- | --- |
| 编号 | 03 |
| 代号 | VAULTDRAIN |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | web3 |
| 类别 | wallet-drainer |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 60） |

## 1. 产品定位

Web3 钱包盗取产品：检测注入式钱包 Provider，诱导连接钱包并请求签名/授权，收集地址与链信息，通过多域名回传。

## 2. 完整攻击链

1. 检测 window.ethereum / 常见钱包 Provider
2. 调用 eth_requestAccounts 获取账户
3. 收集链 ID、余额、钱包类型并生成钓鱼授权请求
4. 编码后回传 C2，并替换页面收款地址
5. 通过 clipboard 覆盖复制地址，提高转账劫持成功率

## 3. 关键能力与实现

- 钱包 Provider 探测
- 账户/链信息采集
- 授权与签名诱导
- 剪贴板地址替换
- 多域名 C2 回退

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/03-crypto-drainer/sample.js
node tools/cli.js analyze examples/products/03-crypto-drainer/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/03-crypto-drainer/sample.js --events | head -40
node tools/cli.js restore examples/products/03-crypto-drainer/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 60
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：eval 解密配置、钱包探测、fetch 回传、剪贴板写入
- **技术标签**：dynamic-code-execution、clipboard-access、network-communication

## 6. 检测与处置建议

- 钱包连接页使用独立域名并校验 EIP-1193 Provider 来源
- 对 approve/permit 请求显示完整目标地址与额度
- 监控剪贴板写入与地址替换行为

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
