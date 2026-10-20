# 04 Whitebox Crypto SDK — whitebox-crypto-sdk

| 属性 | 值 |
| --- | --- |
| 编号 | 04 |
| 名称 | Whitebox Crypto SDK |
| 类型 | 纯 JS 单文件安全 SDK |
| 等级 | 军事级（military） |
| 分类 | whitebox-crypto-sdk |
| 入口 | `whitebox-crypto-sdk.js`（唯一 JS 文件） |
| 规模 | 有效代码 ≥ 3.4MB（大表全部参与校验） |
| 验证 | `node whitebox-crypto-sdk.js` → `MEGA SELFTEST OK` + `MEGA METRICS` |

## 1. 作品定位

本作品是一个**单文件、零依赖**的军事级白盒密码 SDK 样本。它把商业白盒实现中常见的
"隐式密钥 + 大表 + 多态解码 + 虚拟机保护" 组合压缩进一个可直接执行的 JS 文件，
用于逆向工程教学与检测器评估：分析者面对的既不是标准算法调用，也不是普通字符串混淆，
而是**表驱动白盒 SPN + 嵌套 JSVMP + 渲染引擎指纹门禁**的复合体。

对外它表现为一个可用 SDK：`sealText/openText`、`whiteboxHex`、`cipherHex`、
`encode/decode`、`vmEval`、`probeEnvironment`。自检同时充当契约测试。

## 2. 架构与数据流

```
packed literals (hex) ──► 解码为 Uint8Array ──► FNV 摘要(5 个数据段)
        │
        ├── 白盒表段  ──► 3 套 SPN 表（正/逆 T-box + 轮置换 + 隐式密钥）
        ├── VM 字节码 ──► 堡垒 JSVMP（编码操作码 + 乱序 handler + 常量池）
        ├── 多态数据段 ──► 12 个变体 blob（每 blob 独立解码算法 + 校验和）
        ├── 探针矩阵   ──► 240 行 × 256 字节，驱动 72 类渲染引擎探针
        └── 黑洞字符串 ──► 多层加密表（变体层 + 密钥流层）
```

启动顺序：数据解码 → 环境探针 → 反调试自检 → VM 语料结构校验 → 多态变体校验 →
SDK 自检 → 输出 `MEGA METRICS`。

## 3. 黑洞混淆

- **多层字符串表**：明文先与实例密钥流异或（层 2），再由 12 种多态算法之一加密（层 1），
  运行时反向逐层剥离；条目变体编号写入表头，同一文件内环状复用全部 12 个变体。
- **多态解码器**：reverse-xor / nibble-add / lcg-stream / rotate-mask / bit-rotate /
  xor-chain / bitrev-reverse / sub-position / add-cbc / murmur-stream / mask-reverse /
  swap-chain，彼此不可互解，混淆度随实例常量漂移。
- **控制流平坦化 + 死分支**：启动阶段用状态机分发各层装载；不透明谓词分支永不成立，
  但保持可达的表观路径。
- **自校验**：五个数据段各自计算 FNV-1a 摘要，任何一个字节被改写都会在装载或
  反调试阶段暴露（`pack-digest` 检查项）。

## 4. 堡垒 JSVMP

- **操作码加密**：每条指令 4 字节，操作码 = `order[op] ^ opKey[pc/4 & 15] ^ f(pc)`，
  `order` 是 64 项置换表，`opKey` 由实例种子派生；操作数同样按位置密钥异或。
- **乱序处理器**：解码后经逆置换 `opMap` 还原为 30 个语义操作码（NOP/PUSHI/PUSHC/
  STORE/LOAD/ADD/…/NESTED/STACKCK/TLS/POPR/PUSHR），越界操作码直接抛错。
- **编码常量池**：每个程序独立常量池，`PUSHC` 按索引取值，索引同样被编码。
- **栈完整性**：维护增量异或折叠 `fold`，`STACKCK` 重新计算真实栈折叠并比对，
  同时校验深度；`sp` 与数组长度每步对账。
- **嵌套 VM**：`NESTED` 指令以不同种子新建子 VM 实例（另一套 opKey/order），
  在子 VM 中执行另一段字节码并回传结果，形成 VM-in-VM。
- **语料**：内嵌 30 万级操作码（见 METRICS `jsvmpOps`），
  自检校验全部操作码合法性与条数，并实际执行首/末程序与手写汇编程序。

## 5. 白盒与混合加密

**白盒 SPN 套件（3 套）**：每轮 16 个位置各一张 256 项 T-box
`T[r][i][x] = S_r[x] ^ K[r][i]`，并同步内嵌逆表 `IT[r][i][y] = S_r^-1[y ^ K[r][i]]`。
密钥从不出现在文件里，只以异或进表项的形式隐式存在；轮密钥、S 盒、轮置换全部由实例
种子派生。16 字节块通过 CBC 链扩展为任意长度（`wbSeal/wbOpen`）。

**改造密码（3 种）**：

| 名称 | 结构 | 非标准点 |
| --- | --- | --- |
| Silk13 | 4 字 ARX 状态 + 密钥化 S 盒，字节级密钥流 | 13 轮（非 8/10/12/14/16） |
| PermGrind | 奇模乘 + 位置加常 + 循环移位 | 模 256 乘加置换，非常规 SPN |
| Glassfish | 变量旋转 ARX，每字节推进 | 3/5/7/11 混合旋转量 |

