# 14 MEGA Zero-Trust Client SDK

| 属性 | 值 |
| --- | --- |
| 编号 | 14 |
| 名称 | MEGA Zero-Trust Client SDK |
| 类型 | JS 安全 SDK |
| 等级 | 军规级 |
| 分类 | zero-trust |
| 入口 | `zero-trust-client-sdk.js`（单文件，无依赖） |
| 有效代码 | 3.63 MB（原始 3.64 MB） |
| 自检 | `node zero-trust-client-sdk.js` |

## 1. 作品定位

军规级零信任客户端 SDK：设备证明令牌、白盒 MAC 挑战应答（含重放窗口）、策略引擎（扁平化状态机 + VM 评分），并将渲染引擎级指纹（document.all/CSS/WebGL/Canvas/字体）纳入判定。

本作品是 MEGA 单文件系列的一员：全部逻辑（数据表、虚拟机、密码学、环境探针、业务层）都压在一个纯 JavaScript 文件里，不引用任何库、模块、Node API 或 WebAssembly。启动即运行完整自检，打印 `MEGA SELFTEST OK` 与一行 `MEGA METRICS` JSON，供 `examples/mega/run-all.mjs` 校验体积、纯净度与能力下限。

核心能力清单：

1. 设备描述符：环境摘要 + 渲染引擎摘要 + 探测计数
2. 证明令牌：canonical claims + 混合加密信封 + WB-MAC 验签
3. 挑战应答：白盒 MAC 挑战-应答，计数器 + 已见集合防重放
4. 策略引擎：控制流扁平化状态机 + VM 加权评分，输出 allow/step-up/deny
5. document.all HTMLDDA 语义纳入策略否决项
6. 时钟漂移、证明时效、网络位置与补丁级别联合判定

## 2. 架构

单文件自上而下分十层，层层带自校验：

1. **实例熵与 PRNG**：`ZT_INSTANCE` 由时间戳与内置种子折叠而成，所有密钥、表选择、指令表置换、变体选择都由它派生；同一进程内自洽，跨进程随机。
2. **编解码原语**：hex/UTF-8/位转置/常量时间比较/自定义摘要（FNV 变体 + 双状态 Merkle 折叠）。
3. **嵌入式体量表**：S-box 家族 1400 张、混合表 1450 张、KDF 表 640 张，共 872.5 KiB 原始字节，全部以 hex 字符面量内嵌；加载时对每个家族做 FNV 折叠摘要并与构建期常量比对，防止表被改写。
4. **白盒套件（3 套）**：SPN 型 T-box 网络、Feistel 型表驱动流、ARX 型表轮转流，三套都以"隐式密钥"派生密钥流，加密=异或密钥流，解密同构。
5. **自定义分组密码（3 套）**：改造版 XXTEA（自定义 delta/轮数）、12 轮自定义 Feistel（表驱动 F 函数）、RC5 风格变体 ARX（自定义常数与 16 轮），均为可逆分组密码，带 PKCS#7 风格填充与逆填充。
6. **自定义编码（3 套）**：base-64 自定义字母表大数编码（带长度前缀）、8×8 比特转置（对合变换 + 魔术头）、Unicode 码位映射（打乱映射表 + 校验字符）。
7. **混合管线**：变体矩阵 512 行，每行给出白盒套件/分组密码/编码/轮数的组合；`ZT_mixedSeal` 逐轮做"白盒异或 → 分组加密"，最后编码；`ZT_mixedOpen` 逆序还原（解码 → 分组解密 → 白盒异或）。自检对全部 512 个变体取最大轮数（本文件为 3）。
8. **堡垒 JSVMP**：三层嵌套虚拟机（outer → inner → micro），字节码以 base36 定长字段 + 操作码异或掩码存储，运行时再做一次实例级处理器置换（handler table shuffle）；带栈完整性检查、编码常量池、实例级密钥轮。
9. **渲染引擎级环境探针**：90 项探针（含 `document.all` HTMLDDA 语义），全部 try/catch 保护，Node 下的缺失被记录为 `absent` 而不是抛错。
10. **业务层**：面向调用方的 SDK API，见第 7 节。

## 3. 黑洞混淆

- **加密字符串表**：96 条业务标签以 hex 密文内嵌，解码器有 24 种多态变体（各带不同的 `a/b/shift` 常量），解密键由内嵌种子按字符串下标派生；首次访问时解密并缓存，摘要器遍历全部 96 条。
- **控制流扁平化**：业务关键流程被改写成"步骤表 + while 状态机"（`ZT_flatten`），状态转移由步骤函数显式返回（可顺序推进、可回跳成环），异常被吞进 `state=254`，并带 4096 步护栏。
- **不透明谓词与死分支**：`ZT_opaqueGate` 用恒假算式制造永不进入的分支，干扰反编译器的路径剪枝。
- **自校验**：三个体量家族各自折叠摘要并与构建期常量比对；VM 字节码整体再做一次 FNV 摘要比对；业务层对关键断言逐条 `ZT_check`，失败即整体不打印 OK。
- **反调试/反分析陷阱**：见第 8 节，全部为非致命探测，只计数与记录。

