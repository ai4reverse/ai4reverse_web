# MEGA-11 · 反取证清场套件（Forensic Evasion Kit）

- 类型：`virus` ｜ 等级：`military` ｜ 单文件：`forensic-evasion-kit.js` ｜ 条目：`{ id: "11", slug: "forensic-evasion-kit" }`
- 规模：有效代码 ≈ 4.02 MB（去注释/空行），单文件、零依赖、零 `require/import/module`、零 WebAssembly。
- 自检：`node forensic-evasion-kit.js` → `MEGA SELFTEST OK` + `MEGA METRICS {...}`，退出码 0。

## 作品定位

本作品模拟一类"**痕迹清洗 + 反调试**"的军事级恶意脚本：落地后先做环境测绘，再把自身在浏览器里留下的存储、缓存、Cookie、历史与 Service Worker 痕迹按策略清除，并对已采集的设备特征做白盒摘要。它把"清除"当作一种被保护的算法：清洗流程本身被编译进嵌套 JSVMP，静态阅读只能看到大量字节码。

与 MEGA-10 的目标（组网/回传）不同，本作品的**顶级行为是"抹除"**：可执行证据只剩一份"清洗日志"和"蜜罐残留"。所有存储操作都在**内存模型**上完成，`localStorage / caches / cookies / history / serviceWorker` 都只是普通数组，不存在任何真实写入或真实删除。

## 完整攻击链

1. **解链（黑洞混淆）**：1750 条加密字符串（3 套 16 进制字母表 + 层序 stride 11/offset 5 + 实例化 bias）解码为清洗策略标签；`BH_CHECK` 校验总长，6 个钉死槽位（`wipe.local.keys.` … `trace.scrub.ok.11`）必须精确命中。
2. **环境测绘**：90 个渲染引擎级探测；`interactive-surface` / `headless-safe` 决定后续清洗策略的"激进程度"。
3. **痕迹清点**：由 `STORE_ITEMS / CACHE_ITEMS / COOKIE_ITEMS / HISTORY_ITEMS / SW_ITEMS` 构建内存持久化模型（本样本 864 条痕迹），并额外植入一条 `carve.marker.*` 取证标记用于自检。
4. **VM 保护的清洗例程**：12 条例程（`ROUTINES`）各自先在嵌套 VM 中求值 `innerRunner(id) ^ wb2Digest(salt)`，由此决定**就地覆盖**还是**直接截断**，再按策略执行。
5. **蜜罐残留**：部分例程故意留下 1 条 `honeypot.<id>` 记录——这是反取证样本的典型反制：让取证方"看起来删干净了"，实际留了一个诱饵。
6. **设备采集**：48 个字段（渲染面、GPU、排版、存储、能力面）合成 48 维向量，经 WB-1 摘要后折叠成 32 位设备指纹（两次计算必须一致）。
7. **反调试**：栈完整性、时间偏斜、`Function.prototype.toString`、console 完整性、devtools 间隔（5 项），全程只记录不退出。

## 黑洞混淆

- **三层解码**：XOR 密钥流（`bhKey(index)`，每 4 字节换一次移位）→ 16 进制重打包（3 套字母表轮换）→ Unicode 位移（`key % 13`）。
- **层序多态**：`LAYER_ORDERS[(index*11 + 5 + BIAS) % 4]`，`BIAS` 由实例常量派生；与 MEGA-10 的 stride/offset 不同，因此同一分析工具需要重新标定。
- **自校验**：解码总长必须等于 `BH_CHECK`；钉死槽位比对失败即抛错（本样本 `checks=14/14`）。
- **大量真实负载**：表内既有策略标签，也有诱导性短语（`cache.sweep.ledger`、`vault.index.shard`…），提高人工阅读成本。

## 堡垒 JSVMP

- **外层**：150 276 条编码指令，opcode 由独立洗牌的 `VM_OPMAP` 映射，指令字 `((arg<<5)|op) ^ vmKey(VM_SEED, pc)`。
- **内层**：10 812 条指令、另一套 `VM_INNER_OPMAP` 与 `VM_SEED2`，由 `CALL_INNER` 跨层调用；清洗例程的决策值正是内层 VM 的输出。
- **栈完整性**：所有宏净栈深为 0（`PUSH/ADD/XOR/DUP/ROL/MUL/ADD/STORE`），关键步 `TICK` 把栈顶折入 FNV 哈希；报告执行步数与嵌入指令数一致。
- **清洗即程序**：策略不是硬编码 if/else，而是"VM 结果 → 覆盖/截断"的两级分派，patch 掉单条分支只会改变清洗手法，不会中止清洗。

## 白盒与混合加密

| 套件 | 构造 | 与 MEGA-10 的差异 |
| --- | --- | --- |
| WB-1 | ARX 寄存器梯（210 000 项旋转类语料 + 3072 掩码） | 从"SPN 计数模式"改为 ARX 主导 |
| WB-2 | SPN / T-Box（12 轮 × 8192 项） | 轮数与表宽不同（16×16384 → 12×8192） |
| WB-3 | Feistel 梯（8 lane，512 组轮密钥） | 由"ARX 串"改为 Feistel 多 lane |

