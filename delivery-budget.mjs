/**
 * delivery-budget.mjs — **投递预算**：把"一条消息该怎么发"从写死的 1500 字符分片
 * 升级成按场景（kind）动态决定，并且**丢弃必须可数**。
 *
 * 为什么不能统一"分片 or 截断"二选一（2026-11-01 设计）：
 *   同一个出口要发四种东西，它们的"坏"各不相同 ——
 *     · 告警：少一个字都可能让判断错，**宁可多片也不能丢**；
 *     · 日报：多片会刷屏没人看，**宁可摘要 + 链接**；
 *     · 门禁结论：只要 verdict 与失败项，正文本来就不该铺满；
 *     · 对话回复：用户能追问，截断最划算。
 *   所以预算不是"字符数"一个数，而是三个约束（单条上限 / 分片数上限 / 是否允许摘要），
 *   由 kind 决定；超预算时**按场景降级**，而不是一刀切。
 *
 * 三条不变量：
 *   V1 **分片必须有序号**（`[i/N]`）——否则乱序后无法恢复顺序，等于丢内容；
 *   V2 **丢弃必须可数**（`dropped.chars` / `dropped.blocks`），并且 summary 模式必须带可回溯指针（链接/附件/台账路径）；
 *   V3 **不许把截断伪装成完整**：截断必须留省略标记，summary 必须写明"其余 N 字见 X"。
 */

/** 平台/产品约束（**都是可改的常量，不是散落在代码里的魔数**）。 */
export const LIMITS = Object.freeze({
  singleMaxChars: 1500, // 单条消息正文上限（现状：飞书出口一直按 ≤1500 分片）
  maxChunks: {
    alert: 4, // 告警最多 4 片；再多就改摘要 + 全文
    report: 2, // 日报最多 2 片（多了没人读）
    gate: 1, // 门禁结论单片（只发 verdict + 失败项）
    chat: 1,
  },
  orphanMarker: '…（其余见）', // 截断标记（lint 用它判"有没有承认自己截了"）
})

/**
 * 场景默认策略。
 *   chunk=true  ⇒ 允许分片（带序号）
 *   summary=…   ⇒ 超预算时如何摘要（函数返回"可回溯指针"）
 */
export const POLICIES = Object.freeze({
  alert: { chunk: true, prefer: 'completeness' },
  report: { chunk: true, prefer: 'scannability' },
  gate: { chunk: false, prefer: 'verdict' },
  chat: { chunk: false, prefer: 'brevity' },
})

/** 按换行切，但单行超长就硬切（保持现有行为，避免一条超长行撑爆整片）。 */
export function chunkText(text, maxChars = LIMITS.singleMaxChars) {
  if (text.length <= maxChars) return [text]
  const chunks = []
  let current = ''
  for (const line of text.split('\n')) {
    if (line.length > maxChars) {
      if (current) { chunks.push(current); current = '' }
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars))
      continue
    }
    if ((current ? current.length + 1 : 0) + line.length > maxChars && current) {
      chunks.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current) chunks.push(current)
  return chunks
}

/** 给分片加序号（V1）。单片不加，避免"每句话都 [1/1]"这种噪音。 */
export function withOrdinals(chunks) {
  if (chunks.length <= 1) return chunks.slice()
  return chunks.map((c, i) => `[${i + 1}/${chunks.length}]\n${c}`)
}

/** 序号前缀的最坏长度（对 N 片而言，最长的是 `[N/N]\n`）。 */
function ordinalReserve(n) {
  return `[${n}/${n}]\n`.length
}

/**
 * 分片 + 加序号，且**每片加完序号后仍不超过单条上限**。
 *
 * 为什么需要这个而不用 `withOrdinals(chunkText(text, limit))`：序号是**发出去的正文的一部分**，
 * 预算必须包含它。直接按 1500 切再前缀，每条会变成 1500+9 = 1509 字 —— 线上就是超限正文，
 * 门禁也抓不到（E_CHUNK_NO_ORDINAL 只判"有没有序号"，带序号的超限片会被它放过）。
 *
 * 做法：先按整额切一次得到片数 n，再用 `limit - ordinalReserve(n)` 重切，直到片数稳定
 * （预算变小 ⇒ 片数只增；n 一变前缀可能多一位，故迭代到不动点，最多 8 轮）。
 */
export function chunkWithOrdinals(text, limit = LIMITS.singleMaxChars) {
  let chunks = chunkText(text, limit)
  if (chunks.length <= 1) return chunks
  let planned = chunks
  for (let guard = 0; guard < 8; guard += 1) {
    const n = chunks.length
    const next = chunkText(text, limit - ordinalReserve(n))
    planned = next
    if (next.length === n) break
    chunks = next
  }
  const parts = withOrdinals(planned)
  // 兜底：极端输入（片数位数跳变）下若仍有超限片，按"预留 6 位片数 + 分隔符"重切。
  if (parts.some((p) => p.length > limit)) return withOrdinals(chunkText(text, limit - 12))
  return parts
}

