# 15 Hybrid Ransomware JSVMP — hybrid-ransomware-jsvmp

| 属性 | 值 |
| --- | --- |
| 编号 | 15 |
| 名称 | Hybrid Ransomware JSVMP |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | ransomware |
| 入口 | `sample.js` |
| 验证 | `node examples/suite/run-all.mjs --filter 15` |

## 1. 作品定位

JSVMP 保护的混合勒索阶段：混淆虚拟机执行字节码生成加密配置（算法、轮次、目标集、校验和），宿主代码据此用 WebCrypto AES-GCM 加密模拟工作区、导出密钥材料外传，并投放带钱包地址与倒计时的勒索信。样本不读写真实文件，所有数据为合成字符串，端点位于 `example.net`。

## 2. 完整攻击链

1. 运行 `__stage_vm()`：虚拟字节码在栈机上构造配置对象 `{rounds, cipher, target, checksum}`。
2. 读取 VM 结果；失败则回退到等价静态配置，保证阶段继续。
3. 在 `localStorage` 播种三份"财务文件"（`finance/Q4-forecast.xlsx` 等合成内容）。
4. `crypto.getRandomValues` 生成 32 字节密钥与 12 字节 IV，`subtle.importKey` 导入 AES-GCM。
5. 逐文件 `subtle.encrypt`，记录密文长度与 IV 数组；`subtle.exportKey('raw')` 导出密钥。
6. 将 `{target, cipher, rounds, checksum, keyId, files}` Base64 编码，POST 到 `locker.example.net/ransom/vm`，并 `sendBeacon` 冗余外传。
7. Base64 解码勒索信模板，替换 `KEYID` 占位符，渲染 `<div id="hybrid-ransom-note">`，并写入钱包地址 `bc1q...`。
8. 写入 `ransom:keyid`、`ransom:stage`、`ransom:wallet` 与 `ransom_vm` Cookie。
9. 350ms 倒计时三轮，制造付款期限压力。

## 3. 核心能力

- JSVMP 配置虚拟机：12 种操作码、循环与属性读写构建加密配置，静态分析需先解虚拟化。
- AES-GCM 文件加密：WebCrypto `importKey/encrypt/exportKey` 全链路。
- 密钥导出外传：密钥 ID 与密文元数据分离外传，为后续解密谈价服务。
- 勒索信 UI：模板 Base64 编码、运行时替换 keyId 并插入钱包地址。
- 倒计时施压：定时器驱动的付款期限提示。
- 本地持久化：keyId/stage/wallet 三键 + Cookie，便于重启后定位受害者。

## 4. 快速开始

```bash
node examples/suite/15-hybrid-ransomware-jsvmp/build.mjs   # 重新生成 sample.js（可选）
node tools/cli.js analyze examples/suite/15-hybrid-ransomware-jsvmp/sample.js
node tools/cli.js analyze examples/suite/15-hybrid-ransomware-jsvmp/sample.js --json | jq '.tracing.jsvmp, .verdict, .static.iocs.wallets'
node examples/suite/run-all.mjs --filter 15
```

## 5. 预期取证结果（验证与预期结果）

`run-all.mjs` 根据 `expect.requireVm` 启用 `instrumentation: { jsvmp: true }`，校验 `work.json.expect`，实际观测：

- 判定：`malicious`，score 61（≥ 55）。
- IOC：`urls` 1 条（`locker.example.net/ransom/vm`）；`wallets` 1 条（源码钱包地址，Base64 解码后的勒索信与其一致而被去重）；Base64 6 条。
- Artifact：`decoded-string`（勒索信 HTML 模板、C2 载荷）。
- 技术标签：`cryptography`、`network-communication`、`web-storage`、`dom-injection`、`encoded-string-decoding`、`control-flow-dispatch`。
- Trace：`net` 1、`storage` 7、`dom` 2、`timer` 2；`tracing.jsvmp.detected=true`，12 种操作码、`jsvmp:opcode` 事件可还原虚拟程序。
- 控制台可见 `vm profile aes-256-gcm rounds=7 checksum=273`、`staged 3 files keyId=...`。

## 6. 检测与处置建议

- 对 `jsvmp` trace 做符号执行/反汇编，还原被虚拟化的加密配置与密钥派生流程。
- 监控页面短时间内的批量 `crypto.subtle.encrypt` 与 `exportKey` 组合。
- 对包含 `bc1`/`0x` 钱包地址与"encrypted/key"话术的 DOM 注入建立高优先级告警。
- 事件响应时隔离浏览器配置目录、保全 keyId 与密文元数据、从备份恢复并轮换受影响凭据。

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实文件、真实密钥或可用 C2。加密对象为 `localStorage` 中的合成字符串，钱包地址为无效示例地址。

## 8. 生成与 JSVMP 分析

`sample.js` 由本目录 `build.mjs` 通过平台 `tools/jsvmp` builder 生成（obfuscated opcode cipher + 编码常量池）：

```bash
node examples/suite/15-hybrid-ransomware-jsvmp/build.mjs
node examples/suite/run-all.mjs --filter 15
```

VM 程序位于 `build.mjs` 的 `buildStageProgram()`：`NEW_OBJ/DUP/PUSH/SET_PROP/GET_PROP/LT/JMP_IF_NOT/ADD/MUL/JMP/HALT` 构造配置对象并计算 `checksum=273`。分析器在 `requireVm` 下启用 JSVMP instrumentation，预期 `tracing.jsvmp.detected=true` 并产生可还原的 opcode 序列。
