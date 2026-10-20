# 08 DRM Text Watermark SDK — drm-watermarking

| 属性 | 值 |
| --- | --- |
| 编号 | 08 |
| 名称 | DRM Text Watermark SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | drm-watermarking |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

用于电子书、文档、代码与订阅内容分发的隐形文本水印 SDK：把授权元数据编码为零宽字符序列，
散布在正文中，阅读体验不变，但复制、截图 OCR 后仍可提取授权链。帧带有规范 JSON、长度、
HMAC/SHA-256 标签与 Hamming(7,4) 纠错，能承受单个符号翻转，并对越界损坏、错误密钥和
不同来源水印混用给出明确拒绝。

## 2. 架构与数据流

1. 元数据对象 → 键排序的规范 JSON → UTF-8 字节。
2. 组装帧：magic `0xA7`、版本、flags（是否带密钥）、2 字节长度、payload、8 字节标签。
3. 帧字节 → 每字节两个半字节 → 每个半字节 Hamming(7,4) 编码为 7 位。
4. 位流映射为 `U+200B`（0）/ `U+200C`（1），首尾加 `U+2063`/`U+2062` 哨兵。
5. 按可见字符数量均匀散布符号，可见文本保持不变。
6. 提取时扫描哨兵区间，Hamming 解码并纠正单比特错误，校验标签与 JSON 后返回元数据。

帧开销固定 13 字节（5 字节头 + 8 字节标签），每个字节占 14 个零宽符号。

## 3. 核心能力

- `embedWatermark` / `extractWatermark` / `detectWatermark` / `stripWatermark` 全流程 API。
- 规范 JSON（键排序、递归）绑定 owner、licenseId、customer、时间戳等授权字段。
- 可选 HMAC-SHA-256 标签：错误密钥返回 `AUTH_FAILED`，无密钥返回 `AUTH_REQUIRED`。
- Hamming(7,4) 单比特纠错，并返回 `correctedCodewords` 供取证统计。
- `watermarkCapacity` 依据可见字符数、密度与固定开销给出最大 payload；超限返回 `CAPACITY_EXCEEDED`。
- 冲突检测：不同元数据/不同密钥生成不同符号流与指纹，互不干扰。
- `analyzeInvisible` 统计零宽/双向控制字符，可用于内容清洗与审计。

## 4. 快速开始

```bash
node examples/suite/08-drm-watermark-sdk/verify.mjs
```

```js
import { createWatermarker } from './src/index.js'

const drm = createWatermarker({ key: process.env.WATERMARK_KEY })
const marked = drm.embed(articleText, { owner: 'ACME', licenseId: 'LIC-42', customer: 'tenant-42' })
const { metadata, correctedCodewords } = drm.extract(copiedText)
```

## 5. 验证与预期结果

`verify.mjs` 共 10 项检查：Hamming 全半字节/全位置纠错、规范 JSON 稳定性、带密钥往返与可见文本不变、
无密钥检测/提取/清理、容量计算与超限拒绝、单符号篡改恢复、越界损坏拒绝、不同水印/密钥冲突检测、
零宽噪声与诱饵符号鲁棒性、帧长度与元数据校验失败关闭。
输出 `checks: 10/10`，退出码 0；`run-all.mjs` 要求检查数 ≥ 5 且全部通过。

## 6. 生产集成 / 防御建议

- 水印密钥仅保存在签发服务，按客户/批次派生，泄露后可定位来源。
- 对长文档可叠加多份水印（不同位置/不同密钥）提升抗裁剪能力。
- 提取前先做 Unicode 规范化与零宽字符审计；清洗会同时移除水印，需评估业务影响。
- 与访问日志、订单系统联动：提取到的 licenseId 应能反查到签发记录。
- 明确告知用户内容包含溯源水印，满足合规与隐私政策要求。

## 7. 说明

本作品为合成、可离线运行的商业级示例，不包含真实客户数据、密钥或网络访问；
所有水印与测试文本均在本地生成，仅用于内容溯源与 DRM 教学、集成参考与验收测试。