/**
 * 场景感知的摘要：保留"开头（通常是结论）+ 结构行"，把中段压掉并标明去处。
 * @param text 原文
 * @param opts.kind 场景
 * @param opts.pointer 可回溯指针（链接 / 附件 key / 台账路径）
 * @param opts.keepHeadChars 开头保留多少字
 * @param opts.maxChars 摘要上限
 */
export function summarize(text, opts) {
  const { kind = 'report', pointer = '', keepHeadChars = 400, maxChars = LIMITS.singleMaxChars } = opts ?? {}
  const lines = text.split('\n')
  const head = text.slice(0, keepHeadChars)
  // 保留看起来是"结论/计数/标题"的行（表格行、以 #/数字/竖线开头），最多 12 行
  const keyLines = lines
    .filter((l) => /^\s*(#{1,3}\s|\|\s|\d+[.)]\s|[-*]\s)/.test(l))
    .slice(0, 12)
  const rest = Math.max(0, text.length - head.length)
  const parts = [head.trimEnd()]
  if (keyLines.length) parts.push('—— 关键行 ——', ...keyLines)
  parts.push(`${LIMITS.orphanMarker}${pointer || '（未提供指针，属缺陷）'}`)
  parts.push(`省略 ${rest} 字（kind=${kind}）`)
  let out = parts.join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…'
  return out
}

/**
 * 主入口：给定正文与场景，返回**投递计划**。
 *
 * @param {object} input
 * @param {string} input.text 正文
 * @param {'alert'|'report'|'gate'|'chat'} [input.kind]
 * @param {string} [input.pointer] 超预算时的可回溯指针（链接/附件/台账路径）
 * @param {boolean} [input.allowSummary] 该场景是否允许降级为摘要（默认按 POLICIES）
 * @param {object} [input.limits] 覆盖 LIMITS（测试用）
 * @returns {{mode:'single'|'chunked'|'summary'|'truncated', parts:string[], dropped:{chars:number,blocks:number}, reason:string, kind:string}}
 */
export function planDelivery(input) {
  const { text = '', kind = 'report', pointer = '', allowSummary, limits = LIMITS } = input ?? {}
  const policy = POLICIES[kind] ?? POLICIES.report
  const maxChunks = limits.maxChunks?.[kind] ?? 2
  const chars = text.length

  if (chars <= limits.singleMaxChars) {
    return { mode: 'single', parts: [text], dropped: { chars: 0, blocks: 0 }, reason: 'within-single-limit', kind }
  }

  // 片数必须按"加完序号后"的实数算：序号是正文的一部分，占预算 ⇒ 可能比整额切多一片。
  // 允许分片的场景先按含序号的计划算；不允许分片的场景只做整额切（只为把 dropped.blocks 数出来）。
  const chunkable = policy.chunk
  const planned = chunkable ? chunkWithOrdinals(text, limits.singleMaxChars) : null
  if (planned && planned.length <= maxChunks) {
    return {
      mode: 'chunked',
      parts: planned,
      dropped: { chars: 0, blocks: 0 },
      reason: `chunked ${planned.length}/${maxChunks}`,
      kind,
    }
  }
  const rawChunks = chunkable ? planned.length : chunkText(text, limits.singleMaxChars).length

  const maySummarize = allowSummary ?? policy.prefer !== 'completeness'
  if (maySummarize) {
    const summary = summarize(text, { kind, pointer, maxChars: limits.singleMaxChars })
    return {
      mode: 'summary',
      parts: [summary],
      dropped: { chars: Math.max(0, chars - summary.length), blocks: Math.max(0, rawChunks - 1) },
      reason: `over-budget(${rawChunks} chunks > ${maxChunks}) → summary`,
      kind,
    }
  }

  // 完整性优先但超预算：**不静默丢**，截断并显式承认（lint 会断言有省略标记）
  const cut = text.slice(0, limits.singleMaxChars - LIMITS.orphanMarker.length - 40)
  const truncated = `${cut}\n${LIMITS.orphanMarker}${pointer || '（未提供指针，属缺陷）'}\n省略 ${chars - cut.length} 字`
  return {
    mode: 'truncated',
    parts: [truncated],
    dropped: { chars: chars - cut.length, blocks: Math.max(0, rawChunks - 1) },
    reason: `over-budget(${rawChunks} chunks > ${maxChunks}) → truncated (completeness policy)`,
    kind,
  }
}

/** 实际会切出多少片（与分片路径同口径：允许分片时含序号前缀，否则按整额切）。 */
function planChunkCount(text, limit, chunkable) {
  return chunkable ? chunkWithOrdinals(text, limit).length : chunkText(text, limit).length
}
