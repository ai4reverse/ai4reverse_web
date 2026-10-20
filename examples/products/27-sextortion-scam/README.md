# 27 SHAMESCAM — sextortion

| 属性 | 值 |
| --- | --- |
| 编号 | 27 |
| 代号 | SHAMESCAM |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | fraud |
| 类别 | sextortion |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 25） |

## 1. 产品定位

性勒索诈骗页面：伪造“已录制”证据、倒计时付款威胁，展示 BTC 地址并复制到剪贴板。

## 2. 完整攻击链

1. 渲染恐吓页面与倒计时
2. 伪造“录屏/摄像头”证据
3. 展示并复制 BTC 地址
4. 回传访问者信息
5. 超时后刷新页面维持压力

## 3. 关键能力与实现

- 恐吓话术 UI
- 倒计时
- 剪贴板
- 回传
- 页面刷新

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/27-sextortion-scam/sample.js
node tools/cli.js analyze examples/products/27-sextortion-scam/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/27-sextortion-scam/sample.js --events | head -40
node tools/cli.js restore examples/products/27-sextortion-scam/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 25
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：DOM 注入、剪贴板、fetch、localStorage、定时器
- **技术标签**：clipboard-access、dom-injection

## 6. 检测与处置建议

- 不付款、不点击、保留证据并上报
- 邮件网关拦截勒索模板
- 终端检测异常剪贴板写入

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
