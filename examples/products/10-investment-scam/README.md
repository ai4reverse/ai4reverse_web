# 10 PONZIPAGE — investment-scam

| 属性 | 值 |
| --- | --- |
| 编号 | 10 |
| 代号 | PONZIPAGE |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | financial-fraud |
| 类别 | investment-scam |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

虚假投资平台前端：伪造收益曲线与提现门槛，诱导连接钱包/充值，替换存款地址并回传受害者信息。

## 2. 完整攻击链

1. 渲染伪造收益与“限时”话术
2. 引导连接钱包或复制充值地址
3. 用攻击者地址替换存款地址
4. 收集账户/金额/联系方式并回传
5. 提现时展示手续费门槛以拖延

## 3. 关键能力与实现

- 伪造仪表盘
- 地址替换
- 剪贴板诱导
- 表单采集
- C2 回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/10-investment-scam/sample.js
node tools/cli.js analyze examples/products/10-investment-scam/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/10-investment-scam/sample.js --events | head -40
node tools/cli.js restore examples/products/10-investment-scam/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：无强制要求
- **关键行为**：DOM 仪表盘注入、剪贴板写入、fetch 回传、localStorage
- **技术标签**：clipboard-access、network-communication

## 6. 检测与处置建议

- 对投资平台做域名与牌照校验
- 对存款地址变更做二次确认
- 监控剪贴板写入与“客服”联系方式

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