- **自定义密码**：`CC-1` 改造 RC4（3 轮 KSA、`+r*19` 偏置、输出再与 `b>>>1` 混合）；`CC-2` **7 轮**半字节交换 Feistel（长度前缀 + 8 字节分组）；`CC-3` **9 轮**类 ChaCha（旋转量取自 `CC3_R`，含 `Math.imul(b,5)` 的非标准线性层）。
- **自定义编码**：8 进制自定义字母表（每字符 6 位数字）、32 进制位打包、3 字节→4 字符位平面交错（顺序由 `ENC_PERM` 决定）、CJK 区 `0x3400 + byte*3` 宽字符映射。
- **混合管线**：每个变体 6 层随机步骤 + 1 层宽字符外框（`mixedRounds = 7`），14 个变体各自持有向量与校验和；自检逐一 `protect → unprotect`。

## 渲染引擎级环境检测

90 个探测，重点在"**这台机器是不是分析环境**"：

- `document.all`（HTMLDDA）：`typeof`/真假值/`.length` 三件套；缺失时用 shim 校验语义并标记 `degraded`，仅在探测真实执行后把 `documentAll` 置真。
- WebGL `VENDOR/RENDERER/getSupportedExtensions`、canvas `getContext('2d')` 与 `toDataURL` 回读。
- 排版/几何：`measureText` 字宽、`getBoundingClientRect`、`screen` 组合、`matchMedia`。
- 样式引擎：`CSS.supports`、`querySelector`；跨 realm：`iframe.contentWindow`。
- 存储/持久化：`localStorage`、`document.cookie`、`CacheStorage/caches`、`indexedDB`、`cookieStore`、Service Worker 容器（全部走 `feature` 守卫）。
- 能力面：`Worker/SharedWorker/BroadcastChannel`、`WebAssembly` 可用性、`Intl` 时区、`navigator.webdriver`、`permissions.query`、`mediaDevices.enumerateDevices`、`AudioContext` 采样率。

## 快速开始

```bash
cd examples/mega/11-forensic-evasion-kit
node forensic-evasion-kit.js
```

期望输出（节选）：

```
[mega] traces before=864 after=2 routines=12 honeypots=3 surface=interactive-surface
[mega] device fields=48 digest=fd7c6836 wb=2133cc32
[mega] vmOps=150276 inner=10812 variants=14 mixedRounds=7
MEGA SELFTEST OK
MEGA METRICS {"whitebox":3,"customCiphers":3,"encodings":4,"jsvmpOps":161088,"envChecks":90,"polymorphicVariants":14,"mixedRounds":7,"documentAll":true,"antiDebug":5}
```

## 验证

```bash
node examples/mega/run-all.mjs --filter 11
```

- 目录内仅 1 个 JS 文件；无 `require/import/export/module.exports/define([/node:/WebAssembly.*` 命中；
- 有效代码 ≥ 3.4 MB（本作品 4.02 MB）；
- 自检 14 项断言（`checks=14/14`）覆盖：黑洞解码/钉死槽位、白盒表校验和、白盒活性、多态变体往返、编码往返、VM 执行步数、内层 VM、环境探测数、`document.all`、存储清洗、缓存清扫、设备采集、指纹管线。

## 防御建议

- **识别"清洗型"样本**：关注"枚举自身痕迹 → 逐类清除"的调用序列；本样本用 VM 值决定覆盖/截断，需在 VM 退出点做结果汇聚（每个例程都会留下 `remaining` 计数）。
- **蜜罐优先**：若现场只剩 `honeypot.<id>` 类残留，说明样本主动清理并留了诱饵；应据此推断被清除的真实痕迹类别。
- **白盒还原**：`WB1_C/WB2_T/WB3_S` 三张表各自带校验和常量，可直接用作还原正确性判据；键流 XOR 后即可还原明文设备向量。
- **对抗环境测绘**：样本对 90 个面做探测；沙箱应保持"探测项存在但语义中性"（例如 `document.all` 合法 HTMLDDA、WebGL 返回通用 renderer），避免把 `headless-safe` 当成安全信号。
- **取证视角**：真实同族样本会真的删除 IndexedDB/CacheStorage；分析时务必在快照/只读挂载下运行，并预先导出浏览器 profile 副本。

## 说明

- 本作品是**分析用合成样本**：所有"清洗"都发生在内存数组上（`storage: simulated`），不调用任何真实存储 API，不修改 `document`，不发起网络请求。
- 采集阶段只读探测，不写任何宿主状态；`carve.marker.*` 是自检用的虚拟取证标记。
- 体积来自被真实使用的表（白盒语料、嵌套字节码、变体向量、探测矩阵、痕迹语料），不存在为凑体积而存在的死代码。
