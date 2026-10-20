# 07 Rendering Attestation SDK — rendering-attestation

| 属性 | 值 |
| --- | --- |
| 编号 | 07 |
| 名称 | Rendering Attestation SDK |
| 类型 | 纯 JS 安全 SDK（单文件） |
| 等级 | 军工级 |
| 分类 | rendering-attestation |
| 入口 | `rendering-attestation-sdk.js` |
| 体积 | ≥ 3.4MB 有效代码（注释与空行剔除后） |

## 1. 作品定位

面向高价值客户端（DRM 播放器、金融作业台、远程渲染终端）的**渲染引擎级环境证明 SDK**。
它回答一个比 User-Agent 更根本的问题：**当前执行环境是否真的具备可用的浏览器渲染栈**，
还是 Node/沙箱/无头容器用桩对象伪装出来的。SDK 采集 18 个渲染相关族（HTMLDDA、CSS、
WebGL、Canvas、字体、iframe 域、音频、媒体、权限、屏幕/DPR、媒体查询、Intl/时区、DOM
构造器与布局、Worker、存储、引擎指纹、WebAssembly 命名空间、视口几何），按权重矩阵折算
出一个 0–100 的环境风险分，并输出可被服务端复核的**证明令牌**。

## 2. 架构与数据流

1. `buildContext` 优先取真实 `globalThis.document/window`；缺失时（Node）构造**仿真渲染域**
   （emulated realm），其中包含 Canvas2D/WebGL 桩、字体度量、iframe 跨域构造函数、权限与
   存储对象，使每条探针都能真正执行而不是直接判空。
2. `runProbes` 顺序执行探针表，记录 `status`（present/emulated/absent/error）、`signal`
   与可读 `detail`；单条探针异常被隔离，不会中断采集。
3. `attestationCategory` 按族累计权重；`attestationRisk` 用大矩阵（数百行
   `[probeIndex, weight]`）再次加权，缺失/仿真/异常分别计费，得到风险分与四档结论
   （trusted-rendering / mixed-renderer / elevated-automation / hostile-synthetic）。
4. `attestationDigest` 把风险分、族统计与逐探针信号折叠成 32 字节摘要；
   与每实例 nonce 拼接后走**混合管线**（白盒→自定义密码→自定义编码）密封成证明令牌。
5. 服务端用同一管线解封，比对摘要并校验编码校验和；令牌被改动即拒绝。

## 3. 黑洞混淆

- 熵池 `POOL` 以十六进制存放约 1MB+ 的加密字节，运行期按块走三层逆变换
  （位置密钥流 → 替代表 → 位置加法 → 位旋转）解码，再做全池滚动摘要。
- 12 种**多态解码器**（融合循环/逆序/分块/递归/类型化数组/查表调度等）对同一密文切片
  必须给出一致明文，任何实现被替换都会暴露。
- 初始化控制流被压平成 7 状态机；不透明谓词包裹的死分支永不命中，静态上却可达。
- 自校验：全池解码-再编码必须还原原密文；核心函数源码指纹在自检前后比对，
  运行期被替换即失败。
- 反调试：计时漂移、调用栈形状、inspector getter 陷阱、原生函数完整性、
  `Error.prepareStackTrace` 劫持检测。

## 4. 堡垒 JSVMP

嵌入式字节码约十万级操作码，使用**滚动密钥（running key）** 加密并三步一码存放；
逻辑操作码经置换表映射到乱序 handler 槽位，执行时按槽位派发。指令参数来自**加密常量池**
（运行期由熵池切片解出 512 字节常量表，`LOADK` 指令按索引取值）；初始化流程由压平状态机
（7 状态 + 永不命中的死分支）驱动。自检对整个字节码做栈深度结构扫描（下溢/非法跳转/
孤儿 HALT 均为 0）、影子栈校验和检查，并统计操作码直方图与校验和。
内层 VM 使用独立种子与独立编码表，执行一段加密的阶乘程序（6! = 720），
外层的 `CALL` 指令触发 VM-in-VM 派发；另有汇编器现场构造的循环程序（1²+…+20² = 2870）
验证跳转与局部变量语义。结构扫描 + 内层程序 + 汇编程序共同计入 `jsvmpOps`。

## 5. 白盒与混合加密

| 构造 | 说明 |
| --- | --- |
| WB-SPN | 每轮 16 个 256 项替代表（隐式密钥），置换 + 掩码扩散，正逆表均由表材料重建 |
| WB-Feistel | 32 位表驱动轮函数，轮密钥与旋转量藏在表材料中，Feistel 结构天然可逆 |
| WB-ARX | 表驱动字节替换 + 轮常量 + 模加/异或/旋转混合，逆表现场重建 |

