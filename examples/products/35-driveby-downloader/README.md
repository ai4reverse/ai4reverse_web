# 35 DRIVEBY — drive-by-download

| 属性 | 值 |
| --- | --- |
| 编号 | 35 |
| 代号 | DRIVEBY |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | malware-delivery |
| 类别 | drive-by-download |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

驱动下载器：伪造更新提示，自动创建下载链接/Blob 并触发保存，回传下载结果与主机信息。

## 2. 完整攻击链

1. 检测浏览器/平台并伪造更新 UI
2. 构造下载链接或 Blob
3. 自动点击触发下载
4. 回传下载开始/完成状态
5. 失败回退到直接跳转

## 3. 关键能力与实现

- 伪造更新 UI
- 自动下载
- Blob/Anchor 触发
- 状态回传
- 回退跳转

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/35-driveby-downloader/sample.js
node tools/cli.js analyze examples/products/35-driveby-downloader/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/35-driveby-downloader/sample.js --events | head -40
node tools/cli.js restore examples/products/35-driveby-downloader/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：更新 UI、Anchor/Blob、自动点击、fetch
- **技术标签**：network-communication、dom-injection

## 6. 检测与处置建议

- 浏览器下载策略与用户确认
- 监控自动下载触发
- 更新包签名校验

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
