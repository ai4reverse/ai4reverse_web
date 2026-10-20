# 09 DRM Whitebox SDK — drm-whitebox

| 属性 | 值 |
| --- | --- |
| 编号 | 09 |
| 名称 | DRM Whitebox SDK |
| 类型 | 纯 JS 安全 SDK（单文件） |
| 等级 | 商业级 |
| 分类 | drm-whitebox |
| 入口 | `drm-whitebox-sdk.js` |
| 体积 | ≥ 3.4MB 有效代码（注释与空行剔除后） |

## 1. 作品定位

面向授权内容分发的 **DRM + 水印 + 设备绑定 SDK**：把许可证号以扩频方式写入载体数据的
最低有效位，用白盒/自定义密码封装内容密钥，并把许可证绑定到渲染引擎级设备指纹。
换设备、改令牌、动载体都会导致验证失败。

## 2. 架构与数据流

1. `drmFingerprint` 把 100+ 渲染探针的族权重、状态与细节长度折叠成 32 字节设备指纹。
2. 许可证 = 许可证号 + 载荷 + 被混合管线密封的内容密钥 + 设备绑定摘要 + 载体完整性
   摘要 + 载体偏移；整体序列化后再用乱序 Base64（逐块校验和）编码成令牌。
3. 签发时从大载体库切出 2048 字节，用基于偏移的密钥做**扩频 LSB 水印**
   （位置由种子置换决定），写入内存内容库。
4. 验证时重算设备绑定 → 校验载体完整性摘要 → 从水印提取载荷 → 解封内容密钥；
   任一不符即拒绝并给出原因（device-binding-mismatch / carrier-tampered /
   watermark-mismatch / token-decode）。
5. 自检覆盖：正确许可证、错误设备、篡改令牌、篡改载体、未水印载体、6 组水印档位。

## 3. 黑洞混淆

- 熵池三层逆变换 + 分块滚动摘要；初始化状态机压平；不透明谓词死分支。
- 12 种多态解码器一致性校验；核心函数源码指纹在自检前后比对。
- 反调试：计时漂移、栈形状、inspector getter、原生函数完整性、`prepareStackTrace`。

## 4. 堡垒 JSVMP

滚动密钥加密的十万级字节码，置换映射乱序 handler；常量池由加密熵池切片解出，
`LOADK` 指令按索引取值；全量栈深度扫描 + 直方图 + 校验和 + 影子栈校验。
内层 VM 执行加密阶乘程序，外层 `CALL` 触发 VM-in-VM；汇编器构造平方和循环验证跳转。
初始化由压平状态机与死分支构成，VM 语义同时用于派生许可证内容密钥的种子材料。

## 5. 白盒与混合加密

- 白盒三套（WB-SPN / WB-Feistel / WB-ARX），隐式密钥藏在表材料中。
- 自定义密码三套（12 轮 SPN、16 轮 Feistel、8 轮 ARX 流密码）。
- 自定义编码三套（乱序 Base64、位平面交织、Unicode PUA 映射）。
- 许可证密钥封装走随机排序的「白盒 → 自定义密码 → 编码」混合管线；
  两条不同顺序的管线在自检中分别签发/验证。

## 6. 渲染引擎级环境检测

设备指纹来源覆盖：HTMLDDA（`typeof document.all === 'undefined'`、布尔假值、
`.length`、`item()`）、CSS.supports 与选择器、WebGL vendor/renderer/扩展、
Canvas 像素回读与 toDataURL、字体度量、iframe 跨域构造器、音频/媒体/权限、
screen/DPR/方向、matchMedia、Intl/时区、DOM 构造器与布局、Worker、存储、
引擎指纹（UA/webdriver/plugins/cores）、WebAssembly 命名空间、视口几何。
Node 下不存在的对象由仿真域提供，状态标注 `emulated`，不会虚报真实浏览器。

## 7. 快速开始

```bash
cd examples/mega/09-drm-whitebox-sdk
node drm-whitebox-sdk.js
```

## 8. 验证

```bash
node examples/mega/run-all.mjs --filter 09
```

输出包含许可证批量签发/验证结果、设备指纹前缀、管线顺序、篡改原因、水印位数，
并以 `MEGA SELFTEST OK` 与 `MEGA METRICS` 收尾。

## 9. 防御建议

- 内容密钥只在白盒/混合管线上解封，明文密钥不落内存日志。
- 水印载荷加入签发时间/会话随机数，支持泄漏源追踪。
- 设备指纹应定期重采并与服务端风控联合判定，避免单点伪造。
- 对令牌与载体分别做完整性校验，缺一不可。

## 10. 说明

本作是防御向 DRM/水印 SDK，仅使用合成的载体数据与许可证号，不包含真实版权内容，
不联网、不落地。白盒与自定义密码为教学实现，生产环境应使用经过认证的密码库。
