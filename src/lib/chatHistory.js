/**
 * Chat-history sync helpers.
 *
 * The local history stays authoritative on this device. Cloud sync sends a
 * compact copy (never image or file payloads), merges by conversation id and
 * updatedAt, and carries deletion tombstones so a deleted chat does not come
 * back from another device on the next pull.
 */

export const MAX_SYNCED_CONVERSATIONS = 30
export const MAX_HISTORY_TOMBSTONES = 200

// The Worker rejects payloads above 900 KB. Leave room for JSON overhead.
const MAX_SYNC_BYTES = 700_000
const MAX_CONVERSATION_BYTES = 140_000
const MAX_MESSAGE_CHARS = 24_000

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

function byteLength(value) {
  const text = String(value ?? '')
  if (textEncoder) return textEncoder.encode(text).length
  return unescape(encodeURIComponent(text)).length
}

function safeTimestamp(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function fallbackTitle(messages = []) {
  const first = (Array.isArray(messages) ? messages : []).find((message) => (
    message?.role === 'user' && String(message.content ?? '').trim()
  ))
  const text = String(first?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return 'New chat'
  return text.length > 58 ? `${text.slice(0, 57).trimEnd()}…` : text
}

function compactAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null
  return {
    id: String(attachment.id ?? '').slice(0, 120),
    kind: attachment.kind === 'image' ? 'image' : 'file',
    name: String(attachment.name ?? 'Attachment').slice(0, 240),
    ...(attachment.mime ? { mime: String(attachment.mime).slice(0, 120) } : {}),
    ...(Number.isFinite(Number(attachment.size)) ? { size: Number(attachment.size) } : {}),
  }
}

function compactMessage(message) {
  if (!message || typeof message !== 'object') return null
  if (!['user', 'assistant', 'system'].includes(message.role)) return null
  const compact = {
    role: message.role,
    content: String(message.content ?? '').slice(0, MAX_MESSAGE_CHARS),
  }
  if (message.id) compact.id = String(message.id).slice(0, 120)
  if (Number.isFinite(Number(message.ts))) compact.ts = Number(message.ts)
  if (Array.isArray(message.attachments) && message.attachments.length) {
    const attachments = message.attachments.slice(0, 8).map(compactAttachment).filter(Boolean)
    if (attachments.length) compact.attachments = attachments
  }
  if (message.image && typeof message.image === 'object') {
    // Generated image bytes are deliberately local-only; keep the prompt metadata.
    const { status, prompt, seed, mime } = message.image
    compact.image = {
      ...(status ? { status: String(status).slice(0, 24) } : {}),
      ...(prompt ? { prompt: String(prompt).slice(0, 2_000) } : {}),
      ...(seed !== undefined ? { seed: String(seed).slice(0, 120) } : {}),
      ...(mime ? { mime: String(mime).slice(0, 120) } : {}),
    }
  }
  return compact
}

function compactConversation(conversation) {
  if (!conversation?.id || !Array.isArray(conversation.messages) || !conversation.messages.length) {
    return null
  }
  const messages = conversation.messages.map(compactMessage).filter(Boolean)
  if (!messages.length) return null
  const compact = {
    id: String(conversation.id).slice(0, 120),
    title: String(conversation.title || fallbackTitle(messages)).slice(0, 120),
    titleSource: ['manual', 'ai', 'auto'].includes(conversation.titleSource)
      ? conversation.titleSource
      : 'auto',
    createdAt: safeTimestamp(conversation.createdAt) || safeTimestamp(conversation.updatedAt) || Date.now(),
    updatedAt: safeTimestamp(conversation.updatedAt) || Date.now(),
    messages,
  }
  // A single long thread should not crowd every other chat out of the sync.
  if (byteLength(JSON.stringify(compact)) > MAX_CONVERSATION_BYTES) {
    compact.messages = compact.messages.slice(-8)
    if (byteLength(JSON.stringify(compact)) > MAX_CONVERSATION_BYTES) {
      compact.messages = compact.messages.slice(-3)
    }
  }
  return compact
}

export function pruneDeletedConversations(deleted) {
  if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted)) return {}
  return Object.fromEntries(
    Object.entries(deleted)
      .map(([id, at]) => [String(id).slice(0, 120), safeTimestamp(at)])
      .filter(([id, at]) => id && at)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_HISTORY_TOMBSTONES),
  )
}

