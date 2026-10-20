# MEGA — 18 个纯 JS 单文件商业级/军工级完整作品（有效代码 ≥50MB）

`examples/mega/` 提供 **18 个单文件、100% 纯 JavaScript、零依赖、零分包** 的完整作品；每个作品内嵌黑洞级多态混淆、堡垒级嵌套 JSVMP、多套动态隐式白盒/魔改密码/自定义编码与渲染引擎级环境检测。

- 作品数量：**18**（病毒样本 8 / JS 安全 SDK 8 / 完整应用 2）
- 有效代码（去注释/空行、仅统计单文件 JS）：**70.32MB**，满足 ≥50MB 硬性要求
- 每个作品只有一个 `<slug>.js`；`work.json`/`README.md` 之外无任何代码文件，无 `require/import/module/WebAssembly`。

## 一键验证

```bash
node examples/mega/run-all.mjs                 # 18/18 + 纯度/能力/≥50MB 门禁
node examples/mega/run-all.mjs --json          # 机器可读 + 字节/指标
node examples/mega/run-all.mjs --filter 01,07,13
node tests/examples-mega.test.js               # node --test 入口
```

Runner 校验：单文件纯 JS（拒绝 require/import/export/module/AMD/node:/WASM）、每作品 ≥2.8MB 有效代码、总计 ≥50MB、`node <entry>.js` 输出 `MEGA SELFTEST OK` 与 `MEGA METRICS`，并验证 whitebox≥3、customCiphers≥3、encodings≥3、jsvmpOps≥1000、envChecks≥50、polymorphicVariants≥10、mixedRounds≥1、documentAll=true、antiDebug≥1。

## 作品索引

| #   | 类型  | 名称                                                                       | 等级       | 分类                         | 入口                            | 有效代码 |
| --- | ----- | -------------------------------------------------------------------------- | ---------- | ---------------------------- | ------------------------------- | -------: |
| 01  | virus | [BLACKHOLE Loader](./01-blackhole-loader/README.md)                        | military   | loader-blackhole-obfuscation | `blackhole-loader.js`           |   4.34MB |
| 02  | virus | [BASTION RAT](./02-bastion-rat/README.md)                                  | military   | remote-access-trojan         | `bastion-rat.js`                |   4.35MB |
| 03  | virus | [GHOSTRELAY APT Beacon](./03-apt-beacon/README.md)                         | military   | apt-long-haul-beacon         | `apt-beacon.js`                 |   4.52MB |
| 04  | sdk   | [Whitebox Crypto SDK](./04-whitebox-crypto-sdk/README.md)                  | military   | whitebox-crypto-sdk          | `whitebox-crypto-sdk.js`        |   3.96MB |
| 05  | sdk   | [JSVMP Fortress SDK](./05-jsvmp-fortress-sdk/README.md)                    | military   | jsvmp-fortress-sdk           | `jsvmp-fortress-sdk.js`         |   4.20MB |
| 06  | virus | [Ransomware Fortress](./06-ransomware-fortress/README.md)                  | military   | ransomware-fortress          | `ransomware-fortress.js`        |   4.29MB |
| 07  | sdk   | [Rendering Attestation SDK](./07-rendering-attestation-sdk/README.md)      | military   | rendering-attestation        | `rendering-attestation-sdk.js`  |   3.50MB |
| 08  | sdk   | [Polymorphic Obfuscator SDK](./08-polymorphic-obfuscator-sdk/README.md)    | commercial | polymorphic-obfuscator       | `polymorphic-obfuscator-sdk.js` |   3.50MB |
| 09  | sdk   | [DRM Whitebox SDK](./09-drm-whitebox-sdk/README.md)                        | commercial | drm-whitebox                 | `drm-whitebox-sdk.js`           |   3.50MB |
| 10  | virus | [Polymorphic Botnet Node](./10-botnet-polymorphic/README.md)               | military   | botnet-command-and-control   | `botnet-polymorphic.js`         |   4.14MB |
| 11  | virus | [Forensic Evasion Kit](./11-forensic-evasion-kit/README.md)                | military   | anti-forensics               | `forensic-evasion-kit.js`       |   4.02MB |
| 12  | virus | [Crypto Drainer Fortress](./12-crypto-drainer-fortress/README.md)          | military   | crypto-drainer               | `crypto-drainer-fortress.js`    |   4.46MB |
| 13  | sdk   | [MEGA Secure Messaging SDK](./13-secure-messaging-sdk/README.md)           | military   | secure-messaging             | `secure-messaging-sdk.js`       |   3.58MB |
| 14  | sdk   | [MEGA Zero-Trust Client SDK](./14-zero-trust-client-sdk/README.md)         | military   | zero-trust                   | `zero-trust-client-sdk.js`      |   3.63MB |
| 15  | app   | [MEGA Malware Behavior Analyzer](./15-malware-behavior-analyzer/README.md) | commercial | behavior-analysis            | `malware-behavior-analyzer.js`  |   3.57MB |
| 16  | sdk   | [Anti-Tamper Fortress SDK](./16-anti-tamper-fortress-sdk/README.md)        | military   | anti-tamper-sdk              | `anti-tamper-fortress-sdk.js`   |   3.59MB |
| 17  | virus | [Fortress Wiper Simulation](./17-wiper-fortress/README.md)                 | military   | wiper-fortress               | `wiper-fortress.js`             |   3.57MB |
| 18  | app   | [SOC Fortress Console](./18-soc-console/README.md)                         | commercial | soc-console                  | `soc-console.js`                |   3.60MB |

## 技术基线

- **黑洞级混淆**：多层加密字符串/操作码表、多态解码器、控制流平坦化、死分支、自校验、反调试陷阱、每实例随机常量。
- **堡垒级 JSVMP**：编码 opcode、乱序 handler、编码常量池、栈完整性校验、嵌套 VM/VM-in-VM。
- **混合加密**：≥3 套动态隐式白盒（SPN/Feistel/ARX 表驱动）、≥3 套魔改定制密码、≥3 套自定义编码，多轮混合流水线。
- **渲染引擎级环境检测**：`document.all` HTMLDDA（typeof/falsy/length）、CSS.supports/选择器、WebGL vendor/renderer/extensions、canvas 像素/toDataURL、字体度量、iframe 跨 realm、audio/media/permissions、screen/DPR、matchMedia、Intl/时区、DOM 构造器与布局几何、worker/service worker/WASM 可用性。

## 安全声明

所有作品为合成演练代码：病毒行为仅模拟（网络/DOM/存储操作被守卫或只作用于内存），不含真实 C2、凭据或破坏性宿主操作；SDK/应用可离线运行。