**自定义编码（3 种）**：ALPH32X（32 符号自研字母表，5bit/符号）、BitWeave
（奇偶位平面重排后 6bit 打包）、HanMap（6bit 组映射到 CJK 码位）；三者都带 4 符号
长度前缀，可精确逆变换，且字母表按实例盐旋转。

**混合管线**：每实例生成 3–5 轮 plan，例如
`cip>wb>enc>dec>wb>cip>enc`，轮内顺序由种子决定；封装对 plan 正序施加，解封逆序施加，
白盒 → 改造密码 → 编码三类步骤在同一管线中交织。

## 6. 渲染引擎环境检测

240 行探针矩阵（每行 256 字节，行内字节同时用于参数选择与矩阵摘要），驱动 72 类探针：

- **document.all HTMLDDA**：`typeof`、布尔转换、`== null` 语义、`.length` 四元组向量；
- **CSS**：`CSS.supports` 属性对、`CSS.escape`、选择器 engine（`:has`/`::marker`）、样式表规则数；
- **WebGL/WebGL2**：VENDOR/RENDERER/VERSION/GLSL、`WEBGL_debug_renderer_info`
  的 UNMASKED_RENDERER、扩展列表长度、纹理上限；
- **canvas**：像素 `getImageData`、`toDataURL` 前缀、`measureText` 宽度、`isPointInPath`、filter 支持；
- **字体**：多字族宽度差（monospace/serif/system-ui/emoji）、FontFace/FontFaceSet 存在性；
- **iframe 跨 realm**：`contentWindow.Array === window.Array` 判定；
- **布局几何**：offset/client/scroll 度量、`getBoundingClientRect`、`elementFromPoint`、Range rects；
- **音频/媒体**：AudioContext 采样率与 baseLatency、OfflineAudioContext、`canPlayType` 编码串；
- **其余**：permissions、screen/DPR、matchMedia、Intl 时区与 locale、storage/cookie、
  Worker/ServiceWorker/WebAssembly、crypto.subtle、WebRTC、WebGPU/WebXR、Gamepad、
  Trusted Types、observer 家族、插件/mimeTypes、UA-CH brands 等。

在 Node 中所有探针走`缺失保护`分支并逐项上报（`absent`/`no-context`），
`documentAll` 指标表示 HTMLDDA 探针确实执行过。

## 7. 快速开始

```bash
cd examples/mega/04-whitebox-crypto-sdk
node whitebox-crypto-sdk.js
node examples/mega/run-all.mjs --filter 04
```

SDK 用法（同一进程内 require 不可用，SDK 挂在全局）：

```js
const api = globalThis.MEGA_WHITEBOX_CRYPTO_SDK.api.api
const token = api.sealText('机密报文', 'passphrase')
api.openText(token, 'passphrase')            // -> '机密报文'
api.whiteboxHex(0, '00112233445566778899aabbccddeeff')
api.cipherHex('Silk13', 'enc', 'deadbeef', '00112233445566778899aabbccddeeff')
api.encode('HanMap', 'MEGA')
api.vmEval(['PUSHI 9', 'PUSHI 3', 'MUL', 'EMIT'])   // -> [27]
```

## 8. 验证与预期结果

```bash
node whitebox-crypto-sdk.js | tail -3
# MEGA DETAIL {...}
# MEGA SELFTEST OK
# MEGA METRICS {"whitebox":3,"customCiphers":3,"encodings":3,"jsvmpOps":299942,"envChecks":240,
#   "polymorphicVariants":12,"mixedRounds":5,"documentAll":true,"antiDebug":9}
```

自检覆盖 41 项断言：黑洞解码、三套白盒往返与 CBC 链、三种密码往返与密钥分离、
三种编码往返与实例盐、混合管线往返/顺序/轮数、VM 语料完整性、程序执行、嵌套 VM、
栈校验、篡改检出、多态变体与种子唯一性、环境探针数量/覆盖/HTMLDDA/矩阵摘要、
反调试、SDK 七个 API 与确定性。

## 9. 防御建议

1. 单一 `sealText` 调用即包含 3–5 轮白盒+改造密码+编码，别按"一次 AES"来判断成本。
2. 白盒表一旦被 dump，密钥仍然不可直接读出——但**表本身可被搬用**，因此要结合
   完整性与环境门禁（本样本的 `STACKCK`/摘要校验即为此设计）。
3. 检测点优先放在"编码解码函数"与"VM 装载器"上：这两处是必经路径，且高度特征化。
4. `document.all` 四元组 + WebGL UNMASKED_RENDERER + 字体宽度差是目前最难伪造的组合，
   建议同时采集并做一致性交叉校验。
5. 若发现 `MEGA METRICS` 式自报结构，可直接作为分析锚点：指标字段即作者的攻击面清单。

## 10. 说明

- 本文件为**纯 JavaScript 单文件**：不含 `require`/`import`/`module.exports`/
  `WebAssembly.instantiate` 等外部依赖，也不写磁盘、不联网。
- 所有"病毒/攻击"语义均为**离线仿真**：本作品仅做密码学与混淆演示。
- 大体量来源于**被实际使用的字面量**：白盒表、VM 字节码、多态 blob、探针矩阵；
  自检对全部数据段做结构校验与摘要，避免"填充死代码"。
