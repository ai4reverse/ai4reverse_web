# 22 JSVMP Ransomware Stage — ransomware

| 属性 | 值 |
| --- | --- |
| 编号 | 22 |
| 名称 | JSVMP Ransomware Stage |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | ransomware |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 22` |

## 1. 作品定位

JSVMP 保护的勒索阶段：虚拟字节码驱动执行，WebCrypto 加密本地数据、生成勒索信并回传密钥材料。

## 2. 完整攻击链

1. 启动混淆 VM 执行字节码
2. 派生密钥并加密本地数据
3. 回传密钥/密文摘要
4. 渲染勒索信与倒计时

## 3. 核心能力

- JSVMP 解释器
- AES-GCM 加密
- 勒索信 UI
- 密钥外传
- 反静态分析

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/22-ransomware-jsvmp/sample.js
node tools/cli.js analyze examples/works/22-ransomware-jsvmp/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/22-ransomware-jsvmp/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 45。

## 6. 生产集成 / 防御建议

- JSVMP trace 还原虚拟程序
- 监控批量 WebCrypto 加密
- 备份与离线恢复

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。

## 8. 生成与 JSVMP 分析

本样本由平台 `tools/jsvmp` builder 生成（obfuscated opcode cipher + 编码常量池）：

```bash
node examples/works/build-ransomware-jsvmp.mjs
node examples/works/run-all.mjs --filter 22
```

`run-all.mjs` 根据 `expect.requireVm` 启用 `instrumentation: { jsvmp: true }`，预期 `tracing.jsvmp.detected=true` 并产生数百条 `jsvmp:opcode` 事件。
