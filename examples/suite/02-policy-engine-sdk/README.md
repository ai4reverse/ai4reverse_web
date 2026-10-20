# 02 Policy Engine SDK — policy-engine

| 属性 | 值 |
| --- | --- |
| 编号 | 02 |
| 名称 | Policy Engine SDK |
| 类型 | JS 安全 SDK |
| 等级 | 商业级 |
| 分类 | policy-engine |
| 入口 | `src/index.js` |
| 验证 | `node verify.mjs` |

## 1. 作品定位

面向后端服务与网关的声明式授权引擎。策略以纯 JSON 描述“谁（RBAC 角色/主体）在什么属性条件下（ABAC）可以对什么资源执行什么动作”，引擎按拒绝优先（deny-overrides）与优先级给出确定决策，并输出完整解释轨迹，便于审计、回归测试与合规取证。策略中不含可执行代码，条件 DSL 封闭且可校验，避免策略注入与 ReDoS 隐患。

## 2. 架构与数据流

1. `validatePolicy()` 对策略做结构与语义校验，返回全部错误（重复 id、非法 effect、未知算子、非法正则、缺失取值等）。
2. `PolicyEngine` 规范化规则：补齐 `priority`，按“优先级降序 + id 升序”稳定排序。
3. 收到请求后规范化主体：字符串 id 或 `{id, roles, attributes}`，沿 `roleGraph` 展开继承角色。
4. 构造属性作用域 `subject` / `resource` / `action` / `context`，逐规则匹配主体选择器、动作 glob、资源 glob 与全部条件。
5. 命中规则中若存在 deny，则拒绝并取最高优先级 deny；否则取最高优先级 allow；无命中时落回 `defaultEffect`（默认 deny）。
6. 返回 `{decision, reason, matchedRule, evaluated, roles, trace[]}`，trace 中记录每条规则的匹配结果与条件实际值。

## 3. 核心能力

- RBAC 角色继承（`admin -> editor -> viewer`），环安全且展开结果排序稳定
- 主体选择器：`*`、`role:<name>`、`user:<glob>`、裸 id/角色名
- 资源与动作 `*` 通配 glob，资源对象支持 `type:id` 双形态匹配
- 条件 DSL：`eq/neq/in/nin/lt/lte/gt/gte/contains/startsWith/endsWith/regex/exists`
- 拒绝优先，且不影响解释轨迹的确定性
- 条件缺失属性返回 `actual: null, ok: false`，不抛异常
- 策略校验返回稳定错误码，构造期即失败
- `toJSON()/fromJSON()` 可持久化，序列化后评估结果完全一致

## 4. 快速开始

```bash
node examples/suite/02-policy-engine-sdk/verify.mjs
node examples/suite/02-policy-engine-sdk/demo.mjs   # 可选
```

```js
import { createPolicyEngine } from './src/index.js'

const engine = createPolicyEngine({
  defaultEffect: 'deny',
  roleGraph: { admin: ['editor'], editor: ['viewer'] },
  rules: [
    { id: 'deny-suspended', effect: 'deny', priority: 100, subjects: ['*'], actions: ['*'], resources: ['*'],
      conditions: [{ attribute: 'subject.status', op: 'eq', value: 'suspended' }] },
    { id: 'admin-write', effect: 'allow', priority: 10, subjects: ['role:admin'], actions: ['write'], resources: ['doc:*'] },
  ],
})

const decision = engine.explain({ subject: { id: 'alice', roles: ['admin'] }, action: 'write', resource: 'doc:runbook' })
console.log(decision.decision, decision.matchedRule, decision.trace)
```

## 5. 验证与预期结果

`verify.mjs` 使用 `node:assert/strict` 覆盖 12 组断言：合法策略校验、全量错误码、角色继承、拒绝优先、ABAC 金额/网段条件、缺失属性、资源 glob、乱序规则确定性、解释轨迹、算子矩阵、默认效果、序列化往返。预期输出 `checks: 12/12`，`run-all.mjs` 要求 100% 通过且检查数 ≥ 5。

## 6. 生产集成 / 防御建议

- 策略文件纳入版本控制与代码评审，线上加载前必须调用 `validatePolicy()`；校验失败拒绝启动。
- `regex` 条件限制长度（<=512）且使用 `u` 标志；高基数用户输入不要直接拼入正则。
- 角色图由 IAM 系统单一来源生成，避免同名角色跨租户复用；主体属性须由可信身份提供方签名后注入。
- 决策日志记录 `matchedRule` 与条件实际值，便于审计；不要记录敏感属性原文。
- 对策略评估做属性级缓存时，缓存键必须包含策略哈希与请求作用域，防止越权复用。
- 网关层建议默认拒绝（`defaultEffect: 'deny'`），并保留“只记录不拦截”的影子模式做灰度。

## 7. 说明

本作品为合成、可离线运行的商业级示例：策略与主体均为虚构数据，不连接真实 IAM、数据库或网络。SDK 可直接在 Node.js 24 中运行并用于集成参考。
