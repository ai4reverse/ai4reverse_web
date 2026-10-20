# 38 VMORACLE — vm-detection

| 属性 | 值 |
| --- | --- |
| 编号 | 38 |
| 代号 | VMORACLE |
| 等级 | 军工级 |
| 严重度 | HIGH |
| 行业 | evasion |
| 类别 | vm-detection |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

虚拟机/无头环境识别：交叉校验 UA、插件、WebGL、时区、Intl、栈格式与原生函数品牌，输出环境可信度并回传。

## 2. 完整攻击链

1. 采集 10+ 项环境指纹
2. 交叉校验一致性
3. 检测原生函数/栈/自动化标志
4. 计算可信度评分
5. 回传评分并决定后续行为

## 3. 关键能力与实现

- 环境指纹
- 交叉校验
- 原生品牌检测
- 栈检测
- 可信度评分

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/38-vm-detect/sample.js
node tools/cli.js analyze examples/products/38-vm-detect/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/38-vm-detect/sample.js --events | head -40
node tools/cli.js restore examples/products/38-vm-detect/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：指纹采集、原生品牌/栈检测、fetch、localStorage
- **技术标签**：network-communication

## 6. 检测与处置建议

- 沙箱环境保持一致指纹
- 避免可识别的 VM/无头特征
- 对评分型探测做关联检测

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
