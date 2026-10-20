# 12 NAMESIFT — dns-tunneling

| 属性 | 值 |
| --- | --- |
| 编号 | 12 |
| 代号 | NAMESIFT |
| 等级 | 军工级 |
| 严重度 | CRITICAL |
| 行业 | defense |
| 类别 | dns-tunneling |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `suspicious`（score ≥ 40） |

## 1. 产品定位

DNS 隧道外传：把采集数据切片编码进子域名，通过 DNS/图片请求逐段渗出；包含分块、序号与 ACK 逻辑。

## 2. 完整攻击链

1. 采集主机与页面数据并序列化
2. Base64 分块并编码为合法子域标签
3. 逐块请求 *.dns.example.test 触发解析
4. 记录序号并在失败时重试
5. 用最终 ACK 域名关闭会话

## 3. 关键能力与实现

- DNS 隐蔽信道
- 分块编码
- 重试/ACK
- 低带宽外传
- 失败降级

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/12-dns-tunnel/sample.js
node tools/cli.js analyze examples/products/12-dns-tunnel/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/12-dns-tunnel/sample.js --events | head -40
node tools/cli.js restore examples/products/12-dns-tunnel/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`suspicious`，score ≥ 40
- **IOC 类别**：domains、urls
- **Artifact**：decoded-string
- **关键行为**：分块 Base64、Image/fetch DNS 请求、localStorage
- **技术标签**：network-communication

## 6. 检测与处置建议

- 监控超长子域与高频 DNS 解析
- 对非常规 TLD/随机标签做告警
- 限制页面内 DNS 预取与图片请求

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
