# 15 Session Hijacker — session-theft

| 属性 | 值 |
| --- | --- |
| 编号 | 15 |
| 名称 | Session Hijacker |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | session-theft |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 15` |

## 1. 作品定位

会话劫持器：收集 Cookie/Storage 令牌，使用窃取的 Bearer 发起请求并回传会话材料。

## 2. 完整攻击链

1. 读取 document.cookie
2. 枚举 localStorage/sessionStorage 令牌
3. 携带 Bearer 请求验证
4. 回传会话材料

## 3. 核心能力

- Cookie 读取
- Storage 令牌枚举
- Bearer 重放
- 会话外传
- 本地缓存

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/15-session-hijacker/sample.js
node tools/cli.js analyze examples/works/15-session-hijacker/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/15-session-hijacker/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`malicious`，score ≥ 45。

## 6. 生产集成 / 防御建议

- HttpOnly/SameSite 与短 TTL
- 监控异常 Bearer 使用
- 令牌绑定设备/指纹

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
