# 06 Ransomware Fortress — ransomware-fortress

| 属性 | 值 |
| --- | --- |
| 编号 | 06 |
| 名称 | Ransomware Fortress |
| 类型 | 纯 JS 单文件恶意行为仿真（virus） |
| 等级 | 军事级（military） |
| 分类 | ransomware-fortress |
| 入口 | `ransomware-fortress.js`（唯一 JS 文件） |
| 规模 | 有效代码 ≥ 3.4MB（表与语料参与校验） |
| 验证 | `node ransomware-fortress.js` → `MEGA SELFTEST OK` + `MEGA METRICS` |

## 1. 作品定位

一个**完全不触碰宿主机**的勒索软件行为仿真单文件。它把真实勒索家族的三件套——
**混合加密、VM 保护的密钥调度、环境门禁 + 勒索说明**——压缩进一个可执行、可自证的 JS 文件，
用于检测/取证/教学评估：分析者可以完整观察"加密—留note—门禁"的时序，而磁盘上不会产生任何副作用。

仿真对象是 12 个**内存演示文件**（财务报表、工资表、合同、备份、邮件…）。`simulate()` 返回
密文记录与勒索说明；`restore()` 用同一口令逐字节还原。演示存储本身在仿真前后保持原样。

## 2. 架构与数据流

```
环境门禁（240 项渲染引擎探针 + 反调试 + 多态校验）
        │ 不满足 → 直接拒绝，不产生任何密文
        ▼
主密钥 = FNV(口令) ⊕ poly.seed[3] → deriveKey
        │
        ├─ 每文件密钥 = 堡垒 VM 执行密钥调度程序(PUSHC/PUSHI/MUL/TLS/ROL/XOR/EMIT)
        │       └─ 32-bit×4 → 16 字节（受实例 TLS 常量与文件序号影响）
        ├─ 文件内容 → 改造密码(key=派生自文件密钥) → 白盒 SPN(CBC+尾部流) → 自定义编码
        ├─ 文件密钥 → 混合管线(3–5 轮 wb/cip/编码) 封装成信封
        └─ 记录 = {算法组合, IV, salt, 密文, 信封, 校验和}
        ▼
勒索说明（黑洞字符串 + victim-id + key-fingerprint + env-digest）
```

## 3. 黑洞混淆

- 说明文案、错误码、"日志"步骤全部来自**分层加密字符串表**：明文 → 密钥流异或 → 12 种多态算法之一；
- 变体环状复用（reverse-xor / nibble-add / lcg-stream / rotate-mask / bit-rotate / xor-chain /
  bitrev-reverse / sub-position / add-cbc / murmur-stream / mask-reverse / swap-chain）；
- 五段数据各自 FNV 摘要；探针矩阵、变体 blob 逐个解码验签，任一字节被改即失败；
- 状态机式装载 + 不透明谓词死分支，掩盖真实初始化顺序。

## 4. 堡垒 JSVMP

- 编码操作码（需绕过三层才能还原）：`raw[0] = order[op] ^ opKey[pc/4] ^ f(pc)`；
- 乱序 handler 表 + 加密操作数 + 常量池；
- 本作的**密钥调度就是一段 VM 程序**，每次加密 12 个文件会执行 12 次该程序：

```text
PUSHC 0 / PUSHI n / MUL / TLS / XOR / PUSHC 1 / ROL / PUSHC 0 / MUL / EMIT   ×4 words
```

- `TLS` 提供实例私有常量，使密钥表与文件实例绑定；`STACKCK` 校验栈深度与折叠；
  `NESTED` 在子实例中重编码并执行内层程序（VM-in-VM）；
- 内嵌语料 33 万级指令，自检逐条解码；伪造操作码 / 伪造栈深度均被拒绝。

## 5. 白盒与混合加密

**白盒 SPN（3 套）**：20/18/22 轮，`T[r][i][x]=S_r[x]⊕K[r][i]` + 逆表 `IT`，密钥隐式；
16 字节块 CBC 链 + 尾部密钥流，任意长度可逆。

**改造密码（3 种）**：

| 名称 | 结构 | 非标准点 |
| --- | --- | --- |
| Ashgrove | 8 字 ARX + 4bit S 盒 + 32 字节块密钥流 | 9 轮 |
| VaultSpin | 4 字旋转混合流 | 13/7/11 位移组合 |
| SaltMine | 位置置换 + 加性 CBC | 奇乘子位置加常，分组 16 |

