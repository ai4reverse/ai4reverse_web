# 03 Device Fingerprint SDK — device-identity

| 属性 | 值 |
| --- | --- |
| 编号 | 03 |
| 名称 | Device Fingerprint SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | device-identity |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

稳定、可解释的设备指纹 SDK：可注入探针、加权相似度、稳定 ID（忽略视口等易变项）、质量评分与租户命名空间。

## 2. 架构与数据流

1. 采集平台/UA/硬件/时区/WebGL 等组件
2. 归一化并逐项哈希
3. 稳定组件生成设备 ID，易变组件仅参与相似度
4. 跨会话比较/聚类

## 3. 核心能力

- 可注入探针
- 稳定 ID 生成
- 加权相似度/同设备判定
- 质量评分
- 租户 salt 隔离

## 4. 快速开始

```bash
node examples/works/03-device-fingerprint/verify.mjs
node examples/works/03-device-fingerprint/demo.mjs   # 可选
```

## 5. 验证与预期结果

`verify.mjs` 使用 Node.js assert 逐项验证 API 行为，输出 `checks: N/N`；`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 避免采集高敏感字段
- 租户 salt 防止跨站关联
- 对质量过低的结果降级处理

## 7. 说明

本作品为合成、可离线运行的商业级示例：不包含真实凭据、可用 C2 或破坏性宿主操作。病毒样本仅用于在沙箱内验证检测、取证与还原能力；SDK/应用可直接在 Node.js 中运行并用于集成参考。
