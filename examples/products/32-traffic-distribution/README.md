# 32 TDSROUTE — traffic-distribution

| 属性 | 值 |
| --- | --- |
| 编号 | 32 |
| 代号 | TDSROUTE |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | malvertising |
| 类别 | traffic-distribution |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 30） |

## 1. 产品定位

流量分发系统：根据 UA/语言/时区/来源对访问者分流，合格目标重定向到漏洞页或诈骗页，其余跳转到良性页。

## 2. 完整攻击链

1. 采集 UA/语言/时区/来源
2. 命中过滤规则的目标画像
3. 按画像选择落地页
4. 通过 location/replace 重定向
5. 记录分流结果

## 3. 关键能力与实现

- 目标画像
- 规则分流
- 条件重定向
- 来源过滤
- 统计回传

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/32-traffic-distribution/sample.js
node tools/cli.js analyze examples/products/32-traffic-distribution/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/32-traffic-distribution/sample.js --events | head -40
node tools/cli.js restore examples/products/32-traffic-distribution/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 30
- **IOC 类别**：urls
- **Artifact**：decoded-string
- **关键行为**：画像采集、规则判断、location 重定向、fetch
- **技术标签**：network-communication、dom-injection

## 6. 检测与处置建议

- 监控异常重定向链
- 对落地页做信誉与沙箱检测
- 限制第三方跳转

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
