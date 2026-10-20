# 18 Supply-chain SBOM Worm — supply-chain-worm

| 属性 | 值 |
| --- | --- |
| 编号 | 18 |
| 名称 | Supply-chain SBOM Worm |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | supply-chain-worm |
| 入口 | `sample.js` |
| 验证 | `node examples/suite/run-all.mjs --filter 18` |

## 1. 作品定位

供应链 SBOM 蠕虫：把“软件物料清单（SBOM）”与“来源证明（provenance）”本身当作攻击面。样本先读取 registry 上的包元数据，再把 CycloneDX 文档与 SLSA 证明改写成带恶意 `preinstall` 钩子的版本，随后沿依赖图广度优先地“发布”被感染的新包，并把 registry 令牌、环境标记与外传清单打回攻击者收集端。

它演示的是**篡改证据链 + 自传播**的组合，而不是单纯窃密：被改写的 SBOM 会让下游审计工具相信被污染的构件仍来自合法构建。

## 2. 完整攻击链

1. **落地与布标**：在 `localStorage` 写入伪 `.npmrc`（镜像 registry）与 `sbom18:*` 状态键，作为后续轮次的感染标记。
2. **连通性探测**：`GET /-/ping` 判断镜像是否可达；失败则退回内置 `SEED_MANIFEST`，保证离线也能跑完整链条。
3. **元数据解析**：拉取 `/-/package/sbom-seed/meta.json`，解析 name/version/maintainers/scripts/dependencies（5 个依赖）。
4. **SBOM 篡改**：为每个依赖生成 `0.0.0-worm.<version>` 版本、伪造 purl 与 SHA-256 `hashes`，并注入 `worm:hook=preinstall`、`worm:stage` 属性；序列号与时间戳一并伪造。
5. **来源证明篡改**：构造 in-toto Statement + SLSA v1 predicate，替换 `subject.digest.sha256` 与 builder id，`POST` 到 `provenance` 接口。
6. **自传播**：对依赖图做 BFS（上限 5 个包），逐个 `POST /-/package/publish` 发布带 `preinstall` 钩子的新 manifest；首个包额外用 `PUT` 重试一次，并 `HEAD` 探测 tarball 是否可下载。
7. **凭据收割**：遍历 `localStorage` 中命中 `token|npm|registry|auth|publish` 的键值，合并元数据里的 `ciToken` 与 `window.__REGISTRY_ENV__` / `document.cookie` 标记。
8. **外传**：把 token/标记/感染列表/伪造 provenance 摘要 `btoa` 编码后 `POST` 到收集端，并写入 `localStorage` 状态。
9. **页面注入**：向 `document.head` 追加 `meta[name=sbom-provenance]`、`link[rel=preload]` 与 `script[src=hook.js]`，让消费方页面继续加载被污染钩子。
10. **阶段二**：`setTimeout` 到点后 `atob` 还原阶段代码并 `eval`，补写 `data-sbom=infected` 标记；`setInterval` 驱动 3 轮传播。

## 3. 核心能力

- npm 包元数据解析（依赖/脚本/维护者）
- CycloneDX 1.5 SBOM 伪造（版本、purl、哈希、属性注入）
- SLSA provenance 伪造（subject digest、builder id）
- 依赖图 BFS 自传播（发布上限保护）
- registry 令牌与环境标记收割
- Base64 编码外传与本地状态持久化
- head 注入 preload/hook 资源
- `eval` 阶段二执行

## 4. 快速开始

```bash
node examples/suite/run-all.mjs --filter 18
node tools/cli.js analyze examples/suite/18-supply-chain-sbom-worm/sample.js
node tools/cli.js analyze examples/suite/18-supply-chain-sbom-worm/sample.js --json | jq '.verdict.reasons, .static.iocs.domains, .artifacts[].kind'
```

`work.json` 的 `networkRoutes` 提供镜像元数据、provenance 接收、publish 与收集端四类离线应答，可在严格沙箱中复现完整时序。

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 60（实测 63）。
- **IOC**：`urls` 16 条（`registry-mirror.example.test` 的 meta/provenance/publish/ping/tarball、`exfil.registry-mirror.example.test/collect`）、`domains` 9 个、`emails`（维护者邮箱）、`base64`（阶段代码与请求体）。
- **Artifact**：`decoded-string`（阶段代码与编码请求体）、`embedded-blob`、`console-output`（每轮传播统计）。
- **静态技术标签**：`dynamic-code-execution`、`encoded-string-decoding`、`network-communication`、`web-storage`、`dom-injection`、`cookie-access`。
- **动态 trace**：`net`（44）、`storage`（17）、`timer`（6）、`dom`（2）、`api`、`code`。
- **行为摘要**：kill-chain 命中 execution / command-and-control / persistence / injection。

## 6. 检测与处置建议

- **供应链侧**：对同一发布者短时批量 publish、以及“版本号中带非 semver 后缀”的构件做阻断；校验 SBOM `hashes` 与真实 tarball 摘要是否一致。
- **构建侧**：固定 provenance 的 builder id 白名单，拒绝 `externalParameters.registry` 与仓库配置不一致的证明。
- **浏览器侧**：监测 `localStorage` 中 `sbom*` 键、`document.head` 追加远端 `script`/`link` 的行为，以及请求体为 Base64 的 `POST`。
- **处置**：吊销命中的 registry token，回溯 `publish` 审计日志下架被污染版本，重建该包的 SBOM 与 provenance，并对下游消费方下发锁文件冻结。

## 7. 验证与预期结果

`run-all.mjs` 在严格沙箱、`deny` 网络策略 + 显式路由下分析样本，并校验 `work.json.expect`：判定等级、最低分、IOC 类别（`urls`、`domains`）、artifact（`decoded-string|eval-payload|console-output`）、技术标签（`dynamic-code-execution`、`encoded-string-decoding`、`network-communication`、`web-storage`）、trace 类型（`net`、`storage`、`timer`、`dom`）与完整性/句柄释放。预期输出：`malicious 63`。

## 8. 说明

本作品为合成、可离线运行的商业级示例：registry、收集端与 tarball 全部落在保留域名 `*.example.test` 下，令牌为 `npm_REDACTED_EXAMPLE_TOKEN` 之类的占位值，不包含任何真实凭据或可发布到公共 registry 的代码。发布/篡改请求由沙箱路由本地应答，不会触达真实 npm 基础设施。
