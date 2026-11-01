import test from 'node:test'
import assert from 'node:assert/strict'
import { planDelivery, chunkText, withOrdinals, chunkWithOrdinals, summarize, LIMITS } from '../delivery-budget.mjs'

const mk = (chars, word = '行') => Array.from({ length: Math.ceil(chars / 20) }, (_, i) => `${i} ${word}${'x'.repeat(18)}`).join('\n')

test('短文本单片直发，不丢字', () => {
  const r = planDelivery({ text: '短消息', kind: 'alert' })
  assert.equal(r.mode, 'single')
  assert.equal(r.dropped.chars, 0)
})

test('告警：超过单片但在分片上限内 ⇒ 分片且**每片带序号**（V1）', () => {
  const r = planDelivery({ text: mk(3000), kind: 'alert' })
  assert.equal(r.mode, 'chunked')
  assert.ok(r.parts.length > 1 && r.parts.length <= LIMITS.maxChunks.alert)
  for (const [i, p] of r.parts.entries()) assert.ok(p.startsWith(`[${i + 1}/${r.parts.length}]`), p.slice(0, 20))
  assert.equal(r.dropped.chars, 0)
})

test('日报：超过 2 片 ⇒ 降级摘要，且摘要必须带可回溯指针（V2）', () => {
  const r = planDelivery({ text: mk(12000), kind: 'report', pointer: 'https://example.com/report' })
  assert.equal(r.mode, 'summary')
  assert.equal(r.parts.length, 1)
  assert.ok(r.parts[0].includes('https://example.com/report'), '摘要里必须有指针')
  assert.ok(r.dropped.chars > 0, '丢弃必须可数')
  assert.match(r.reason, /over-budget/)
})

test('负向控制：摘要没有指针时也要显式说"属缺陷"，不能静默', () => {
  const r = planDelivery({ text: mk(12000), kind: 'report' })
  assert.equal(r.mode, 'summary')
  assert.ok(r.parts[0].includes('未提供指针'))
})

test('门禁结论：不分片，超预算走摘要（kind=gate 的 maxChunks=1）', () => {
  const r = planDelivery({ text: mk(4000), kind: 'gate', pointer: '台账 .rust-los-gov/gate-runs.jsonl' })
  assert.notEqual(r.mode, 'chunked')
  assert.ok(r.parts[0].includes('台账'))
})

test('完整性策略（alert + 禁摘要）超预算 ⇒ truncated，但必须留省略标记（V3）', () => {
  const r = planDelivery({ text: mk(30000), kind: 'alert', allowSummary: false, pointer: 'storages/x.jsonl' })
  assert.equal(r.mode, 'truncated')
  assert.ok(r.parts[0].includes(LIMITS.orphanMarker), '截断必须有标记')
  assert.ok(r.dropped.chars > 0)
})

test('分片行为：单行超长被硬切，总长不丢（除换行）', () => {
  const one = 'A'.repeat(4000)
  const chunks = chunkText(one, 1500)
  assert.equal(chunks.length, 3)
  assert.equal(chunks.join('').length, 4000)
})

test('withOrdinals 单片不加序号（避免 [1/1] 噪音）', () => {
  assert.deepEqual(withOrdinals(['x']), ['x'])
})

test('summarize 保留结论与关键行，且结果不超上限', () => {
  const text = `# 结论\n\n| 项 | 值 |\n|---|---|\n| a | 1 |\n${'填充'.repeat(2000)}`
  const s = summarize(text, { kind: 'report', pointer: 'p', maxChars: 800 })
  assert.ok(s.length <= 800)
  assert.ok(s.includes('# 结论'))
  assert.ok(s.includes('| a | 1 |'))
  assert.ok(s.includes('p'))
})

// ── T4（2026-11-01）接入前新增：序号是**发出去的正文的一部分**，预算必须含它 ──

test('负向控制：先按整额切再加序号 ⇒ 会出现超限片（这就是不能直接接线的理由）', () => {
  const text = mk(6000)
  const naive = withOrdinals(chunkText(text, LIMITS.singleMaxChars))
  assert.ok(
    naive.some((p) => p.length > LIMITS.singleMaxChars),
    '旧做法（整额切 + 加前缀）必须至少有一片超过单条上限，否则这条测试失去意义',
  )
})

test('chunkWithOrdinals：每片**含序号**后仍不超过单条上限，且序号连续完整', () => {
  const text = mk(6000)
  const parts = chunkWithOrdinals(text, LIMITS.singleMaxChars)
  assert.ok(parts.length > 1)
  for (const [i, p] of parts.entries()) {
    assert.ok(p.length <= LIMITS.singleMaxChars, `第 ${i + 1} 片 ${p.length} 字超限`)
    assert.ok(p.startsWith(`[${i + 1}/${parts.length}]\n`), `第 ${i + 1} 片序号不对：${p.slice(0, 12)}`)
  }
  // 正文不丢：去掉序号后按换行拼回，应与原文等长（chunkText 只在行边界/硬切处断开）
  const body = parts.map((p) => p.slice(p.indexOf('\n') + 1)).join('\n')
  assert.equal(body.replace(/\n/g, '').length, text.replace(/\n/g, '').length)
})

test('planDelivery 分片模式下同样守住单条上限（接入 feishu-client 的真正前置条件）', () => {
  for (const kind of ['alert', 'report']) {
    const r = planDelivery({ text: mk(4000), kind })
    for (const p of r.parts) assert.ok(p.length <= LIMITS.singleMaxChars, `${kind} 出现 ${p.length} 字的片`)
  }
})
