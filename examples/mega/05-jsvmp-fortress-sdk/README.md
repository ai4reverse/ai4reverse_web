# 05 JSVMP Fortress SDK — jsvmp-fortress-sdk

| 属性 | 值 |
| --- | --- |
| 编号 | 05 |
| 名称 | JSVMP Fortress SDK |
| 类型 | 纯 JS 单文件虚拟机保护 SDK |
| 等级 | 军事级（military） |
| 分类 | jsvmp-fortress-sdk |
| 入口 | `jsvmp-fortress-sdk.js`（唯一 JS 文件） |
| 规模 | 有效代码 ≥ 3.4MB（表与语料全部参与校验） |
| 验证 | `node jsvmp-fortress-sdk.js` → `MEGA SELFTEST OK` + `MEGA METRICS` |

## 1. 作品定位

一个**可编译、可执行、可自证反篡改**的 JSVMP 保护 SDK 单文件样本。与 04（白盒密码重心）不同，
本作品的重心是**虚拟机本身**：内置的汇编器把人类可读的源码编译成被加密的字节码，
多个 VM 实例拥有各自的操作码置换与位置密钥，同一份源码在不同实例上编译出**完全不同的字节码**，
但语义一致；内层程序由 `NESTED` 指令在子实例中**重新编码后执行**（VM-in-VM）。

自检同时是一份"反篡改证明"：非法操作码、伪造栈深度、操作数漂移、语料翻位、数据段摘要
五类篡改都必须被检出。

## 2. 架构与数据流

```
源码行(PUSHI/JZ/CALL/NESTED/TLS ...)
        │  assembler（两趟：标签解析 + 编码发射）
        ▼
加密字节码 [op ^ order[] ^ posKey] [arg ^ posKey ^ f(pc)]
        │  实例化 dispatch（每个 VM 实例独立 order/opKey/接口）
        ▼
栈机执行：8 寄存器 / 256 深度 / 常量池 / 调用栈 / 增量折叠 fold
        │
        ├─ STACKCK  ── 深度 + 重算折叠比对
        ├─ NESTED   ── 子实例 rekey(重编码) → 递归执行
        └─ EMIT     ── 输出
```

启动流程：数据解码 → 环境探针 → 反调试 → 语料结构校验 → 多态变体校验 → SDK 自检。

## 3. 黑洞混淆

- 分层字符串表：明文 → 密钥流异或 → 12 种多态算法之一加密，表头记录变体编号；
- 变体环状复用：reverse-xor / nibble-add / lcg-stream / rotate-mask / bit-rotate / xor-chain /
  bitrev-reverse / sub-position / add-cbc / murmur-stream / mask-reverse / swap-chain；
- 每个数据段独立 FNV-1a 摘要，任一段被改写都会在装载阶段抛错或使 `pack-digest` 检查失败；
- 死分支/不透明谓词与状态机式装载顺序共同掩盖真实控制流。

## 4. 堡垒 JSVMP（本作核心）

| 机制 | 实现 |
| --- | --- |
| 操作码加密 | `raw = order[op] ^ opKey[(pc>>2)&15] ^ ((pc/4*7+13)&255)` |
| 操作数加密 | `raw = arg ^ opKey[(pc+k)&15] ^ ((pc*31+k*17)&255)` |
| handler 乱序 | `order` 为 64 项费雪-耶茨置换，`opMap` 为逆置换 |
| 常量池 | 每程序独立池，`PUSHC` 索引越界安全包裹 |
| 栈完整性 | 增量异或折叠 `fold`；`STACKCK` 重算真实栈折叠并比对深度 |
| VM 内嵌 VM | `NESTED` → 子实例 `rekey` 重编码目标程序 → 子实例执行 |
| 多态编译 | 同一源码 × 4 实例 → 4 种字节码，4 个相同结果 |
| 预算保护 | 单程序步数上限，防止恶意循环 |

内嵌语料约 30 万条指令（见 `jsvmpOps`），自检逐条解码校验；汇编器支持标签、相对跳转、
`CALL/RET`、`NESTED`、`STACKCK`、`TLS`（实例私有常量）。

```text
PUSHI 0 / STORE 0 / PUSHI 1 / STORE 1 / loop: / LOAD 1 / PUSHI 21 / SUB / JZ done
LOAD 0 / LOAD 1 / ADD / STORE 0 / LOAD 1 / PUSHI 1 / ADD / STORE 1 / JMP loop
done: / LOAD 0 / EMIT          -> 210
```

## 5. 白盒与混合加密

- **白盒 SPN（3 套）**：18/16/20 轮，每轮 16 张 256 项 T-box + 逆表，密钥异或进表项隐式存在；
- **改造密码（3 种）**：Onyx31（31 轮 Feistel 密钥流，奇数轮数）、BitSieve（8×8 位平面转置 +
  每行密钥旋转 + 尾部独立流）、Quartz（4 轮 even-Mansour 乘法混合）；
