# 08 PAYROLLX — payroll-fraud

| 属性 | 值 |
| --- | --- |
| 编号 | 08 |
| 代号 | PAYROLLX |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | enterprise |
| 类别 | payroll-fraud |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

薪资/ACH 劫持页面产品：篡改收款路由与账号字段，收集员工与金额数据，回传并保持页面显示一致。

## 2. 完整攻击链

1. 识别薪资/ACH 表格
2. 替换 routing/account 输入与表格单元格
3. 收集员工、金额、原账户与新账户
4. 回传 C2 并写入本地
5. 刷新后重新应用篡改（持久化视图）

## 3. 关键能力与实现

- DOM 表格篡改
- 数据采集
- 持久化伪装
- 加密回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/08-payroll-diversion/sample.js
node tools/cli.js analyze examples/products/08-payroll-diversion/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/08-payroll-diversion/sample.js --events | head -40
node tools/cli.js restore examples/products/08-payroll-diversion/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：无强制要求
- **关键行为**：表格字段替换、fetch 回传、localStorage
- **技术标签**：dom-injection、network-communication

## 6. 检测与处置建议

- 薪资系统启用字段级审计与变更告警
- 对 routing/account 修改要求双人审批
- 监控 DOM 篡改与重复注入

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
