# 06 JSVMP Protector SDK — code-protection

| 属性 | 值 |
| --- | --- |
| 编号 | 06 |
| 名称 | JSVMP Protector SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | code-protection |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

表达式级 JSVMP 保护 SDK：Pratt 解析 → 栈式字节码 → XOR 混淆 opcode 与常量池 → 运行时解释执行，源码不出现原表达式。

## 2. 架构与数据流

1. 业务表达式编译为字节码
2. opcode XOR 混淆并序列化
3. 客户端加载 VM 执行
4. 服务端可分析 trace 还原逻辑

## 3. 核心能力

- 表达式解析/编译
- 栈式字节码
- opcode/常量池编码
- 运行时 VM
- 程序序列化/恢复
- 语法错误分类

## 4. 快速开始

```bash
node examples/works/06-jsvmp-protector/verify.mjs
node examples/works/06-jsvmp-protector/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 保护关键算法/授权逻辑
- 结合完整性校验防 VM 篡改
- 不要仅依赖混淆，配合服务端校验

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