## 4. 堡垒 JSVMP

指令编码：每条指令 7 个 base36 字符 = 1 字符操作码（与实例掩码异或）+ 3 字符操作数 A + 3 字符操作数 B，因此单条指令最多可寻址 46656 个常量池下标/立即数。

三层虚拟机：

| 层 | 指令数 | 作用 |
| --- | --- | --- |
| outer | 240000 | 主完整性摘要程序（对常量池、S 盒、密钥轮做混合折叠） |
| inner | 12800 | outer 的 INNER 指令调用，内部再调用 micro |
| micro | 31 | 手写小程序，最内层 VM-in-VM 调度 |

合计内嵌并全部执行的指令数：**252831**。运行时安全机制：

- **操作码密码**：存储态 = 真实操作码 ⊕ 实例掩码；
- **处理器置换**：加载时用实例 PRNG 生成 16 元置换 `perm`，把 `impl[op]` 放到 `handlers[perm[op]]`，再把字节码整体重映射，静态阅读无法把存储字节对应到语义；
- **编码常量池**：`ZT_POOL` 以 hex 存储 32 位常量，运行时一次性解码；
- **栈完整性**：`STK` 指令核对栈深，不符则翻转寄存器并累加 fault（自检断言 fault 为 0）；
- **自检**：micro/inner/outer 三层各断言链值、寄存器、指令数与字节码摘要，并把总量写入 metrics。

## 5. 白盒与混合加密

三套白盒构造都把"密钥"藏进表里，公开接口只有 `ZT_wbStream(suite, material, nonce, len)`：

1. **WB-1（SPN/T-box）**：8 轮 256 项 T-box，盒值由 S-box 家族与混合表家族切片经隐式密钥 `k` 逐字节混合、再按 `k & 7` 旋转；每轮 `a = T[a ^ b&255] ^ rotl(b, 5+r)`。
2. **WB-2（Feistel）**：10 轮表驱动 F 函数，两张 256 项表 `g1/g2` 与 12 个轮键构成密钥流，输出按 32 位字序列化。
3. **WB-3（ARX）**：12 轮 ARX，每轮取 S 盒表与 KDF 表切片做加-旋-异或链路，状态 6 字。

三套自定义密码（可逆，参与混合管线）：

1. **C1 改造 XXTEA**：delta = `0x9e3779d1`（非常量），轮数 `10 + (n*7)%9`，按字数组分组链接；
2. **C2 自定义 Feistel**：12 轮，F 函数由两张表 + 轮键 + 旋转构成，输入输出异或轮键；
3. **C3 ARX / RC5 变体**：P/Q 常数替换为 `0xb7e15162/0x9e3779b1`，密钥调度混入 `0x7f4a7c15`，16 轮，数据相关旋转。

三套自定义编码：

1. **E1 base-64**：自定义 64 字符字母表，大数进位置换，3 字符长度前缀；
2. **E2 位平面转置**：8×8 比特转置 + 魔术头 + 长度头，转置为对合变换（编码=解码）；
3. **E3 Unicode 映射**：256 个码位打乱映射到 `0x4E00` 起的高区，头部携带长度与校验字符。

混合管线 `ZT_mixedSeal/Open` 把上述三层串起来，顺序与轮数由变体矩阵决定，因此**同一份明文在不同实例、不同消息下标下会产生不同层级组合的密文**。自检对 9 个变体各做一次往返，并做篡改拒绝测试。

## 6. 渲染引擎级环境检测

探针矩阵覆盖渲染引擎与宿主差异，Node 下全部 guarded（缺失记为 `absent`/`no-dom`，绝不抛错）：

