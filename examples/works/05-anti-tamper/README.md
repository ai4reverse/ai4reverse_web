# 05 Anti-Tamper SDK — integrity

| 属性 | 值 |
| --- | --- |
| 编号 | 05 |
| 名称 | Anti-Tamper SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | integrity |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

运行时完整性基线 SDK：捕获属性描述符、原型链与原生函数源码，检测方法替换、描述符改写、原型污染与 toString 篡改。

## 2. 架构与数据流

1. 启动时对关键对象取样
2. 安全边界处重新取样并 diff
3. 发现漂移触发告警/阻断
4. 按版本重新基线

## 3. 核心能力

- 描述符/原型快照
- 差异检测
- 断言与连续 guard
- 原生函数源码比对
- 可重基线

## 4. 快速开始

```bash
node examples/works/05-anti-tamper/verify.mjs
node examples/works/05-anti-tamper/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 保护关键 SDK/加密入口
- 对篡改事件上报并降级功能
- 结合 SRI/CSP 做纵深防御

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
