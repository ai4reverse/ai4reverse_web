# 28 · Attack Simulation Range（攻击模拟靶场）

## 作品定位

红队/检测工程团队用来回答一个具体问题的工具：**「这条攻击链，平台到底能测出几段？」**

靶场把 MITRE ATT&CK 风格的杀伤链拆成有序阶段（钓鱼投递 → dropper 执行 → C2 回连 → 数据外传），每段携带攻击者会真实执行的 JavaScript 载荷和一份可评审的期望（判定档位、判定分下限、必须命中的技术点、必须提取的 IOC 主机、必须出现的杀伤链阶段、最小网络事件数）。引擎逐段在全新的无痕沙箱里执行、对比期望并输出记分卡。整个过程无随机、无真实网络，可在 CI 中作为检测能力的回归门禁。

## 工作流

1. `list` 查看内置场景与战术链。
2. `run` 执行全部场景；`--scenario <id>` 只跑一个；`--scenario-file <path>` 跑外部场景。
3. 引擎对每个阶段：`analyzeSample(stage.sample, {network: {policy:'deny'}})` → 抽取观测（verdict / score / techniques / iocHosts / killChain / networkEvents / disposal）。
4. `evaluateStage` 把期望逐条展开成断言（`verdict`、`score`、`technique:<name>`、`ioc:<host>`、`killchain:<stage>`、`network-events`、`disposal`），每条断言都记录期望值与实际值。
5. 汇总成记分卡：单场景 `expectationsMet`、`detectionCoverage`、`meanVerdictScore`；全靶场再聚合一次，并列出 IOC 主机与「意外 IOC」（不在场景 allowlist 内的外联主机）。
6. 任一断言失败 → 进程退出码 1，失败断言带 `id/expected/actual` 直接可定位。

## 核心能力

- **场景即数据**：`SCENARIOS` 是冻结常量，阶段样本与期望同屏可读；`validateScenario` 强制校验字段、kebab-case id、MITRE 编号格式（`T1566.002`）、样本非空，避免「打错字的场景静默通过」。
- **期望可加严**：`minScore` 取在实测分下方几点，既能容忍启发式调参，又能在检测真回退时报警；`verdictIn` 默认 `suspicious|malicious`。
- **IOC 双向核对**：既检查「应检出的主机是否检出」（`missing`），也检查「是否连了不该连的主机」（`unexpected`），后者是外联策略回归的早期信号。
- **销毁与出网不放松**：每段都必须 `disposal.ok === true`，所有网络 URL 必须落在 `.example.test` 靶场域内。
- **负控制**：自检内置一个不可能满足的场景，确认引擎会失败、分数会下降、失败断言命名正确（拒绝假绿）。
- **自定义场景**：外部 JSON 只需 `stages[].sample` + `expect`，`expect` 缺省项自动补 `EXPECT_BASELINE`。

## 快速开始

```bash
cd examples/suite/28-attack-simulation-range

node app.mjs list
node app.mjs run                                   # 全部场景，文本记分卡
node app.mjs run --scenario full-killchain         # 单场景
node app.mjs run --json > scorecard.json           # 机器可读
node app.mjs run --scenario-file my-scenario.json  # 外部场景

node app.mjs run --scenario credential-phish       # 示例输出
# 场景 credential-phish — 凭据钓鱼套件（Credential Phishing Kit）
# STAGE               TECHNIQUE  VERDICT     SCORE  CHECKS  RESULT
# phish-page          T1566.002  suspicious  25     8/8     PASS
# credential-harvest  T1056.003  suspicious  28     7/7     PASS
# 期望达成 100% (15/15) | 检测覆盖 100% | 平均判定分 27
```

外部场景格式：

```json
{
  "id": "custom-dropper",
  "name": "自定义 dropper 场景",
  "description": "只验证 dropper 执行段",
  "tactics": ["execution"],
  "allowlist": ["cdn.polyfill.example.test"],
  "stages": [
    {
      "id": "dropper",
      "name": "解码执行",
      "technique": "T1059.007",
      "tactic": "execution",
      "sample": "eval(atob('Y29uc29sZS5sb2coMSk='));",
      "expect": { "verdictIn": ["suspicious", "malicious"], "minScore": 20, "techniques": ["dynamic-code-execution"] }
    }
  ]
}
```

## 验证与预期结果

```bash
node app.mjs --self-test
```

自检覆盖 2 个必测场景 + 1 个负控制场景：

| 断言 | 预期 |
| --- | --- |
| `full-killchain` 阶段数 | 4，按 `initial-access,execution,command-and-control,exfiltration` 顺序 |
| 全段通过 | `passed=true`，`expectationsMet=100`，`detectionCoverage=100` |
| 判定分布 | 4 段全部非 benign（suspicious 或 malicious） |
| IOC 汇总 | 含 `beacon.example.test`、`exfil.example.test`，`unexpected=[]` |
| 每段销毁 | `disposalOk=true`，网络 URL 全部落在 `.example.test` |
| `credential-phish` | 2 段通过，含 `sso-verify.example.test` |
| 负控制 | `passed=false`，`expectationsMet<100`，失败断言含 `score` 与 `ioc:nowhere.example.test` |
| 意外 IOC | 负控制中把 `cdn.polyfill.example.test` 标为 unexpected |
| 全靶场 | 3 个内置场景全部通过，`networkPolicy=deny` |
| 渲染 | 文本记分卡含 `PASS` 与 `T1071.001` |

通过时输出：

```
range: scenarios=3 stages=8 checks=56/56 coverage=100% negative=2 iocs=4
full-killchain scores: phish-page=25 dropper-exec=32 c2-beacon=38 exfil-dump=31
SELFTEST OK
```

实测判定分（seed 固定，可复现）：钓鱼 25、dropper 32、C2 38、外传 31。

## 生产集成与防御建议

- **CI 门禁**：把 `node app.mjs run --json` 的 `totals.expectationsMet` 与 `iocs.missing` 作为阈值指标；检测规则或沙箱环境变更后自动比对。
- **ATT&CK 覆盖图**：用 `stages[].technique/tactic` 直接映射 ATT&CK Navigator 图层，统计「已覆盖战术 / 未覆盖战术」。
- **样本来源**：生产环境可把 `stage.sample` 换成从样本库拉取的真实载荷（保持 `network: deny`），场景结构不变。
- **蓝队视角**：靶场验证的是「平台能看见什么」；配套建议是把 `iocs.unexpected` 主机加入阻断清单，把失败断言对应的 ATT&CK 技术点补进检测规则（Sigma / EDR 自定义规则）。
- **边界**：靶场不做真实外联、不落盘真实恶意样本，仅用于检测能力回归；结果不代表真实攻击成功率。

## 说明

- 场景与断言全部确定性：相同 seed 下判定分、IOC 列表、断言结果逐字节一致。
- `expect.minScore` 是「下限」而非「精确值」，平台打分上调不会破坏靶场，下调到阈值以下才会失败。
- 新增场景只需追加到 `SCENARIOS`（或使用外部 JSON），无需改引擎。
