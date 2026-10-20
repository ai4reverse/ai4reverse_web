# 41 BRACKETFUCK — jsfuck

| 属性 | 值 |
| --- | --- |
| 编号 | 41 |
| 代号 | BRACKETFUCK |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | malware-protection |
| 类别 | jsfuck |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 50） |

## 1. 产品定位

JSFuck 编码加载器：用 []()!+ 等字符构造字符串与代码，运行时还原并 eval，规避关键字检测。

## 2. 完整攻击链

1. 用 JSFuck 表达式构造解码器
2. 还原 Base64 配置与 C2
3. eval 执行第二阶段
4. 回传结果
5. 本地缓存

## 3. 关键能力与实现

- JSFuck 编码
- 运行时字符串还原
- eval 阶段
- C2 回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/41-jsfuck-loader/sample.js
node tools/cli.js analyze examples/products/41-jsfuck-loader/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/41-jsfuck-loader/sample.js --events | head -40
node tools/cli.js restore examples/products/41-jsfuck-loader/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 50
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：JSFuck 还原、eval、fetch、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 检测高强度 JSFuck 表达式
- 对 eval 外部内容阻断
- 静态规则结合动态 trace

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
