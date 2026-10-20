# 50 个商业级 / 军工级恶意 JavaScript 产品示例集

本目录包含 **50 个完整的产品级分析对象**。每个产品都是一个独立包：

- `product.json`：产品档案与**机器可校验的分析契约**（判定等级、最低分、IOC 类别、artifact 类型、技术标签、追踪类型、可选 JSVMP 检测、可选网络路由）。
- `sample.js`：完整、可执行、可在沙箱中安全分析的样本（真实攻击链，网络全部 mock）。
- `README.md`：产品定位、完整攻击链、关键实现、分析命令、预期取证结果、检测与处置建议。

所有样本仅用于防御性检测/取证/还原能力验证：域名使用保留域，网络、文件、进程访问均被沙箱阻断；不含可用 C2、真实凭据或破坏性宿主操作。

## 套件概览

- 产品数量：**50**
- 商业级：**37** ｜ 军工级：**13**
- 严重度：CRITICAL 20 ｜ HIGH 25 ｜ MEDIUM 5
- 覆盖类别：银行注入、卡 skimmer、钱包盗取、勒索/擦除、APT 信标、DNS 隧道、隐写、WebSocket/HTTP C2、DGA、供应链、广告欺诈、反分析/反取证、JSVMP/JSFuck/字符串数组保护等。

## 一键验证全部产品

```bash
node examples/products/run-all.mjs            # 表格 + 契约校验
node examples/products/run-all.mjs --json     # 机器可读结果
node examples/products/run-all.mjs --filter 01,17,40
```

`run-all.mjs` 对每个产品运行严格环境下的 `analyzeSample`，并校验 `product.json.expect`：
判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型、JSVMP 检测（如声明）与样本哈希。任一不满足即非零退出。

## 产品索引

