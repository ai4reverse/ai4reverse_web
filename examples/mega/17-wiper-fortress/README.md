# 17 · Fortress Wiper Simulation

> MEGA 单文件纯 JavaScript 作品 · type=virus · grade=military · 有效代码 3.57MB
> 入口：`wiper-fortress.js`（唯一 JS 文件，无 require/import/模块/WebAssembly/外部库）

## 作品定位

擦除器（wiper）行为链的离线合成样本：用于训练“配置解密 → 计划生成 → 覆写/清除 → 环境判定”的分析路径，同时保证不产生真实破坏。

## 攻击链

模拟攻击链（全部在内存对象上执行，无真实宿主 I/O）：

1. **配置解密**：嵌入的混合加密配置块（自定义密码 + base-37 + 位交织/Unicode 重映射，固定工作密钥）经流水线逆运算还原为 `key=value` 文本，并校验 FNV 摘要。
2. **计划生成**：由外层 VM 执行计划程序，得到清除轮数与覆写模式，再与配置声明的上限做一致性检查。
3. **卷覆写模拟**：对内存中的 96 个模拟卷条目执行多轮模式覆写 + 归零覆写 + 逐块验证，统计“写入字节数”（模拟）。
4. **缓存清除模拟**：清空 96 个模拟缓存条目并置脏标记。
5. **DOM 拆除模拟**：在模拟节点树上递归摘除子节点，统计摘除数量，验证根节点无子节点。
6. **执行环境检查**：复用 68 项渲染探针与 6 项反调试检查，决定是否进入“观察模式”。

所有对象都是普通 JS 对象/数组，不触碰 `fs`、网络、真实 DOM 或存储。

## 黑洞混淆

- 字符串表按 12 个多态变体分别加密存储（替换盒 + 变体密钥链 + 索引算术三层），运行时按实例变体选择解码器；自检对解码结果重新编码并逐字节比对。
- 启动流程被控制流展平为 9 段状态机（状态号随机化），配合不透明谓词与不可达死分支。
- 自校验：启动时对所有大表做 FNV 折叠，与嵌入摘要比对（`tableDigestOk`），摘要同时作为实例密钥派生的隐式输入。
- 反调试：计时抖动、调用栈深度、console 探针、inspector 启动参数、`Error.prepareStackTrace`、`Function.prototype.toString` 漂移共 6 项。

## 堡垒JSVMP

- 外层 VM 嵌入 62000 条操作码（编码后 124000 个字面量），操作码用 `(op * 35 + 23) & 0xFF` 仿射加密，处理器表按实例置换，栈完整性每 64 步校验（canary + 深度）。
- 常量池 XOR 掩码编码，FOLD 指令采样白盒大表；程序入口用 JZ 跳过 24 条不可达死指令。
- VM-in-VM：INNER 指令调用第二层 VM（独立操作码密钥、独立处理器置换、独立常量池），自检统计内层执行操作数。
- 自检执行整段字节码并报告已执行指令数、完整性校验次数与陷阱计数。

## 白盒与混合加密

- 3 套白盒构造：SPN（逆 S 盒 + 自定义 ShiftRows + AES 型 MixColumns）、Feistel-64（表驱动轮函数）、ARX-Feistel（乘法/旋转混合轮函数）；密钥由实例熵 + 表摘要隐式派生，不落盘明文。
- 3 个自定义密码：Kite-17（4 字 ARX，19 轮）、Lattice-11（和扩散 SPN，13 轮）、Ember（15 轮 Feistel）。
- 3 种自定义编码：base-37 大整数编码（自定义字母表、前导零填充到 16 字节块）、奇偶位交织、Unicode 码位重映射。
- 混合流水线每轮为“白盒 → 自定义密码 → 编码”的随机置换，共 3 轮；每轮记录长度轨迹以便严格逆运算，自检做 16 字节样本往返。

## 渲染引擎级环境检测

共 68 项探针（有序置换矩阵），涵盖：

- `document.all` HTMLDDA 语义：`typeof`、布尔假值、`.length`；Node 中以守卫式缺失分支执行并记录 `documentAll=true`。
- CSS.supports（属性/选择器/`:has()`/`--var`）、CSS.escape。
- WebGL vendor/renderer/extensions/MAX_TEXTURE_SIZE/GLSL。
- canvas 2D、像素回读、toDataURL、measureText、ImageData、OffscreenCanvas。
- 字体度量（offsetWidth、getComputedStyle、document.fonts.check）。
- iframe 跨 realm（contentWindow.Array 原型）。
- AudioContext sampleRate/state、媒体 canPlayType、MediaSource/MediaKeys。
- permissions、Notification、geolocation。
- screen/DPR/orientation/matchMedia（dark、reduced-motion、pointer、standalone）。
- Intl 时区/区域/Collator/NumberFormat/DateTimeFormat。
- navigator（UA/platform/languages/hardwareConcurrency/deviceMemory/maxTouchPoints/webdriver/plugins/mimeTypes/vendor/connection）。
- storage/cookie/indexedDB（localStorage 写入探针带 try/catch）。
- DOM 构造器、布局几何（rect/offset/client/scroll）。
- Worker/SharedWorker/ServiceWorker、WebAssembly 存在性、requestAnimationFrame、performance、visualViewport。
- chrome.runtime、RTCPeerConnection、speechSynthesis、history/location/document 状态。

## 快速开始

```bash
node examples/mega/17-wiper-fortress/wiper-fortress.js
```

预期输出包含 `MEGA SELFTEST OK` 与 `MEGA METRICS {...}`。

## 验证

```bash
node examples/mega/run-all.mjs --filter 17
```

体积 / 纯净度 / 指标由 MEGA runner 判定；本作品自检输出：

- whitebox=3、customCiphers=3、encodings=3
- jsvmpOps ≥ 1000（实际见 METRICS）
- envChecks ≥ 50、polymorphicVariants=12、mixedRounds=3
- documentAll=true、antiDebug≥1

## 防御建议

- 对 `Function.prototype.toString`、属性描述符、原型链做周期性快照对比，可发现热补丁与调试器注入。
- 环境探针应组合使用（WebGL + canvas + 字体 + DOM 几何），单点检测易被 headless 伪造。
- 白盒密钥不要落盘；把表摘要纳入密钥派生，可让篡改表直接导致解密失败。
- 对 JSVMP 需关注操作码仿射关系与处理器置换的可恢复性，建议结合动态污点追踪。

## 说明

本作品为防御研究与逆向训练用途的合成样本，所有“攻击面”均为离线模拟或检测逻辑，不包含真实宿主 I/O、网络请求或破坏行为。嵌入大表均为**实际参与运算**的查表/密钥材料，自检会执行并抽样校验。
