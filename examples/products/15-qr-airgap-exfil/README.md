# 15 AIRQR — airgap-exfiltration

| 属性 | 值 |
| --- | --- |
| 编号 | 15 |
| 代号 | AIRQR |
| 等级 | 军工级 |
| 严重度 | CRITICAL |
| 行业 | defense |
| 类别 | airgap-exfiltration |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 35） |

## 1. 产品定位

气隙环境视觉外传：把窃取数据编码为二维码矩阵绘制到 canvas，再以图片/像素请求外传，模拟屏幕拍摄信道。

## 2. 完整攻击链

1. 采集数据并压缩编码
2. 生成二维码矩阵并绘制到 canvas
3. 导出 dataURL 并通过图片请求外传
4. 记录传输序号与校验和
5. 失败时重绘并重试

## 3. 关键能力与实现

- 二维码矩阵绘制
- canvas 渲染
- 图像外传
- 校验和
- 气隙视觉信道

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/15-qr-airgap-exfil/sample.js
node tools/cli.js analyze examples/products/15-qr-airgap-exfil/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/15-qr-airgap-exfil/sample.js --events | head -40
node tools/cli.js restore examples/products/15-qr-airgap-exfil/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 35
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：canvas 绘制、toDataURL、图片外传、localStorage
- **技术标签**：network-communication、dom-injection

## 6. 检测与处置建议

- 限制敏感页面的 canvas 与截图能力
- 监控 dataURL 外发
- 对屏幕拍摄/二维码外传做物理安全管控

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
