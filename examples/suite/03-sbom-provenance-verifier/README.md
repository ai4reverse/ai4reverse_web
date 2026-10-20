# 03 SBOM / Provenance Verifier — supply-chain-security

| 属性 | 值 |
| --- | --- |
| 编号 | 03 |
| 名称 | SBOM / Provenance Verifier |
| 类型 | JS 安全 SDK |
| 等级 | 军用级 |
| 分类 | supply-chain-security |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

面向软件供应链安全的离线证据工具链。构建阶段由本 SDK 生成 CycloneDX 风格 SBOM 与 SLSA/in-toto 溯源信封；部署/发布阶段由同一 SDK 复算摘要、验证 DSSE 签名、约束 builder 白名单，并精确区分“缺失文件、多余文件、被篡改文件”。所有摘要与签名都由确定性 canonical JSON 驱动，可在隔离网络中复现和审计。

## 2. 架构与数据流

1. `buildSbom()` 接收 `path -> content` 文件集合，逐个异步计算 SHA-256，按路径排序生成 `components[]`、哈希、大小与依赖关系。
2. `sbomDigest()` 对“可复现投影”（组件名/版本/哈希/属性，去掉序列号与时间戳）计算摘要，作为 subject digest。
3. `createProvenance()` 组装 in-toto Statement（subject、predicateType、buildDefinition、runDetails），序列化为 canonical JSON，按 DSSE PAE 编码后用 HMAC-SHA256 或 ECDSA P-256 签名。
4. `verifyProvenance()` 校验信封结构、payload 解码、Statement 结构、可信 keyId、DSSE 签名、builder 白名单、谓词类型与 subject 摘要。
5. `verifyArtifacts()` 对交付物重新哈希，输出 `missing/extra/tampered` 三类差异。
6. `diffSbom()` 在两个 SBOM 之间做结构化比较，用于构建间漂移检测。

## 3. 核心能力

- 异步 SHA-256（WebCrypto `subtle.digest`）文件哈希与大小记录
- CycloneDX 1.5 风格 SBOM：`bomFormat/specVersion/serialNumber/metadata/components/dependencies`
- 确定性 subject digest：忽略序列号、时间戳与工具版本，重建可得同一摘要
- DSSE Pre-Authentication Encoding（`DSSEv1 <len> <type> <len> <payload>`）
- HMAC-SHA256（常数时间比较）与 ECDSA P-256 双签名模式，支持多签名与阈值
- SLSA builder 白名单：字符串 glob 或 `{id, version}` 精确锁定
- subject 名称/摘要绑定，防止“换 SBOM 复用签名”
- 文件级差异分类与确定性排序，便于 CI 门禁输出
- SBOM/溯源信封的 JSON 导入导出与结构校验

## 4. 快速开始

```bash
node examples/suite/03-sbom-provenance-verifier/verify.mjs
node examples/suite/03-sbom-provenance-verifier/demo.mjs   # 可选
```

```js
import { buildSbom, createProvenance, generateSigningKeyPair, verifyProvenance, verifyArtifacts } from './src/index.js'

const files = { 'dist/app.js': '...' }
const bom = await buildSbom({ name: 'demo-service', version: '1.0.0', files })
const key = generateSigningKeyPair('ci-builder')
const envelope = await createProvenance({ bom, key, builder: { id: 'https://ci.example.test/gha', version: '2.1.0' } })
const result = await verifyProvenance(envelope, {
  keys: [{ keyId: key.keyId, type: key.type, publicKey: key.publicKey }],
  trustedBuilders: ['https://ci.example.test/*'],
  bom,
})
const report = await verifyArtifacts(bom, files)
console.log(result.valid, report.ok)
```

## 5. 验证与预期结果

`verify.mjs` 使用 `node:assert/strict` 覆盖 11 组断言：SBOM 构建、摘要可复现性、HMAC 全绿（9 项检查）、ECDSA + PAE、builder 白名单/版本锁定、payload/签名/密钥篡改、subject 绑定、文件差异、SBOM diff、JSON 往返、输入校验。预期输出 `checks: 11/11`，`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- CI 中以只读方式采集构建产物，SBOM 与签名由独立发布账号持有密钥；建议使用硬件/KMS 托管 ECDSA 私钥与多签阈值。
- 消费端必须同时校验签名、builder 白名单与 subject digest；仅验签不校验 subject 会被“合法签名 + 错误产物”绕过。
- 将 `trustedBuilders` 写成精确 id 加版本，避免过宽 glob（如 `*`）。
- HMAC 仅适用于同一信任域内的共享密钥场景；跨组织分发请使用非对称签名。
- 发布门禁应以 `verifyArtifacts().missing/extra/tampered` 三个空数组为通过条件，并对 SBOM diff 做人工/自动评审。
- 保留 provenance 信封原始字节用于审计，避免二次序列化改变 payload。

## 7. 说明

本作品为合成、可离线运行的商业级/军用级示例：示例 builder、密钥与文件内容均为虚构，不访问真实文件系统、网络或制品库。SDK 可直接在 Node.js 24 中运行并用于集成参考。
