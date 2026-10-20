# 33 ADREDIR — malvertising

| 属性 | 值 |
| --- | --- |
| 编号 | 33 |
| 代号 | ADREDIR |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | malvertising |
| 类别 | malvertising |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

恶意广告重定向：广告素材内嵌脚本，检测点击/曝光后跳转到漏洞利用页，并用多层中转隐藏来源。

## 2. 完整攻击链

1. 广告位加载并测量曝光
2. 检测用户手势
3. 通过多层中转域名重定向
4. 记录点击与跳转结果
5. 失败回退到良性广告

## 3. 关键能力与实现

- 曝光/点击检测
- 多级重定向
- 来源隐藏
- 失败回退
- 统计回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/33-malvertising-redirect/sample.js
node tools/cli.js analyze examples/products/33-malvertising-redirect/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/33-malvertising-redirect/sample.js --events | head -40
node tools/cli.js restore examples/products/33-malvertising-redirect/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：点击检测、多层 location、fetch、定时器
- **技术标签**：network-communication、dom-injection

## 6. 检测与处置建议

- 广告素材沙箱与域名信誉
- 监控多级重定向
- 限制广告 iframe 能力

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