- **自定义编码（3 种）**：Rune32（卢恩字母 5bit）、QuartetSwap（带圈数字 4bit、LSB-first 位序）、
  Base70（数学符号 6bit），三者均带变宽长度前缀（ceil(32/位宽) 个符号）与实例盐旋转；
- **混合管线**：本作把管线与**信封**叠加 —— 管线（cip→wb 交替、4–6 轮、以编码收尾）
  输出再经多态变体封装 + FNV 校验头，形成 `VF05.<variant>.<rounds>.<sum>.<hex>` 信封；
  校验头不符直接拒绝，充分体现"分层"与本作"先验证后解密"的策略差异。

## 6. 渲染引擎环境检测

240 行 × 256 字节探针矩阵驱动 72 类渲染引擎探针（矩阵字节同时决定参数与摘要）：

- `document.all` HTMLDDA：`typeof`/`Boolean`/`== null`/`.length` 四元组；
- CSS：`CSS.supports` 属性对、`CSS.escape`、`:has()`/`::marker` 选择器、样式表规则；
- WebGL/WebGL2：VENDOR/RENDERER/VERSION/GLSL、UNMASKED_RENDERER 扩展、扩展数量与纹理上限；
- canvas：像素、`toDataURL` 前缀、`measureText`、`isPointInPath`、filter/letterSpacing 能力；
- 字体：8 种字族宽度指纹、FontFace/FontFaceSet；
- iframe 跨 realm：`contentWindow.Array === Array`；
- 布局：offset/client/scroll、`getBoundingClientRect`、`elementFromPoint`、Range rects；
- 音频/媒体：AudioContext 采样率与 baseLatency、OfflineAudioContext、`canPlayType`；
- 其余：permissions、screen/DPR、matchMedia、Intl、storage、Worker/WebAssembly、crypto、
  WebRTC/WebGPU/WebXR/Gamepad、observer、插件、UA-CH 等。

Node 环境下全部走缺失保护分支并逐项上报；`documentAll=true` 表示 HTMLDDA 探针确实执行。

## 7. 快速开始

```bash
cd examples/mega/05-jsvmp-fortress-sdk
node jsvmp-fortress-sdk.js
node examples/mega/run-all.mjs --filter 05
```

```js
const sdk = globalThis.MEGA_JSVMP_FORTRESS_SDK.api.api
sdk.run(['PUSHI 6', 'PUSHI 7', 'MUL', 'EMIT'])            // -> [42]
sdk.disassemble(['PUSHI 1', 'PUSHI 2', 'ADD', 'EMIT'])     // -> ['PUSHI 1', ...]
sdk.tamperTest()                                          // -> 'BAD_OPCODE_45@0'
const token = sdk.sealEnvelope('机密', 'fortress')
sdk.openEnvelope(token, 'fortress')                       // -> '机密'
const a = sdk.compile(['PUSHI 1', 'EMIT'], 1)
const b = sdk.compile(['PUSHI 1', 'EMIT'], 2)              // 字节码不同，语义相同
```

## 8. 验证与预期结果

```bash
node jsvmp-fortress-sdk.js | tail -3
# MEGA DETAIL {...}
# MEGA SELFTEST OK
# MEGA METRICS {"whitebox":3,"customCiphers":3,"encodings":3,"jsvmpOps":329930,"envChecks":240,
#   "polymorphicVariants":12,"mixedRounds":4,"documentAll":true,"antiDebug":9}
```

自检共 41 项断言，覆盖：黑洞字符串、环境探针数量/HTMLDDA/矩阵摘要、反调试、三套白盒、
三种密码、三种编码、混合管线与 plan 形状、汇编器（求和/阶乘/嵌套/栈校验/常量池/实例常量）、
多态编译（4 实例 4 种字节码）、跨实例 rekey、五类篡改检出、变体往返、信封往返与校验头、
SDK 七个 API。

## 9. 防御建议

1. **先看字节码密度**：本作操作码占 4 字节/条，密文熵高且无 ASCII 结构，是 JSVMP 的典型特征。
2. **优先 hook 调度器而不是语义**：在 `decodeOp`/`decodeArg` 出口打点，可一次性还原全部 handler 语义。
3. **篡改检测点在 STACKCK 与 rekey**：这两处是"必须通过"的路径，适合作为完整性布防点。
4. **多实例多态是有效的同源性抗性**：同一函数编译两次字节码不同，基于字节码哈希的相似度比对会失效，
   更稳的指纹是"指令条数/栈深度分布/常量池尺寸"这类统计特征。
5. `VF05` 信封把校验放在解密之前，模仿真实勒索/授权系统的"先验后解"顺序，分析时应先绕过校验头。

## 10. 说明

- 纯 JavaScript 单文件：无 `require`/`import`/`module.exports`/`WebAssembly.instantiate`，
  不联网、不写盘。
- 大体量来自**被使用的字面量**：白盒表、VM 语料（逐条校验）、多态 blob（逐个解码验签）、探针矩阵。
- 本作品仅用于虚拟机保护/反篡改技术的教学与检测器评估。
