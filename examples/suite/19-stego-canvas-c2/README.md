# 19 Steganographic Canvas C2 — steganographic-c2

| 属性 | 值 |
| --- | --- |
| 编号 | 19 |
| 名称 | Steganographic Canvas C2 |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | steganographic-c2 |
| 入口 | `sample.js` |
| 验证 | `node examples/suite/run-all.mjs --filter 19` |

## 1. 作品定位

画布隐写命令控制样本：把任务与回传数据编码进图片像素最低有效位（LSB），
本地通过 Canvas `ImageData` 逐位还原并执行阶段二，外传数据同样藏回像素后以
`dataURL` 上传。用于验证隐写载荷提取、画布行为检测与 JSVMP 之外的另一种
“保护/隐蔽”路线。

## 2. 完整攻击链

1. 从 CDN 拉取伪装成 `tile/frame-*` 的载体图片（沙箱内由 mock 路由返回）。
2. 创建 canvas 并绘制载体，读取 `ImageData` 像素。
3. 按 LSB 逐位拼装任务字节，校验帧头/长度后还原 Base64 任务。
4. `eval` 执行阶段二（示例为日志/存储写入）。
5. 把主机信息写回像素，`toDataURL` 后通过 `collect.stego.example.net` 外传。
6. 通过 `ack/frame` 端点确认帧接收，并在 `localStorage` 记录帧状态。

## 3. 核心能力

- 画布载体生成与 LSB 位级嵌入/提取
- `ImageData` 读写与帧头/长度校验
- 像素任务解包与阶段二执行
- 像素外传载体（dataURL / fetch）
- 帧状态持久化与 ACK

## 4. 快速开始

```bash
node tools/cli.js analyze examples/suite/19-stego-canvas-c2/sample.js
node tools/cli.js analyze examples/suite/19-stego-canvas-c2/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/suite/19-stego-canvas-c2/sample.js --events | head -40
```

## 5. 验证与预期结果

- **判定**：`malicious`，score ≥ 60
- **IOC 类别**：urls、domains
- **Artifact**：decoded-string / eval-payload / console-output
- **关键行为**：canvas 像素读写、eval 执行、net 外传、localStorage
- **技术标签**：dynamic-code-execution、encoded-string-decoding、network-communication、web-storage

## 6. 检测与处置建议

- 对图片 LSB/隐写做检测，尤其是下载后立即 canvas 读取并 eval 的链路。
- 限制页面跨域图片 canvas 读取，监控 `toDataURL` 后的外发。
- 对 `collect.stego.example.net` 类隐写收集域做阻断与情报关联。

## 7. 说明

本样本为合成演练样本，图片/任务均为内嵌合成数据，网络由沙箱 mock，不含真实 C2、凭据或破坏性操作。
