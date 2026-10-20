# 07 Post-Quantum Hybrid KEM SDK — post-quantum-crypto

| 属性 | 值 |
| --- | --- |
| 编号 | 07 |
| 名称 | Post-Quantum Hybrid KEM SDK |
| 类型 | JS 安全 SDK |
| 等级 | 军工级 |
| 分类 | post-quantum-crypto |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

面向"先收集、后解密"威胁的混合密钥封装 SDK：经典半部分使用 P-256 临时 ECDH（WebCrypto），
后量子半部分使用从零实现的玩具 ML-KEM/Kyber 风格模-LWE 格 KEM，两者经 HKDF-SHA-256 合成，
并绑定接收方公钥、传输脚本和应用上下文。任一算法被攻破时，会话密钥仍由另一半保护。
所有格运算为 NTT-free 的 schoolbook 实现，便于审计与教学，不依赖第三方密码库。

## 2. 架构与数据流

1. 接收方生成 P-256 ECDH 密钥对与玩具 ML-KEM 密钥对，导出混合公钥。
2. 发送方生成临时 P-256 密钥，对接收方静态公钥做 ECDH。
3. 发送方对接收方格公钥做 KEM 封装，得到格密文与 32 字节共享秘密。
4. 以 `epk || pqCiphertext || recipient || contextHash` 的规范 JSON 作为 HKDF salt，
   `classical || pq` 作为 IKM，派生 32 字节会话密钥。
5. 接收方校验接收方指纹、上下文哈希，解封装格密文，重算 transcript 与 8 字节 tag。
6. 任一环节不符即拒绝（`WRONG_RECIPIENT` / `CONTEXT_MISMATCH` / `BAD_CIPHERTEXT` / `HYBRID_TAMPERED`）。

格 KEM 参数：`n=64`、`q=3329`、`rank=2`、CBD `eta=1`；消息编码为 64 个系数（0 或 q/2），
解密后压缩回 8 字节并校验 SHA-256 检查哈希，构成 FO 风格的隐式校验。

## 3. 核心能力

- 玩具 ML-KEM：确定性 XOF 生成公钥矩阵 A、CBD 噪声、`t = A·s + e`、`u = A^T·r + e1`、`v = t^T·r + e2 + m`。
- 负循环 schoolbook 乘法与模约减，无 NTT，便于逐行审计。
- 密文检查哈希：任意 `u`/`v` 篡改导致消息校验失败。
- 混合合成：HKDF-SHA-256，transcript 绑定 `epk`、格密文、接收方指纹与上下文。
- 8 字节 tag 快速拒绝混合信封篡改；ECDH 与格密钥均不出现在导出公钥中。
- 可移植编码：公钥 289B、私钥 257B、密文 417B（base64url/JSON）。

## 4. 快速开始

```bash
node examples/suite/07-pq-hybrid-kem-sdk/verify.mjs
```

```js
import { createHybridKem } from './src/index.js'

const alice = await createHybridKem()
const bob = await createHybridKem()
const { sharedSecret, envelope } = await alice.encapsulate(bob.publicKey, { context: 'session-42' })
const recovered = await bob.decapsulate(envelope, { context: 'session-42' })
// sharedSecret 与 recovered 相同；篡改 envelope.pq/tag 或换 context 均被拒绝
```

## 5. 验证与预期结果

`verify.mjs` 共 12 项检查：负循环乘法已知向量、CBD 采样边界、格 KEM 封装/解封装一致性、
固定种子确定性、密钥/密文编码往返、密文与错误私钥拒绝、畸形密钥拒绝、混合双方协商一致、
接收方/上下文绑定、混合信封篡改拒绝、缺少后量子半部分拒绝、公钥不含私钥材料。
输出 `checks: 12/12`，退出码 0；`run-all.mjs` 要求检查数 ≥ 5 且全部通过。

## 6. 生产集成 / 防御建议

- 本格 KEM 为教学级玩具（n=64），不可直接用于生产；生产环境应使用经过审计的 ML-KEM/Kyber 实现（如 liboqs、BoringSSL）。
- 经典半部分建议升级为 X25519；若 WebCrypto 不支持，再退回 P-256 ECDH。
- 服务端应绑定 transcript（会话 ID、协议版本、双方公钥）防止密钥替换与跨会话重放。
- 拒绝策略使用统一错误码，避免向攻击方泄露哪一半校验失败；记录审计日志时再细分。
- 密钥对定期轮换，长期静态公钥应通过证书或签名目录分发。

## 7. 说明

本作品为合成、可离线运行的军工级示例，不包含真实密钥、凭据、网络访问或生产密码学声明；
所有随机数与确定性测试向量均在本地生成，仅用于混合后量子 KEM 的教学、集成参考与验收测试。
