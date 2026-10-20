# 42 HEXARRAY — string-array

| 属性 | 值 |
| --- | --- |
| 编号 | 42 |
| 代号 | HEXARRAY |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | malware-protection |
| 类别 | string-array |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 50） |

## 1. 产品定位

字符串数组+控制流平坦化加载器：数组旋转、解码函数、switch 顺序表组合，运行时拼接 C2 并执行阶段。

## 2. 完整攻击链

1. 字符串数组旋转初始化
2. 解码函数还原配置
3. switch 顺序表推进执行
4. eval 阶段载荷
5. 回传并持久化

## 3. 关键能力与实现

- 数组旋转
- 解码函数
- 控制流平坦化
- eval
- C2 拼接

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/42-string-array-loader/sample.js
node tools/cli.js analyze examples/products/42-string-array-loader/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/42-string-array-loader/sample.js --events | head -40
node tools/cli.js restore examples/products/42-string-array-loader/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 50
- **IOC 类别**：urls
- **Artifact**：eval-payload、decoded-string
- **关键行为**：字符串数组/旋转、控制流平坦化、eval、fetch、localStorage
- **技术标签**：dynamic-code-execution、network-communication

## 6. 检测与处置建议

- 还原字符串数组与控制流
- 对 eval 阶段阻断
- 关联 C2 域名

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
