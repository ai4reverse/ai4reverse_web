# 09 E2EE Messaging SDK — secure-messaging

| 属性 | 值 |
| --- | --- |
| 编号 | 09 |
| 名称 | E2EE Messaging SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | secure-messaging |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

端到端加密 SDK：ECDH P-256 + HKDF 派生会话密钥，AES-256-GCM 加密并绑定双方 transcript 指纹。

## 2. 架构与数据流

1. 双方交换 ECDH 公钥
2. 派生同一会话密钥
3. 消息加密并绑定 transcript
4. 接收方解密/拒绝篡改

## 3. 核心能力

- ECDH 身份/会话
- HKDF 密钥派生
- AES-GCM 消息加密
- transcript/AAD 绑定
- 指纹与序列化

## 4. 快速开始

```bash
node examples/works/09-e2ee-messaging/verify.mjs
node examples/works/09-e2ee-messaging/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 公钥通过可信通道验证（TOFU/指纹）
- 定期轮换会话密钥
- 防止重放（消息序号/时间窗）

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
