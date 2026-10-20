# 01 BLACKHOLE Loader — loader-blackhole-obfuscation

| 属性 | 值 |
| --- | --- |
| 编号 | 01 |
| 名称 | BLACKHOLE Loader |
| 类型 | 病毒样本（loader） |
| 等级 | 军工级 |
| 分类 | loader-blackhole-obfuscation |
| 入口 | `blackhole-loader.js`（单文件、纯 JavaScript） |
| 加密段 | 10 段 / 解码后 3.23MB |
| 白盒表 | 5,900 个实例化 T-box 记录 |
| 验证 | `node examples/mega/run-all.mjs --filter 01` |

## 1. 作品定位

BLACKHOLE 是一款「加载器优先」的军工级投放器：自身不携带可用 payload，而是把
二阶段载荷、投递域名与任务通道全部封存在黑洞式多层加密表里，运行期按实例密钥解封。
它的目标不是直接破坏宿主，而是**在渲染引擎里完成环境裁决、解码、分发与持久化的整条链**，
同时让静态分析者面对数十万条无意义的高熵表项。

## 2. 完整攻击链

1. **环境裁决**：渲染引擎级探针（`document.all` HTMLDDA、CSS、WebGL vendor/renderer、
   canvas 像素、字体度量、iframe 跨 realm、布局几何、音频/媒体/权限、Intl 时区、存储与 cookie）
   判断宿主是真实浏览器、无人值守沙箱还是 Node 式无头环境。
2. **表解封**：10 个加密段依次经过 base91/base64-变体/85/62/半字节交织解码、
   LCG 密钥流异或与 64 字节块置换，随后校验魔数、长度、FNV-1a 摘要与结构约束
   （S 盒双射性、字节码操作数走查、字符域、取值范围、int32 对齐）。
3. **DGA**：从 0.95MB 的 DGA 词池中按固定步长采样，
   拼接成 8 个候选域名并选取 primary / fast-flux 集合。
4. **载荷封装**：二阶段配置（build id、stage id、域名、实例种子）经 utf8 →
   混合管线（白盒 SPN → 定制分组密码 → 编码）封装成字符串，只存在于内存。
5. **分发计划**：为 fast-flux 主机生成 3 条 beacon 计划并排入队列（样本内全部模拟，
   不发起任何真实请求）。

## 3. 黑洞混淆

- **多层字符串/操作码加密**：字符串池按「明文 → 逐串密钥流 → 段级 XOR → 段级块置换 → 变体 base-N」
  五层落地；`poolGet` 只在首次访问时解封，命中即缓存。
- **多态解码器**：`cB64a/cB64b`、`cB91a/cB91b`、`cNibble/cNibbleb` 是同语义的两套实现
  （位移拼装 vs 位缓冲、双循环 vs 单循环），实际启用哪一套由**解密后的变体派发表**逐调用点决定，
  自检阶段还会强制两套实现逐段互校（`decoder variants agree`）。
- **控制流扁平化**：主链被压平为 `stageMachine` 状态机（boot → tables → crypto → vm → probe），
  中间插入 `opFalse()` 不透明谓词守住诱饵状态（decoy / decoy2），静态阅读时不能确定真实路径。
- **自校验**：每个段记录魔数、长度、FNV-1a；全量段摘要再折叠成 `dataDigest`，
  字符串池另有独立 `poolDigest`，任何一字节被改动都会在自检阶段抛错。
- **反调试**：8 个探针——计时差、`Error().stack` 帧数、`console.log` 源码篡改、
  native toString 校验、时钟分辨率、视口差值、不透明谓词包裹的 `debugger` 陷阱、堆累加哨兵。

## 4. 堡垒 JSVMP

- 32 条操作码（nop/pushc/pushi/…/inner/mix/tick），**opcode 字节以 `opKey` 异或编码**，
  操作数同样异或，因此字节码段在明文里不可读。
- **处理器表打乱**：`P.opSlotOf` 是 opcode → slot 的 32 元置换，
  分发器通过 `H[so[op]]` 调用，源码顺序与语义顺序无关。
- **嵌套 VM**：主程序含 `INNER` 指令，用**另一把 opcode 密钥**执行内层字节码；
  自检用差分方式验证结果：VM 解释执行值必须等于源码中直接计算的表达式值。
- **栈完整性**：每次 push/pop 记账，单步校验 `pushes - pops === sp`，
  并检查栈上限、峰值与步骤预算；越界/漂移立即抛错。
- **嵌入式字节码规模**：主程序由 54,000 条记录生成的
  0.68MB 线性程序（栈平衡、以 HALT 收尾），
  自检既做**操作数走查计数**（`vmCountOps`，与度量里的 jsvmpOps 同源），
  也真正执行其中 6 万步，用于证明解码、常量池与分发器可用。

