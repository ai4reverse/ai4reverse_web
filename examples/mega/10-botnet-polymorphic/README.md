# MEGA-10 · 多态僵尸网络节点（Polymorphic Botnet Node）

- 类型：`virus` ｜ 等级：`military` ｜ 单文件：`botnet-polymorphic.js` ｜ 条目：`{ id: "10", slug: "botnet-polymorphic" }`
- 规模：有效代码 ≈ 4.14 MB（去注释/空行），单文件、零依赖、零 `require/import/module`、零 WebAssembly。
- 自检：`node botnet-polymorphic.js` → 输出 `MEGA SELFTEST OK` 与 `MEGA METRICS {...}`，退出码 0。

## 作品定位

本作品是一份**纯 JavaScript 单文件**的僵尸网络节点样本，用于在分析平台中复现"军事级" C2 节点在真实浏览器里投放、驻留、接收任务、回传结果的全链路逃逸手法。它属于教学/分析样本：所有网络动作、DOM 动作、存储动作都在运行时被**显式降级为内存模拟**（`NETWORK_ALLOWED = false`，总线只是一个内存数组），不存在任何真实 I/O、真实外连或真实文件写入。

作品刻意把"体积"变成分析成本：约 4 MB 的有效代码里，绝大部分是**被真实使用的**巨型表——白盒 T-Box 语料、嵌套 VM 字节码、多态变体向量、探测矩阵，而不是填充注释。

## 完整攻击链

1. **落地解链（黑洞混淆）**：1700 条加密字符串表经三层解码器（XOR 密钥流 → 16 进制字母表重打包 → Unicode 位移）还原，层序由 `index` 与实例常量共同决定；表尾校验和（`BH_CHECK`）不匹配即中止。
2. **实例化**：由 `MEGA_KEY` 与启动时钟派生节点种子，生成 32 位十六进制 `node` 标识；不存在硬编码 ID。
3. **环境闸门**：87 个渲染引擎级探测决定运行剖面（`interactive-surface` / `headless-safe`）。闸门只影响"行为参数"，不会让样本自毁——这是它的对抗设计：沙箱里也要跑完。
4. **协议协商**：从 14 个多态变体中按 `seq` 与节点种子挑选，对同一条 C2 消息使用**不同层序/不同密码**封装，形成"同一网关多协议"。
5. **任务下发**：`task.pull` 帧经内存总线投递，worker 式队列以 4 条一批消费，每条任务在嵌套 VM 中求值后再被混合管线封装。
6. **回传**：`task.ack / relay.push` 帧逐条重新解封校验（`delivered == relayed == 320`），形成闭环证据。
7. **驻留痕迹**：反调试检查（栈完整性、时间偏斜、`Function.prototype.toString`、console 完整性、devtools 间隔）始终执行，但只记录不退出。

## 黑洞混淆

- **多层表**：`BH_TABLE`（1700 条）全部以非明文形态存放；解码器三选一顺序由 `LAYER_ORDERS[(index*7+3+BIAS) % 4]` 决定，`BIAS` 由实例常量派生。
- **多态解码器**：同一张表的不同区间走不同层序，单点 patch 无法还原全文。
- **自校验**：解码总长度必须等于 `BH_CHECK`；6 个钉死槽位（`c2.beacon.alpha4`、`c2.task.grant.04` …）必须精确命中，否则自检抛错。
- **死分支/平坦化**：初始化逻辑以状态机形式展开，环境缺项时进入"降级路径"而非短路返回。
- **随机化常量**：`MEGA_KEY = 0x1f2e3d4c` 参与所有密钥派生（表密钥、VM 密钥流、变体向量），每个实例派生不同子密钥。

## 堡垒 JSVMP

- **外层 VM**：125 230 条嵌入指令，指令字 = `((arg & 0x3ffff) << 5) | opcode` 再与逐位置 `vmKey(seed, pc)` 异或；opcode 语义表由 `VM_OPMAP` 洗牌，处理器表按"编码后 opcode"索引，反编译必须先还原洗牌。
- **内层 VM**：11 866 条独立字节码，使用**另一套** opcode 洗牌与另一条密钥流（`VM_SEED2`），由外层 `CALL_INNER` 指令跨层调用，构成 VM-in-VM 分派。
- **栈完整性**：所有宏展开为"净栈深 0"的平衡序列（PUSH/ADD/XOR/DUP/ROL/MUL/ADD/STORE），并在关键步执行 `TICK` 把栈顶折叠进 FNV 式哈希，输出哈希即执行证据。
- **规模即防御**：嵌入字节码 >130 k 条，自检报告实际执行步数与总指令数一致。

## 白盒与混合加密

| 套件 | 构造 | 密钥形态 |
| --- | --- | --- |
| WB-1 | 16 轮 SPN 计数器模式，4×4096 组 T-Box（262 144 项） | 密钥隐入表，无显式 key 参数 |
| WB-2 | 8 分支 Feistel 轮函数 + 1024 组轮密钥 | 由 `WB2_S` 语料隐式派生 |
| WB-3 | ARX 寄存器串（65 536 项旋转常数） | 逐实例旋转量隐式编码 |

