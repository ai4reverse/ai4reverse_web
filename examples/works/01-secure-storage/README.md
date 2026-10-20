# 01 Secure Storage SDK — secure-storage

| 属性 | 值 |
| --- | --- |
| 编号 | 01 |
| 名称 | Secure Storage SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | secure-storage |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

基于 PBKDF2-SHA-256 + AES-256-GCM 的认证加密存储 SDK，支持二进制/JSON、AAD 绑定、可移植信封与篡改检测。

## 2. 架构与数据流

1. 口令 → PBKDF2 派生 AES 密钥
2. 明文/JSON/二进制 → 随机 IV 加密
3. 信封携带 KDF 参数、salt、IV、AAD
4. 解密失败统一拒绝（错误口令/篡改/AAD 不符）

## 3. 核心能力

- PBKDF2 密钥派生
- AES-256-GCM 认证加密
- AAD 上下文绑定
- 可移植信封/口令恢复
- 错误分类（BAD_ENVELOPE/DECRYPT_FAILED）

## 4. 快速开始

```bash
node examples/works/01-secure-storage/verify.mjs
node examples/works/01-secure-storage/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 密钥永不出现在信封中
- 按租户使用 AAD 防跨租户重放
- 定期轮换口令并重加密

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
