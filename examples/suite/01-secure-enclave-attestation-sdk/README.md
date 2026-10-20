# 01 Secure Enclave Attestation SDK — attestation

| 属性 | 值 |
| --- | --- |
| 编号 | 01 |
| 名称 | Secure Enclave Attestation SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | attestation |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

面向机密计算/可信执行环境工作负载的远程证明 SDK。依赖方（Relying Party）在零信任架构中需要确认“远端运行的是哪一份代码、是否由可信飞地签发、是否针对本次会话”。本 SDK 将模块清单度量、challenge 绑定、策略约束与 ECDSA P-256 签名组合成可离线校验的报价（Quote），并以完整证据链返回每一层校验结论。

## 2. 架构与数据流

1. 依赖方调用 `createChallenge()` 生成 256 位 nonce 与过期时间，经带外通道下发。
2. 飞地内 `measureManifest()` 对每个模块计算 SHA-256，排序后折叠为根度量 `measurement.root`。
3. `createPolicy()` 生成策略哈希，绑定度量白名单、飞地白名单、必需声明与最大报价年龄。
4. `createAttestor().attest()` 组装报价体（含 nonce、测量值、模块列表、声明、策略哈希），计算 `claimsHash` 与 `reportData`，用 P-256 私钥签名。
5. `verifyAttestation()` 依次校验结构、声明摘要、reportData 绑定、度量根、签名、challenge、时效、重放与策略，返回 `checks[]` 证据链。
6. 只有全部检查通过时，报价才会被写入 `ReplayCache`，避免攻击者用未签名 nonce 污染缓存。

## 3. 核心能力

- SHA-256 模块清单度量、根摘要重算与篡改检测
- ECDSA P-256 确定性 canonical JSON 签名/验签
- challenge nonce、challenge id、过期时间三重绑定
- issuedAt/expiresAt/最大年龄 + 时钟偏移容差的新鲜度判定
- 有容量与 TTL 上界的单次使用重放缓存
- 策略绑定：度量白名单、飞地白名单、任意声明断言（`region`、`build` 等）
- 时间窗口化密钥环，支持签名密钥平滑轮换
- 失败封闭：畸形报价返回 `valid=false` 而非抛出，错误码稳定

## 4. 快速开始

```bash
node examples/suite/01-secure-enclave-attestation-sdk/verify.mjs
node examples/suite/01-secure-enclave-attestation-sdk/demo.mjs   # 可选
```

```js
import { createAttestor, createChallenge, createPolicy, generateEnclaveKeyPair, measureManifest, verifyAttestation } from './src/index.js'

const manifest = { 'app.wasm': 'binary-v1' }
const policy = createPolicy({ measurements: [measureManifest(manifest).root], requiredClaims: { stage: 'prod' } })
const { privateKey, keyId } = generateEnclaveKeyPair()
const attestor = createAttestor({ enclaveId: 'enclave-1', privateKey, keyId, policy, claims: { stage: 'prod' } })
const challenge = createChallenge({ ttlMs: 30_000 })
const quote = attestor.attest({ challenge, manifest })
console.log(verifyAttestation(quote, { challenge, policy }).valid)
```

## 5. 验证与预期结果

`verify.mjs` 使用 `node:assert/strict` 覆盖 13 组断言：canonical 序列化与度量稳定性、单字节变更、challenge 唯一性、完整报价全绿（16 项检查）、PEM/密钥环验签、模块/声明篡改、nonce 不匹配、过期与陈旧报价、重放拒绝、策略三要素拒绝、密钥轮换窗口、畸形输入失败封闭。预期输出 `checks: 13/13`，`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 将 challenge 一次性下发并绑定用户会话，禁止复用；nonce 至少 128 位。
- 策略、度量白名单与必需声明必须来自受控配置，且与报价中的 `policyHash` 强绑定。
- 验签公钥通过 `keyRing` 管理，设置 `notBefore/notAfter` 实现轮换，退役密钥只验历史报价。
- `ReplayCache` 在多实例部署时应替换为 Redis 等共享存储，TTL 不小于报价有效期。
- 生产环境请使用硬件背书的密钥（TPM/SEV-SNP/TDX Quote），本 SDK 的软件 P-256 签名仅承载协议层。
- 时钟必须使用可信 NTP；`clockSkewMs` 不要放大到分钟级。

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、真实飞地或可用 C2；密钥在进程内即时生成，仅在 `verify.mjs`/`demo.mjs` 的生命周期内存在。SDK 可直接在 Node.js 24 中运行并用于集成参考。
