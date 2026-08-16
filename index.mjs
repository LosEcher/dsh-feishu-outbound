/**
 * dsh-feishu-outbound — Cordis plugin.
 * Registers globalThis.__dshChannelNotify.feishu so de_channel_send / de_notify
 * can push to Feishu via the same self-build app credentials as dsh-lark-channel.
 *
 * Named exports (name/inject/Config/apply) to dodge the Loader's default
 * unwrap that drops Config — same pattern as dsh-channel-wechat.
 */

import Schema from '@deepseek-ai/schemastery'
import { FeishuClient } from './feishu-client.mjs'

export const name = 'dsh-feishu-outbound'
export const inject = []
export const Config = Schema.object({
  /** App ID (self-build Feishu app); empty → LARK_APP_ID env. */
  appId: Schema.string().default(''),
  /** App Secret; empty → LARK_APP_SECRET env. */
  appSecret: Schema.string().default(''),
  /** Default send target "p2p:ou_xxx" / "group:oc_xxx"; empty → explicit target required. */
  defaultTo: Schema.string().default(''),
})

export function apply(ctx, config = {}) {
  const appId = config.appId || process.env.LARK_APP_ID || ''
  const appSecret = config.appSecret || process.env.LARK_APP_SECRET || ''
  const defaultToRaw = config.defaultTo || process.env.FEISHU_DEFAULT_TO || ''

  // defaultTo: "p2p:ou_xxx" / "group:oc_xxx" → {kind, id}
  const defaultTo = parseTarget(defaultToRaw)

  if (!appId || !appSecret) {
    ctx.logger.warn('[dsh-feishu-outbound] LARK_APP_ID / LARK_APP_SECRET not set; channel inert')
    return
  }

  const client = new FeishuClient({ appId, appSecret })

  const CHANNEL_REGISTRY_KEY = '__dshChannelNotify'
  const outboundChannel = {
    async send(target, content, _opts) {
      try {
        return await client.sendText(resolveTarget(target, defaultTo), String(content ?? ''))
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async sendMedia(target, media, _opts) {
      try {
        return await client.sendMedia(resolveTarget(target, defaultTo), media)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    recentChat() {
      return defaultTo ? { ...defaultTo } : null
    },
    status() {
      return { ok: true, channel: 'feishu', appId, defaultTo: defaultTo ? 'set' : 'unset' }
    },
  }

  try {
    const registry = globalThis[CHANNEL_REGISTRY_KEY] ?? (globalThis[CHANNEL_REGISTRY_KEY] = {})
    registry.feishu = outboundChannel
    ctx.logger.info(
      `[dsh-feishu-outbound] outbound channel registered: feishu (appId=${appId}, defaultTo=${defaultTo ? 'set' : 'unset'})`,
    )
  } catch (error) {
    ctx.logger.warn(`[dsh-feishu-outbound] registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** target may be {kind,id}, a "kind:id" string, or absent → defaultTo */
function resolveTarget(target, defaultTo) {
  if (target == null) return defaultTo ?? { kind: 'p2p', id: '' }
  if (typeof target === 'string') return parseTarget(target) ?? { kind: 'p2p', id: target }
  if (typeof target.id === 'string') return target
  return defaultTo ?? { kind: 'p2p', id: '' }
}

function parseTarget(raw) {
  if (!raw || typeof raw !== 'string') return null
  const idx = raw.indexOf(':')
  if (idx <= 0) return null
  const kind = raw.slice(0, idx)
  const id = raw.slice(idx + 1)
  if (!id) return null
  return { kind: kind === 'group' ? 'group' : 'p2p', id }
}