- `document.all` HTMLDDA 语义：`typeof === 'undefined'`、布尔假、`== null`、`.length === 0`、`.item` 可调用。浏览器域直接读真值；Node 无 DOM 域时使用"影子域"镜像断言同一套契约，两者都要求四项全部成立才把 `documentAll` 置为 true。
- CSS：`CSS.supports` 属性/选择器、`CSS.escape`；`matchMedia` 媒体特性。
- WebGL：vendor/renderer（`WEBGL_debug_renderer_info`）、扩展数量、`MAX_TEXTURE_SIZE`。
- Canvas：2D 上下文、`toDataURL`、像素回读。
- 字体：`span` 度量、`document.fonts` 尺寸。
- iframe 跨 realm：`contentWindow` 与跨 realm 全局构造器。
- 音频/媒体/权限：`AudioContext`、`OfflineAudioContext` 采样率、`navigator.mediaDevices`、`navigator.permissions`。
- 屏幕与布局：`screen.width/colorDepth/availHeight`、`devicePixelRatio`、`getBoundingClientRect`、`offsetHeight`、滚动位置。
- 观察者：Mutation/Intersection/Resize/Performance Observer。
- 存储与 Cookie：localStorage/sessionStorage/cookieEnabled/indexedDB/caches。
- 运行时：Worker/ServiceWorker/SharedArrayBuffer/Atomics/WebAssembly 存在性（仅 `typeof`）、Intl 与 timezone、语言列表。
- 宿主 Node：platform/arch/version/uptime/memory/stdout TTY。

metrics 中的 `envChecks` 为实际执行并记录的探针数（90 项，≥ 50）。

## 7. 业务层与快速开始

```bash
cd examples/mega/14-zero-trust-client-sdk
node zero-trust-client-sdk.js
```

期望输出（末尾三行）：

```
14 MEGA Zero-Trust Client SDK [sdk/military] — assertions N passed | blackhole-digest <hex> | Tms
MEGA SELFTEST OK
MEGA METRICS {"whitebox":3,"customCiphers":3,"encodings":3,"jsvmpOps":252831,"envChecks":90,"polymorphicVariants":512,"mixedRounds":3,"documentAll":true,"antiDebug":10}
```

SDK 入口（同文件内可直接调用）：

- `ZT_deviceDescriptor()` / `ZT_attest(descriptor, secret)` / `ZT_verifyAttestation(token, descriptor, secret)` / `ZT_challengeCreate(secret)` / `ZT_challengeRespond(state, secret)` / `ZT_challengeVerify(state, secret, response)`
- `ZT_evaluatePolicy(context)`（返回 allow / step-up / deny、违规项与 trace）/ `ZT_rendererReport()`
- 底层能力：`ZT_mixedSeal/Open`、`ZT_wbStream`、`ZT_cipherEncrypt/Decrypt`、`ZT_encEncode/Decode`；
- 契约：`ZT_mixedOpen` 在编码结构/校验失败时返回 `null`，空明文返回零长度 `Uint8Array`

## 8. 验证

`node zero-trust-client-sdk.js` 的自检项（任一失败即不打印 OK 且退出码非 0）：

- 三张体量表家族摘要与形状比对；
- 白盒 3 套：密钥流非退化、往返、确定性、换键分离；
- 自定义密码 3 套：往返、确定性、换键分离、密文膨胀；编码 3 套：往返（含二进制脏字节、空载荷）；
- 混合管线：9 个变体往返 + 篡改拒绝 + 轮数下限；
- JSVMP：micro/inner/outer 三层链值与指令数、字节码摘要、确定性复跑；
- 环境探针计数与 `document.all` 语义；
- 反调试探针计数；
- 业务层：描述符、证明验签、篡改/错误密钥/过期拒绝、挑战应答与重放拒绝、策略 allow/step-up/deny、VM 指令数。

批量门禁（体积/纯净度/能力下限）：

```bash
node examples/mega/run-all.mjs --filter 14
```

## 9. 防御建议

- 这类"单文件巨型混淆体"不适合静态阅读：先跑自检拿到 metrics 作为能力基线，再用 `tools/cli.js` 提高体积上限做分区导出。
- 关注 `ZT_POOL`/`SBOX` 家族的摘要校验点，它是篡改检测的咽喉；改表必被自检发现。
- 运行时取证建议 hook `Math.imul`、`Date.now`、`Uint32Array` 构造与 VM 主循环入口，即可定位三层调度。
- 环境探针矩阵可用于反向指纹：比对同一文件在无头环境与真实浏览器中的 `envChecks` 差异。
- 企业侧若引入同类构造，应把"体积"与"安全性"解耦：白盒/自定义密码不能替代标准 AEAD，混合管线应在外层再套标准化的认证加密。

## 10. 说明

- 该文件为教学/评测用的**合成**作品：所有"恶意行为样本"（如 15 号作品的语料）均为内嵌构造的合成事件流，不含任何真实恶意代码；SDK 层的白盒与自定义密码为演示构造，不声称达到生产密码学强度。
- 无网络、无文件系统、无子进程、无动态求值：所有数据都在文件内，所有执行都是确定性的（除实例熵带来的变体选择）。
- 体积来自**被真正使用**的面量：表家族参与摘要与切片、字节码全部执行、变体矩阵参与管线选择、密文标签参与解码。
