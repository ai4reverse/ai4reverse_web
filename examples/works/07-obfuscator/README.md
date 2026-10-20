# 07 JavaScript Obfuscator SDK — code-protection

| 属性 | 值 |
| --- | --- |
| 编号 | 07 |
| 名称 | JavaScript Obfuscator SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | code-protection |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

基于 Babel 的语义保持混淆 SDK：字符串转 fromCharCode、局部标识符重命名、死代码注入，并提供可读化 deobfuscate。

## 2. 架构与数据流

1. 源码解析为 AST
2. 安全检查后执行变换
3. 生成混淆代码
4. 必要时还原字符串/死代码

## 3. 核心能力

- 字符串编码
- 局部标识符重命名
- 死代码注入
- Babel AST 变换
- deobfuscate 还原
- shadowing/with 安全检查

## 4. 快速开始

```bash
node examples/works/07-obfuscator/verify.mjs
node examples/works/07-obfuscator/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 不要依赖纯混淆作为安全边界
- 结合 JSVMP/完整性校验
- 保留 source map 供内部调试

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
