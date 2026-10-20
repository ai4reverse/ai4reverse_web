# 14 PIXELVAULT — steganography

| 属性 | 值 |
| --- | --- |
| 编号 | 14 |
| 代号 | PIXELVAULT |
| 等级 | 军工级 |
| 严重度 | CRITICAL |
| 行业 | intelligence |
| 类别 | steganography |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 55） |

## 1. 产品定位

图片隐写载荷加载器：下载 PNG，从像素 alpha/LSB 提取 Base64 代码，拼接后 eval；用于规避内容检测。

## 2. 完整攻击链

1. 下载伪装图片
2. 绘制到 canvas 并读取像素
3. 按 LSB/alpha 通道提取比特流
4. 拼装 Base64 并解码
5. eval 执行第二阶段

## 3. 关键能力与实现

- LSB 隐写
- canvas 像素读取
- 载荷拼装
- eval 执行
- 失败重试

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/14-stego-image-loader/sample.js
node tools/cli.js analyze examples/products/14-stego-image-loader/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/14-stego-image-loader/sample.js --events | head -40
node tools/cli.js restore examples/products/14-stego-image-loader/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 55
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：fetch 图片、canvas 像素、eval 载荷、DOM
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 对图片 LSB 做隐写检测
- 限制页面 canvas 读取跨域图片
- 监控图片下载后立即 eval 的行为

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
