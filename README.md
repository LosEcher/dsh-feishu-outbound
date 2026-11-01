# dsh-feishu-outbound

DSH **outbound 推送**插件：把 DSH 的 `de_channel_send` / `de_notify` 接到**飞书**。

复用飞书自建应用「零虾」（`cli_a912c950d9b8dcc7`，长连接已由 dsh-lark-channel 建立），
本插件只负责**主动推送**（DSH→飞书单向）：`globalThis.__dshChannelNotify.feishu` 注册，
`de_channel_send channels: feishu` 即可用。与 dsh-lark-channel（双向对话）互补不冲突。

## 契约

与 dsh-channel-wechat 同款（`__dshChannelNotify[channel]`）：

- `send(target, content, opts)` → `{ok, messageId?, error?}`；target = `{kind, id}`，
  kind ∈ `p2p|group`，id = 飞书 `open_id`（单聊）或 `chat_id`（群聊）。
- `sendMedia(target, media, opts)` → 文本/图片/文件推送。
- `recentChat()` → `{kind:'p2p', id}`（来自 defaultTo 配置）或 `null`。
- `status()` → 配置与 token 状态。

## 实现

- `feishu-client.mjs`：纯飞书 OpenAPI 客户端（无 DSH 依赖）：
  - `tenant_access_token`（POST /open-apis/auth/v3/tenant_access_token/internal，2h 缓存）
  - 文本：POST /open-apis/im/v1/messages?receive_id_type=open_id
  - 图片：POST /open-apis/im/v1/images 上传 → im/v1/messages msg_type=image
  - 文件：POST /open-apis/im/v1/files 上传 → im/v1/messages msg_type=file
- `index.mjs`：Cordis 插件本体，注册 `__dshChannelNotify.feishu`。
- `delivery-budget.mjs`：**投递预算**（纯函数，T4 2026-11-01）。文本怎么发由场景决定，
  不再一刀切切 1500：单片 / 带 `[i/N]` 序号的分片 / 摘要 / 截断，丢弃量可数
  （`dropped.chars`）。三条不变量：分片必须有序号、降级必须留可回溯指针、截断不许伪装成完整。
  设计依据 `dsfolder/FEISHU-DELIVERY-BUDGET-DESIGN-2026-11-01.md`。

## 投递预算（send 的 opts）

`send(target, content, { kind, pointer })` —— `opts` 会原样传给 `sendText`：

| kind | 谁用 | 超预算时 |
| --- | --- | --- |
| `alert`（**缺省**） | 门禁红 / 节点掉线 / 额度告警 | 先分片（≤4 片）；再多就**截断并显式承认**（完整性优先，不摘要） |
| `report` | 日报 / 盘点 | 分片 ≤2 片，再多降级为摘要 + 指针 |
| `gate` | 门禁结论 | 不分片，单片摘要 |
| `chat` | 对话式回复 | 不分片 |

`pointer` = 降级时的可回溯指针（链接 / 附件 key / 台账路径）。**不传就会在正文里写
「（未提供指针，属缺陷）」**，dsfolder 的 `feishu-copy-lint` 会把这种正文判红 —— 有意的：
降级要么给去处，要么让门禁看得见。

## 启用

1. 环境变量 `LARK_APP_ID` / `LARK_APP_SECRET`（或 patch 里 fallback 字面量）。
2. `cordis.patch.yml` insert 行 id=`feishu-outbound`（本 bundle 自带）。
3. 重启 dsh web，日志出现 `[dsh-feishu-outbound] outbound channel registered: feishu`。
4. 测试：`de_channel_send channels: feishu target: "p2p:ou_xxx" content: "hi"`。

## 测试

`npm test`（= `node --test test/*.test.mjs`）：`feishu-client.test.mjs` 用 mock OpenAPI server
验发送路径（含分片带序号、降级为摘要），`delivery-budget.test.mjs` 验纯函数与三条不变量。
