# 22 ASHWIPE — wiper

| 属性 | 值 |
| --- | --- |
| 编号 | 22 |
| 代号 | ASHWIPE |
| 等级 | 军工级 |
| 严重度 | CRITICAL |
| 行业 | cyber-operations |
| 类别 | wiper |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 45） |

## 1. 产品定位

擦除型载荷：清空本地存储、覆盖页面内容、阻断恢复入口，并通过远程载荷执行破坏逻辑。

## 2. 完整攻击链

1. 拉取并执行擦除模块
2. 清空 localStorage/sessionStorage 与 Cookie
3. 覆盖 DOM 与标题制造破坏效果
4. 注册 beforeunload 阻断离开
5. 回传执行状态

## 3. 关键能力与实现

- 数据擦除
- DOM 破坏
- 卸载阻断
- 远程模块执行
- 状态回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/22-wiper-dropper/sample.js
node tools/cli.js analyze examples/products/22-wiper-dropper/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/22-wiper-dropper/sample.js --events | head -40
node tools/cli.js restore examples/products/22-wiper-dropper/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 45
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：eval 载荷、存储清理、DOM 覆盖、fetch 回传
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 对批量存储清理与页面覆盖做检测
- 阻断远程 eval 模块
- 备份关键数据并限制浏览器存储权限

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
