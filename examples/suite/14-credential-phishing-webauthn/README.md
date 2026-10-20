# 14 WebAuthn Credential Phishing — credential-phishing-webauthn

| 属性 | 值 |
| --- | --- |
| 编号 | 14 |
| 名称 | WebAuthn Credential Phishing |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | credential-phishing |
| 入口 | `sample.js` |
| 验证 | `node examples/suite/run-all.mjs --filter 14` |

## 1. 作品定位

模拟针对 Passkey/WebAuthn 的凭据钓鱼套件：渲染克隆的 passkey 提示，劫持 `navigator.credentials.get/create`，把 challenge、rpId、allowCredentials、user 等材料转发到中继端，并在认证器返回空时合成凭据材料；同时提供密码回退表单与紧迫倒计时。样本不使用真实凭据，所有端点位于 `example.net`。

## 2. 完整攻击链

1. 生成 6 字节十六进制钓鱼会话 ID，写入 `wa_phish` Cookie。
2. 安装凭据钩子：保存原生 `navigator.credentials.get/create`，替换为记录型包装。
3. `get` 包装：Base64 编码 challenge、rpId、timeout、allowCredentials，先外传 `get.options`。
4. 调用原生 `get`；返回凭据则外传凭据 ID，返回 `null` 则合成 `clientDataJSON`/`authenticatorData`/`signature` 并外传 `get.synthetic`。
5. `create` 包装：外传 user/算法参数，原生返回 `null` 时伪造注册结果。
6. 渲染克隆 UI：标题、账号/密码输入框、"Use passkey" 按钮；按钮点击触发真实的 `credentials.get`。
7. 安装 `keydown` 记录器与密码回退捕获，将表单值做长度统计与 Base64 编码后外传。
8. 通过 `fetch` 与 `sendBeacon` 双通道提交到 `phish-relay.example.net/wa/collect`。
9. 400ms 倒计时两轮，制造"会话即将过期"的紧迫感。

## 3. 核心能力

- 伪造 passkey UI：克隆品牌化提示与账号表单。
- 凭据 API 劫持：运行期替换 `get/create` 且代理原生行为。
- challenge/凭据转发：完整提取 WebAuthn 选项与返回材料。
- 合成凭据材料：认证器无响应时伪造断言/注册数据，维持钓鱼闭环。
- 密码回退采集：保留传统口令通道。
- 会话标记与倒计时：Cookie/Storage 标记 + 紧迫 UI。
- 双通道外传：POST 与 `sendBeacon` 冗余投递。

## 4. 快速开始

```bash
node tools/cli.js analyze examples/suite/14-credential-phishing-webauthn/sample.js
node tools/cli.js analyze examples/suite/14-credential-phishing-webauthn/sample.js --json | jq '.verdict, .artifacts'
node examples/suite/run-all.mjs --filter 14
```

## 5. 预期取证结果（验证与预期结果）

严格沙箱运行后，`run-all.mjs` 校验 `work.json.expect`，实际观测：

- 判定：`suspicious`，score 48（≥ 42）。
- IOC：`urls` 2 条（`phish-relay.example.net`、`login.example.net`）；`domains` 12 条；`emails` 2 条（表单占位与合成用户）。
- Artifact：`decoded-string`（中继地址 Base64；合成 clientDataJSON/签名材料）。
- 技术标签：`dom-injection`、`network-communication`、`web-storage`、`keylogging`、`encoded-string-decoding`、`cryptography`。
- Trace：`net` 9、`dom` 3、`storage` 3、`timer` 2；控制台可见 `credential hooks get=true create=true`、`password fallback captured`、`urgency countdown 2/2`。
- 关键状态：`wa:phish:session`、`wa:phish:last` 与 `wa_phish` Cookie。

## 6. 检测与处置建议

- 检测页面是否改写 `navigator.credentials.get/create`（描述符与原生文本比对）。
- 对同时请求 passkey 与密码回退的页面提高风险评分。
- 校验 rpId 与当前 origin 一致，拒绝跨域 challenge 转发。
- 事件响应时吊销受影响凭据、清理 `wa:phish:*` 状态并通知用户重新注册 passkey。

## 7. 说明

本作品为合成、可离线运行的商业级示例：认证器返回空结果，合成材料仅用于验证检测与取证链路，不包含真实凭据。所有域名均为保留示例域。