- **自定义密码 3 套**：`CC-1` 改造 RC4（4 轮 KSA、非标准 swap 与 `+r*37` 偏移）；`CC-2` 9 轮 Feistel 分组密码（长度前缀 + 8 字节分组 + 自造轮函数）；`CC-3` 11 轮类 ChaCha 四分之一轮（旋转量取自 `CC3_C` 表）。
- **自定义编码 4 套**：16 进制自定义字母表、32 进制位打包（含长度头）、3 字节→4 字符位平面交错（顺序由 `ENC_PERM` 决定）、CJK 宽字符映射（`0x4e00 + byte*4`）。
- **混合管线**：每个变体持有 6 层随机步骤 + 1 层宽字符外框（共 7 轮，`mixedRounds = 7`），步骤从 10 种算子中不重复抽取。自检对 14 个变体全部执行 `protect → unprotect` 往返，并逐一核对变体向量校验和。

## 渲染引擎级环境检测

87 个探测覆盖：

- **`document.all`（HTMLDDA）**：`typeof` 必须为 `'undefined'`、布尔上下文中必须为假、`.length` 必须可读；缺失时（如 Node）用 shim 校验 `length`/`namedItem` 语义并把记录标记为 `degraded`，`documentAll` 指标仅在探测真实执行后置真。
- **渲染/GPU**：`canvas.getContext('2d')`、WebGL `VENDOR/RENDERER/getSupportedExtensions`、像素回读 `toDataURL`。
- **排版/几何**：`measureText` 字宽、`getBoundingClientRect`、`screen` 尺寸与 DPR、`matchMedia`。
- **样式引擎**：`CSS.supports(prop, 'inherit')`、`querySelector`。
- **跨 realm**：`iframe.contentWindow` 引用差异。
- **音频/媒体/权限**：`AudioContext` 采样率、`mediaDevices.enumerateDevices`、`permissions.query`。
- **能力面**：`Worker/SharedWorker/ServiceWorker/BroadcastChannel/WebAssembly` 可用性、`Intl` 时区、storage/cookie、DOM 构造器、33 项 feature 探测。
- 全部探测通过 `typeof` 守卫与 `try/catch` 包裹，Node 环境下走缺项路径并计入 `envChecks`。

## 快速开始

```bash
cd examples/mega/10-botnet-polymorphic
node botnet-polymorphic.js
```

期望输出（节选）：

```
[mega] node=7d2466b7718509d45dd1af803f3d354d gate=interactive-surface protocolVariant=7
[mega] c2 messages=320 relayed=320 busDepth=320 network=suspended
[mega] taskQueue=220 digest=e6113e59 vmOps=125230 inner=11866
MEGA SELFTEST OK
MEGA METRICS {"whitebox":3,"customCiphers":3,"encodings":4,"jsvmpOps":137096,"envChecks":87,"polymorphicVariants":14,"mixedRounds":7,"documentAll":true,"antiDebug":5}
```

## 验证

```bash
# 单作品权威校验（纯度 / 有效体积 / 能力下限 / 退出码）
node examples/mega/run-all.mjs --filter 10
```

验收要点：

- 目录内**只有一个** JS 文件，且无 `require/import/export/module.exports/define([/node:/WebAssembly.*` 命中；
- 有效代码 ≥ 3.4 MB（本作品 4.14 MB）；
- 自检 13 项断言全部通过（`checks=13/13`），指标满足 `whitebox=3, customCiphers=3, encodings=4, jsvmpOps=137096, envChecks=87, polymorphicVariants=14, mixedRounds=7, documentAll=true, antiDebug=5`。

## 防御建议

- **还原字符串表**：定位 `BH_TABLE` 的 4 种层序分支，按 `index` 重建映射后批量解密；校验和常量 `BH_CHECK` 可直接作为还原正确性的判据。
- **VM 反编译**：先导出 `VM_OPMAP`（把"编码 opcode → 语义"用运行期插桩枚举出来），再按 `cell ^ vmKey(seed, pc)` 还原指令字；`CALL_INNER` 处需同时导出第二套映射。
- **协议识别**：同一网关存在 14 种封装层序，静态签名会漏；应以"解封后结构一致"为聚类特征。
- **检测面**：节点 ID 由时钟参与派生（每次运行不同），不要依赖 hash 黑名单；应检测"大批量环境探测 + 内存总线式消息队列"的组合行为。
- **运行隔离**：尽管本样本不产生真实 I/O，真实同族样本会；分析时务必在无网络、无凭据的沙箱中执行，并 hook `fetch/XMLHttpRequest/WebSocket`。

## 说明

- 本作品是**分析用合成样本**：C2 传输只在内存数组中排队（`network=suspended`），没有任何真实请求、真实存储写入或真实 DOM 修改；环境探测只读不写。
- 所有"攻击行为"均以可验证的自检断言形式呈现（`checks=13/13`），便于独立复核。
- 体积来自被真实使用的表（白盒语料、嵌套字节码、变体向量、探测矩阵），不存在为凑体积而存在的死代码。
