# 26 Detection-as-code CI — detection-as-code

| 属性 | 值 |
| --- | --- |
| 编号 | 26 |
| 名称 | Detection-as-code CI |
| 类型 | CI 门禁应用 |
| 等级 | 商业级 |
| 分类 | detection-as-code |
| 入口 | `app.mjs` |
| 验证 | `node app.mjs --self-test` |

## 1. 作品定位

把"检测覆盖"变成可执行的门禁：扫描仓库里的 JavaScript 样本，为每个恶意样本生成 YARA + Sigma 规则，校验规则能解析、能命中、且不误伤良性样本；任何一个恶意样本没有规则覆盖，构建即失败（退出码 2）。检测规则与样本同仓管理，规则变更走代码评审。

## 2. 工作流

1. **扫描**：递归收集 `.js/.mjs/.cjs`（跳过 `node_modules/.git/dist/build/coverage/detections`，单文件上限 2MB），逐个 `analyzeSample()` 分诊。
2. **构造匹配面**：每个样本产出
   - `haystack`：原始源码 + 还原后源码 + artifact 预览 + 全部 IOC 值（fileless 样本靠恢复出的字符串才能被内容规则命中）
   - `record`：`text/url/domain/technique/stage/kind/action/suspiciousTld` 扁平字段，供行为规则（Sigma）匹配
3. **加载规则**：读取检测目录下的 `.yar/.yara` 与 `.yml/.yaml`，同名文件组成一个检测单元；解析失败的文件进入 `errors` 而不会中断扫描。
4. **覆盖评估**：
   - required 样本 = `malicious`，或 `--fail-on suspicious` 的 `suspicious`，或 `score >= --min-score`
   - 每个 required 样本必须被至少一条规则命中 → 否则 `uncovered`
   - 规则命中非 required 样本 → `false positive`
   - 规则不命中任何样本 → `stale`（仅告警）
5. **生成**：`--generate` 只对未覆盖的 required 样本生成规则（`wx` 独占写入，天然幂等，不会覆盖人工修订的规则）。
6. **门禁**：`uncovered` / `false positive` / 无效规则任一存在 → `exit 2`；否则 `exit 0`。

### 规则生成策略

- **YARA**：从 IOC 中按优先级（URL → Telegram → base64 → Discord → 钱包 → mutex → shell）择优 1–4 条字符串，`ascii nocase`；条件为 `any of them` / `all of them` / `2 of them`。
- **Sigma**：URL host + 行为技术（最多各 2 条）+ 高滥用 TLD + JSVMP 检测，条件固定 `1 of selection_*`；字段与修饰符（`contains`/`equals`）显式写出，解析器可通过 `field|modifier: [values]` 还原。
- **可追溯**：`meta.reference = sample:<相对路径>`、`sample_sha256`，规则与来源样本双向可查。

## 3. 核心能力

- 仓库级批量分诊（确定性 seed、网络拒绝）
- fileless 友好的匹配面构造（含还原代码与恢复字符串）
- YARA 生成/渲染/解析/匹配（`any|all|N of them`）
- Sigma 生成/渲染/解析/匹配（`1 of selection_*`、`any|all of them`）
- 覆盖门禁（required/covered/uncovered）
- 误报门禁（规则命中良性样本即失败）
- 规则卫生（stale 告警、无效规则报错）
- 幂等生成（`wx` 写入，跳过已存在文件）
- 文本/JSON 双输出，退出码可直接接 CI

## 4. 快速开始

```bash
cd examples/suite/26-detection-as-code-ci

# 1) 先看门禁失败：仓库里有恶意样本但没有检测
node app.mjs --path samples/repo

# 2) 生成规则并重新评估
node app.mjs --path samples/repo --detections /tmp/suite-detections --generate

# 3) 之后的 CI 运行（不再生成，仅校验）
node app.mjs --path samples/repo --detections /tmp/suite-detections

# 4) 更严格的门禁：suspicious 也必须被覆盖
node app.mjs --path samples/repo --detections /tmp/suite-detections --fail-on suspicious --json

# 5) 自检
node app.mjs --self-test
```

预期片段：

```text
  malicious   74  src/stager.js    required JS_SRC_STAGER_4CF84FD4, dc-4cf84fd4c45c
rules    : 2 loaded, 0 stale, 0 invalid
coverage : 1/1 (100.0%)
gate     : PASS
```

## 5. 验证与预期结果

`--self-test` 在临时目录内构造 `src/stager.js`（恶意）+ `src/benign.js`（良性），覆盖：

1. 无规则时：required=1、`src/stager.js` 未覆盖、`exitCode=2`、且未自动生成规则。
2. `--generate`：写出 `.yar` + `.yml` 两个文件，覆盖率恢复 1/1，门禁 PASS（exit 0），良性样本无误报。
3. 幂等：再次 `--generate` 不写任何文件，门禁仍 PASS。
4. 往返：生成的 YARA/Sigma 从磁盘解析成功；YARA 命中恶意 haystack、不命中良性；Sigma 命中恶意 record、不命中良性。
5. 渲染确定性：同一 unit 两次渲染字节一致。
6. 无效规则：缺条件、使用不支持条件（`filesize < 10`）都被收集为错误。
7. stale 规则：不命中任何样本 → 计入 stale，但不单独导致失败。
8. 确定性：同一输入两次 `runGate` 的 JSON 完全一致。
9. `--fail-on suspicious` 会把要求集合并集化（required 不减少）。
10. 门禁阻止未覆盖样本（stale 场景仍因未覆盖而失败）。

预期最后一行：`SELFTEST OK`（退出码 0）。

## 6. 生产集成 / 防御建议

- **流水线位置**：作为 PR 检查运行 `--path <repo> --detections <dir>`，失败即阻断合并；Nightly 用 `--generate` 产出候选规则并进入人工评审，**不要**在 main 上自动生成。
- **规则评审**：生成规则是"最低可用基线"，必须补充 `falsepositives`、`level` 与上下文说明；`stale` 规则应定期下线，避免规则库腐化。
- **误报门禁**：良性样本目录应持续扩充（正常 SDK/框架代码），任何命中良性的规则都视为回归。
- **可复现性**：匹配面包含还原代码与恢复字符串，阈值固定在 `--min-score`，同一 commit 的结论稳定。
- **数据安全**：规则文件包含真实 URL/钱包等 IOC，检测仓库需按情报级别控制访问；`meta.reference` 只记录相对路径，不泄露主机名。

## 7. 说明

本作品为合成、可离线运行的商业级示例：示例仓库样本为自写测试样例，不含真实凭据或可用 C2；分析在沙箱内以 `network: {policy: 'deny'}` 执行。生成与匹配均为本地纯计算，结果对同一输入确定。
