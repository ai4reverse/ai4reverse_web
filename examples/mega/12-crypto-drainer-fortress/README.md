# MEGA-12 · 加密吸血器堡垒（Crypto Drainer Fortress）

- 类型：`virus` ｜ 等级：`military` ｜ 单文件：`crypto-drainer-fortress.js` ｜ 条目：`{ id: "12", slug: "crypto-drainer-fortress" }`
- 规模：有效代码 ≈ 4.46 MB（去注释/空行），单文件、零依赖、零 `require/import/module`、零 WebAssembly。
- 自检：`node crypto-drainer-fortress.js` → `MEGA SELFTEST OK` + `MEGA METRICS {...}`，退出码 0。

## 作品定位

本作品模拟"**钱包授权钓鱼 + 剪贴板地址替换**"类型的军事级吸血器：它在受害者页面里构造一份看似正常的 `permit` 授权载荷，用白盒与自定义密码组成的多态管线密封后攒进内存外传缓冲，并同时运行剪贴板劫持逻辑（把复制出来的来源地址替换成攻击者地址）。

**本样本不接触任何链**：没有 RPC 客户端、没有签名、没有 `fetch`/`XMLHttpRequest`/`WebSocket`、没有私钥；钱包地址、余额、permit 字段全部是合成 fixture。所有"外传"只是把密文推进一个内存数组（`chain=simulated`、`network=simulated`）。

## 完整攻击链

1. **解链（黑洞混淆）**：1800 条加密字符串、3 套 16 进制字母表、层序 stride 13 / offset 9 / 实例化 bias；6 个钉死槽位（`permit.build.v12`、`clipboard.swap.12`、`exfil.buffer.v12`、`address.match.12`、`wallet.sink.v12.`、`chain.simulated.1`）必须精确命中。
2. **环境测绘**：94 个渲染引擎级探测（含 `document.all`、WebGL、canvas 回读、字体度量、跨 realm、`crypto.subtle`、`navigator.clipboard`），得到 `interactive-surface` / `headless-safe` 剖面。
3. **钱包 fixture**：8 个 source、6 个 sink、12 个 decoy 钱包；24 个与 source **共享前缀 6 位 + 后缀 4 位**的诱饵地址（这是剪贴板替换的关键素材）。
4. **VM permit 构造**：200 份 `PERMIT_SPECS`，每个字段（`value/nonce/deadline`）先经过内层 VM 求值（`innerRunner(id)`）再序列化；permit 文本用实例化变体密封，摘要由 WB-1/WB-2 交叉折叠得到。
5. **加密外传缓冲**：每份密文再走一次混合管线进入 `EXFIL`（200 条，97 987 字节），逐条回解验证前缀 `permit#<id>`；缓冲只存在于内存。
6. **剪贴板/地址逻辑**：180 次模拟复制，按前缀/后缀相似度打分，达到 `CLIP_RULES.minScore` 时把剪贴板内容改写为诱饵地址，并断言"替换后绝不等于来源地址"。
7. **吸血计划（只计算不执行）**：按余额阈值筛出目标，扣减无法整除的尾数，汇总 `planValue`；断言 `CHAIN_SIMULATED === true`。
8. **反调试**：栈完整性、时间偏斜、`Function.prototype.toString`、console 完整性、devtools 间隔（5 项）。

## 黑洞混淆

- **三层解码**：XOR 密钥流 → 16 进制重打包（3 套字母表轮换）→ Unicode 位移（`key % 13`）。
- **层序多态**：`LAYER_ORDERS[(index*13 + 9 + BIAS) % 4]`；与 MEGA-10（7/3）、MEGA-11（11/5）不同，同一份解链脚本换作品即失效。
- **自校验**：解码总长必须等于 `BH_CHECK`；钉死槽位比对失败立即抛错。
- **负载真实**：表中包含 `permit|vault|sink|clip|swap` 等语义词与诱导性组合，便于后续按语义聚类，而不是纯噪声。

## 堡垒 JSVMP

- **外层**：158 184 条编码指令；指令字 `((arg<<5)|op) ^ vmKey(VM_SEED, pc)`，opcode 语义由独立洗牌的 `VM_OPMAP` 决定，处理器表以"编码后 opcode"为下标。
- **内层**：11 604 条指令，第二套 `VM_INNER_OPMAP` + `VM_SEED2`，由 `CALL_INNER` 触发；permit 字段与清洗决策都取自内层结果。
- **栈完整性**：宏展开后净栈深恒为 0；关键步 `TICK` 把栈顶折入 FNV 哈希，报告步数与嵌入指令数一致（`vmOps=158184`）。
- **"授权即程序"**：permit 的 `nonce/deadline/value` 不是常量表，而是 VM 输出与 fixture 的混合，静态脱表无法直接得到明文授权结构。

## 白盒与混合加密

| 套件 | 构造 | 特点 |
| --- | --- | --- |
| WB-1 | T-Box SPN（10 轮 × 4 × 4096 = 163 840 项） | 密钥隐入表，旋转 9/19 |
| WB-2 | 4 寄存器 ARX 梯（210 000 项旋转语料 + 2048 掩码） | 逐实例旋转量隐式编码 |
| WB-3 | Feistel 梯（8 lane、12 轮、2048 白化掩码） | 双 S 层 + 掩码白化 |

