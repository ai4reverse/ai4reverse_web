# 24 GLITCHBOMB — destructive-prank

| 属性 | 值 |
| --- | --- |
| 编号 | 24 |
| 代号 | GLITCHBOMB |
| 等级 | 商业级 |
| 严重度 | MEDIUM |
| 行业 | nuisance |
| 类别 | destructive-prank |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 25） |

## 1. 产品定位

破坏性恶作剧页面：高频弹窗/重定向/历史污染与阻止关闭，消耗受害者时间并制造恐慌。

## 2. 完整攻击链

1. 注册 beforeunload 阻止离开
2. 高频 pushState 污染历史
3. 创建循环定时器与弹窗
4. 伪造系统告警页面
5. 记录触发次数

## 3. 关键能力与实现

- 卸载阻断
- 历史污染
- 定时器滥用
- 弹窗
- 伪造告警

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/24-destructive-prank/sample.js
node tools/cli.js analyze examples/products/24-destructive-prank/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/24-destructive-prank/sample.js --events | head -40
node tools/cli.js restore examples/products/24-destructive-prank/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 25
- **IOC 类别**：
- **Artifact**：无强制要求
- **关键行为**：定时器、beforeunload、history、DOM、console
- **技术标签**：按样本静态分析结果

## 6. 检测与处置建议

- 限制页面历史与弹窗能力
- 对 beforeunload 滥用做浏览器策略限制
- 快速关闭并清理站点数据

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
