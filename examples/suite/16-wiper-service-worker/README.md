# 16 Wiper Service Worker — wiper-service-worker

| 属性 | 值 |
| --- | --- |
| 编号 | 16 |
| 名称 | Wiper Service Worker |
| 类型 | 病毒样本 |
| 等级 | 商业级 |
| 分类 | wiper |
| 入口 | `sample.js` |
| 验证 | `node examples/suite/run-all.mjs --filter 16` |

## 1. 作品定位

模拟 Service Worker 擦除器：注册破坏性 worker，投毒并删除 Cache Storage，删除 IndexedDB 库，清空 local/session Storage 与 Cookie，销毁 DOM 并布置卸载阻断；最后替换 `JSON.stringify` 掩盖本地遥测。所有破坏操作落在沙箱 stub 上，不触碰宿主磁盘，端点位于 `example.net`。

## 2. 完整攻击链

1. Base64 解码擦除配置：缓存名、数据库名、Cookie 名、存储前缀、worker 脚本与回执端点。
2. 擦除前外传目标清单与 UA 到 `wiper.example.net/ack`（POST + `sendBeacon`）。
3. 对每个缓存名执行 `caches.open` → `put('/index.html', ...)` → `add('/wipe.js')` → `caches.delete`，完成投毒后删除。
4. 对每个数据库调用 `indexedDB.deleteDatabase`，挂接 `onsuccess/onerror` 记录结果。
5. 写入 `wipe:marker` 后 `localStorage.clear()`、`sessionStorage.clear()`，并按前缀 `removeItem` 补刀。
6. 将配置中的 Cookie 逐个置为 1970 年过期，并写入 `wipe=1` 标记。
7. DOM 销毁：清空 `document.title`，循环 `removeChild` 清空 body，插入擦除横幅，`document.write` 覆写页面。
8. 注册 `/sw-wipe.js`（scope `/`），等待 `navigator.serviceWorker.ready` 并读取 `active.state`，同时列举既有注册。
9. 卸载阻断：`beforeunload` 监听 + `window.onbeforeunload` + `history.pushState` 污染。
10. 替换 `JSON.stringify`：对带 `__wipe` 标记的对象返回 `{}`，掩盖遥测；随后 300ms 心跳两轮。

## 3. 核心能力

- Service Worker 注册：注册 + `ready` + `active` 状态确认，形成持久驻留面。
- 缓存投毒与清除：向 Cache Storage 写入恶意响应后删除缓存。
- IndexedDB 删除：遍历配置中的数据库名并记录失败原因。
- 存储与 Cookie 清空：local/session Storage + Cookie 过期三路擦除。
- DOM 销毁：标题、body 子树与 `document.write` 覆写。
- 卸载阻断：`beforeunload` 双通道 + 历史污染。
- 内建对象篡改：替换 `JSON.stringify` 掩盖证据，触发沙箱完整性漂移。

## 4. 快速开始

```bash
node tools/cli.js analyze examples/suite/16-wiper-service-worker/sample.js
node tools/cli.js analyze examples/suite/16-wiper-service-worker/sample.js --json | jq '.verdict, .integrity, .artifacts'
node examples/suite/run-all.mjs --filter 16
```

## 5. 预期取证结果（验证与预期结果）

严格沙箱运行后，`run-all.mjs` 校验 `work.json.expect`，实际观测：

- 判定：`suspicious`，score 46（≥ 42）。
- IOC：`urls` 1 条（`wiper.example.net/ack`）；`domains` 2 条；Base64 2 条（配置 blob 与回执载荷）。
- Artifact：`embedded-blob`（408 字符配置 blob）、`decoded-string`（配置 JSON）。
- 技术标签：`service-worker`、`web-storage`、`cookie-access`、`network-communication`、`dom-injection`、`encoded-string-decoding`。
- Trace：`net` 1、`storage` 14、`dom` 3、`timer` 2；控制台可见 `cache poisoned and dropped shell-v3`、`worker active state=activated`、`telemetry serializer replaced`。
- 完整性：`JSON.stringify` 被替换导致 `integrity.intact=false`，因此 `work.json` 声明 `allowIntegrityDrift: true`（与真实擦除器的反取证行为一致）。

## 6. 检测与处置建议

- 监控非业务页面的 Service Worker 注册、`caches.delete` 与 `indexedDB.deleteDatabase` 组合。
- 检测 `document.write` 覆写、`beforeunload` 阻断与历史污染同时出现。
- 对 `JSON.stringify`/`Array.prototype` 等内建对象篡改做完整性告警。
- 处置时注销恶意 Service Worker、清空站点数据、从备份恢复，并复核持久化注册来源。

## 7. 说明

本作品为合成、可离线运行的商业级示例：Cache/IndexedDB/Storage 均为沙箱 stub，不包含真实数据破坏；所有域名均为保留示例域。完整性漂移是本样本刻意展示的反取证能力，而非平台缺陷。
