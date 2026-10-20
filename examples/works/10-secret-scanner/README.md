# 10 Secret Scanner SDK — secrets-detection

| 属性 | 值 |
| --- | --- |
| 编号 | 10 |
| 名称 | Secret Scanner SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | secrets-detection |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

密钥/凭据扫描 SDK：规则 + Shannon 熵、脱敏预览、行列定位、allowlist、可扩展规则与批量摘要。

## 2. 架构与数据流

1. 文本逐条规则匹配
2. 熵阈值过滤误报
3. 输出脱敏 finding
4. 生成修复/阻断建议

## 3. 核心能力

- 内置凭据规则
- 高熵检测
- 脱敏与定位
- allowlist
- 自定义规则
- 摘要统计

## 4. 快速开始

```bash
node examples/works/10-secret-scanner/verify.mjs
node examples/works/10-secret-scanner/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 在 CI/提交钩子中阻断
- 对测试 fixture 使用 allowlist
- 结合历史泄露情报

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
