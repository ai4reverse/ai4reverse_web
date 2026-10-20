# 30 个商业级完整作品（JS 安全 SDK / 病毒样本 / 完整应用）

`examples/works/` 在 50 个产品样本之外，补充 **30 个完整作品**，每个都是可运行、可验证的独立工程：

- **JS 安全 SDK**：10 个（加密存储、Passkey、设备指纹、Bot 检测、反篡改、JSVMP、混淆器、许可证、E2EE、密钥扫描）。
- **病毒样本**：12 个（浏览器锁定、无文件加载、SW 持久化、原型污染 rootkit、会话劫持、表单劫持、钱包授权钓鱼、剪贴板蠕虫、PWA 更新器、WASM 挖矿、DNS 信标、JSVMP 勒索）。
- **完整应用**：8 个（SOC 分诊台、样本库、情报富化、CI 门禁、钓鱼套件分析、检测规则生成、IR 剧本、并行沙箱农场）。

每个作品包含 `work.json`（可机读契约）、`README.md`（定位/架构/命令/验证/防御）以及入口文件：SDK 为 `src/index.js` + `verify.mjs`，病毒为 `sample.js`，应用为 `app.mjs`。

## 一键验证

```bash
node examples/works/run-all.mjs              # 30/30 契约验证
node examples/works/run-all.mjs --json       # 机器可读结果
node examples/works/run-all.mjs --filter 01,11,23
```

`run-all.mjs` 对 SDK 运行其 `verify.mjs` 并要求 `checks: N/N`（N≥5）；对病毒样本在严格沙箱中分析并校验判定/IOC/artifact/技术/trace/JSVMP/完整性与句柄释放；对应用运行 `--self-test` 并要求标记输出。任一失败即非零退出。

## 作品索引