| # | 代号 | 等级 | 严重度 | 行业 | 类别 | 预期判定 | 目录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | HELIOS-WEBINJECT | commercial | critical | financial-services | banking-trojan | `malicious` ≥60 | [`01-bank-webinject`](./01-bank-webinject/README.md) |
| 02 | MAGEPAY-SKIMMER | commercial | high | e-commerce | card-skimming | `malicious` ≥60 | [`02-card-skimmer`](./02-card-skimmer/README.md) |
| 03 | VAULTDRAIN | commercial | high | web3 | wallet-drainer | `suspicious` ≥50 | [`03-crypto-drainer`](./03-crypto-drainer/README.md) |
| 04 | SWAPCLIP | commercial | high | crypto | clipboard-hijacker | `suspicious` ≥40 | [`04-clipboard-swapper`](./04-clipboard-swapper/README.md) |
| 05 | LEDGERBEC | commercial | high | enterprise | business-email-compromise | `suspicious` ≥25 | [`05-bec-invoice-fraud`](./05-bec-invoice-fraud/README.md) |
| 06 | OTPRELAY | commercial | high | financial-services | otp-relay | `suspicious` ≥55 | [`06-otp-relay`](./06-otp-relay/README.md) |
| 07 | PAYGRAB | commercial | high | e-commerce | form-grabber | `suspicious` ≥45 | [`07-payment-form-grabber`](./07-payment-form-grabber/README.md) |
| 08 | PAYROLLX | commercial | high | enterprise | payroll-fraud | `suspicious` ≥28 | [`08-payroll-diversion`](./08-payroll-diversion/README.md) |
| 09 | HASHMINE | commercial | high | cryptojacking | cryptominer | `malicious` ≥60 | [`09-cryptominer-web`](./09-cryptominer-web/README.md) |
| 10 | PONZIPAGE | commercial | high | financial-fraud | investment-scam | `suspicious` ≥40 | [`10-investment-scam`](./10-investment-scam/README.md) |
| 11 | GHOSTRELAY | military | critical | defense | apt-beacon | `suspicious` ≥55 | [`11-apt-beacon`](./11-apt-beacon/README.md) |
| 12 | NAMESIFT | military | critical | defense | dns-tunneling | `suspicious` ≥40 | [`12-dns-tunnel`](./12-dns-tunnel/README.md) |
| 13 | DEADDROP | military | critical | intelligence | dead-drop | `suspicious` ≥35 | [`13-dead-drop-resolver`](./13-dead-drop-resolver/README.md) |
| 14 | PIXELVAULT | military | critical | intelligence | steganography | `suspicious` ≥40 | [`14-stego-image-loader`](./14-stego-image-loader/README.md) |
| 15 | AIRQR | military | critical | defense | airgap-exfiltration | `suspicious` ≥30 | [`15-qr-airgap-exfil`](./15-qr-airgap-exfil/README.md) |
| 16 | SIGPROF | military | medium | intelligence | sigint-profiling | `suspicious` ≥30 | [`16-sigint-profiler`](./16-sigint-profiler/README.md) |
| 17 | SPECTREWS | commercial | critical | remote-access | websocket-c2 | `suspicious` ≥40 | [`17-websocket-c2`](./17-websocket-c2/README.md) |
| 18 | POLLC2 | commercial | critical | remote-access | http-c2 | `suspicious` ≥40 | [`18-longpoll-c2`](./18-longpoll-c2/README.md) |
| 19 | MAILSPY | commercial | high | enterprise | email-exfiltration | `suspicious` ≥26 | [`19-email-exfil`](./19-email-exfil/README.md) |
| 20 | CREDHARVEST | commercial | critical | enterprise | credential-theft | `suspicious` ≥28 | [`20-credential-harvester`](./20-credential-harvester/README.md) |
| 21 | LOCKSTAGE | commercial | critical | ransomware | ransomware-stager | `suspicious` ≥45 | [`21-ransomware-stager`](./21-ransomware-stager/README.md) |
| 22 | ASHWIPE | military | critical | cyber-operations | wiper | `suspicious` ≥40 | [`22-wiper-dropper`](./22-wiper-dropper/README.md) |
| 23 | NOTEFORGE | commercial | high | ransomware | ransom-note | `suspicious` ≥30 | [`23-ransom-note`](./23-ransom-note/README.md) |
| 24 | GLITCHBOMB | commercial | medium | nuisance | destructive-prank | `suspicious` ≥25 | [`24-destructive-prank`](./24-destructive-prank/README.md) |
| 25 | VAULTLOCK | commercial | critical | ransomware | data-encryptor | `suspicious` ≥40 | [`25-backup-encryptor`](./25-backup-encryptor/README.md) |
| 26 | NOBOOT | military | high | cyber-operations | anti-recovery | `suspicious` ≥30 | [`26-anti-recovery`](./26-anti-recovery/README.md) |
| 27 | SHAMESCAM | commercial | high | fraud | sextortion | `suspicious` ≥25 | [`27-sextortion-scam`](./27-sextortion-scam/README.md) |
| 28 | SWARM | commercial | critical | botnet | botnet-agent | `suspicious` ≥45 | [`28-botnet-agent`](./28-botnet-agent/README.md) |
| 29 | CLICKFARM | commercial | medium | adtech-fraud | click-fraud | `suspicious` ≥35 | [`29-clickfraud`](./29-clickfraud/README.md) |
| 30 | POPUNDER | commercial | medium | adware | popunder | `suspicious` ≥40 | [`30-adware-popunder`](./30-adware-popunder/README.md) |
| 31 | COOKIESTUFF | commercial | medium | affiliate-fraud | cookie-stuffing | `suspicious` ≥30 | [`31-cookie-stuffer`](./31-cookie-stuffer/README.md) |
| 32 | TDSROUTE | commercial | high | malvertising | traffic-distribution | `suspicious` ≥30 | [`32-traffic-distribution`](./32-traffic-distribution/README.md) |
| 33 | ADREDIR | commercial | high | malvertising | malvertising | `suspicious` ≥35 | [`33-malvertising-redirect`](./33-malvertising-redirect/README.md) |
| 34 | CVEKIT | commercial | critical | exploit-kit | exploit-kit | `malicious` ≥60 | [`34-exploit-kit-loader`](./34-exploit-kit-loader/README.md) |
| 35 | DRIVEBY | commercial | high | malware-delivery | drive-by-download | `suspicious` ≥30 | [`35-driveby-downloader`](./35-driveby-downloader/README.md) |
| 36 | PHISHKIT | commercial | critical | credential-phishing | phishing-kit | `suspicious` ≥50 | [`36-phishing-kit`](./36-phishing-kit/README.md) |
| 37 | SANDBOXGHOST | commercial | high | evasion | sandbox-evasion | `suspicious` ≥35 | [`37-sandbox-evasion`](./37-sandbox-evasion/README.md) |
| 38 | VMORACLE | military | high | evasion | vm-detection | `suspicious` ≥30 | [`38-vm-detect`](./38-vm-detect/README.md) |
| 39 | CLEANTRACE | military | high | cyber-operations | anti-forensics | `suspicious` ≥30 | [`39-anti-forensics`](./39-anti-forensics/README.md) |
| 40 | VMORPH | commercial | critical | malware-protection | jsvmp | `suspicious` ≥40 | [`40-jsvmp-loader`](./40-jsvmp-loader/README.md) |
| 41 | BRACKETFUCK | commercial | high | malware-protection | jsfuck | `suspicious` ≥45 | [`41-jsfuck-loader`](./41-jsfuck-loader/README.md) |
| 42 | HEXARRAY | commercial | high | malware-protection | string-array | `suspicious` ≥40 | [`42-string-array-loader`](./42-string-array-loader/README.md) |
| 43 | TRAPDOOR | commercial | high | evasion | anti-debugging | `suspicious` ≥30 | [`43-anti-debug`](./43-anti-debug/README.md) |
| 44 | POLYGLOT | commercial | high | malware-protection | polyglot | `suspicious` ≥35 | [`44-polyglot-loader`](./44-polyglot-loader/README.md) |
| 45 | TELEBOT | commercial | critical | remote-access | telegram-c2 | `suspicious` ≥40 | [`45-telegram-c2`](./45-telegram-c2/README.md) |
| 46 | DISCORDHOOK | commercial | critical | remote-access | discord-c2 | `malicious` ≥60 | [`46-discord-c2`](./46-discord-c2/README.md) |
| 47 | SLACKHOOK | commercial | critical | remote-access | slack-c2 | `suspicious` ≥40 | [`47-slack-c2`](./47-slack-c2/README.md) |
| 48 | DGAFALL | military | high | command-and-control | dga | `suspicious` ≥40 | [`48-dga-domain`](./48-dga-domain/README.md) |
| 49 | FASTFLUX | military | high | command-and-control | fast-flux | `suspicious` ≥30 | [`49-fastflux-c2`](./49-fastflux-c2/README.md) |
| 50 | NPMWORM | military | critical | supply-chain | supply-chain-worm | `suspicious` ≥45 | [`50-supply-chain-worm`](./50-supply-chain-worm/README.md) |

