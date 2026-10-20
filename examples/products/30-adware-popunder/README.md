# 30 POPUNDER — popunder

| 属性 | 值 |
| --- | --- |
| 编号 | 30 |
| 代号 | POPUNDER |
| 等级 | 商业级 |
| 严重度 | MEDIUM |
| 行业 | adware |
| 类别 | popunder |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

弹窗/弹下广告：捕获首次点击后打开隐藏窗口，定时重定向与历史操控，回传展示与点击。

## 2. 完整攻击链

1. 监听首次用户点击
2. window.open 打开弹下窗口
3. 定时重定向广告页
4. history 操控返回路径
5. 回传展示/点击事件

## 3. 关键能力与实现

- 弹窗/弹下
- 点击劫持
- 历史操控
- 广告轮换
- 事件回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/30-adware-popunder/sample.js
node tools/cli.js analyze examples/products/30-adware-popunder/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/30-adware-popunder/sample.js --events | head -40
node tools/cli.js restore examples/products/30-adware-popunder/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：window.open、fetch、history、DOM、定时器
- **技术标签**：network-communication、dom-injection

## 6. 检测与处置建议

- 浏览器弹窗拦截与用户手势校验
- 监控异常 window.open
- 广告域信誉过滤

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
