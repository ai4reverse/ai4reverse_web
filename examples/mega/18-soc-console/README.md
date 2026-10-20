# 18 · SOC Fortress Console

> MEGA 单文件纯 JavaScript 作品 · type=app · grade=commercial · 有效代码 3.60MB
> 入口：`soc-console.js`（唯一 JS 文件，无 require/import/模块/WebAssembly/外部库）

## 作品定位

面向安全运营中心（SOC）的离线控制台样本：展示“嵌入式合成语料 + VM 保护规则引擎 + 研判表 + 风险度量”的一体化结构，可在无网络环境中直接运行。

## 架构

SOC 控制台由五层组成：

1. **语料层**：768 条合成安全事件（源地址、目的端口、字节数、severity、flags、时间戳）以大表嵌入，启动时解码为事件对象并校验折叠摘要。
2. **情报层**：混合加密的 `key=value` 情报块（阈值、最大展示行数、数据源模式）经流水线解密。
3. **规则引擎**：12 条规则编译为字节码，由外层 JSVMP 执行；事件字段写入 VM 内存槽，规则通过 GETM/ROT/XOR/MUL/ADD 组合打分（0-99）。
4. **排序与研判**：对所有事件聚合规则得分，插入排序取 Top-N，输出带 severity/hits 的 triage 表。
5. **风险度量**：severity 直方图、均值/最大值、源地址分桶熵，输出 steady/elevated/critical 状态。

## 黑洞混淆

- 字符串表按 12 个多态变体分别加密存储（替换盒 + 变体密钥链 + 索引算术三层），运行时按实例变体选择解码器；自检对解码结果重新编码并逐字节比对。
- 启动流程被控制流展平为 9 段状态机（状态号随机化），配合不透明谓词与不可达死分支。
- 自校验：启动时对所有大表做 FNV 折叠，与嵌入摘要比对（`tableDigestOk`），摘要同时作为实例密钥派生的隐式输入。
- 反调试：计时抖动、调用栈深度、console 探针、inspector 启动参数、`Error.prepareStackTrace`、`Function.prototype.toString` 漂移共 6 项。

## 堡垒JSVMP

- 外层 VM 嵌入 70000 条操作码（编码后 140000 个字面量），操作码用 `(op * 49 + 13) & 0xFF` 仿射加密，处理器表按实例置换，栈完整性每 64 步校验（canary + 深度）。
- 常量池 XOR 掩码编码，FOLD 指令采样白盒大表；程序入口用 JZ 跳过 24 条不可达死指令。
- VM-in-VM：INNER 指令调用第二层 VM（独立操作码密钥、独立处理器置换、独立常量池），自检统计内层执行操作数。
- 自检执行整段字节码并报告已执行指令数、完整性校验次数与陷阱计数。

## 白盒与混合加密

- 3 套白盒构造：SPN（逆 S 盒 + 自定义 ShiftRows + AES 型 MixColumns）、Feistel-64（表驱动轮函数）、ARX-Feistel（乘法/旋转混合轮函数）；密钥由实例熵 + 表摘要隐式派生，不落盘明文。
- 3 个自定义密码：Kite-17（4 字 ARX，15 轮）、Lattice-11（和扩散 SPN，9 轮）、Ember（11 轮 Feistel）。
- 3 种自定义编码：base-43 大整数编码（自定义字母表、前导零填充到 16 字节块）、奇偶位交织、Unicode 码位重映射。
- 混合流水线每轮为“白盒 → 自定义密码 → 编码”的随机置换，共 5 轮；每轮记录长度轨迹以便严格逆运算，自检做 16 字节样本往返。

## 渲染引擎级环境检测

共 72 项探针（有序置换矩阵），涵盖：

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
node examples/mega/18-soc-console/soc-console.js
```

预期输出包含 `MEGA SELFTEST OK` 与 `MEGA METRICS {...}`。

## 验证

```bash
node examples/mega/run-all.mjs --filter 18
```

体积 / 纯净度 / 指标由 MEGA runner 判定；本作品自检输出：

- whitebox=3、customCiphers=3、encodings=3
- jsvmpOps ≥ 1000（实际见 METRICS）
- envChecks ≥ 50、polymorphicVariants=12、mixedRounds=5
- documentAll=true、antiDebug≥1

## 防御建议

- 对 `Function.prototype.toString`、属性描述符、原型链做周期性快照对比，可发现热补丁与调试器注入。
- 环境探针应组合使用（WebGL + canvas + 字体 + DOM 几何），单点检测易被 headless 伪造。
- 白盒密钥不要落盘；把表摘要纳入密钥派生，可让篡改表直接导致解密失败。
- 对 JSVMP 需关注操作码仿射关系与处理器置换的可恢复性，建议结合动态污点追踪。

## 说明

本作品为防御研究与逆向训练用途的合成样本，所有“攻击面”均为离线模拟或检测逻辑，不包含真实宿主 I/O、网络请求或破坏行为。嵌入大表均为**实际参与运算**的查表/密钥材料，自检会执行并抽样校验。
