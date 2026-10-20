# 30 Sandbox Farm — orchestration

| 属性 | 值 |
| --- | --- |
| 编号 | 30 |
| 名称 | Sandbox Farm |
| 类型 | 完整应用 |
| 等级 | 商业级 |
| 分类 | orchestration |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

并行沙箱农场：以有界并发运行多样本，聚合完成/超时/失败与句柄释放，验证运行间隔离。

## 2. 工作流

1. 创建沙箱池
2. 分发样本并收集 trace
3. 分类完成/超时/失败
4. 释放并验证隔离

## 3. 核心能力

- 有界并发
- 多样本调度
- 超时/失败分类
- 隔离验证
- 聚合统计

## 4. 快速开始

```bash
node examples/works/30-sandbox-farm/app.mjs --self-test
node examples/works/30-sandbox-farm/app.mjs --help
```

## 5. 验证与预期结果

`--self-test` 在临时目录中运行完整流程并校验输出，成功时打印 `SELFTEST OK`；`run-all.mjs` 要求退出码为 0。

## 6. 生产集成 / 防御建议

- 按 CPU/内存限制并发
- 超时与配额告警
- 样本队列优先级

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
