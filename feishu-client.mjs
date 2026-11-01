/**
 * Pure Feishu OpenAPI client (no DSH dependency).
 * - tenant_access_token with 2h cache
 * - text / image / file message push via im/v1/messages
 * - **文本投递按场景预算**（delivery-budget.planDelivery：单片/带序号分片/摘要/截断）
 */

import { planDelivery } from './delivery-budget.mjs'

const API_BASE = 'https://open.feishu.cn/open-apis';

/**
 * sendText 缺省场景 = alert。
 *
 * 为什么不是 report/chat：这个出口发出的绝大多数是通知与告警（磁盘水位、节点掉线、门禁红），
 * 它们的坏法是"少一段就判断错"⇒ 按 alert 的完整性策略（宁可多片，超预算也显式承认截断）。
 * 摘要型内容（日报/盘点）应由调用方显式传 opts.kind='report' 才降级为摘要 —— 默认降级会静默丢内容。
 */
const DEFAULT_KIND = 'alert'


export class FeishuClient {
  constructor({ appId, appSecret, apiBase = API_BASE, fetchImpl = fetch }) {
    this.appId = appId
    this.appSecret = appSecret
    this.apiBase = apiBase
    this.fetchImpl = fetchImpl
    this._token = null
    this._tokenExpiresAt = 0
  }

  async token() {
    if (this._token && Date.now() < this._tokenExpiresAt - 60_000) {
      return this._token
    }
    const res = await this.fetchImpl(`${this.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    if (!res.ok) throw new Error(`token http ${res.status}`)
    const data = await res.json()
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`token rejected: ${data.code} ${data.msg ?? ''}`.trim())
    }
    this._token = data.tenant_access_token
    // expire_ttl is seconds; refresh slightly before
    this._tokenExpiresAt = Date.now() + (data.expire ?? 7200) * 1000
    return this._token
  }

  /** target = {kind, id}: kind p2p→open_id, group→chat_id */
  receiveIdType(target) {
    return target?.kind === 'group' ? 'chat_id' : 'open_id'
  }

  /**
   * 文本发送（T4：分片由 delivery-budget 决定，不再在这里手切 1500）。
   *
   * @param {{kind:string,id:string}} target
   * @param {string} text
   * @param {object} [opts]
   * @param {'alert'|'report'|'gate'|'chat'} [opts.kind] 场景（缺省 alert，见 DEFAULT_KIND）
   * @param {string} [opts.pointer] 降级（summary/truncated）时的可回溯指针（链接/附件 key/台账路径）
   */
  async sendText(target, text, opts = {}) {
    const to = target?.id
    if (!to) return { ok: false, error: 'no target id for feishu send' }
    // 唯一的切分/降级决策点：纯函数（可单测、可回滚）。parts 已满足「每片 ≤ 单条上限」，
    // 分片带 [i/N] 序号；超预算则按 kind 降级，并把丢失量记在 dropped 里（可数）。
    const plan = planDelivery({
      text: String(text ?? ''),
      kind: opts?.kind ?? DEFAULT_KIND,
      pointer: opts?.pointer ?? '',
    })
    const parts = plan.parts
    let lastOk = null
    for (let i = 0; i < parts.length; i += 1) {
      const result = await this._postMessage(target, 'text', { text: parts[i] })
      if (!result.ok) return result
      lastOk = result
      if (i + 1 < parts.length) await sleep(400)
    }
    const delivery = { kind: plan.kind, mode: plan.mode, parts: parts.length, dropped: plan.dropped, reason: plan.reason }
    return lastOk ? { ...lastOk, delivery } : { ok: false, error: 'empty content' }
  }

  async sendMedia(target, media) {
    const to = target?.id
    if (!to) return { ok: false, error: 'no target id for feishu sendMedia' }
    if (!media || typeof media !== 'object') return { ok: false, error: 'invalid media payload' }
    // de_channel_send 直发契约：无附件文本以 {kind:'text', content} 进入 sendMedia 槽位
    if (media.kind === 'text' || (typeof media.content === 'string' && media.content.length > 0 && !media.url && !media.path)) {
      return this.sendText(target, media.content ?? media.text ?? '')
    }
    let fileBuffer = null
    let fileName = media.fileName ?? ''
    if (media.path) {
      const fs = await import('node:fs/promises')
      fileBuffer = await fs.readFile(media.path)
      if (!fileName) fileName = basenameSafe(media.path)
    } else if (media.url) {
      const res = await this.fetchImpl(media.url)
      if (!res.ok) throw new Error(`download http ${res.status}`)
      fileBuffer = Buffer.from(await res.arrayBuffer())
      if (!fileName) fileName = urlFilename(media.url)
    } else if (media.base64) {
      fileBuffer = Buffer.from(media.base64, 'base64')
      if (!fileName) fileName = media.fileName ?? 'attachment.bin'
    }
    if (!fileBuffer) {
      return { ok: false, error: `feishu sendMedia unsupported payload: ${JSON.stringify(media).slice(0, 120)}` }
    }
    const isImage = media.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(fileName)
    if (isImage) {
      const imageKey = await this._uploadImage(fileBuffer)
      const result = await this._postMessage(target, 'image', { image_key: imageKey })
      if (media.caption) {
        const cap = await this.sendText(target, media.caption)
        if (!cap.ok) return cap
      }
      return result
    }
    const fileKey = await this._uploadFile(fileBuffer, fileName)
    return this._postMessage(target, 'file', { file_key: fileKey })
  }

  async _postMessage(target, msgType, contentObj) {
    const token = await this.token()
    const url = `${this.apiBase}/im/v1/messages?receive_id_type=${this.receiveIdType(target)}`
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: target.id, msg_type: msgType, content: JSON.stringify(contentObj) }),
    })
    if (!res.ok) return { ok: false, error: `feishu http ${res.status}` }
    const data = await res.json().catch(() => ({}))
    if (data.code !== 0) return { ok: false, error: `feishu reject ${data.code} ${data.msg ?? ''}`.trim() }
    return { ok: true, messageId: data.data?.message_id ?? data.message_id ?? null }
  }

  async _uploadImage(buffer) {
    const token = await this.token()
    const fd = new FormData()
    fd.append('image_type', 'message')
    fd.append('image', new Blob([buffer]))
    const res = await this.fetchImpl(`${this.apiBase}/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    })
    const data = await res.json().catch(() => ({}))
    if (data.code !== 0 || !data.data?.image_key) {
      throw new Error(`feishu image upload reject ${data.code} ${data.msg ?? ''}`.trim())
    }
    return data.data.image_key
  }

  async _uploadFile(buffer, fileName) {
    const token = await this.token()
    const fd = new FormData()
    fd.append('file_type', 'stream')
    fd.append('file_name', fileName)
    fd.append('file', new Blob([buffer]))
    const res = await this.fetchImpl(`${this.apiBase}/im/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    })
    const data = await res.json().catch(() => ({}))
    if (data.code !== 0 || !data.data?.file_key) {
      throw new Error(`feishu file upload reject ${data.code} ${data.msg ?? ''}`.trim())
    }
    return data.data.file_key
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function basenameSafe(p) {
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] || 'attachment.bin'
}

function urlFilename(u) {
  try {
    const path = new URL(u).pathname
    const name = path.split('/').filter(Boolean).pop()
    return name || 'attachment.bin'
  } catch {
    return 'attachment.bin'
  }
}
