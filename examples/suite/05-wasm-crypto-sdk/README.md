# 05 WASM Crypto SDK — cryptography

| 属性 | 值 |
| --- | --- |
| 编号 | 05 |
| 名称 | WASM Crypto SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | cryptography |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

以 WebAssembly 承载密码原语的密钥分离与认证流 SDK。模块不使用 wabt/emscripten，而是由 `src/wasm-module.js` 以确定性字节方式手工汇编：同一份源码在任何平台生成完全相同的 402 字节模块，可计算 SHA-256 指纹做白名单、可审计、可复现。加载后先执行自检（WASM 结果 vs JavaScript 参考实现），再允许任何密钥材料进入。

## 2. 架构与数据流

1. `buildCryptoModule()` 按 WASM 二进制格式生成 type/function/memory/export/code 段，导出 `memory` 与 5 个原语。
2. `loadWasmCrypto()` 用 `WebAssembly.instantiate()` 实例化，校验导出与内存，运行自检向量，缓存单例 Promise。
3. `hash()`：把输入按 32 字节块异或进 8 路状态，调用 WASM `permute` 做 8 轮 ARX 置换；尾部 0x80 填充 + 64 位长度块，输出 32 字节。
4. `deriveKey()`：HKDF 式 `PRK = PRF(salt, ikm)`，再按 `T(i) = PRF(PRK, T(i-1) || info || i)` 扩展，支持任意 1..8160 字节长度。
5. `deriveSubkeys()`：以 `enc`、`mac`、`index` 等 label 派生相互独立的 256 位子密钥。
6. `seal()`：明文与 ARX keystream 在 WASM 线性内存中通过 `xorBuf` 分块异或；`tag = PRF(macKey, nonce || aad || ct || label)`。
7. `open()`：先常数时间比较 MAC（失败即 `AUTH_FAILED`），再解密，避免 padding-oracle 类侧信道。

## 3. 核心能力

- 确定性 WASM 模块构建：无工具链、无网络、字节级可复现
- 原语：`xor`（原地字节异或）、`rotl`、`mix(a,b)=rotl(a^b,13)+rotl(a,7)`、`permute`（8 lane ARX）、`xorBuf`（内存块异或）
- 实例化后自动自检：xor/xorBuf/rotl/mix/permute 与 JS 参考实现逐字节比对
- 模块 SHA-256 指纹 `MODULE_SHA256`、大小 `MODULE_SIZE`、`MODULE_BASE64`
- HKDF 式密钥派生，`info`/`salt` 变化必然改变输出
- 密钥分离：enc/mac/index 子密钥互不相等，主密钥不同则子密钥不同
- 认证流：16 字节随机 nonce、AAD 绑定、256 位 MAC、kid 绑定主密钥
- 分块处理：xor 采用 4KB 分块，支持大于单页 scratch 的负载
- 错误码：`BAD_INPUT/BAD_KEY/BAD_LENGTH/BAD_NONCE/BAD_ENVELOPE/AUTH_FAILED/WASM_*`

## 4. 快速开始

```bash
node examples/suite/05-wasm-crypto-sdk/verify.mjs
node examples/suite/05-wasm-crypto-sdk/demo.mjs   # 可选
```

```js
import { createWasmCrypto } from './src/index.js'

const crypto = await createWasmCrypto()
const master = Buffer.alloc(32, 0x5a)
const envelope = crypto.seal(master, 'secret payload', { aad: 'tenant-1' })
const opened = crypto.open(master, envelope, { aad: 'tenant-1', text: true })
const { enc, mac, index } = crypto.deriveSubkeys(master)
console.log(opened, enc.length, mac.length, index.length)
```

## 5. 验证与预期结果

`verify.mjs` 使用 `node:assert/strict` 覆盖 9 组断言：模块编译/字节确定性/指纹、原语与 JS 参考实现一致性、哈希确定性与雪崩、HKDF 固定向量与输入分离、子密钥独立性、认证流固定向量与 nonce 确定性、多分块负载、MAC 篡改/错误密钥/错误 AAD、畸形输入错误码。预期输出 `checks: 9/9`，`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 本构造用于密钥分离与信封完整性演示，不是 AES-GCM/ChaCha20-Poly1305 的替代品；合规数据请使用标准 AEAD，本 SDK 可用于子密钥派生与域分离。
- 主密钥必须来自 CSPRNG/KMS/HSM，长度 ≥32 字节；本 SDK 拒绝短于 16 字节的主密钥。
- nonce 必须唯一：`seal()` 默认使用 16 字节 CSPRNG nonce，禁止在固定密钥下重复使用同一 nonce。
- AAD 用于绑定租户/会话/文件元数据，解密时必须提供相同 AAD；`kid` 只做快速错钥识别，不能替代 MAC。
- 部署前将 `MODULE_SHA256` 写入允许清单，并在启动时比对，防止模块被替换。
- 不要把 WASM 自检当作侧信道证明；涉及远程攻击者的场景应使用经过审计的常数时间实现。

## 7. 说明

本作品为合成、可离线运行的商业级示例：模块字节在本地生成，不下载任何 WASM；密钥在 `verify.mjs`/`demo.mjs` 生命周期内即时生成，不包含真实凭据、网络请求或宿主破坏操作。SDK 可直接在 Node.js 24 中运行并用于集成参考。