| # | 类型 | 名称 | 等级 | 分类 | 入口 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | sdk | [Secure Storage SDK](./01-secure-storage/README.md) | commercial | secure-storage | `src/index.js` | `node verify.mjs` |
| 02 | sdk | [WebAuthn Passkey SDK](./02-webauthn-passkey/README.md) | commercial | authentication | `src/index.js` | `node verify.mjs` |
| 03 | sdk | [Device Fingerprint SDK](./03-device-fingerprint/README.md) | commercial | device-identity | `src/index.js` | `node verify.mjs` |
| 04 | sdk | [Bot Detection SDK](./04-bot-detection/README.md) | commercial | bot-defense | `src/index.js` | `node verify.mjs` |
| 05 | sdk | [Anti-Tamper SDK](./05-anti-tamper/README.md) | commercial | integrity | `src/index.js` | `node verify.mjs` |
| 06 | sdk | [JSVMP Protector SDK](./06-jsvmp-protector/README.md) | commercial | code-protection | `src/index.js` | `node verify.mjs` |
| 07 | sdk | [JavaScript Obfuscator SDK](./07-obfuscator/README.md) | commercial | code-protection | `src/index.js` | `node verify.mjs` |
| 08 | sdk | [License Verifier SDK](./08-license-verifier/README.md) | commercial | licensing | `src/index.js` | `node verify.mjs` |
| 09 | sdk | [E2EE Messaging SDK](./09-e2ee-messaging/README.md) | commercial | secure-messaging | `src/index.js` | `node verify.mjs` |
| 10 | sdk | [Secret Scanner SDK](./10-secret-scanner/README.md) | commercial | secrets-detection | `src/index.js` | `node verify.mjs` |
| 11 | virus | [Browser Locker](./11-browser-locker/README.md) | commercial | browser-locker | `sample.js` | `run-all --filter 11` |
| 12 | virus | [Fileless Memory Loader](./12-fileless-loader/README.md) | commercial | fileless-malware | `sample.js` | `run-all --filter 12` |
| 13 | virus | [Service Worker Persistence](./13-service-worker-persistence/README.md) | commercial | persistence | `sample.js` | `run-all --filter 13` |
| 14 | virus | [Prototype Pollution Rootkit](./14-prototype-pollution-rootkit/README.md) | commercial | prototype-pollution | `sample.js` | `run-all --filter 14` |
| 15 | virus | [Session Hijacker](./15-session-hijacker/README.md) | commercial | session-theft | `sample.js` | `run-all --filter 15` |
| 16 | virus | [Formjacker](./16-formjacker/README.md) | commercial | formjacking | `sample.js` | `run-all --filter 16` |
| 17 | virus | [Web3 Approval Drainer](./17-web3-approval-drainer/README.md) | commercial | wallet-drainer | `sample.js` | `run-all --filter 17` |
| 18 | virus | [Crypto Clipper Worm](./18-crypto-clipper-worm/README.md) | commercial | clipboard-hijacker | `sample.js` | `run-all --filter 18` |
| 19 | virus | [Malicious PWA Updater](./19-pwa-updater-malware/README.md) | commercial | pwa-malware | `sample.js` | `run-all --filter 19` |
| 20 | virus | [WASM Cryptominer](./20-wasm-cryptominer/README.md) | commercial | cryptominer | `sample.js` | `run-all --filter 20` |
| 21 | virus | [DNS Beacon](./21-dns-beacon/README.md) | commercial | dns-covert-channel | `sample.js` | `run-all --filter 21` |
| 22 | virus | [JSVMP Ransomware Stage](./22-ransomware-jsvmp/README.md) | commercial | ransomware | `sample.js` | `run-all --filter 22` |
| 23 | app | [SOC Triage Console](./23-soc-triage-console/README.md) | commercial | soc-triage | `app.mjs` | `--self-test` |
| 24 | app | [Malware Zoo Manager](./24-malware-zoo-manager/README.md) | commercial | sample-management | `app.mjs` | `--self-test` |
| 25 | app | [Threat-Intel Enricher](./25-threat-intel-enricher/README.md) | commercial | threat-intelligence | `app.mjs` | `--self-test` |
| 26 | app | [CI Security Gate](./26-ci-security-gate/README.md) | commercial | ci-security | `app.mjs` | `--self-test` |
| 27 | app | [Phishing-Kit Analyzer](./27-phishing-kit-analyzer/README.md) | commercial | phishing-analysis | `app.mjs` | `--self-test` |
| 28 | app | [Detection Rule Generator](./28-detection-rule-generator/README.md) | commercial | detection-engineering | `app.mjs` | `--self-test` |
| 29 | app | [Incident-Response Playbook](./29-ir-playbook/README.md) | commercial | incident-response | `app.mjs` | `--self-test` |
| 30 | app | [Sandbox Farm](./30-sandbox-farm/README.md) | commercial | orchestration | `app.mjs` | `--self-test` |

## SDK 使用示例

```js
import { createVault } from './examples/works/01-secure-storage/src/index.js'
const vault = await createVault({ password: 'passphrase' })
const envelope = await vault.seal('secret')
console.log(await vault.open(envelope))
```

每个 SDK 的 `README.md` 包含完整 API、错误码、安全边界与集成建议，`verify.mjs` 是可直接运行的契约测试。

## 病毒样本分析示例

```bash
node tools/cli.js analyze examples/works/12-fileless-loader/sample.js
node tools/cli.js analyze examples/works/22-ransomware-jsvmp/sample.js --json | jq .tracing.jsvmp
node tools/cli.js restore examples/works/11-browser-locker/sample.js
```

病毒样本全部在沙箱中运行：网络被 mock、无真实文件/进程访问；`.test`/`.example.net` 为保留域。

## 应用使用示例

```bash
node examples/works/23-soc-triage-console/app.mjs --file examples/sample-loader.js
node examples/works/26-ci-security-gate/app.mjs --path ./src --fail-on suspicious
node examples/works/30-sandbox-farm/app.mjs examples/sample-loader.js examples/benign.js --concurrency 2
```

## 与产品套件的关系

- `examples/products/`：50 个产品样本包（攻击链 + 分析契约）。
- `examples/works/`：30 个完整作品（SDK/病毒/应用），可独立运行、验证和集成。
- `examples/national-sdk/`：硬化国密 JS-SDK 工程。

## 安全声明

所有病毒样本均为合成演练样本，不包含可用 C2、真实凭据或破坏性宿主操作；所有 SDK/应用可离线运行，不发起真实网络请求。
