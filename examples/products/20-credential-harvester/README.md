# 20 CREDHARVEST — credential-theft

| 属性 | 值 |
| --- | --- |
| 编号 | 20 |
| 代号 | CREDHARVEST |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | enterprise |
| 类别 | credential-theft |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 55） |

## 1. 产品定位

凭据/令牌收集器：遍历 localStorage/sessionStorage/cookie 与常见令牌键，读取剪贴板，编码后回传；对高价值键优先排序。

## 2. 完整攻击链

1. 枚举存储与 Cookie
2. 匹配 token/session/api-key 模式
3. 读取剪贴板并去重
4. 优先级排序后打包
5. Base64 回传并本地缓存

## 3. 关键能力与实现

- 存储遍历
- Cookie 读取
- 令牌模式识别
- 剪贴板采集
- 优先级外传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/20-credential-harvester/sample.js
node tools/cli.js analyze examples/products/20-credential-harvester/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/20-credential-harvester/sample.js --events | head -40
node tools/cli.js restore examples/products/20-credential-harvester/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 55
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：存储/Cookie 读取、剪贴板、fetch 回传、localStorage
- **技术标签**：network-communication、web-storage、clipboard-access

## 6. 检测与处置建议

- 避免在 Web Storage 存放长期令牌
- 启用 HttpOnly/SameSite
- 监控批量存储枚举与剪贴板读取

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