## 5. 白盒与混合加密

| 构造 | 说明 |
| --- | --- |
| 白盒 SPN | 4 字节分组、5 轮；256 项 S 盒 + 20 字节轮密钥 + mix 常量**逐实例**不同；解密侧运行期反演 S 盒 |
| 白盒 Feistel | 8 字节分组、6 轮，轮函数由 256 项表 + 字节旋转构成，逐实例表 |
| 白盒 ARX | 16 字节分组、6 轮，(`+ `, `^`, rot9/rot13) 四词结构，轮密钥取自加密常量池 |

定制/改造密码 4 套：rotor（数据驱动盒 + 位置相关密钥的流式置换）、
Speck 变体（非标准旋转对 8/3、14 轮、LCG 密钥表）、
mirror-SPN（双 S 盒交替 + 字节置换 + 32 字节轮密钥）、add-keystream（乘法散列密钥流 + 模 256 加）。

自定义编码 4 套：置换字母表 base64、base91、半字节交织（位置相关 4bit 旋转 + 双掩码）、
Unicode 映射（`0x4E00 + byte`）。编码器统一加 2 字节长度信封，保证任意字节宽度的无损往返。

**混合管线**：`mixSeal` 按实例顺序表串接「白盒 → 定制密码 → 编码」，自检对每个顺序表项
都执行 seal/open 往返并逐字节比对（`mixed pipeline roundtrip`，rounds=5）。

## 6. 渲染引擎级环境检测

共数十个探针（运行期以 envChecks 输出实际数量）、覆盖 html/css/webgl/canvas/fonts/iframe/layout/audio/media/permissions/screen/intl/storage/cookie/dom/worker/wasm/plugins/misc 等领域：

- `document.all` 按 **HTMLDDA** 语义判定：`typeof document.all === 'undefined'`、
  布尔假值、`.length` 类型三项必须自洽；Node 下绑定缺失，探针依然执行并记录 `available:false`。
- WebGL 取 `VENDOR`/`RENDERER`/`WEBGL_debug_renderer_info`/`MAX_TEXTURE_SIZE`/扩展列表，
  显卡驱动指纹是虚拟机与真实浏览器最强的分水岭之一。
- canvas 做像素回读、`toDataURL` 前缀、`measureText` 宽度、渐变与命中测试；
  字体用 serif/monospace 度量差与字形墨迹像素数交叉验证。
- iframe 创建后取 `contentWindow` 并比较 `cw.Array !== window.Array`（跨 realm 隔离）。
- 布局用离屏 div 的 `offsetWidth`/`getBoundingClientRect`/`getClientRects` 真实测量。

## 7. 快速开始

```bash
node examples/mega/01-blackhole-loader/blackhole-loader.js      # 自检 + 度量
node examples/mega/run-all.mjs --filter 01                      # 契约校验
node tools/cli.js analyze examples/mega/01-blackhole-loader/blackhole-loader.js --virtual-ms 120000
```

## 8. 验证

自检必须打印 `MEGA SELFTEST OK` 与一行 `MEGA METRICS {...}`，
并且下面每一项都通过（任一项失败即以非零码退出）：

- `flattened stages`、`segment digest`、`decoder variants agree`
- `pool string 0..n`、`pool digest`
- `whitebox spn/feistel/arx roundtrip`、`whitebox instance keying`
- `rotor/speck/mirror/addks roundtrip`
- `encoding roundtrip 0..3`、`mixed pipeline roundtrip`
- `vm bulk arity`、`vm differential`、`vm nested dispatch`、`vm stack integrity`
- `probe count`、`document.all probe executed`、`probe domains`、`anti debug probes`、`behaviour chain`

## 9. 防御建议

- 以「超大高熵表 + 少量真实逻辑」为特征做体积/熵检测，而不是逐字符反混淆。
- 对 `document.all`、WebGL renderer、canvas 指纹组合做**指纹一致性**校验：
  真实浏览器不会同时缺失 HTMLDDA 语义与 WebGL vendor。
- 阻断首次解析即执行的 DGA 解析与 fast-flux A 记录轮换，检测同页面对 8+ 随机子域的解析。
- 对 `Function.prototype.toString`、`console.log` 的篡改做运行时完整性监控。

## 10. 说明

本作品为合成、可离线运行的军工级示例：域名使用保留域，网络、存储、权限访问全部模拟或
守卫式跳过，不含可用 C2、真实凭据或破坏性宿主操作。体积来自**被真实解码、校验并参与运算**的
大表（白盒 T-box、VM 字节码、DGA 词池、变体派发表），而非无意义填充。
