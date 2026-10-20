# 25 VAULTLOCK — data-encryptor

| 属性 | 值 |
| --- | --- |
| 编号 | 25 |
| 代号 | VAULTLOCK |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | ransomware |
| 类别 | data-encryptor |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 50） |

## 1. 产品定位

数据加密组件：读取本地备份数据，使用 AES-GCM 加密并用远控公钥封装密钥，上传密文与密钥信封。

## 2. 完整攻击链

1. 读取 localStorage 备份数据
2. 生成/导入 AES 密钥并加密
3. 用远程公钥封装密钥
4. 上传密文与信封
5. 删除明文并记录状态

## 3. 关键能力与实现

- AES-GCM 批量加密
- 密钥封装
- 密文上传
- 明文清理
- 状态持久化

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/25-backup-encryptor/sample.js
node tools/cli.js analyze examples/products/25-backup-encryptor/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/25-backup-encryptor/sample.js --events | head -40
node tools/cli.js restore examples/products/25-backup-encryptor/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 50
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：eval 模块、WebCrypto、fetch、localStorage
- **技术标签**：dynamic-code-execution、cryptography、network-communication

## 6. 检测与处置建议

- 监控 WebCrypto 批量加密与密钥外传
- 限制页面访问备份数据
- 检测 eval 加密模块

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
