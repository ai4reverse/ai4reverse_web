# 40 VMORPH — jsvmp

| 属性 | 值 |
| --- | --- |
| 编号 | 40 |
| 代号 | VMORPH |
| 等级 | 商业级 |
| 严重度 | CRITICAL |
| 行业 | malware-protection |
| 类别 | jsvmp |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 40） |

## 1. 产品定位

JSVMP 保护加载器：业务逻辑编译为自定义字节码，由混淆 dispatch 解释器执行，静态分析难以还原；用于载荷分发与反分析。

## 2. 完整攻击链

1. 启动混淆 JSVMP 解释器
2. 执行字节码程序（字符串/对象/调用）
3. 由虚拟指令拼接 C2 与载荷
4. 回传执行结果
5. 本地缓存 VM 状态

## 3. 关键能力与实现

- 字节码解释器
- opcode 混淆
- 常量池编码
- 反静态分析
- C2 拼接

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/40-jsvmp-loader/sample.js
node tools/cli.js analyze examples/products/40-jsvmp-loader/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/40-jsvmp-loader/sample.js --events | head -40
node tools/cli.js restore examples/products/40-jsvmp-loader/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 40
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：JSVMP dispatch、字节码执行、fetch、localStorage
- **技术标签**：network-communication

## 6. 检测与处置建议

- 识别 dispatch-loop/字节码特征
- 动态 trace 恢复虚拟程序
- 阻断 VM 保护加载器的网络行为

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。

## 8. 生成说明

本样本由平台自身的 JSVMP builder 生成（obfuscated opcode cipher + 编码常量池）：

```bash
node examples/products/build-jsvmp-loader.mjs   # 重新生成 40-jsvmp-loader/sample.js
node tools/cli.js analyze examples/products/40-jsvmp-loader/sample.js --json | jq .tracing.jsvmp
```

分析时启用 `instrumentation: { jsvmp: true }`（run-all 根据 `requireVm` 自动启用），
预期得到 `tracing.jsvmp.detected=true` 与数百条 `jsvmp:opcode` 事件。
