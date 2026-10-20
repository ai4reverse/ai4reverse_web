# 04 SWAPCLIP — clipboard-hijacker

| 属性 | 值 |
| --- | --- |
| 编号 | 04 |
| 代号 | SWAPCLIP |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | crypto |
| 类别 | clipboard-hijacker |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

剪贴板地址替换产品：轮询读取剪贴板，识别 BTC/ETH 地址并替换为攻击者地址，配合页面收款地址替换和回传。

## 2. 完整攻击链

1. 定时轮询 clipboard.readText
2. 正则识别 BTC/ETH/TRX 地址
3. 将匹配地址替换为攻击者地址并写回剪贴板
4. 记录替换次数与受害者地址到 C2
5. 在页面中替换显示的收款地址

## 3. 关键能力与实现

- 剪贴板轮询与覆盖
- 多链地址识别
- 页面地址替换
- 轻量级持久化

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/04-clipboard-swapper/sample.js
node tools/cli.js analyze examples/products/04-clipboard-swapper/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/04-clipboard-swapper/sample.js --events | head -40
node tools/cli.js restore examples/products/04-clipboard-swapper/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：间距轮询、剪贴板读写、正则匹配、fetch 回传
- **技术标签**：clipboard-access

## 6. 检测与处置建议

- 对剪贴板写入做用户确认与地址一致性提示
- 监控高频 clipboard.readText 调用
- 对收款地址做二次校验与短地址展示

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
