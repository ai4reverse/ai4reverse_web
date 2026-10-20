# 29 Incident-Response Playbook — incident-response

| 属性 | 值 |
| --- | --- |
| 编号 | 29 |
| 名称 | Incident-Response Playbook |
| 类型 | 完整应用 |
| 等级 | 商业级 |
| 分类 | incident-response |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

事件响应剧本生成器：依据判定、kill chain、IOC 与异常生成分阶段、带优先级/负责人/时限的处置清单。

## 2. 工作流

1. 读取分析报告
2. 按 kill-chain/IOC 生成步骤
3. 排序并输出清单
4. 跟踪验证项

## 3. 核心能力

- 分阶段剧本
- 优先级/负责人/时限
- IOC 驱动步骤
- Markdown/JSON 输出
- 自检

## 4. 快速开始

```bash
node examples/works/29-ir-playbook/app.mjs --self-test
node examples/works/29-ir-playbook/app.mjs --help
```

## 5. 验证与预期结果

`--self-test` 在临时目录中运行完整流程并校验输出，成功时打印 `SELFTEST OK`；`run-all.mjs` 要求退出码为 0。

## 6. 生产集成 / 防御建议

- 与工单/值守系统集成
- 演练并校准时限
- 保留审计记录

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
