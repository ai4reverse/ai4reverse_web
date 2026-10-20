# 08 Polymorphic Obfuscator SDK — polymorphic-obfuscator

| 属性 | 值 |
| --- | --- |
| 编号 | 08 |
| 名称 | Polymorphic Obfuscator SDK |
| 类型 | 纯 JS 安全 SDK（单文件） |
| 等级 | 商业级 |
| 分类 | polymorphic-obfuscator |
| 入口 | `polymorphic-obfuscator-sdk.js` |
| 体积 | ≥ 3.4MB 有效代码（注释与空行剔除后） |

## 1. 作品定位

一个**黑洞式多态混淆器**：同一份明文程序每次构建都会得到结构不同、密钥不同、控制流
形状不同的变体，但语义完全一致。SDK 负责生成变体、加密字符串与操作码、压平控制流、
写入自校验和，并在运行期验证「所有变体解出同一明文」。它面向需要在分发侧做批量
变体与水印追踪的软件保护场景。

## 2. 架构与数据流

1. `VARIANT_SPECS` 描述 24 个静态变体的种子、解码器索引、密文槽位、压平顺序与校验盐。
2. 每个变体用独立 `LAYERS` 密钥把同一份 demo 明文加密成 `VARIANT_BANK` 中的密文；
   运行期用该变体的多态解码器解出明文，再**重新加密**比对密文，形成密封/解封回环。
3. `flattenFold` 用状态机（phase 0/1/2/3）实现「正向折叠 + 逆向折叠 + 长度混合」；
   `foldReference` 是同一算法的直线实现，两者结果必须相等 —— 这是控制流压平的语义证明。
4. `generateRuntimeVariants` 在运行时继续生成 16 个新变体（新密钥、新解码器槽位、
   新压平顺序），逐一验证，展示「生成即验证」的闭环。
5. `STRING_BANK` 存放加密字符串表，运行期解码后与 `STRING_EXPECT` 逐条比对。

## 3. 黑洞混淆

- 熵池 + 三层可逆变换 + 全池滚动摘要；12 种多态解码器共享同一语义。
- 逐变体校验和：`checksum = mix(seed, folded)`，任何变体被改写都会改变指纹。
- 字符串表：每条字符串用独立位置盐加密，只有解码器链正确时才还原。
- 不透明谓词死分支、初始化状态机、核心函数源码指纹复核。
- 反调试：计时漂移、栈形状、inspector getter、原生函数完整性、`prepareStackTrace` 检测。

## 4. 堡垒 JSVMP

字节码以滚动密钥逐条解密，操作码经置换映射到乱序 handler；常量池由加密熵池切片解出，
`LOADK` 指令按索引取值。自检对全量字节码做栈深度扫描、非法跳转检查、直方图与校验和统计，
并核对影子栈校验和与 `faults` 计数。内层 VM 执行独立加密的循环程序（6! = 720），
外层 `CALL` 完成 VM-in-VM 派发；汇编器另构造 1²+…+20² 循环程序验证跳转与局部变量。
初始化由压平状态机与死分支构成，变体生成器复用同一 VM 语义，保证「不同外壳、同一内核」。

## 5. 白盒与混合加密

- 白盒三套：WB-SPN（每轮 16 张 256 项表，隐式密钥）、WB-Feistel（32 位表驱动轮函数）、
  WB-ARX（表驱动替换 + 轮常量 + ARX 混合）。
- 自定义密码三套：12 轮 SPN（自选移位与 GF(2⁸) 矩阵）、16 轮 Feistel、8 轮 ARX 流密码。
- 自定义编码三套：乱序 Base64（块校验和）、8×8 位平面交织、Unicode PUA 字形映射。
- 混合管线按实例随机排列「白盒 → 自定义密码 → 编码」，对每个变体做密封/解封回环。

## 6. 渲染引擎级环境检测

采集 18 个渲染族共 100+ 探针：HTMLDDA（`typeof document.all`、假值、`.length`、
`item/namedItem`）、CSS.supports/选择器、WebGL vendor/renderer/扩展、Canvas 像素与
toDataURL、字体度量、iframe 跨域构造器、音频/媒体/权限、screen/DPR、matchMedia、
Intl/时区、DOM 构造器与布局、Worker、存储、引擎指纹、WebAssembly 命名空间与视口几何。
Node 下缺失的真实对象由仿真域补齐并标注 `emulated`；探针结果参与变体水印与设备指纹。

## 7. 快速开始

```bash
cd examples/mega/08-polymorphic-obfuscator-sdk
node polymorphic-obfuscator-sdk.js
```

## 8. 验证

```bash
node examples/mega/run-all.mjs --filter 08
```

要求：退出码 0、`MEGA SELFTEST OK`、`MEGA METRICS` 满足 whitebox≥3、customCiphers≥3、
encodings≥3、jsvmpOps≥1000、envChecks≥50、polymorphicVariants≥10、mixedRounds≥1、
documentAll=true、antiDebug≥1。

## 9. 防御建议

- 变体指纹与校验和放入服务端白名单，客户端只上报摘要。
- 分析侧可先静态定位 `VARIANT_BANK` 与解码器调度表，再动态比对解出明文的哈希。
- 不要依赖单一变体特征做检测；应按语义哈希聚类。
- 对混淆器输出做差分（同明文多构建）可快速定位不变量。

## 10. 说明

本作是防御向的软件保护/研究 SDK，不包含恶意载荷，不联网、不落地。所有多态与白盒构造
都是教学实现，用于展示「同一语义、多种外壳」的生成与验证方法。
