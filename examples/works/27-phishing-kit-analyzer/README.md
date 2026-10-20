# 27 Phishing-Kit Analyzer — phishing-analysis

| 属性 | 值 |
| --- | --- |
| 编号 | 27 |
| 名称 | Phishing-Kit Analyzer |
| 类型 | 完整应用 |
| 等级 | 商业级 |
| 分类 | phishing-analysis |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

钓鱼套件分析器：提取表单/字段、外传 action、Telegram/Discord/Slack 通道、品牌与混淆特征，输出风险分。

## 2. 工作流

1. 解析 HTML/JS
2. 提取表单与凭据字段
3. 识别 bot/webhook 通道
4. 计算风险并输出

## 3. 核心能力

- 表单/字段提取
- 外传通道识别
- 品牌识别
- 混淆特征
- 风险评分

## 4. 快速开始

```bash
node examples/works/27-phishing-kit-analyzer/app.mjs --self-test
node examples/works/27-phishing-kit-analyzer/app.mjs --help
```

## 5. 验证与预期结果

`--self-test` 在临时目录中运行完整流程并校验输出，成功时打印 `SELFTEST OK`；`run-all.mjs` 要求退出码为 0。

## 6. 生产集成 / 防御建议

- 与邮件网关/URL 信誉联动
- 提取的通道立即封禁
- 品牌方通报

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
