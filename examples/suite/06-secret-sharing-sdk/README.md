# 06 Shamir Secret Sharing SDK — key-management

| 属性 | 值 |
| --- | --- |
| 编号 | 06 |
| 名称 | Shamir Secret Sharing SDK |
| 类型 | JS 安全 SDK |
| 等级 | 军工级 |
| 分类 | key-management |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

面向密钥托管、灾备恢复与多签审批的 Shamir 门限秘密共享 SDK。秘密按字节拆分为 n 个分片，
任意 k 个分片可重构，少于 k 个不泄露任何信息；同时提供 SHA-256 承诺、分片校验和与损坏分片定位，
用于对抗分片损坏、分片来源混用和运维误操作。实现只依赖 Node.js 内置 `node:crypto`，无第三方依赖。

## 2. 架构与数据流

1. 调用方提供秘密字节（密钥/口令/恢复码）与 k、n。
2. 每个秘密字节生成一个 k-1 次随机多项式，常数项为该字节。
3. 在 GF(256) 上对 x = 1..n 求值，得到分片 `{index, y, fingerprint}`。
4. 计算 SHA-256 承诺并写入 `sss1.k.n.commitment.share...` 信封。
5. 重构时按分片 x 坐标做 Lagrange 插值（x=0），再用承诺校验结果。
6. 序列化分片在解析阶段校验校验和与索引范围，损坏分片直接拒绝。

## 3. 核心能力

- GF(256) 域运算：AES 多项式 `x^8+x^4+x^3+x+1` 上的乘、幂、逆、除。
- k-of-n 拆分与任意子集重构；重复分片、索引越界、长度不一致显式报错。
- SHA-256 承诺绑定：混用不同批次分片时返回 `COMMITMENT_MISMATCH`。
- 分片校验和：序列化阶段检测字节损坏（`BAD_SHARE_CHECKSUM`）。
- `findInvalidShares`：n ≤ 12 时穷举 k 子集，定位无法参与一致重构的分片。
- `sss1` 可移植信封：base64url 编码，便于跨系统传输与审计。

## 4. 快速开始

```bash
node examples/suite/06-secret-sharing-sdk/verify.mjs
```

```js
import { splitSecret, combineShares, serializeShares } from './src/index.js'

const envelope = splitSecret('recovery-key', { threshold: 3, shares: 5 })
const secret = combineShares(envelope.shares.slice(0, 3), { commitment: envelope.commitment })
const portable = serializeShares(envelope) // 交给 5 位持有人分别保管
```

## 5. 验证与预期结果

`verify.mjs` 共 11 项检查，覆盖 GF(256) 已知向量、确定性 2-of-2 向量、3-of-5 全部 10 种组合、
门限不足、重复/畸形分片、跨批次混用、序列化往返、校验和损坏、损坏分片定位、随机性与参数校验。
输出 `checks: 11/11`，退出码 0；`run-all.mjs` 要求检查数 ≥ 5 且全部通过。

## 6. 生产集成 / 防御建议

- 分片应由不同主体、不同介质、不同地理位置分别保管，避免单点同时失守。
- 承诺值应通过独立可信通道公布或写入审计日志，防止分片集合被整体替换。
- 重构应在受控进程内完成，重构后的秘密及时清零并限制导出。
- 分片传输使用认证加密；不要将 n 个分片放在同一配置文件中。
- 定期演练恢复流程，验证 k 个分片可用且承诺一致。

## 7. 说明

本作品为合成、可离线运行的军工级示例，不包含真实密钥、凭据或网络访问；所有随机性与测试向量均在本地生成，
仅用于门限共享方案的教学、集成参考与验收测试。
