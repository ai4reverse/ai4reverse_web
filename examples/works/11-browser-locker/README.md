# 11 Browser Locker — browser-locker

| 属性 | 值 |
| --- | --- |
| 编号 | 11 |
| 名称 | Browser Locker |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | browser-locker |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 11` |

## 1. 作品定位

全屏勒索锁定页面：覆盖 DOM、阻止卸载、污染历史、循环弹窗并回传受害者环境。

## 2. 完整攻击链

1. eval 解密覆盖层模块
2. 覆盖页面并注册 beforeunload
3. pushState 污染历史
4. 定时弹窗施压
5. 回传环境并写入 localStorage

## 3. 核心能力

- 全屏覆盖
- 卸载/历史阻断
- 循环弹窗
- C2 回传
- 本地标记

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/11-browser-locker/sample.js
node tools/cli.js analyze examples/works/11-browser-locker/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/11-browser-locker/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 40。

## 6. 生产集成 / 防御建议

- 浏览器策略限制弹窗/卸载
- 快速结束进程并清理站点数据
- 检测全屏覆盖与锁定话术

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
