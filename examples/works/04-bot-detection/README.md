# 04 Bot Detection SDK — bot-defense

| 属性 | 值 |
| --- | --- |
| 编号 | 04 |
| 名称 | Bot Detection SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | bot-defense |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

可解释的机器人/欺诈行为评分 SDK：指针轨迹、键盘节奏、表单时序、蜜罐与自动化标志，输出 0–100 分与原因。

## 2. 架构与数据流

1. 采集 pointer/key/focus/form/honeypot 事件
2. 规则引擎累计风险
3. 输出 human/suspicious/bot 与原因
4. 按阈值触发挑战或阻断

## 3. 核心能力

- 行为事件采集
- 线性轨迹/机器人节奏检测
- 表单时序与蜜罐检测
- 0–100 评分与 verdict
- 可解释原因与权重

## 4. 快速开始

```bash
node examples/works/04-bot-detection/verify.mjs
node examples/works/04-bot-detection/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 不依赖单一信号
- 根据业务调整权重与阈值
- 保留审计原因便于申诉

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
