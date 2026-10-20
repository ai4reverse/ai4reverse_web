# 08 License Verifier SDK — licensing

| 属性 | 值 |
| --- | --- |
| 编号 | 08 |
| 名称 | License Verifier SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | licensing |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

ES256 JWS 许可证 SDK：签发、验签、过期/生效时间、受众与产品绑定、时钟偏移，纯 WebCrypto 实现。

## 2. 架构与数据流

1. 授权方离线签发 license
2. 客户端内置公钥验签
3. 校验过期/受众/产品
4. 按 scope 授权功能

## 3. 核心能力

- ES256 签发/验签
- JWK 公私钥
- exp/iat/nbf 校验
- audience/product 绑定
- 时钟偏移
- JWS 解码

## 4. 快速开始

```bash
node examples/works/08-license-verifier/verify.mjs
node examples/works/08-license-verifier/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 私钥仅存于授权服务
- 短 TTL + 在线续期
- 吊销列表/版本绑定

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
