import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { FeishuClient } from '../feishu-client.mjs'

function mockFeishuServer() {
  const calls = { token: 0, messages: [], images: 0, files: 0 }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      calls.token += 1
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 't-123', expire: 7200 }))
      return
    }
    if (url.pathname === '/open-apis/im/v1/messages') {
      let body = ''
      for await (const chunk of req) body += chunk
      calls.messages.push({ receiveIdType: url.searchParams.get('receive_id_type'), body: JSON.parse(body) })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ code: 0, msg: 'ok', data: { message_id: 'om-abc' } }))
      return
    }
    if (url.pathname === '/open-apis/im/v1/images') {
      calls.images += 1
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ code: 0, msg: 'ok', data: { image_key: 'img-k1' } }))
      return
    }
    if (url.pathname === '/open-apis/im/v1/files') {
      calls.files += 1
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ code: 0, msg: 'ok', data: { file_key: 'file-k1' } }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ code: 404, msg: 'nf' }))
  })
  const out = { server, calls, port: null, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => { out.port = server.address().port; r(out.port) })) }
  return out
}

test('sendText posts to im/v1/messages with open_id type and bearer token', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  const result = await client.sendText({ kind: 'p2p', id: 'ou_123' }, 'hello 飞书')

  assert.equal(result.ok, true)
  assert.equal(result.messageId, 'om-abc')
  assert.equal(m.calls.token, 1)
  assert.equal(m.calls.messages.length, 1)
  assert.equal(m.calls.messages[0].receiveIdType, 'open_id')
  assert.equal(m.calls.messages[0].body.receive_id, 'ou_123')
  assert.equal(m.calls.messages[0].body.msg_type, 'text')
  assert.deepEqual(JSON.parse(m.calls.messages[0].body.content), { text: 'hello 飞书' })
})

test('group target uses chat_id type', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  await client.sendText({ kind: 'group', id: 'oc_grp' }, 'hi')
  assert.equal(m.calls.messages[0].receiveIdType, 'chat_id')
  assert.equal(m.calls.messages[0].body.receive_id, 'oc_grp')
})

test('long text is chunked at 1500 chars', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  const long = '行'.repeat(3200)
  await client.sendText({ kind: 'p2p', id: 'ou_123' }, long)
  assert.ok(m.calls.messages.length >= 3)
  assert.ok(m.calls.messages.every((x) => JSON.parse(x.body.content).text.length <= 1500))
})

// ── T4：splitText 已被 delivery-budget.planDelivery 取代（分片带 [i/N] 序号） ──

test('T4 分片：每条带 [i/N] 序号、连续完整，且**含序号**仍不超过 1500 字', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  const texts = Array.from({ length: 200 }, (_, i) => `${i} 告警行${'x'.repeat(20)}`).join('\n') // ≈4.5k 字
  const result = await client.sendText({ kind: 'p2p', id: 'ou_123' }, texts)

  const sent = m.calls.messages.map((x) => JSON.parse(x.body.content).text)
  assert.ok(sent.length > 1, '应当被分片')
  for (const [i, s] of sent.entries()) {
    assert.ok(s.startsWith(`[${i + 1}/${sent.length}]\n`), `第 ${i + 1} 条缺序号：${s.slice(0, 16)}`)
    assert.ok(s.length <= 1500, `第 ${i + 1} 条 ${s.length} 字超过单条上限`)
  }
  assert.equal(result.delivery.mode, 'chunked')
  assert.equal(result.delivery.parts, sent.length)
  assert.equal(result.delivery.dropped.chars, 0)
})

test('T4 单片：短文本不加 [1/1]，且 delivery.mode=single', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  const result = await client.sendText({ kind: 'p2p', id: 'ou_123' }, '短消息正文')
  assert.equal(m.calls.messages.length, 1)
  assert.equal(JSON.parse(m.calls.messages[0].body.content).text, '短消息正文')
  assert.equal(result.delivery.mode, 'single')
})

test('T4 降级：kind=report 超预算 ⇒ 单片摘要（带指针），不再分片刷屏', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  const big = Array.from({ length: 600 }, (_, i) => `| ${i} | 指标 |`).join('\n')
  const result = await client.sendText({ kind: 'p2p', id: 'ou_123' }, big, {
    kind: 'report',
    pointer: 'https://example.com/report',
  })
  assert.equal(m.calls.messages.length, 1, '摘要降级只发一条')
  const sent = JSON.parse(m.calls.messages[0].body.content).text
  assert.ok(sent.includes('…（其余见）https://example.com/report'), '省略标记必须同行带指针')
  assert.equal(result.delivery.mode, 'summary')
  assert.ok(result.delivery.dropped.chars > 0, '丢弃必须可数')
})

test('token is cached across sends', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  await client.sendText({ kind: 'p2p', id: 'ou_1' }, 'a')
  await client.sendText({ kind: 'p2p', id: 'ou_1' }, 'b')
  assert.equal(m.calls.token, 1)
})

test('sendMedia image uploads then posts image message with caption', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  const result = await client.sendMedia({ kind: 'p2p', id: 'ou_123' }, { kind: 'image', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), fileName: 'a.png', caption: '看这个' })
  assert.equal(result.ok, true)
  assert.equal(m.calls.images, 1)
  const imgMsg = m.calls.messages.find((x) => x.body.msg_type === 'image')
  assert.ok(imgMsg, 'image message posted')
  assert.deepEqual(JSON.parse(imgMsg.body.content), { image_key: 'img-k1' })
  const capMsg = m.calls.messages.find((x) => x.body.msg_type === 'text')
  assert.deepEqual(JSON.parse(capMsg.body.content), { text: '看这个' })
})

test('sendMedia text-only payload routes to sendText', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  await client.sendMedia({ kind: 'p2p', id: 'ou_123' }, { kind: 'text', content: 'plain' })
  assert.equal(m.calls.messages.length, 1)
  assert.equal(m.calls.messages[0].body.msg_type, 'text')
})

test('sendMedia file uploads then posts file message', async (t) => {
  const m = mockFeishuServer()
  await m.listen()
  t.after(() => m.server.close())

  const client = new FeishuClient({ appId: 'cli_x', appSecret: 's', apiBase: `http://127.0.0.1:${m.port}/open-apis` })
  const result = await client.sendMedia({ kind: 'p2p', id: 'ou_123' }, { kind: 'file', base64: Buffer.from('pdf-bytes').toString('base64'), fileName: 'report.pdf' })
  assert.equal(result.ok, true)
  assert.equal(m.calls.files, 1)
  const fileMsg = m.calls.messages.find((x) => x.body.msg_type === 'file')
  assert.deepEqual(JSON.parse(fileMsg.body.content), { file_key: 'file-k1' })
})
