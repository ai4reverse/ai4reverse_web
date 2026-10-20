# 26 CI Security Gate — ci-security

| 属性 | 值 |
| --- | --- |
| 编号 | 26 |
| 名称 | CI Security Gate |
| 类型 | 完整应用 |
| 等级 | 商业级 |
| 分类 | ci-security |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

CI 安全门禁：递归扫描 JS 文件，按阈值/判定等级阻断构建，输出可机读结果，适合合并请求流水线。

## 2. 工作流

1. 收集变更/仓库 JS 文件
2. 逐个沙箱分析
3. 按 fail-on/max-score 判定
4. 失败退出 2 阻断合并

## 3. 核心能力

- 递归 JS 扫描
- 阈值/等级门禁
- 退出码契约
- JSON 输出
- 自检

## 4. 快速开始

```bash
node examples/works/26-ci-security-gate/app.mjs --self-test
node examples/works/26-ci-security-gate/app.mjs --help
```

## 5. 验证与预期结果

`--self-test` 在临时目录中运行完整流程并校验输出，成功时打印 `SELFTEST OK`；`run-all.mjs` 要求退出码为 0。

## 6. 生产集成 / 防御建议

- 在 MR 流水线强制运行
- 对生成代码设置白名单
- 失败时附报告链接

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
