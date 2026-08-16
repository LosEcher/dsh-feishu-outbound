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

## 启用

1. 环境变量 `LARK_APP_ID` / `LARK_APP_SECRET`（或 patch 里 fallback 字面量）。
2. `cordis.patch.yml` insert 行 id=`feishu-outbound`（本 bundle 自带）。
3. 重启 dsh web，日志出现 `[dsh-feishu-outbound] outbound channel registered: feishu`。
4. 测试：`de_channel_send channels: feishu target: "p2p:ou_xxx" content: "hi"`。

## 测试

`node --test test/feishu-client.test.mjs`（mock OpenAPI server）。