## 逐个产品分析

```bash
node tools/cli.js analyze examples/products/01-bank-webinject/sample.js
node tools/cli.js analyze examples/products/01-bank-webinject/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/products/42-string-array-loader/sample.js
node tools/cli.js run examples/products/40-jsvmp-loader/sample.js --events | head -40
```

## 目录约定与扩展

- 每个产品一个 `NN-slug/` 目录，编号 01–50。
- `product.json` 的 `expect` 是**契约**：新增产品必须声明可验证的判定/IOC/artifact/技术/追踪预期，并由 `run-all.mjs` 校验。
- 样本必须保持无真实 I/O：网络只使用 `fetch`/XHR/WebSocket/Beacon 等浏览器 API，由沙箱 mock；禁止真实文件/进程访问。
- 期望值应反映产品在“仅客户端证据”下的真实能力，而不是为了分数编造行为。

## 重新生成

```bash
node examples/products/build-jsvmp-loader.mjs   # 重新生成 40-jsvmp-loader 的 JSVMP 样本
```

## 相关文档

- [`../../examples/README.md`](../README.md) — 基础示例与演示脚本
- [`../../docs/REPORT-SCHEMA.md`](../../docs/REPORT-SCHEMA.md) — 报告字段
- [`../../docs/RESEARCH-ANTI-ANALYSIS.md`](../../docs/RESEARCH-ANTI-ANALYSIS.md) — 反分析技术与暴露面
