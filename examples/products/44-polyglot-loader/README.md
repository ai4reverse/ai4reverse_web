# 44 POLYGLOT — polyglot

| 属性 | 值 |
| --- | --- |
| 编号 | 44 |
| 代号 | POLYGLOT |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | malware-protection |
| 类别 | polyglot |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 50） |

## 1. 产品定位

多语言/多形态加载器：文件同时是 HTML/JS，注释与模板串隐藏 Base64 载荷，浏览器与 Node 行为不同，运行时 eval。

## 2. 完整攻击链

1. 以 HTML 注释/模板串隐藏载荷
2. 按运行环境选择解码路径
3. 拼接并 eval 阶段
4. 回传环境与结果
5. 持久化阶段标记

## 3. 关键能力与实现

- HTML/JS 多形态
- 环境分支
- Base64 载荷
- eval
- 环境回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/44-polyglot-loader/sample.js
node tools/cli.js analyze examples/products/44-polyglot-loader/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/44-polyglot-loader/sample.js --events | head -40
node tools/cli.js restore examples/products/44-polyglot-loader/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 50
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：HTML/JS 多形态、eval、fetch、localStorage、DOM
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 检测 HTML/JS 多形态与注释隐藏载荷
- 对 eval 外部内容阻断
- 静态与动态关联分析

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
