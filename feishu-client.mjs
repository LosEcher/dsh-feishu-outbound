/**
 * Pure Feishu OpenAPI client (no DSH dependency).
 * - tenant_access_token with 2h cache
 * - text / image / file message push via im/v1/messages
 */

const API_BASE = 'https://open.feishu.cn/open-apis';

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

  async sendText(target, text) {
    const to = target?.id
    if (!to) return { ok: false, error: 'no target id for feishu send' }
    const parts = splitText(String(text ?? ''))
    let lastOk = null
    for (let i = 0; i < parts.length; i += 1) {
      const result = await this._postMessage(target, 'text', { text: parts[i] })
      if (!result.ok) return result
      lastOk = result
      if (i + 1 < parts.length) await sleep(400)
    }
    return lastOk ?? { ok: false, error: 'empty content' }
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

/** Split long text into ≤1500-char chunks on newline boundaries, hard-splitting overlong single lines. */
function splitText(text) {
  if (text.length <= 1500) return [text]
  const chunks = []
  let current = ''
  for (const line of text.split('\n')) {
    if (line.length > 1500) {
      // overlong single line: flush current, then hard-cut
      if (current.length > 0) {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < line.length; i += 1500) {
        chunks.push(line.slice(i, i + 1500))
      }
      continue
    }
    if ((current + line).length > 1500 && current.length > 0) {
      chunks.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current) chunks.push(current)
  return chunks
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
