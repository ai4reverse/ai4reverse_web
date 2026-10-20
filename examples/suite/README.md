# Suite II — 30 个商业级/军工级完整作品（有效代码 ≥100KB）

`examples/suite/` 在 50 个产品样本与 30 个完整作品之上，再补充 **30 个独立工程**，并设置硬性代码体积门禁：

- **10 个 JS 安全 SDK**：安全飞地远程证明、策略引擎、SBOM/来源验证、WebAuthn 服务端验证、WASM 加密、Shamir 秘密共享、PQ 混合 KEM、DRM 水印、安全更新验证、反作弊完整性。
- **12 个病毒/恶意样本**：APT DNS 植入、WebRTC RAT、扩展加载器、WebAuthn 钓鱼、JSVMP 混合勒索、SW 擦除器、WS Botnet、SBOM 供应链蠕虫、画布隐写 C2、点击欺诈、Permit2 盗取、缓存 bootkit。
- **8 个完整应用**：威胁狩猎查询引擎、家族分类器、取证时间线重建、检测即代码 CI、IR 案件管理、攻击模拟靶场、沙箱调度器、SOC 指标面板。

当前**有效代码（去注释/空行）合计 562.8KB**，满足 ≥100KB 的硬性要求；每个作品另有 `README.md` 说明定位、工作流/攻击链、命令、预期结果与防御建议。

## 一键验证（含代码体积门禁）

```bash
node examples/suite/run-all.mjs                 # 30/30 + ≥100KB effective code
node examples/suite/run-all.mjs --json          # 机器可读 + 字节统计
node examples/suite/run-all.mjs --filter 01,11,23
node examples/suite/run-all.mjs --min-effective-bytes 120000
```

`run-all.mjs` 对 SDK 执行 `verify.mjs`（要求 `checks: N/N`，N≥5），对病毒样本在严格沙箱中分析并校验判定/IOC/artifact/技术/trace/JSVMP/完整性/句柄释放，对应用执行 `--self-test`；全量运行时同时统计去注释有效代码，低于阈值直接失败。

## 作品索引