- **自定义密码**：`CC-1` 改造 RC4（2 轮 KSA、`+r*53`、`(a>>>1)` 混合）；`CC-2` **11 轮** Feistel（长度前缀 + 8 字节分组 + `>>3` 尾混）；`CC-3` **13 轮**类 ChaCha（`Math.imul(d,3)` / `Math.imul(b,7)` 非标准线性层）。
- **自定义编码**：36 进制自定义字母表（4 位/字符）、32 进制位打包、3 字节→4 字符位平面交错（`ENC_PERM` 决定顺序）、CJK 区 `0x5b00 + byte*2` 宽字符映射。
- **混合管线**：14 个变体各持 6 层随机步骤 + 1 层宽字符外框（`mixedRounds = 7`），步骤从 10 种算子中不重复抽取；自检对每个变体执行 `protect → unprotect` 往返并核对向量校验和。
- **摘要**：`permit` 摘要 = `wb1Digest(id+value) ^ wb2Digest(nonce)`，两次独立计算必须一致（`checks=16/16`）。

## 渲染引擎级环境检测

94 个探测，围绕"**是不是可交互的真实渲染环境**"：

- `document.all`（HTMLDDA）：`typeof === 'undefined'`、布尔上下文为假、`.length` 可读；缺失时用 shim 校验语义并标记 `degraded`，只有探测真实执行后 `documentAll` 才为真。
- GPU/Canvas：WebGL `VENDOR/RENDERER/getSupportedExtensions`、`getContext('2d')`、`toDataURL` 像素回读。
- 排版/几何：`measureText`、`getBoundingClientRect`、`screen`、`matchMedia`、`devicePixelRatio`。
- 样式/跨 realm：`CSS.supports`、`querySelector`、`iframe.contentWindow`。
- 钱包相关面：`crypto.subtle`/`getRandomValues`、`navigator.clipboard`（只读探测，不写剪贴板）。
- 能力面：`Worker`、`ServiceWorker`、`BroadcastChannel`、`WebAssembly` 可用性、`Intl` 时区、storage/cookie、35 项 feature 探测。

## 快速开始

```bash
cd examples/mega/12-crypto-drainer-fortress
node crypto-drainer-fortress.js
```

期望输出（节选）：

```
[mega] permits=200 firstDigest=46da016a exfil=200 bytes=97987 chain=simulated
[mega] clipboardSeeds=180 swaps=180 planTargets=8 planValue=4184691
[mega] vmOps=158184 inner=11604 variants=14 mixedRounds=7
MEGA SELFTEST OK
MEGA METRICS {"whitebox":3,"customCiphers":3,"encodings":4,"jsvmpOps":169788,"envChecks":94,"polymorphicVariants":14,"mixedRounds":7,"documentAll":true,"antiDebug":5}
```

## 验证

```bash
node examples/mega/run-all.mjs --filter 12
```

- 目录内仅 1 个 JS 文件；无 `require/import/export/module.exports/define([/node:/WebAssembly.*` 命中；
- 有效代码 ≥ 3.4 MB（本作品 4.46 MB）；
- 自检 16 项断言（`checks=16/16`）：黑洞解码与钉死槽位、白盒表校验和、白盒活性、变体往返、编码往返、VM 步数、内层 VM、探测数、`document.all`、钱包 fixture、permit 构造、permit 摘要、外传缓冲、剪贴板替换、吸血计划。

## 防御建议

- **permit 识别**：真实吸血器最终必须把 permit 交给 `eth_signTypedData` 类接口；监控该调用与"页面内自主构造 typed-data 结构"的组合，比签名黑名单更有效。
- **剪贴板保护**：地址替换依赖"前缀/后缀相似"（本样本共享 6+4 位），钱包应在粘贴时做完整地址校验、展示 ENS/白名单标记，并对剪贴板变更做来源提示。
- **白盒还原**：`WB1_T/WB2_C/WB3_S` 各自带校验和（`WB1_CHK/WB2_CHK/WB3_CHK`），可作为还原正确性判据；把密钥流 XOR 掉即可解密 `EXFIL` 缓冲。
- **变体聚类**：`permit` 与 `EXFIL` 使用不同变体密封，单条密文签名会漏；应以"回解后结构一致（`permit#<id>`）"为聚类特征。
- **环境对抗**：样本探测 `document.all`/WebGL/字体/剪贴板；沙箱应保证这些面"存在但语义中性"，避免自身指纹反而暴露。

## 说明

- 本作品是**分析用合成样本**：`CHAIN_SIMULATED = true`、`NETWORK_ALLOWED = false`，`EXFIL` 只是内存数组，`clipboard` 只是普通对象；不存在链上交互、私钥、签名或真实剪贴板读写。
- 地址、余额、permit 字段均为随机合成 fixture（`0x` + 随机 hex），不与任何真实账户相关。
- 体积来自被真实使用的表（白盒语料、嵌套字节码、变体向量、探测矩阵、permit fixture），不存在为凑体积而存在的死代码。
