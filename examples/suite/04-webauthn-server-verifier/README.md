# 04 WebAuthn Server Verifier — authentication

| 属性 | 值 |
| --- | --- |
| 编号 | 04 |
| 名称 | WebAuthn Server Verifier |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | authentication |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

面向 Node.js 依赖方的零依赖 WebAuthn 服务端校验 SDK。浏览器提交的注册/认证响应是不可信输入：challenge 可能被替换、origin 可能被伪造、CBOR 可能畸形、签名可能被重放。本 SDK 从字节层开始实现严格编解码与语义校验，覆盖从 `clientDataJSON`、`authenticatorData`、COSE 公钥到 ECDSA 验签、签名计数器回退检测的完整链路。

## 2. 架构与数据流

1. 服务端下发 challenge（base64url），并保存到一次性会话存储。
2. 浏览器返回 `clientDataJSON` + `attestationObject`（注册）或 `authenticatorData` + `signature`（认证）。
3. `base64urlDecode()` 严格解码；`decodeCbor()` 解析 attestationObject 与 COSE 公钥（映射返回 `Map`，避免整数标签被字符串化）。
4. `parseAuthenticatorData()` 提取 rpIdHash、UP/UV/BE/BS/AT/ED 标志、signCount、AAGUID、credentialId 与 COSE 公钥。
5. `parseClientDataJSON()` + `validateClientData()` 校验 type、challenge、origin、crossOrigin 与 tokenBinding。
6. `verifyRegistration()` 校验 rpIdHash、UP/UV、凭据数据与 attestation 格式，返回可落库的凭据。
7. `verifyAssertion()` 对 `authenticatorData || SHA-256(clientDataJSON)` 用 COSE 公钥验签，并拒绝 signCount 回退。
8. `CredentialStore` / `authenticate()` 完成查找、验签、计数器推进，失败时不修改存储。

## 3. 核心能力

- 严格 base64url：字母表、长度、canonical round-trip 三重校验
- 最小 CBOR 解码器：整数/负数/字节串/文本/数组/映射/标签/浮点/不定长
- CBOR 编码器：用于构造/迁移 COSE EC2 公钥与测试夹具
- COSE EC2 P-256 解析：kty/alg/crv 与 32 字节坐标校验，导出 JWK 公钥
- authenticatorData 解析：标志位、计数器、AAGUID、credentialId、扩展
- clientDataJSON：UTF-8 严格解码、JSON 结构、origin 规范化（非 localhost 强制 https）
- ECDSA P-256 验签：同时接受 DER 与 64 字节 P-1363 签名
- signCount 单调性校验（允许 0/0 的旧式认证器）
- 凭据存储：用户维度查询、序列化、计数器更新与回退拒绝

## 4. 快速开始

```bash
node examples/suite/04-webauthn-server-verifier/verify.mjs
node examples/suite/04-webauthn-server-verifier/demo.mjs   # 可选
```

```js
import { CredentialStore, authenticate, verifyRegistration } from './src/index.js'

const registered = verifyRegistration(registration, {
  challenge, origin: 'https://example.test', rpId: 'example.test',
  userVerification: 'required', attestationTypes: ['none'],
})
const store = new CredentialStore([{
  id: registered.credentialId,
  publicKey: registered.credentialPublicKey,
  signCount: registered.signCount,
  userHandle: 'dXNlci0x',
}])
const result = authenticate(store, assertion, {
  challenge, origin: 'https://example.test', rpId: 'example.test', userVerification: 'required',
})
console.log(result.verified, result.newSignCount)
```

## 5. 验证与预期结果

`verify.mjs` 使用 `node:assert/strict` 覆盖 13 组断言：base64url 严格性、CBOR 往返与截断、COSE 解析与算法拒绝、authenticatorData/扩展、clientData 绑定、注册成功、注册五类拒绝、断言验签、DER/P-1363 双签名、坏签名/rpId/计数器回退、凭据存储序列化、`authenticate` 原子推进与重放、畸形响应错误码。预期输出 `checks: 13/13`，`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- challenge 必须一次性、128 位以上、与服务端会话绑定；校验后立即删除。
- origin 使用白名单精确匹配，禁止 `*`；生产环境强制 HTTPS（本 SDK 仅放行 localhost HTTP）。
- 强制 `userVerification: 'required'` 的场景必须在注册与认证两侧同时开启；BE/BS 标志应结合 passkey 同步策略处理。
- 凭据存储必须持久化 `signCount`，并在同一事务内完成“验签成功 + 计数器推进”；多实例部署使用行锁/乐观锁。
- 对同一 credentialId 的并发认证请求做串行化，否则计数器回退检测会被并发绕过。
- 校验失败统一返回通用错误，避免泄露“凭据是否存在”等侧信道；服务端日志保留错误码用于审计。
- 定期轮换 RP ID 需谨慎（WebAuthn 凭据与 rpIdHash 绑定），迁移应使用 `relatedOrigins` 方案。

## 7. 说明

本作品为合成、可离线运行的商业级示例：RP ID、origin、用户与密钥均为虚构数据，不连接真实认证器、数据库或网络。SDK 可直接在 Node.js 24 中运行并用于集成参考。