| # | 类型 | 名称 | 等级 | 分类 | 入口 | 代码 | 验证 |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| 01 | sdk | [Secure Enclave Attestation SDK](./01-secure-enclave-attestation-sdk/README.md) | commercial | attestation | `src/index.js` | 23.3KB | `node verify.mjs` |
| 02 | sdk | [Policy Engine SDK](./02-policy-engine-sdk/README.md) | commercial | policy-engine | `src/index.js` | 25.8KB | `node verify.mjs` |
| 03 | sdk | [SBOM / Provenance Verifier](./03-sbom-provenance-verifier/README.md) | military | supply-chain-security | `src/index.js` | 28.4KB | `node verify.mjs` |
| 04 | sdk | [WebAuthn Server Verifier](./04-webauthn-server-verifier/README.md) | commercial | authentication | `src/index.js` | 38.8KB | `node verify.mjs` |
| 05 | sdk | [WASM Crypto SDK](./05-wasm-crypto-sdk/README.md) | commercial | cryptography | `src/index.js` | 27.1KB | `node verify.mjs` |
| 06 | sdk | [Shamir Secret Sharing SDK](./06-secret-sharing-sdk/README.md) | military | key-management | `src/index.js` | 18.2KB | `node verify.mjs` |
| 07 | sdk | [Post-Quantum Hybrid KEM SDK](./07-pq-hybrid-kem-sdk/README.md) | military | post-quantum-crypto | `src/index.js` | 27.7KB | `node verify.mjs` |
| 08 | sdk | [DRM Text Watermark SDK](./08-drm-watermark-sdk/README.md) | commercial | drm-watermarking | `src/index.js` | 17.8KB | `node verify.mjs` |
| 09 | sdk | [Secure Update Verifier SDK](./09-secure-update-verifier/README.md) | military | secure-update | `src/index.js` | 28.7KB | `node verify.mjs` |
| 10 | sdk | [Anti-Cheat Integrity SDK](./10-anti-cheat-integrity-sdk/README.md) | military | anti-cheat-integrity | `src/index.js` | 29.1KB | `node verify.mjs` |
| 11 | virus | [APT DNS Implant](./11-apt-dns-implant/README.md) | commercial | apt-implant | `sample.js` | 7.8KB | `run-all --filter 11` |
| 12 | virus | [WebRTC RAT](./12-webrtc-rat/README.md) | commercial | remote-access-trojan | `sample.js` | 7.5KB | `run-all --filter 12` |
| 13 | virus | [Extension Loader Malware](./13-extension-loader-malware/README.md) | commercial | extension-loader | `sample.js` | 6.5KB | `run-all --filter 13` |
| 14 | virus | [WebAuthn Credential Phishing](./14-credential-phishing-webauthn/README.md) | commercial | credential-phishing | `sample.js` | 8.7KB | `run-all --filter 14` |
| 15 | virus | [Hybrid Ransomware JSVMP](./15-hybrid-ransomware-jsvmp/README.md) | commercial | ransomware | `sample.js` | 10.8KB | `run-all --filter 15` |
| 16 | virus | [Wiper Service Worker](./16-wiper-service-worker/README.md) | commercial | wiper | `sample.js` | 6.8KB | `run-all --filter 16` |
| 17 | virus | [Botnet WebSocket C2 Node](./17-botnet-ws-c2/README.md) | commercial | botnet-client | `sample.js` | 8.5KB | `run-all --filter 17` |
| 18 | virus | [Supply-chain SBOM Worm](./18-supply-chain-sbom-worm/README.md) | commercial | supply-chain-worm | `sample.js` | 10.0KB | `run-all --filter 18` |
| 19 | virus | [Steganographic Canvas C2](./19-stego-canvas-c2/README.md) | commercial | steganographic-c2 | `sample.js` | 9.2KB | `run-all --filter 19` |
| 20 | virus | [Ad-Fraud Click Injection](./20-adfraud-click-injection/README.md) | commercial | ad-fraud | `sample.js` | 3.4KB | `run-all --filter 20` |
| 21 | virus | [Permit2 Approval Drainer](./21-crypto-permit2-drainer/README.md) | commercial | wallet-drainer | `sample.js` | 3.8KB | `run-all --filter 21` |
| 22 | virus | [Cache Bootkit Persistence](./22-bootkit-cache-persistence/README.md) | commercial | persistence | `sample.js` | 3.2KB | `run-all --filter 22` |
| 23 | app | [Threat Hunting Query Engine](./23-threat-hunting-query-engine/README.md) | commercial | threat-hunting | `app.mjs` | 38.0KB | `--self-test` |
| 24 | app | [Malware Family Classifier](./24-malware-family-classifier/README.md) | commercial | family-attribution | `app.mjs` | 20.4KB | `--self-test` |
| 25 | app | [Forensic Timeline Reconstructor](./25-forensic-timeline-reconstructor/README.md) | commercial | forensics-timeline | `app.mjs` | 24.6KB | `--self-test` |
| 26 | app | [Detection-as-code CI](./26-detection-as-code-ci/README.md) | commercial | detection-as-code | `app.mjs` | 28.4KB | `--self-test` |
| 27 | app | [IR Case Manager](./27-ir-case-manager/README.md) | commercial | incident-response | `app.mjs` | 28.5KB | `--self-test` |
| 28 | app | [Attack Simulation Range](./28-attack-simulation-range/README.md) | commercial | adversary-simulation | `app.mjs` | 21.1KB | `--self-test` |
| 29 | app | [Sandbox Scheduler](./29-sandbox-scheduler/README.md) | military | orchestration | `app.mjs` | 20.6KB | `--self-test` |
| 30 | app | [SOC Metrics Dashboard](./30-soc-metrics-dashboard/README.md) | commercial | soc-operations | `app.mjs` | 30.1KB | `--self-test` |

## SDK 示例

```js
import { createPolicyEngine } from './examples/suite/02-policy-engine-sdk/src/index.js'
const engine = createPolicyEngine([{ effect: 'allow', subject: 'role:analyst', action: 'read', resource: 'report:*' }])
console.log(engine.evaluate({ subject: ['role:analyst'], action: 'read', resource: 'report:42' }))
```

## 病毒样本分析

```bash
node tools/cli.js analyze examples/suite/18-supply-chain-sbom-worm/sample.js
node tools/cli.js analyze examples/suite/15-hybrid-ransomware-jsvmp/sample.js --json | jq .tracing.jsvmp
```

## 应用示例

```bash
node examples/suite/23-threat-hunting-query-engine/app.mjs --self-test
node examples/suite/26-detection-as-code-ci/app.mjs --self-test
node examples/suite/30-soc-metrics-dashboard/app.mjs --self-test
```

## 安全声明

所有病毒样本为合成演练样本，使用保留域、无真实网络/文件/进程访问；SDK 与应用可离线运行，不含真实凭据。
