# 23 Threat Hunting Query Engine — threat-hunting

| 属性 | 值 |
| --- | --- |
| 编号 | 23 |
| 名称 | Threat Hunting Query Engine |
| 类型 | 狩猎/查询应用 |
| 等级 | 商业级 |
| 分类 | threat-hunting |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

把分析师写的 Sigma 风格检测规则编译成可执行谓词，在样本分析产物的**归一化观测表**上做一次"报告级"狩猎：规则命中后给出规则元数据、命中的 selection 以及支撑命中的具体观测证据。目标是让"检测逻辑"与"分析引擎实现"彻底解耦——规则是数据，引擎只负责编译与求值。

## 2. 工作流

1. **规则加载**：`loadRules()` 递归读取 `rules/` 下的 `.yml/.yaml/.json`，一个 `---` 分隔的文档即一条规则，重复 id 直接报错。
2. **解析**：`lib/yaml.js` 用内置 YAML 子集解析器（缩进映射、`- ` 序列、行内 `[a,b]`/`{a: b}`、引号标量、布尔/null）解析规则，不引入任何第三方依赖。
3. **编译**：`compileRule()` 把 `detection.<selection>` 编译成字段测试，把 `condition` 编译成布尔表达式 AST（`and/or/not`、括号、`1 of sel_*`、`all of them`）。未知字段、未知修饰符、未定义 selection、畸形条件在**加载期**报错。
4. **归一化**：`normalizeReport()` 把 `analyzeSample()` 产出（verdict / static / ioc / dynamic / artifact / technique）投影成扁平观测表，每条观测带统一字段与 `text` 检索haystack。
5. **求值**：`runHunt()` 先按 selection 收集证据观测，再用 condition 组合出规则级命中，输出按等级+规则 id 稳定排序。
6. **解释/渲染**：`--explain` 逐 selection 打印"字段 [期望值] -> 实际值"，`--json` 输出机器可读结果。

## 3. 核心能力

- Sigma 子集 YAML 解析器（严格、带定位错误）
- 规则编译：字段表 + 修饰符（`contains/startswith/endswith/re/gt/gte/lt/lte/neq/all`）
- 布尔条件语言：`and/or/not`、括号、`N of pattern*`、`all/any of them`
- 报告归一化观测表（layer/kind/action/api/url/domain/value/technique/stage/seq/…）
- 报告级求值 + 证据保留（每个 selection 最多保留 5 条证据观测）
- 未使用 selection 提示、命中等级排序、最高等级摘要
- Markdown 报告联动输出（`--markdown`）

## 4. 快速开始

```bash
# 1) 对样本直接狩猎（内置 8 条规则）
node examples/suite/23-threat-hunting-query-engine/app.mjs \
  --sample examples/works/12-fileless-loader/sample.js --explain

# 2) 对已有报告 JSON 狩猎，输出机器可读结果
node examples/suite/23-threat-hunting-query-engine/app.mjs \
  --report /tmp/report.json --rules examples/suite/23-threat-hunting-query-engine/rules --json

# 3) 规则清单
node examples/suite/23-threat-hunting-query-engine/app.mjs --list-rules

# 4) 自检
node examples/suite/23-threat-hunting-query-engine/app.mjs --self-test
```

规则示例（`rules/hunting.yml`）：

```yaml
id: hunt-encoded-beacon
title: Base64-encoded C2 beacon
level: high
detection:
  encoded_decode:
    kind: obfuscation
    value: base64-decode
  outbound:
    layer: dynamic
    kind: net
  url_indicator:
    layer: ioc
    category: urls
  condition: encoded_decode and outbound and url_indicator
```

## 5. 验证与预期结果

`--self-test` 在系统临时目录内运行，覆盖：

1. 加载并编译内置 8 条规则（loader 报告的规则数一致）。
2. 对内置 beacon 样本狩猎，断言 `hunt-encoded-beacon`、`hunt-dynamic-eval`、`hunt-storage-persistence`、`hunt-suspicious-verdict` 命中。
3. 反向断言 `hunt-wallet-swap`、`hunt-telegram-c2` **不**命中（无对应证据）。
4. 同一报告两次狩猎的 summary 与命中顺序完全一致（确定性）。
5. `--explain` 文本包含 selection、字段实际值与 condition。
6. 条件语言：`2 of sel_*` 生效；引用未定义 selection 报错。
7. 未知字段/未知修饰符/缺 condition/畸形表达式全部在编译期被拒绝。
8. YAML 子集：嵌套映射、序列、行内集合、标量类型正确。
9. 目录加载（临时目录 `extra.yml`）、报告 JSON 反序列化后再狩猎结果一致。
10. `renderMarkdown()` 生成 `## Verdict` 段。

预期输出最后一行：`SELFTEST OK`（退出码 0）；`run-all.mjs` 以该标记判定通过。

## 6. 生产集成 / 防御建议

- **规则即代码**：把 `rules/` 纳入 Git，改动走评审；CI 用 `--report` + `--json` 做回归，命中集合变化必须显式接受。
- **狩猎数据源**：引擎只依赖报告 schema（`docs/REPORT-SCHEMA.md`），因此可以接入 EDR 导出的等价观测（URL、进程 API、存储写入）而无需改规则。
- **降低误报**：优先用跨层组合（编码解码 + 外联 + IOC）而非单字段匹配；`falsepositives` 字段记录已知良性来源。
- **威胁情报**：`hunt-suspicious-tld` 依赖 TLD 滥用率，建议随季度情报更新；高风险规则（`critical`）应触发人工复核而不是自动阻断。
- **权限与留痕**：狩猎结果包含完整 URL/host，属于敏感数据，输出文件需按事件响应等级保护。

## 7. 说明

本作品为合成、可离线运行的商业级示例：规则、样本与输出均不包含真实凭据、可用 C2 或破坏性宿主操作。引擎不发起任何网络请求，分析在平台沙箱内以 `network: {policy: 'deny'}` 执行，结果对同一输入保持确定性。
