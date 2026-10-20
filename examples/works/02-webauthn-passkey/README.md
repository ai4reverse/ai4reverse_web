# 02 WebAuthn Passkey SDK — authentication

| 属性 | 值 |
| --- | --- |
| 编号 | 02 |
| 名称 | WebAuthn Passkey SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | authentication |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

Passkey 注册/认证全流程 SDK：选项构造、clientData 绑定校验、authenticatorData 解析、凭据序列化与签名验证钩子。

## 2. 架构与数据流

1. 服务端生成 challenge 与 options
2. 浏览器调用 navigator.credentials
3. SDK 校验 clientData、rpIdHash、credentialId
4. RP 后端完成签名验证并建立会话

## 3. 核心能力

- 注册/认证选项构造
- base64url 处理
- challenge/origin/rpId 绑定校验
- authenticatorData/COSE 解析
- 凭据序列化与签名验证钩子

## 4. 快速开始

```bash
node examples/works/02-webauthn-passkey/verify.mjs
node examples/works/02-webauthn-passkey/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- challenge 一次性且绑定 origin
- 强制用户验证（UV）与 resident key 策略
- 校验签名计数器与备份状态

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