export function buildSyncPayload(conversations = [], deleted = {}) {
  const tombstones = pruneDeletedConversations(deleted)
  const baseBytes = byteLength(JSON.stringify({ version: 1, conversations: [], deleted: tombstones }))
  let used = baseBytes
  const selected = []
  const sorted = (Array.isArray(conversations) ? conversations : [])
    .filter((conversation) => conversation?.id)
    .sort((left, right) => (safeTimestamp(right.updatedAt) - safeTimestamp(left.updatedAt)))

  for (const conversation of sorted) {
    if (selected.length >= MAX_SYNCED_CONVERSATIONS) break
    if (tombstones[conversation.id] >= safeTimestamp(conversation.updatedAt)) continue
    const compact = compactConversation(conversation)
    if (!compact) continue
    const size = byteLength(JSON.stringify(compact)) + 1
    if (used + size > MAX_SYNC_BYTES) break
    selected.push(compact)
    used += size
  }

  return { version: 1, conversations: selected, deleted: tombstones }
}

function mergeConversation(value) {
  if (!value?.id || !Array.isArray(value.messages) || !value.messages.length) return null
  const createdAt = safeTimestamp(value.createdAt)
  const updatedAt = safeTimestamp(value.updatedAt)
  return {
    ...value,
    id: String(value.id),
    title: String(value.title || fallbackTitle(value.messages)),
    titleSource: ['manual', 'ai', 'auto'].includes(value.titleSource) ? value.titleSource : 'auto',
    createdAt: createdAt || updatedAt || Date.now(),
    updatedAt: updatedAt || Date.now(),
    messages: value.messages.filter(Boolean),
  }
}

/**
 * Merge a server history payload into this device's history.
 * A newer edit wins; on an exact timestamp tie the local copy wins so a
 * compact remote message cannot replace richer local attachments.
 */
export function mergeHistory(localConversations, localDeleted, remoteHistory) {
  const remote = remoteHistory?.conversations
    ? remoteHistory
    : remoteHistory?.history?.conversations
      ? remoteHistory.history
      : { conversations: [], deleted: {} }

  const deleted = {}
  for (const source of [localDeleted, remote.deleted]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    for (const [id, at] of Object.entries(source)) {
      const key = String(id)
      const timestamp = safeTimestamp(at)
      if (!key || !timestamp) continue
      deleted[key] = Math.max(Number(deleted[key]) || 0, timestamp)
    }
  }

  const byId = new Map()
  const add = (value) => {
    const conversation = mergeConversation(value)
    if (!conversation) return
    if (deleted[conversation.id] >= conversation.updatedAt) return
    const current = byId.get(conversation.id)
    if (!current || conversation.updatedAt > current.updatedAt) {
      byId.set(conversation.id, conversation)
    }
  }

  // Local first: equal timestamps keep the full local copy.
  for (const conversation of Array.isArray(localConversations) ? localConversations : []) add(conversation)
  for (const conversation of remote.conversations ?? []) add(conversation)

  const conversations = [...byId.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SYNCED_CONVERSATIONS)

  return {
    conversations,
    deleted: pruneDeletedConversations(deleted),
  }
}

export function historyFingerprint(conversations = [], deleted = {}) {
  const active = (Array.isArray(conversations) ? conversations : [])
    .filter((conversation) => conversation?.id)
    .map((conversation) => [
      conversation.id,
      safeTimestamp(conversation.updatedAt),
      String(conversation.title ?? ''),
      String(conversation.titleSource ?? ''),
      Array.isArray(conversation.messages) ? conversation.messages.length : 0,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const tombstones = Object.entries(pruneDeletedConversations(deleted))
    .sort((left, right) => left[0].localeCompare(right[0]))
  return JSON.stringify([active, tombstones])
}
