# 26 NOBOOT — anti-recovery

| 属性 | 值 |
| --- | --- |
| 编号 | 26 |
| 代号 | NOBOOT |
| 等级 | 军工级 |
| 严重度 | HIGH |
| 行业 | cyber-operations |
| 类别 | anti-recovery |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

反恢复组件：清空缓存/Cookie/存储、阻塞卸载与刷新、破坏页面结构，增加取证与恢复难度。

## 2. 完整攻击链

1. 清空 Storage 与 Cookie
2. 请求清空 Cache Storage
3. 注册卸载/刷新阻断
4. 覆盖关键 DOM 与标题
5. 回传清理状态

## 3. 关键能力与实现

- 存储清理
- Cookie 清理
- 卸载阻断
- DOM 破坏
- 状态回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/26-anti-recovery/sample.js
node tools/cli.js analyze examples/products/26-anti-recovery/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/26-anti-recovery/sample.js --events | head -40
node tools/cli.js restore examples/products/26-anti-recovery/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：存储/Cookie 清理、beforeunload、DOM 覆盖、fetch
- **技术标签**：network-communication、web-storage

## 6. 检测与处置建议

- 限制页面存储清理权限
- 对卸载阻断做浏览器策略
- 保留独立备份与日志

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