自定义密码：12 轮 SPN（自选移位偏移、GF(2⁸) 自定义 MDS 矩阵及现场求逆）、
16 轮 Feistel（非标准轮函数与前后置密钥）、8 轮 ARX 流密码（自定义状态混合）。
自定义编码：乱序字母表 Base64（逐块校验和 + 头部标记）、8×8 位平面交织（车道掩码）、
Unicode PUA 字形映射（位置盐）。混合管线把「白盒 → 自定义密码 → 自定义编码」按实例
随机排序执行，自检对 3 条不同顺序的管线做密封/解封回环。

## 6. 渲染引擎级环境检测

- **HTMLDDA**：`typeof document.all === 'undefined'`、布尔假值、`.length`、`item()`、
  `namedItem()`、同一性；Node 下在语义模型上逐条执行并标注 `emulated`。
- **CSS**：`CSS.supports` 双参/单参、`CSS.escape`、`:has()`/`::backdrop` 选择器、
  `@supports` 复合条件、样式表数量。
- **WebGL**：上下文、VENDOR/RENDERER、UNMASKED_*、扩展列表、MAX_TEXTURE_SIZE、
  WebGL2、着色器精度。
- **Canvas**：2D 上下文、像素回读摘要、`toDataURL` 前缀、文本度量、命中测试、
  OffscreenCanvas、画布指纹。
- **字体**：`FontFaceSet.check`、等宽/无衬线/CJK 度量、`offsetWidth`、字体集。
- **iframe 域**：contentWindow、跨域 `Array/Object` 构造器身份、跨域 `instanceof`、
  sandbox 属性、srcdoc、frame origin。
- **音频/媒体/权限**：AudioContext 采样率与 destination、analyser、MediaRecorder、
  canPlayType、MediaSource、getUserMedia/enumerateDevices、camera/notifications/
  clipboard/geolocation/midi 权限查询形状。
- **屏幕/DPR/媒体查询**：宽高/可用区/色深、devicePixelRatio、方向、宽高比、
  prefers-color-scheme、reduced-motion、min-resolution、hover、forced-colors、监听器。
- **Intl/时区**：timeZone、locale、offset、日期/数字格式化、collation、calendar。
- **DOM/布局**：构造器、getBoundingClientRect、offsetWidth/clientHeight、三种 Observer、
  DOMParser、querySelector、documentElement/viewport/chrome/scrollHeight。
- **Worker/存储/引擎**：Worker/SharedWorker/ServiceWorker/MessageChannel/postMessage、
  localStorage 读写回环、sessionStorage、cookie、indexedDB、caches、quota、
  UA/vendor/webdriver/platform/plugins/languages/hardwareConcurrency、WebAssembly 命名空间。

## 7. 快速开始

```bash
cd examples/mega/07-rendering-attestation-sdk
node rendering-attestation-sdk.js
```

输出包含：

```
MEGA ATTEST verdict=... risk=... coverage=18/18 probes=... matrix=...
MEGA ATTEST document.all typeof=undefined falsy=true length=...
MEGA ATTEST categories html-dda=... css=... webgl=...
MEGA ATTEST token=...
MEGA SELFTEST OK
MEGA METRICS {"whitebox":3,...}
```

## 8. 验证

- 套件级：`node examples/mega/run-all.mjs --filter 07`
- 本地：退出码 0、`MEGA SELFTEST OK`、`MEGA METRICS` 中 whitebox≥3、
  customCiphers≥3、encodings≥3、jsvmpOps≥1000、envChecks≥50、
  polymorphicVariants≥10、mixedRounds≥1、documentAll=true、antiDebug≥1。

## 9. 防御建议

- 把风险分与令牌校验放在服务端，客户端结论只作参考，避免自证清白。
- 对 `emulated` 占比、`webdriver`、异常族权重设阈值；高价值操作要求多因子（设备证书）。
- 定期轮换矩阵权重与 nonce 派生常量，防止攻击者按固定权重做针对性伪装。
- 令牌必须绑定会话/动作上下文；单次有效，避免重放。

## 10. 说明

本作是**纯防御向**的检测与证明 SDK：不发起网络请求、不采集真实用户数据、不落地文件。
在 Node 中运行时全部探针走仿真域，输出明确标注 `emulated`，不宣称具备真实浏览器能力。
所有密码构造为教学/演示用白盒与自定义算法，不替代标准密码库。
