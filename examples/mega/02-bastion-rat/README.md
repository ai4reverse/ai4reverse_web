# 02 BASTION RAT — remote-access-trojan

| 属性 | 值 |
| --- | --- |
| 编号 | 02 |
| 名称 | BASTION RAT |
| 类型 | 病毒样本（远控木马） |
| 等级 | 军工级 |
| 分类 | remote-access-trojan |
| 入口 | `bastion-rat.js`（单文件、纯 JavaScript） |
| 加密段 | 10 段 / 解码后 3.11MB |
| 白盒表 | 6,200 个实例化表记录 |
| 验证 | `node examples/mega/run-all.mjs --filter 02` |

## 1. 作品定位

BASTION 是长期驻留型浏览器远控：它把**命令集中枢**藏在加密表里，用加权调度器挑选
键盘记录、屏幕抓取、剪贴板读取、文件枚举、令牌窃取等任务，并把会话密钥、
C2 通道与持久化键全部交给黑洞表 + 白盒混合加密保护。与分析者的对抗点在于：
命令语义分散在 0.84MB 的权重表里，
真正的任务字符串只在 `poolGet` 解封后才出现，且会话密钥每次运行都重新封装。

## 2. 完整攻击链

1. **环境裁决**：先跑渲染引擎探针（HTMLDDA、WebGL renderer、canvas 像素、字体、布局、
   权限、媒体能力、Intl 时区、存储/cookie）。缺少 `document.addEventListener` 时
   走 `headless-guard` 分支，不注册任何 DOM 钩子。
2. **命令权重装载**：64 个命令槽从 0.84MB 命令矩阵中
   取权重（1..8），归一化后由 mulberry32 逐实例随机选择 6 条待执行命令。
3. **会话封存**：implant 名 + 构建号 + 种子摘要经 utf8 → 6 轮混合管线（白盒 → 定制密码 → 编码）
   得到会话票据，落内存不落盘。
4. **通道选择**：`wss://c2.example.test/rat` 与备用域来自加密字符串池，
   持久化键同样来自池（本样本只导出键名，不写存储）。
5. **外发编码**：命令队列以 base64 变体编码后暂存，等待 channel 就绪（全部模拟）。

## 3. 黑洞混淆

- 字符串池 5 层落地（逐串密钥流 → 段 XOR → 64 字节块置换 → 变体 base-N → 缓存），
  20 条配置串（通道、UA、键名、路径、错误码）在源码里全部不可见。
- **多态解码器**：base64/base91/nibble 各有两套等价实现（位移拼装 vs 位缓冲、
  双循环 vs 单循环），启用哪套由**解密后的变体派发表**（8192 字节）逐调用点决定；
  自检强制两套实现互校。
- **控制流扁平化**：`stageMachine` 状态机 + `opFalse()` 不透明谓词，诱饵状态不可达但静态上不可判定。
- **自校验**：段级 FNV-1a + 全量 `dataDigest` + 字符串池 `poolDigest`。
- **反调试**：计时差、栈特征、console 篡改、native toString、时钟分辨率、视口差、
  `debugger` 陷阱、堆哨兵；命中数在 banner 里输出为 `anti-hits`。

## 4. 堡垒 JSVMP

- 32 条操作码，opcode 与操作数均以 opKey 异或；处理器表经 32 元置换打乱（`P.opSlotOf`）。
- **嵌套 VM**：主程序 `INNER` 指令以内层专属 opcode 密钥执行内层字节码，
  自检做差分校验（解释器结果 == 源码直接算出的期望值）。
- **栈完整性**：push/pop 记账 + 单步 `pushes - pops === sp` 校验 + 峰值/步骤预算。
- **规模**：46,000 条字节码记录（约 0.58MB）用于操作数走查计数并真实执行 6 万步；
  常量池 undefined 项 int32，供 `PUSH_C` 随机索引，杜绝"空表充数"。

## 5. 白盒与混合加密

| 构造 | 参数 |
| --- | --- |
| 白盒 SPN | 4 字节分组 / 6 轮 / 逐实例 S 盒 + 24 字节密钥材料 |
| 白盒 Feistel | 8 字节分组 / 7 轮 / 逐实例 256 项轮函数表 |
| 白盒 ARX | 16 字节分组 / 7 轮 / 密钥取自常量池 |

定制密码 4 套：rotor、Speck 变体（rot 8/3，16 轮）、mirror-SPN（双 S 盒交替）、
add-keystream。自定义编码 4 套：置换 base64、base91、半字节交织、Unicode 映射，
统一 2 字节长度信封保证无损。

**混合管线**：本样本 round=6，顺序表 6 组，
每组含 3~5 个变换；自检对每组都做 seal/open 往返比对。

## 6. 渲染引擎级环境检测

BASTION 的探针比 01 更偏**交互面**：`document.all` HTMLDDA 三连判（typeof/布尔/`.length`）、
iframe 跨 realm（`cw.Array !== window.Array`）、布局几何、`navigator.permissions` 相机查询、
`Notification.permission`、`navigator.userActivation`、WebGL `UNMASKED_RENDERER_WEBGL`、
canvas 像素回读与 `toDataURL` 前缀、字体度量差与字形墨迹、`canPlayType` 三种容器、
`MediaRecorder`/`MediaSource`、`AudioContext` 采样率、Intl 时区与偏移、
localStorage/sessionStorage/indexedDB、cookie 串与 `cookieStore`、
`customElements`/`ShadowRoot`/`Worker`/`SharedWorker`/`serviceWorker`/`MessageChannel`、
`WebAssembly` 绑定存在性等。Node 下全部以 `available:false` 记录，链路不中断。

## 7. 快速开始

```bash
node examples/mega/02-bastion-rat/bastion-rat.js
node examples/mega/run-all.mjs --filter 02
node tools/cli.js analyze examples/mega/02-bastion-rat/bastion-rat.js --virtual-ms 120000
```

## 8. 验证

自检输出 `MEGA SELFTEST OK` + `MEGA METRICS {...}`，并逐项通过：
段摘要、解码器互校、字符串池、三类白盒往返与实例差异、四类定制密码往返、
四类编码往返、混合管线往返、VM 操作数走查/差分/嵌套/栈完整性、
探针数量与 `document.all` 语义、反调试探针、行为链（`behaviour chain`）。

## 9. 防御建议

- 监控单页面长时间存在的高频 `setInterval` + 编码外发组合，尤其是 wss 通道。
- 对权限查询（camera/mic）、剪贴板读取、屏幕捕获 API 的组合调用做前置授权与审计。
- 检测"首次访问即读取大量 localStorage 键名"的行为（持久化键枚举）。
- 用体积/熵 + WebGL 指纹一致性识别黑洞表型样本，避免陷入逐字符串还原。

## 10. 说明

本作品为合成、可离线运行的军工级示例：C2 使用保留域，命令执行、键盘/屏幕/剪贴板采集
均为**模拟记录**，DOM 钩子只在真实引擎存在时才注册且不注入任何真实监听，
不含可用 C2、真实凭据或破坏性宿主操作。
