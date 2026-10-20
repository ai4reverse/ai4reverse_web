# 21 DNS Beacon — dns-covert-channel

| 属性 | 值 |
| --- | --- |
| 编号 | 21 |
| 名称 | DNS Beacon |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | dns-covert-channel |
| 入口 | `sample.js` |
| 验证 | `node examples/works/run-all.mjs --filter 21` |

## 1. 作品定位

DNS 隐蔽信标：把主机信息切块编码进子域，通过图片/fetch 触发解析并带重试退避。

## 2. 完整攻击链

1. 采集主机信息并 Base64
2. 切块编码进子域
3. Image/fetch 触发递归解析
4. ACK 域名收尾并重试

## 3. 核心能力

- 子域编码
- 分块/编号
- DNS 触发
- 重试退避
- 本地状态

## 4. 快速开始

```bash
node tools/cli.js analyze examples/works/21-dns-beacon/sample.js
node tools/cli.js analyze examples/works/21-dns-beacon/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js restore examples/works/21-dns-beacon/sample.js   # 混淆类样本
```

## 5. 验证与预期结果

`run-all.mjs` 在严格沙箱中分析该样本并校验 `work.json.expect`：判定等级、最低分、IOC 类别、artifact、技术标签、trace 类型与完整性/句柄释放。预期：`suspicious`，score ≥ 30。

## 6. 生产集成 / 防御建议

- 超长子域/高频解析检测
- DNS 防火墙与随机域告警
- 限制页面图片/DNS 预取

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
