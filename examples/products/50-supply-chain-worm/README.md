# 50 NPMWORM — supply-chain-worm

| 属性 | 值 |
| --- | --- |
| 编号 | 50 |
| 代号 | NPMWORM |
| 等级 | 军工级 |
| 严重度 | CRITICAL |
| 行业 | supply-chain |
| 类别 | supply-chain-worm |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 50） |

## 1. 产品定位

供应链蠕虫模拟：在安装脚本环境读取环境变量/令牌，回传后尝试以同作者身份发布，形成横向扩散。

## 2. 完整攻击链

1. 识别 CI/安装环境变量
2. 收集 npm token 与仓库凭据
3. 回传凭据与包元数据
4. eval 远程扩散模块
5. 尝试发布/修改包（模拟）

## 3. 关键能力与实现

- 环境变量采集
- 凭据窃取
- 包元数据篡改
- eval 扩散模块
- C2 回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/50-supply-chain-worm/sample.js
node tools/cli.js analyze examples/products/50-supply-chain-worm/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/50-supply-chain-worm/sample.js --events | head -40
node tools/cli.js restore examples/products/50-supply-chain-worm/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 50
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：环境采集、eval、fetch、localStorage
- **技术标签**：dynamic-code-execution、network-communication、web-storage

## 6. 检测与处置建议

- 安装脚本最小权限与令牌隔离
- npm token 短期化与来源绑定
- 供应链完整性校验与审计

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
