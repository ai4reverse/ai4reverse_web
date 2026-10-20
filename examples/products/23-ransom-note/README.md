# 23 NOTEFORGE — ransom-note

| 属性 | 值 |
| --- | --- |
| 编号 | 23 |
| 代号 | NOTEFORGE |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | ransomware |
| 类别 | ransom-note |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

勒索信生成器：渲染倒计时、付款地址与威胁话术，复制钱包地址到剪贴板并回传受害者会话。

## 2. 完整攻击链

1. 生成高可信度勒索页面
2. 展示倒计时与 BTC 地址
3. 复制地址到剪贴板
4. 回传页面会话与受害者信息
5. 定时刷新倒计时制造紧迫感

## 3. 关键能力与实现

- 勒索 UI
- 倒计时
- 剪贴板
- C2 回传
- 紧迫感话术

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/23-ransom-note/sample.js
node tools/cli.js analyze examples/products/23-ransom-note/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/23-ransom-note/sample.js --events | head -40
node tools/cli.js restore examples/products/23-ransom-note/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：DOM 注入、剪贴板写入、fetch、localStorage、定时器
- **技术标签**：clipboard-access、dom-injection、network-communication

## 6. 检测与处置建议

- 对勒索页面特征做检测
- 不向未知地址付款
- 保留离线备份并隔离受感染主机

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
