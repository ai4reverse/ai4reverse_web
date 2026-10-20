# 03 GHOSTRELAY APT Beacon — apt-long-haul-beacon

| 属性 | 值 |
| --- | --- |
| 编号 | 03 |
| 名称 | GHOSTRELAY APT Beacon |
| 类型 | 病毒样本（APT 长周期信标） |
| 等级 | 军工级 |
| 分类 | apt-long-haul-beacon |
| 入口 | `apt-beacon.js`（单文件、纯 JavaScript） |
| 加密段 | 10 段 / 解码后 3.39MB |
| 白盒表 | 5,800 个实例化表记录 |
| 验证 | `node examples/mega/run-all.mjs --filter 03` |

## 1. 作品定位

GHOSTRELAY 是**低慢**型 APT 植入体：不做即时破坏，而是用抖动调度把心跳压到极低频，
用死投（dead-drop）解析器替代固定 C2，把任务封存在白盒混合加密里。
与分析者的对抗点是**噪声与体积的错配**：网络侧几乎无特征，
文件侧却是一个数 MB 的黑洞表 + 堡垒 JSVMP，足以拖垮逐指令的人工还原。

## 2. 完整攻击链

1. **环境裁决**：渲染引擎探针（HTMLDDA、WebGL、canvas、字体、iframe realm、布局、
   媒体解码能力、权限、Intl 时区、存储）判定真实浏览器/沙箱/无头环境。
2. **抖动调度**：`mulberry32(seed ^ 0x5a5a)` 生成 6 段 240–2040ms 的抖动窗口，
   累加得到长窗口 `window`，避免规律心跳。
3. **死投解析**：从 1.05MB 路由表中按固定步长采样，
   取 250 以内字节映射为 `a-z` 路径片段，拼出 4 条 `/xxxxxxx/xxxxxxx` 死投路径。
4. **任务封存**：任务 ID + implant 名 + 死投路径经 utf8 → 7 轮混合管线
   （白盒 → 定制密码 → 编码）封装，仅驻留内存。
5. **通道轮转**：主死投域 + 备用域 + 路径轮转（模拟，无真实请求）。

## 3. 黑洞混淆

- 字符串池 5 层落地：逐串密钥流 → 段 XOR → 64 字节块置换 → 变体 base-N → 惰性缓存。
- **多态解码器**：三族解码器各两套等价实现，启用哪套由**解密后的变体派发表**决定；
  自检阶段两套实现逐段互校（`decoder variants agree`）。
- **控制流扁平化**：`stageMachine` + 两处 `opFalse()` 不透明谓词（decoy / decoy2）。
- **自校验**：每段魔数/长度/FNV-1a，全量 `dataDigest`，字符串池 `poolDigest`。
- **反调试**：计时差、栈特征（帧数/是否含 node:）、console 篡改、native toString、
  时钟分辨率、视口差、`debugger` 陷阱、堆哨兵，共 8 项。

## 4. 堡垒 JSVMP

- 32 条操作码；opcode 与操作数以 `opKey` 异或；处理器表按 32 元置换打乱。
- **嵌套 VM**：`INNER` 指令用第二把密钥执行内层字节码；自检做差分校验。
- **栈完整性**：push/pop 记账、单步 `pushes - pops === sp` 断言、栈上限与峰值检查。
- **规模**：61,000 条记录的线性字节码
  （约 0.76MB），常量池 undefined 项；
  自检执行 6 万步并做操作数走查计数。

## 5. 白盒与混合加密

| 构造 | 参数 |
| --- | --- |
| 白盒 SPN | 4 字节 / 7 轮 / 逐实例 S 盒与轮密钥 |
| 白盒 Feistel | 8 字节 / 8 轮 / 逐实例轮函数表 |
| 白盒 ARX | 16 字节 / 8 轮 / rot13 + rot7 |

定制密码：rotor、Speck 变体（18 轮）、mirror-SPN、add-keystream。
自定义编码：置换 base64、base91、半字节交织、Unicode 映射（2 字节长度信封）。
**混合管线**：round=7，6 组顺序表，自检逐组往返。

与 01/02 的差异：本作品白盒表段使用 base85 承载、主字节码段使用置换 base64、
路由表使用 base91，三段的层组合与 01/02 完全不同；S 盒与轮函数表由
`(i*7+13)&255` 起始置换生成，与 01/02 的纯随机置换分布不同。

## 6. 渲染引擎级环境检测

探针覆盖 18 个域：`document.all` HTMLDDA（typeof/布尔/`.length`）、CSS.supports 与
`CSS.escape`、计算样式、WebGL vendor/renderer/limits/extensions/precision、
canvas 2D/像素/toDataURL/measureText/命中测试、字体度量与墨迹、
iframe contentWindow 与跨 realm Array 比较、布局几何、
AudioContext/OfflineAudioContext/采样率、`canPlayType` 三容器、
permissions/Notification/userActivation、screen/DPR/matchMedia/orientation、
Intl 时区与本地化、localStorage/sessionStorage/indexedDB/Storage.prototype、
cookie 三态、DOM 构造器与 brand check、Worker/SharedWorker/serviceWorker/MessageChannel、
`WebAssembly` 绑定、plugins/UA-CH、performance/RAF/hardwareConcurrency/connection/secureContext。
Node 下全部守卫式记录，链路不中断。

## 7. 快速开始

```bash
node examples/mega/03-apt-beacon/apt-beacon.js
node examples/mega/run-all.mjs --filter 03
node tools/cli.js analyze examples/mega/03-apt-beacon/apt-beacon.js --virtual-ms 120000
```

## 8. 验证

自检输出 `MEGA SELFTEST OK` + `MEGA METRICS {...}`；检查项：
扁平化状态机、段摘要、解码器互校、字符串池、三类白盒往返与实例差异、
四类定制密码往返、四类编码往返、混合管线往返、
VM 走查/差分/嵌套/栈完整性、探针数量与 `document.all` 语义、反调试、行为链。

## 9. 防御建议

- 死投解析的特征是**同一路径模式反复出现但域名低频**：按 URL 路径熵 + 域名信誉联动检测。
- 抖动调度在长窗口内仍会留下分布的"下限"（最短间隔），可用长周期心跳聚类发现。
- 对 permissions/媒体能力的大面积探测（一次运行覆盖 10+ API）做高危评分。
- 体积/熵门限 + WebGL/canvas 指纹一致性比逐指令反混淆性价比更高。

## 10. 说明

本作品为合成、可离线运行的军工级示例：死投域名为保留域，网络与存储访问均被模拟或
守卫式跳过，不含可用 C2、真实凭据或破坏性宿主操作。
