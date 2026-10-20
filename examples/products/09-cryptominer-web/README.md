# 09 HASHMINE — cryptominer

| 属性 | 值 |
| --- | --- |
| 编号 | 09 |
| 代号 | HASHMINE |
| 等级 | 商业级 |
| 严重度 | HIGH |
| 行业 | cryptojacking |
| 类别 | cryptominer |
| 平台 | 浏览器 JavaScript |
| 样本 | `sample.js` |
| 预期判定 | `malicious`（score ≥ 55） |

## 1. 产品定位

浏览器挖矿产品：加载 WASM 挖矿内核，创建 Worker 线程，按 CPU 占用动态调优，通过矿池协议上报份额。

## 2. 完整攻击链

1. 检测 WebAssembly/Worker 能力
2. 拉取挖矿内核并初始化矿池连接
3. 启动 Worker 执行哈希循环
4. 根据页面可见性/CPU 调优线程与节流
5. 定时上报份额与心跳

## 3. 关键能力与实现

- WASM 加载
- Worker 线程
- 矿池通信
- 可见性/节流对抗
- 本地配置持久化

## 4. 分析指令

```bash
node tools/cli.js analyze examples/products/09-cryptominer-web/sample.js
node tools/cli.js analyze examples/products/09-cryptominer-web/sample.js --json | jq '.verdict, .static.iocs, .artifacts'
node tools/cli.js run examples/products/09-cryptominer-web/sample.js --events | head -40
node tools/cli.js restore examples/products/09-cryptominer-web/sample.js   # 混淆类样本
```

## 5. 预期取证结果

- **判定**：`malicious`，score ≥ 55
- **IOC 类别**：urls
- **Artifact**：eval-payload
- **关键行为**：eval 引导、fetch 内核、Worker 创建、矿池 POST、定时器
- **技术标签**：dynamic-code-execution、worker-thread

## 6. 检测与处置建议

- 监控高 CPU 的 Worker 与矿池域名
- 对 WebAssembly 实例化与 Worker 创建做策略限制
- 检测页面空闲时的持续 CPU 使用

## 7. 说明

本样本为合成演练样本（synthetic），所有域名使用 `.test` 保留域，网络请求在沙箱内被完全 mock，不包含可用 C2、真实凭据或破坏性宿主操作。仅用于验证检测、取证、还原与溯源能力。
