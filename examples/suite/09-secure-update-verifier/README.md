# 09 Secure Update Verifier SDK — secure-update

| 属性 | 值 |
| --- | --- |
| 编号 | 09 |
| 名称 | Secure Update Verifier SDK |
| 类型 | JS 安全 SDK |
| 等级 | 军工级 |
| 分类 | secure-update |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

面向桌面客户端、PWA 与设备固件分发的安全更新校验 SDK：发布方用 ECDSA P-256 对更新清单签名，
客户端在安装前完成签名、有效期、产品/通道绑定、版本防回滚、密钥吊销、Merkle 文件树、
分块证明与产物哈希的全链路校验。任何一项失败都以稳定错误码拒绝，避免"部分校验通过即安装"。

## 2. 架构与数据流

1. 发布服务为每个文件计算 SHA-256、大小与可选分块 Merkle 根。
2. 文件描述符（path/size/sha256）哈希为叶子，构建文件 Merkle 树写入 `merkleRoot`。
3. 清单包含 product、channel、version、minVersion、issuer、keyId、时间窗口，规范 JSON 后 ES256 签名。
4. 客户端按 keyId 选择固定信任根，先检查吊销/生效期，再验签，再校验清单语义。
5. 版本必须高于已安装版本且不低于清单签名下限，否则 `ROLLBACK_REJECTED`。
6. 重算文件 Merkle 根，校验分块根与单块证明，最后校验下载产物的 SHA-256 与大小。
7. 通过后 `commit` 推进本地版本状态，形成防降级闭环。

## 3. 核心能力

- `generateUpdateKeys` / `signManifest` / `verifyManifest`：ES256 签发与验证。
- 规范 JSON 签名，字段顺序无关，防止序列化歧义。
- semver 比较（含预发布标识），支持签名 `minVersion` 下限与本地已安装版本双重防回滚。
- 信任根列表 + `revokedKeyIds` + `notBefore/notAfter`，覆盖密钥轮换与吊销。
- SHA-256 二叉 Merkle 树（奇数节点提升），`merkleProof`/`verifyMerkleProof` 提供单文件包含证明。
- `chunkHashes`/`createChunkProof`/`verifyChunkProof`/`verifyFileChunks` 支持分块下载与断点续传校验。
- 产物校验区分 `MISSING_ARTIFACT`、`SIZE_MISMATCH`、`HASH_MISMATCH`。
- `SecureUpdateVerifier` 封装信任根、时钟偏移与本地状态，`commit` 原子推进版本。

## 4. 快速开始

```bash
node examples/suite/09-secure-update-verifier/verify.mjs
```

```js
import { buildManifest, generateUpdateKeys, signManifest, verifyManifest } from './src/index.js'

const keys = await generateUpdateKeys()
const manifest = buildManifest({
  product: 'acme-client', channel: 'stable', version: '2.4.1', minVersion: '2.0.0',
  keyId: keys.keyId, files: [{ path: 'app.js', data: source, chunkSize: 1024 }],
})
const envelope = await signManifest(keys, manifest)
const result = await verifyManifest(envelope, {
  trustedKeys: [{ keyId: keys.keyId, publicJwk: keys.publicJwk }],
  product: 'acme-client', channel: 'stable',
  state: { version: '2.4.0' }, artifacts: { 'app.js': source },
})
```

## 5. 验证与预期结果

`verify.mjs` 共 11 项检查：Merkle 全叶子证明与篡改拒绝、签名清单与产物校验、篡改清单/签名/密钥拒绝、
过期/时钟偏移/未生效窗口、双重防回滚与 semver 比较、产品/通道绑定、吊销/过期/轮换信任根、
产物缺失/大小/哈希错误、分块根与单块证明、内部不一致清单失败关闭、有状态更新器提交与降级拒绝。
输出 `checks: 11/11`，退出码 0；`run-all.mjs` 要求检查数 ≥ 5 且全部通过。

## 6. 生产集成 / 防御建议

- 私钥保存在 HSM/KMS，签名服务与分发网络分离；客户端只内置公钥。
- 每个产品/通道独立密钥，密钥轮换时双密钥过渡并维护吊销列表。
- 强制校验 `minVersion` 与本地状态；对降级尝试上报遥测并锁定更新通道。
- 先验签再下载/解包，分块校验通过后才落盘；临时文件使用独立目录与权限。
- 时钟不可信的环境应结合单调计数器或服务器时间；保留签名清单与校验日志用于取证。

## 7. 说明

本作品为合成、可离线运行的军工级示例，不包含真实发布密钥、更新服务器或网络访问；
所有密钥、清单与产物均在本地生成，仅用于安全更新链路的教学、集成参考与验收测试。