**自定义编码（3 种）**：HexCipher（15 段制表符区 4bit）、Braille3（盲文码位 3bit LSB-first）、
WideDigits（十进制三位组，无长度前缀）；前两者带变宽长度前缀与实例盐旋转。

**混合管线**：`cip→wb` 交替、3–5 轮、以编码收尾；本作以 `suiteIndex/cipherName/encIndex`
**逐文件轮换**（12 个文件至少出现 3 种算法组合），文件密钥再经管线封装——典型 hybrid：
数据用一次性密钥、密钥用主密钥包裹。

## 6. 渲染引擎环境检测（同时是门禁）

门禁要求：探针数 ≥50、HTMLDDA 探针确实执行、反调试全过、变体 ≥10、矩阵摘要非零。
探针矩阵 240 行 × 256 字节驱动 72 类探针：

- `document.all` HTMLDDA 四元组、CSS.supports/escape/选择器、样式表规则数；
- WebGL/WebGL2 厂商/渲染器/扩展、canvas 像素与 toDataURL、字体宽度指纹、iframe 跨 realm；
- 布局几何（offset/client/rect/elementFromPoint/Range）、音频与媒体能力、permissions；
- screen/DPR、matchMedia、Intl 时区、storage、Worker/WebAssembly、crypto、WebRTC/WebGPU/XR 等。

Node 中全部走缺失保护分支；`documentAll=true` 表示 HTMLDDA 探针确实执行过。

## 7. 快速开始

```bash
cd examples/mega/06-ransomware-fortress
node ransomware-fortress.js
node examples/mega/run-all.mjs --filter 06
```

```js
const sim = globalThis.MEGA_RANSOMWARE_FORTRESS.api.sim
const run = sim.simulate('demo-passphrase-06', null)
run.records.length            // 12
run.note                      // 勒索说明（仅在内存中）
const files = sim.restore(run, 'demo-passphrase-06')
files[0].content              // 与 sim.demoStore()[0].content 完全一致
sim.simulate('x', { fail: true }).refused   // true —— 环境门禁拒绝
```

## 8. 验证与预期结果

```bash
node ransomware-fortress.js | tail -3
# MEGA DETAIL {...}
# MEGA SELFTEST OK
# MEGA METRICS {"whitebox":3,"customCiphers":3,"encodings":3,"jsvmpOps":329939,"envChecks":240,
#   "polymorphicVariants":12,"mixedRounds":5,"documentAll":true,"antiDebug":9}
```

自检共 36 项断言，覆盖：黑洞文案、环境探针/HTMLDDA/矩阵、反调试、三套白盒、三种密码、三种编码、
混合管线与实例顺序、VM 语料/执行/嵌套/篡改/密钥调度、多态变体与种子、门禁通过/拒绝、
混合加密组合数、密文无明文泄漏、说明渲染、**execute() 无宿主 I/O 且演示存储未被修改**、
还原一致性、密钥确定性、错误口令拒绝、密文篡改检出、每文件密钥唯一、API 表面。

## 9. 防御建议

1. **门禁前置**是本样本最值得注意的点：不满足渲染引擎/反调试条件的沙箱里加密过程不会发生，
   因此"让样本在沙箱里跑一遍看行为"可能永远看不到加密路径——需要构造满足条件的环境。
2. **密钥调度在 VM 内**：仅 dump 白盒表不足以恢复每文件密钥，必须复现 VM 语义；
   但一旦 dump 出 `TLS` 常量与语料，密钥表即可批量重算。
3. **信封先验后解**：记录自带校验和，先校验再解密，说明作者有意让取证者反复失败。
4. 检测侧可用"编码后长度/字符集（制表符区、盲文区、十进制三位组）+ 每文件算法轮换"作为家族指纹。
5. 真实环境中请以**离线备份 + 不可变快照**为第一防线；本仿真证明：只要保留原始口令派生链，
   密文可完整还原——所以"密钥是否随环境销毁"才是勒索不可逆性的关键。

## 10. 说明

- 纯 JavaScript 单文件：无 `require`/`import`/`module.exports`/`WebAssembly.instantiate`；
- **无破坏性宿主操作**：不打开文件、不写盘、不联网、不调用任何 fs/process/Buffer API，
  12 个"文件"只是内存中的字符串常量，自检明确断言这一点；
- 大体量来自被使用的字面量：白盒表、VM 语料、多态 blob、探针矩阵；
- 本作品仅用于恶意软件分析教学与检测器评估，不可用于攻击。
