# 21 LOCKSTAGE — ransomware-stager

| 属性 | 值 |
| --- | --- |
| 编号 | 21 |
| 代号 | LOCKSTAGE |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | ransomware |
| 类别 | ransomware-stager |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 55） |

## 1. 产品定位

勒索软件前端投放器：拉取加密模块、用 WebCrypto 加密本地数据、生成勒索信并回传密钥材料。

## 2. 完整攻击链

1. 拉取加密模块并 eval 初始化
2. 生成 AES-GCM 密钥并加密 localStorage 数据
3. 把密钥材料编码回传 C2
4. 渲染勒索信与倒计时
5. 清理原始数据并阻断页面卸载

## 3. 关键能力与实现

- 远程模块加载
- WebCrypto 加密
- 密钥外传
- 勒索信 UI
- 数据清理
- 卸载阻断

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/21-ransomware-stager/sample.js
node tools/cli.js analyze examples/products/21-ransomware-stager/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/21-ransomware-stager/sample.js --events | head -40
node tools/cli.js restore examples/products/21-ransomware-stager/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 55
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：eval 模块、WebCrypto、fetch、localStorage、DOM 勒索信
- **技术标签**：dynamic-code-execution、cryptography、network-communication

## 6. 检测与处置建议

- 监控页面内 WebCrypto 批量加密与密钥外传
- 阻断 eval 远程模块
- 对勒索信 DOM 特征与倒计时做检测

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
