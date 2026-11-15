/**
 * Javelin Cloud — a free, keyless-for-users OpenAI-compatible endpoint.
 *
 * Users need no account, no API key and no local runtime: the upstream provider key
 * lives here as a Worker secret. The app sends its install id, which is counted once
 * per day so one machine cannot drain the shared free tier.
 *
 * Routes
 *   GET  /health                 liveness + configuration state
 *   GET  /v1/models              the model ids the app may ask for
 *   POST /v1/chat/completions    proxied, streamed through unchanged
 */

const ALLOWED_MODELS = new Set(['javelin', 'javelin-fast'])
const OWNER_USERNAME = 'bungles17x'
// Signed-in accounts get a token balance rather than a small daily request cap.
const MEMBER_TOKEN_LIMIT = 100_000_000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
const RESET_TTL_MS = 60 * 60 * 1000
const LOGIN_TTL_MS = 10 * 60 * 1000
const LOCK_LINK_TTL_MS = 24 * 60 * 60 * 1000
const EMAIL_COOLDOWN_MS = 60 * 1000
const EMAIL_HOURLY_LIMIT = 5
// Cloudflare's Web Crypto implementation caps PBKDF2 at 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000
const SUPPORT_EMAIL = 'JavelinAIServices@gmail.com'
const SUPPORT_TOPICS = {
  bug: { label: 'Bug report', placeholder: 'What happened? Include what you expected and any steps that reproduce it.' },
  feature: { label: 'Feature request', placeholder: 'What would you like Javelin to do, and why would it help?' },
  account: { label: 'Account or sign-in help', placeholder: 'What happened when you tried to sign in or manage your account?' },
  other: { label: 'Something else', placeholder: 'How can we help?' },
}
const SUPPORT_COOLDOWN_MS = 30_000
const SUPPORT_DAILY_LIMIT = 8
const HISTORY_MAX_BYTES = 900_000
const HISTORY_MAX_CONVERSATIONS = 30
const HISTORY_MAX_TOMBSTONES = 200
const HISTORY_MAX_MESSAGE_CHARS = 50_000

let authSchemaReady = false
let supportSchemaReady = false

function authError(message, code, status = 400, details = null) {
  return json({ error: { message, type: 'javelin_auth_error', code, ...(details || {}) } }, status)
}

function historyTimestamp(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function cleanHistoryConversation(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages)) return null
  const id = String(value.id ?? '').trim().slice(0, 120)
  if (!id) return null
  const messages = value.messages.slice(0, 500).map((message) => {
    if (!message || typeof message !== 'object') return null
    const role = ['user', 'assistant', 'system'].includes(message.role) ? message.role : ''
    if (!role) return null
    const clean = { role, content: String(message.content ?? '').slice(0, HISTORY_MAX_MESSAGE_CHARS) }
    if (message.id) clean.id = String(message.id).slice(0, 120)
    if (Number.isFinite(Number(message.ts))) clean.ts = Number(message.ts)
    if (Array.isArray(message.attachments) && message.attachments.length) {
      const attachments = message.attachments.slice(0, 8).map((attachment) => {
        if (!attachment || typeof attachment !== 'object') return null
        return {
          id: String(attachment.id ?? '').slice(0, 120),
          kind: attachment.kind === 'image' ? 'image' : 'file',
          name: String(attachment.name ?? 'Attachment').slice(0, 240),
          ...(attachment.mime ? { mime: String(attachment.mime).slice(0, 120) } : {}),
          ...(Number.isFinite(Number(attachment.size)) ? { size: Number(attachment.size) } : {}),
        }
      }).filter(Boolean)
      if (attachments.length) clean.attachments = attachments
    }
    if (message.image && typeof message.image === 'object') {
      // Image bytes stay on the source device; the synced copy keeps only metadata.
      clean.image = {
        ...(message.image.status ? { status: String(message.image.status).slice(0, 24) } : {}),
        ...(message.image.prompt ? { prompt: String(message.image.prompt).slice(0, 2_000) } : {}),
        ...(message.image.seed !== undefined ? { seed: String(message.image.seed).slice(0, 120) } : {}),
        ...(message.image.mime ? { mime: String(message.image.mime).slice(0, 120) } : {}),
      }
    }
    return clean
  }).filter(Boolean)
  if (!messages.length) return null
  const updatedAt = historyTimestamp(value.updatedAt)
  return {
    id,
    title: String(value.title || 'New chat').slice(0, 120),
    titleSource: ['manual', 'ai', 'auto'].includes(value.titleSource) ? value.titleSource : 'auto',
    createdAt: historyTimestamp(value.createdAt) || updatedAt || Date.now(),
    updatedAt: updatedAt || Date.now(),
    messages,
  }
}

function cleanHistoryTombstones(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, at]) => [String(id).trim().slice(0, 120), historyTimestamp(at)])
      .filter(([id, at]) => id && at)
      .sort((left, right) => right[1] - left[1])
      .slice(0, HISTORY_MAX_TOMBSTONES),
  )
}

function normalizeHistoryDocument(value) {
  const source = value && typeof value === 'object' ? value : {}
  const conversations = (Array.isArray(source.conversations) ? source.conversations : [])
    .map(cleanHistoryConversation)
    .filter(Boolean)
  return {
    version: 1,
    conversations,
    deleted: cleanHistoryTombstones(source.deleted),
  }
}

/**
 * Merge two device snapshots without trusting whichever arrived last.
 * Each chat keeps its newest revision, and a deletion applies until a newer
 * revision of that same chat is uploaded (for example after an undo).
 */
function mergeHistoryPayloads(existingValue, incomingValue) {
  const existing = normalizeHistoryDocument(existingValue)
  const incoming = normalizeHistoryDocument(incomingValue)
  const deleted = { ...existing.deleted }
  for (const [id, at] of Object.entries(incoming.deleted)) {
    deleted[id] = Math.max(Number(deleted[id]) || 0, at)
  }

  const byId = new Map()
  const add = (conversation) => {
    if (deleted[conversation.id] >= conversation.updatedAt) return
    const current = byId.get(conversation.id)
    if (!current || conversation.updatedAt > current.updatedAt) byId.set(conversation.id, conversation)
  }
  for (const conversation of existing.conversations) add(conversation)
  for (const conversation of incoming.conversations) add(conversation)

  return {
    version: 1,
    conversations: [...byId.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, HISTORY_MAX_CONVERSATIONS),
    deleted: cleanHistoryTombstones(deleted),
  }
}

function bytesToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value) {
  const binary = atob(String(value ?? ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function base64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken() {
  return `jv_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`
}

function loginCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)))
  return base64Url(new Uint8Array(digest))
}

async function derivePassword(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password).normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    256,
  )
  return new Uint8Array(bits)
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}

function equalText(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role === 'owner' ? 'owner' : row.role === 'staff' ? 'staff' : 'member',
    createdAt: row.created_at,
    emailVerified: Boolean(row.email_verified_at),
  }
}

function parseBoolean(value, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

/**
 * Use an existing mailbox over SMTP instead of a transactional provider.
 * Gmail and Yahoo are the zero-extra-signup cases: SMTP_USER + SMTP_PASS
 * (an app password) is enough; other providers only need SMTP_HOST.
 */
function smtpConfig(env) {
  const user = String(env.SMTP_USER || '').trim()
  const pass = String(env.SMTP_PASS || '').trim()
  if (!user || !pass) return null
  const defaultHost = /@(gmail|googlemail)\.com$/i.test(user)
    ? 'smtp.gmail.com'
    : /@(yahoo|ymail|rocketmail)\.com$/i.test(user)
      ? 'smtp.mail.yahoo.com'
      : ''
  const host = String(env.SMTP_HOST || '').trim()
    || defaultHost
  if (!host) return null
  const port = Number(env.SMTP_PORT || 465)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const secure = parseBoolean(env.SMTP_SECURE, port === 465)
  const fromEmail = String(env.EMAIL_FROM_EMAIL || user).trim() || user
  const name = String(env.EMAIL_FROM_NAME || 'Javelin Accounts').trim() || 'Javelin Accounts'
  return { provider: 'smtp', host, port, secure, user, pass, fromEmail, name }
}

function emailConfig(env) {
  const smtp = smtpConfig(env)
  if (smtp) return smtp
  const fromEmail = String(env.EMAIL_FROM_EMAIL || '').trim()
  if (!fromEmail) return null
  const name = String(env.EMAIL_FROM_NAME || 'Javelin Accounts').trim() || 'Javelin Accounts'
  if (env.BREVO_API_KEY) return { provider: 'brevo', key: env.BREVO_API_KEY, fromEmail, name }
  if (env.RESEND_API_KEY) return { provider: 'resend', key: env.RESEND_API_KEY, fromEmail, name }
  return null
}

function emailConfigured(env) {
  return typeof env.EMAIL_SENDER === 'function' || Boolean(emailConfig(env))
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64Lines(value) {
  return base64Utf8(value).replace(/(.{76})/g, '$1\r\n')
}

function cleanHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

function smtpAddress(value) {
  const address = cleanHeader(value)
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new Error('Invalid email address.')
  return address
}

function encodedHeader(value) {
  const text = cleanHeader(value)
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${base64Utf8(text)}?=`
}

function buildSmtpMessage(config, message) {
  const fromEmail = smtpAddress(config.fromEmail)
  const to = smtpAddress(message.to)
  const replyTo = message.replyTo ? smtpAddress(message.replyTo) : fromEmail
  const boundary = `javelin-${crypto.randomUUID()}`
  const domain = fromEmail.split('@')[1] || 'javelin.invalid'
  const body = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${encodedHeader(config.name || 'Javelin Accounts')} <${fromEmail}>`,
    `Reply-To: ${encodedHeader(config.name || 'Javelin Accounts')} <${replyTo}>`,
    `To: <${to}>`,
    `Subject: ${encodedHeader(message.subject)}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
    'Content-Language: en',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.html),
    `--${boundary}--`,
    '',
    '',
  ].join('\r\n')
  return body
}

class SmtpChannel {
  constructor(socket, buffer = '') {
    this.socket = socket
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
    this.decoder = new TextDecoder()
    this.buffer = buffer
  }

  async waitOpen() {
    if (this.socket.opened) await this.socket.opened
  }

  async readLine() {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '')
        this.buffer = this.buffer.slice(newline + 1)
        return line
      }
      const { value, done } = await this.reader.read()
      if (done) throw new Error('SMTP connection closed.')
      this.buffer += this.decoder.decode(value, { stream: true })
    }
  }

  async readReply() {
    const first = await this.readLine()
    const match = /^(\d{3})([ -])/.exec(first)
    if (!match) throw new Error('SMTP reply was malformed.')
    const code = match[1]
    const lines = [first]
    let separator = match[2]
    while (separator === '-') {
      const next = await this.readLine()
      lines.push(next)
      const nextMatch = /^(\d{3})([ -])/.exec(next)
      if (!nextMatch || nextMatch[1] !== code) throw new Error('SMTP reply was malformed.')
      separator = nextMatch[2]
    }
    return { code, lines }
  }

  async write(value) {
    await this.writer.write(new TextEncoder().encode(value))
  }

  async commandReply(value, expected) {
    await this.write(`${value}\r\n`)
    const reply = await this.readReply()
    if (!expected.includes(reply.code)) throw new Error(`SMTP command failed (${reply.code}).`)
    return reply
  }

  async command(value, expected) {
    return (await this.commandReply(value, expected)).code
  }

  startTls() {
    const upgraded = this.socket.startTls()
    this.release()
    return new SmtpChannel(upgraded, this.buffer)
  }

  release() {
    try { this.reader.releaseLock() } catch { /* already released */ }
    try { this.writer.releaseLock() } catch { /* already released */ }
  }

  async close() {
    this.release()
    try { await this.socket.close() } catch { /* already closed */ }
  }
}

async function openSmtpSocket(config) {
  const { connect } = await import('cloudflare:sockets')
  return connect(
    { hostname: config.host, port: config.port },
    { secureTransport: config.secure ? 'on' : 'off' },
  )
}

function withTimeout(promise, milliseconds) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Email delivery timed out.')), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function sendSmtpEmail(config, message, options = {}) {
  let channel = new SmtpChannel(await (options.connect ? options.connect(config) : openSmtpSocket(config)))
  try {
    await channel.waitOpen()
    const greeting = await channel.readReply()
    if (greeting.code !== '220') throw new Error(`SMTP greeting was not accepted (${greeting.code}).`)
    let ehlo = await channel.commandReply('EHLO javelin-ai', ['250'])
    if (!config.secure) {
      await channel.command('STARTTLS', ['220'])
      channel = channel.startTls()
      ehlo = await channel.commandReply('EHLO javelin-ai', ['250'])
    }
    const capabilities = ehlo.lines.join(' ').toUpperCase()
    if (/\bAUTH\b/.test(capabilities) && /\bPLAIN\b/.test(capabilities)) {
      await channel.command(`AUTH PLAIN ${base64Utf8(`\0${config.user}\0${config.pass}`)}`, ['235'])
    } else if (/\bAUTH\b/.test(capabilities) && /\bLOGIN\b/.test(capabilities)) {
      await channel.command('AUTH LOGIN', ['334'])
      await channel.command(base64Utf8(config.user), ['334'])
      await channel.command(base64Utf8(config.pass), ['235'])
    } else {
      await channel.command(`AUTH PLAIN ${base64Utf8(`\0${config.user}\0${config.pass}`)}`, ['235'])
    }
    await channel.command(`MAIL FROM:<${smtpAddress(config.fromEmail)}>`, ['250'])
    await channel.command(`RCPT TO:<${smtpAddress(message.to)}>`, ['250', '251'])
    await channel.command('DATA', ['354'])
    const mime = buildSmtpMessage(config, message)
      .split('\r\n')
      .map((line) => (line.startsWith('.') ? `.${line}` : line))
      .join('\r\n')
    await channel.write(`${mime}\r\n.\r\n`)
    const accepted = await channel.readReply()
    if (accepted.code !== '250') throw new Error(`SMTP message was not accepted (${accepted.code}).`)
    try { await channel.command('QUIT', ['221']) } catch { /* some servers close immediately */ }
  } finally {
    await channel.close()
  }
}

async function deliverEmail(env, message) {
  if (typeof env.EMAIL_SENDER === 'function') {
    try {
      const result = await env.EMAIL_SENDER(message)
      return { configured: true, sent: result !== false }
    } catch {
      return { configured: true, sent: false }
    }
  }

  const config = emailConfig(env)
  if (!config) return { configured: false, sent: false }

  try {
    if (config.provider === 'smtp') {
      await withTimeout(sendSmtpEmail(config, message), 15_000)
      return { configured: true, sent: true }
    }
    const response = config.provider === 'brevo'
      ? await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': config.key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: config.name, email: config.fromEmail },
          to: [{ email: message.to }],
          ...(message.replyTo ? { replyTo: { email: message.replyTo } } : {}),
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(8000),
      })
      : await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: `${config.name} <${config.fromEmail}>`,
          to: [message.to],
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(8000),
      })
    return { configured: true, sent: response.ok }
  } catch {
    return { configured: true, sent: false }
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function emailShell(title, body, footer = `If you did not request this, you can ignore this email. Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:#9a4b08;text-decoration:underline">Email Javelin support</a>.`) {
  return `<!doctype html><html><body style="margin:0;background:#f5f3ee;color:#24231f;font-family:Segoe UI,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ee;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#fffdf8;border:1px solid #ded8cb;border-radius:14px;padding:30px"><tr><td><div style="font-size:11px;letter-spacing:2px;font-weight:700;color:#b45309;margin-bottom:18px">JAVELIN ACCOUNTS</div><h1 style="font-size:23px;line-height:1.25;margin:0 0 16px">${title}</h1>${body}<p style="font-size:12px;line-height:1.6;color:#777167;margin:24px 0 0">${footer}</p></td></tr></table></td></tr></table></body></html>`
}

function supportEmailShell(body) {
  return `<!doctype html><html><body style="margin:0;background:#f5f3ee;color:#24231f;font-family:Segoe UI,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ee;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#fffdf8;border:1px solid #ded8cb;border-radius:14px;padding:30px"><tr><td><div style="font-size:11px;letter-spacing:2px;font-weight:700;color:#b45309;margin-bottom:18px">JAVELIN SUPPORT</div>${body}</td></tr></table></td></tr></table></body></html>`
}

function cleanSupportText(value, maxLength) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength)
}

function supportEmail({ topic, email, message, context, requestId }) {
  const label = SUPPORT_TOPICS[topic].label
  const details = [
    ['Reference', requestId],
    ['Topic', label],
    ['Reply to', email],
    context.appVersion ? ['App', `Javelin AI IDE ${context.appVersion}`] : null,
    context.mode ? ['Mode', context.mode] : null,
    context.provider ? ['Provider', context.provider] : null,
    context.platform ? ['Platform', context.platform] : null,
  ].filter(Boolean)
  const text = [
    'New Javelin support request',
    '',
    ...details.map(([key, value]) => `${key}: ${value}`),
    '',
    'Message:',
    message,
  ].join('\n')
  const detailRows = details.map(([key, value]) => `<tr><td style="padding:3px 12px 3px 0;color:#8a8377;vertical-align:top">${escapeHtml(key)}</td><td style="padding:3px 0;color:#24231f">${escapeHtml(value)}</td></tr>`).join('')
  return {
    subject: `[Javelin Support] ${label}`,
    replyTo: email,
    text,
    html: supportEmailShell(`<h1 style="font-size:23px;line-height:1.25;margin:0 0 16px">New support request</h1><table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:20px;font-size:13px">${detailRows}</table><div style="border-top:1px solid #ded8cb;padding-top:18px;font-size:14px;line-height:1.7;white-space:pre-wrap">${escapeHtml(message)}</div>`),
  }
}

async function ensureSupportSchema(env) {
  if (!env.DB || supportSchemaReady) return
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS support_requests (id TEXT PRIMARY KEY, client_hash TEXT NOT NULL, topic TEXT NOT NULL, created_at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS support_requests_client_idx ON support_requests(client_hash, created_at)'),
  ])
  supportSchemaReady = true
}

function supportClientId(request) {
  const ip = String(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
  const install = String(request.headers.get('x-javelin-install') || '').trim().slice(0, 80)
  return `${ip || 'no-ip'}|${install || 'no-install'}`
}

async function checkSupportRate(env, clientHash) {
  if (!env.DB) return { ok: true }
  try {
    await ensureSupportSchema(env)
    const now = Date.now()
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS count, MAX(created_at) AS last FROM support_requests WHERE client_hash = ? AND created_at > ?',
    )
      .bind(clientHash, now - 24 * 60 * 60 * 1000)
      .first()
    if (Number(row?.count ?? 0) >= SUPPORT_DAILY_LIMIT) {
      return { ok: false, message: 'You have reached the daily support message limit. Please try again tomorrow.' }
    }
    if (Number(row?.last ?? 0) > now - SUPPORT_COOLDOWN_MS) {
      return { ok: false, message: 'Please wait a moment before sending another support message.' }
    }
  } catch {
    // The form should still work during a storage hiccup; email remains the hard limit.
  }
  return { ok: true }
}

async function recordSupportRequest(env, clientHash, topic) {
  if (!env.DB) return
  try {
    await ensureSupportSchema(env)
    await env.DB.prepare('INSERT INTO support_requests (id, client_hash, topic, created_at) VALUES (?, ?, ?, ?)')
      .bind(crypto.randomUUID(), clientHash, topic, Date.now())
      .run()
  } catch {
    /* the message was already delivered; a missing audit row must not fail it */
  }
}

async function handleSupport(request, env) {
  if (request.method !== 'POST') return errorResponse('Use POST.', 405)
  if (!emailConfigured(env)) return errorResponse('Support email is not configured on this server yet.', 503)

  let body
  try {
    body = await request.json()
  } catch {
    return errorResponse('The request body must be JSON.', 400)
  }

  const topic = cleanSupportText(body?.topic, 20).toLowerCase()
  const email = cleanSupportText(body?.email, 254)
  const message = cleanSupportText(body?.message, 4000)
  if (!SUPPORT_TOPICS[topic]) return errorResponse('Choose a support topic.', 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errorResponse('Enter a valid email address so we can reply.', 400)
  if (message.length < 10) return errorResponse('Add a little more detail so we can help.', 400)

  const context = {
    appVersion: cleanSupportText(body?.appVersion, 40),
    mode: cleanSupportText(body?.mode, 40),
    provider: cleanSupportText(body?.provider, 80),
    platform: cleanSupportText(body?.platform, 120),
  }
  const clientHash = await sha256(supportClientId(request))
  const rate = await checkSupportRate(env, clientHash)
  if (!rate.ok) {
    return new Response(JSON.stringify({ error: { message: rate.message, type: 'javelin_support_error' } }), {
      status: 429,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30' },
    })
  }

  const requestId = crypto.randomUUID()
  const delivery = await deliverEmail(env, {
    to: SUPPORT_EMAIL,
    ...supportEmail({ topic, email, message, context, requestId }),
  })
  if (!delivery.sent) return errorResponse('We could not send your message. Try again in a moment.', 502)
  await recordSupportRequest(env, clientHash, topic)
  return json({ ok: true, requestId })
}

function verificationEmail(user, link) {
  const name = escapeHtml(user.username)
  return {
    subject: 'Verify your Javelin email',
    text: `Hi ${user.username},\n\nConfirm your email for Javelin AI:\n${link}\n\nThis link expires in 24 hours. If you did not create this account, ignore this email.`,
    html: emailShell('Verify your email', `<p style="font-size:14px;line-height:1.65">Hi ${name}, confirm this address so we can help you recover your Javelin account.</p><p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#b45309;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Verify email</a></p><p style="font-size:12px;line-height:1.6;color:#777167">Or paste this link into your browser:<br><a href="${link}" style="color:#9a4b08;word-break:break-all">${link}</a></p><p style="font-size:12px;line-height:1.6;color:#777167">This link expires in 24 hours.</p>`),
  }
}

function resetEmail(user, link) {
  const name = escapeHtml(user.username)
  return {
    subject: 'Reset your Javelin password',
    text: `Hi ${user.username},\n\nReset your Javelin password here:\n${link}\n\nThis link expires in one hour and can be used once. Resetting your password signs out other devices.`,
    html: emailShell('Reset your password', `<p style="font-size:14px;line-height:1.65">Hi ${name}, use the button below to choose a new password for your Javelin account.</p><p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#b45309;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Choose a new password</a></p><p style="font-size:12px;line-height:1.6;color:#777167">Or paste this link into your browser:<br><a href="${link}" style="color:#9a4b08;word-break:break-all">${link}</a></p><p style="font-size:12px;line-height:1.6;color:#777167">This link expires in one hour and can be used once. Resetting your password signs out other devices.</p>`),
  }
}

function loginEmail(user, link, code) {
  const name = escapeHtml(user.username)
  const codeText = escapeHtml(code)
  return {
    subject: 'Your Javelin sign-in link and code',
    text: `Hi ${user.username},\n\nPress the button in this email to sign in to Javelin:\n${link}\n\nIf the button does not work, enter this code in the Javelin IDE:\n${code}\n\nThe Javelin IDE will finish signing you in automatically. This link and code expire in 10 minutes and can be used once. If you did not request this, ignore this email.`,
    html: emailShell('Sign in to Javelin', `<p style="font-size:14px;line-height:1.65">Hi ${name}, press the button below to confirm your sign-in. The Javelin IDE will finish signing you in automatically.</p><p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#b45309;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Sign in to Javelin</a></p><p style="font-size:13px;line-height:1.6;color:#5d584f;margin:0 0 6px">If the button does not work, enter this code in the Javelin IDE:</p><div style="font-size:26px;letter-spacing:6px;font-weight:700;color:#24231f;background:#f5f3ee;border:1px solid #ded8cb;border-radius:8px;padding:12px 16px;display:inline-block">${codeText}</div><p style="font-size:12px;line-height:1.6;color:#777167;margin:22px 0 0">Or paste this link into your browser:<br><a href="${link}" style="color:#9a4b08;word-break:break-all">${link}</a></p><p style="font-size:12px;line-height:1.6;color:#777167">This link and code expire in 10 minutes and can be used once.</p>`),
  }
}

function banEmail(user, { reason, expiresAt }) {
  const name = escapeHtml(user.username)
  const safeReason = escapeHtml(reason || 'No reason was provided.')
  const access = expiresAt
    ? `Access returns: ${new Date(expiresAt).toUTCString()}`
    : 'This is a permanent suspension.'
  const safeAccess = escapeHtml(access)
  return {
    subject: 'Your Javelin account has been suspended',
    replyTo: SUPPORT_EMAIL,
    text: `Hi ${user.username},\n\nYour Javelin account has been suspended by Javelin moderation.\n\nReason: ${reason || 'No reason was provided.'}\n${access}\n\nIf you believe this was a mistake, contact Javelin support at ${SUPPORT_EMAIL}. Include your account email and this notice. Do not send your password or a sign-in code.`,
    html: emailShell(
      'Your account is suspended',
      `<p style="font-size:14px;line-height:1.65">Hi ${name}, Javelin moderation has suspended this account.</p><table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;font-size:13px"><tr><td style="padding:4px 14px 4px 0;color:#8a8377;vertical-align:top">Reason</td><td style="padding:4px 0;color:#24231f;font-weight:700">${safeReason}</td></tr><tr><td style="padding:4px 14px 4px 0;color:#8a8377;vertical-align:top">Access</td><td style="padding:4px 0;color:#24231f">${safeAccess}</td></tr></table><p style="font-size:13px;line-height:1.65">If you believe this was a mistake, reply to this email or contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#9a4b08;text-decoration:underline">Javelin support</a>. Include your account email and this notice. Do not send your password or a sign-in code.</p>`,
      `This notice was sent because this address belongs to a suspended Javelin account. Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:#9a4b08;text-decoration:underline">Email Javelin support</a>.`,
    ),
  }
}

function loginAlertEmail(user, { method, time, ip, region, device, lockLink }) {
  const name = escapeHtml(user.username)
  const methodLabel = method === 'email link' ? 'Email sign-in link' : method === 'email code' ? 'Email verification code' : 'Password'
  const detailRows = [
    ['Time', time],
    ['Method', methodLabel],
    region ? ['Approx. location', region] : null,
    ip ? ['IP address', ip] : null,
    device ? ['Device', device] : null,
  ].filter(Boolean)
  const text = [
    `Hi ${user.username},`,
    '',
    'A new sign-in to your Javelin account just happened.',
    '',
    ...detailRows.map(([label, value]) => `${label}: ${value}`),
    '',
    'If this was you, no action is needed.',
    'If this was not you, lock your account now:',
    lockLink,
    'That signs out every device and requires an email verification sign-in next time.',
    '',
    `Need help? Contact ${SUPPORT_EMAIL}. Do not send your password or a sign-in code.`,
  ].join('\n')
  return {
    subject: 'New sign-in to your Javelin account',
    replyTo: SUPPORT_EMAIL,
    text,
    html: emailShell(
      'New sign-in to your account',
      `<p style="font-size:14px;line-height:1.65">Hi ${name}, a new sign-in to your Javelin account just happened.</p><table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;font-size:13px">${detailRows.map(([label, value]) => `<tr><td style="padding:4px 14px 4px 0;color:#8a8377;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0;color:#24231f">${escapeHtml(value)}</td></tr>`).join('')}</table><p style="font-size:13px;line-height:1.65">If this was you, no action is needed.</p><p style="font-size:13px;line-height:1.65">If this was not you, lock the account immediately. That signs out every device and requires an email verification sign-in next time.</p><p style="margin:22px 0"><a href="${lockLink}" style="display:inline-block;background:#b91c1c;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Lock my account</a></p><p style="font-size:12px;line-height:1.6;color:#777167">Or paste this safety link into your browser:<br><a href="${lockLink}" style="color:#9a4b08;word-break:break-all">${lockLink}</a></p>`,
      `This security alert was sent to the email on your Javelin account. Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:#9a4b08;text-decoration:underline">Email Javelin support</a>.`,
    ),
  }
}

function accountOrigin(request, env) {
  return String(env.ACCOUNT_ORIGIN || new URL(request.url).origin).replace(/\/+$/, '')
}

async function issueEmailToken(env, userId, kind, ttl) {
  const token = randomToken()
  const tokenHash = await sha256(token)
  const now = Date.now()
  await env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL')
    .bind(now, userId, kind)
    .run()
  await env.DB.prepare('INSERT INTO email_tokens (token_hash, user_id, kind, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)')
    .bind(tokenHash, userId, kind, now, now + ttl)
    .run()
  return token
}

async function sendVerificationEmail(env, request, user) {
  try {
    const token = await issueEmailToken(env, user.id, 'verify', VERIFICATION_TTL_MS)
    const link = `${accountOrigin(request, env)}/account/verify?token=${encodeURIComponent(token)}`
    return await deliverEmail(env, { to: user.email, ...verificationEmail(user, link) })
  } catch {
    return { configured: emailConfigured(env), sent: false }
  }
}

async function sendPasswordResetEmail(env, request, user) {
  try {
    const token = await issueEmailToken(env, user.id, 'reset', RESET_TTL_MS)
    const link = `${accountOrigin(request, env)}/account/reset?token=${encodeURIComponent(token)}`
    return await deliverEmail(env, { to: user.email, ...resetEmail(user, link) })
  } catch {
    return { configured: emailConfigured(env), sent: false }
  }
}

async function sendBanEmail(env, user, ban) {
  try {
    return await deliverEmail(env, { to: user.email, ...banEmail(user, ban) })
  } catch {
    return { configured: emailConfigured(env), sent: false }
  }
}

async function sendLoginAlert(env, request, userId, method) {
  try {
    const user = await env.DB.prepare(
      'SELECT username, email, login_alerts FROM users WHERE id = ?',
    )
      .bind(userId)
      .first()
    if (!user || Number(user.login_alerts) === 0) return { skipped: true, sent: false }
    const headers = request.headers
    const forwarded = String(headers.get('x-forwarded-for') || '').split(',')[0].trim()
    const ip = cleanHeader(headers.get('cf-connecting-ip') || forwarded).slice(0, 64)
    const region = cleanHeader(headers.get('cf-ipcountry') || headers.get('x-vercel-ip-country')).slice(0, 80)
    const device = cleanHeader(headers.get('user-agent')).slice(0, 180)
    const lockToken = await issueEmailToken(env, userId, 'lock', LOCK_LINK_TTL_MS)
    const lockLink = `${accountOrigin(request, env)}/account/lock?token=${encodeURIComponent(lockToken)}`
    return await deliverEmail(env, {
      to: user.email,
      ...loginAlertEmail(user, {
        method,
        time: new Date().toUTCString(),
        ip,
        region,
        device,
        lockLink,
      }),
    })
  } catch {
    return { configured: emailConfigured(env), sent: false }
  }
}

function queueLoginAlert(env, ctx, request, userId, method) {
  const task = sendLoginAlert(env, request, userId, method).catch(() => {})
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task)
  else void task
  return task
}

async function createEmailLoginRequest(env, request, email) {
  if (!emailConfigured(env)) {
    return { error: authError('Email delivery is not configured on this server yet.', 'EMAIL_NOT_CONFIGURED', 503) }
  }
  const emailLower = String(email).trim().toLowerCase()
  const now = Date.now()
  await env.DB.prepare('DELETE FROM login_requests WHERE expires_at <= ?').bind(now).run()
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS count, MAX(created_at) AS last FROM login_requests WHERE email_lower = ? AND created_at > ?',
  )
    .bind(emailLower, now - 60 * 60 * 1000)
    .first()
  if (Number(recent?.count ?? 0) >= EMAIL_HOURLY_LIMIT || Number(recent?.last ?? 0) > now - EMAIL_COOLDOWN_MS) {
    return { ok: true, cooldown: true }
  }

  const user = await env.DB.prepare(
    'SELECT id, username, email, role, created_at, email_verified_at FROM users WHERE email_lower = ?',
  )
    .bind(emailLower)
    .first()
  if (user) {
    const ban = await activeBan(env, user.id)
    if (ban) return { error: bannedAuthError(ban) }
  }
  const requestId = crypto.randomUUID()
  const emailToken = randomToken()
  const pollToken = randomToken()
  const code = loginCode()
  const [emailTokenHash, pollTokenHash, codeHash] = await Promise.all([
    sha256(emailToken), sha256(pollToken), sha256(code),
  ])
  const expiresAt = now + LOGIN_TTL_MS
  await env.DB.prepare(
    'INSERT INTO login_requests (id, user_id, email_lower, email_token_hash, poll_token_hash, login_code_hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?, ?)',
  )
    .bind(requestId, user?.id ?? null, emailLower, emailTokenHash, pollTokenHash, codeHash, now, expiresAt)
    .run()

  // The response is deliberately the same for known and unknown addresses.
  // An unknown address gets a harmless pending request; it can never be approved.
  if (user) {
    const link = `${accountOrigin(request, env)}/account/email-login?token=${encodeURIComponent(emailToken)}`
    const delivery = await deliverEmail(env, { to: user.email, ...loginEmail(publicUser(user), link, code) })
    if (!delivery.sent) {
      await env.DB.prepare('DELETE FROM login_requests WHERE id = ?').bind(requestId).run()
      return { error: authError('We could not send the sign-in email. Try again in a moment.', 'EMAIL_DELIVERY_FAILED', 502) }
    }
  }
  return { ok: true, requestId, pollToken, expiresAt: new Date(expiresAt).toISOString() }
}

async function ensureAuthSchema(env) {
  if (!env.DB) throw new Error('Account storage is not configured.')
  if (authSchemaReady) return
  await env.DB.batch([
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, email TEXT NOT NULL, email_lower TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, iterations INTEGER NOT NULL, role TEXT NOT NULL DEFAULT \'member\', created_at TEXT NOT NULL, email_verified_at TEXT, require_email_verification INTEGER NOT NULL DEFAULT 0, login_alerts INTEGER NOT NULL DEFAULT 1, account_locked_at TEXT)',
    ),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
    ),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS email_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)',
    ),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS login_requests (id TEXT PRIMARY KEY, user_id TEXT, email_lower TEXT NOT NULL, email_token_hash TEXT NOT NULL, poll_token_hash TEXT NOT NULL, login_code_hash TEXT, code_attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT \'pending\', session_token TEXT, session_expires_at INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)',
    ),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS moderation_actions (id TEXT PRIMARY KEY, action TEXT NOT NULL, target_user_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, expires_at INTEGER)',
    ),
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS chat_history (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    ),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id, kind, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS login_requests_email_idx ON login_requests(email_lower, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS login_requests_token_idx ON login_requests(email_token_hash)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS moderation_actions_created_idx ON moderation_actions(created_at)'),
  ])
  // Existing deployments predate email verification; add the column once.
  try {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN email_verified_at TEXT').run()
  } catch {
    /* the column is already present */
  }
  for (const column of [
    'banned_at TEXT',
    'ban_reason TEXT',
    'ban_expires_at TEXT',
    'banned_by TEXT',
    'require_email_verification INTEGER NOT NULL DEFAULT 0',
    'login_alerts INTEGER NOT NULL DEFAULT 1',
    'account_locked_at TEXT',
  ]) {
    try {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${column}`).run()
    } catch {
      /* the column is already present */
    }
  }
  // Existing login requests predate the fallback code; add its columns once.
  try {
    await env.DB.prepare('ALTER TABLE login_requests ADD COLUMN login_code_hash TEXT').run()
  } catch {
    /* the column is already present */
  }
  try {
    await env.DB.prepare('ALTER TABLE login_requests ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0').run()
  } catch {
    /* the column is already present */
  }
  authSchemaReady = true
}

async function readAuthBody(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

async function createSession(env, user) {
  const token = randomToken()
  const tokenHash = await sha256(token)
  const createdAt = Date.now()
  const expiresAt = createdAt + SESSION_TTL_MS
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?')
    .bind(user.id, createdAt)
    .run()
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, user.id, createdAt, expiresAt)
    .run()
  return { token, expiresAt: new Date(expiresAt).toISOString(), user }
}

async function approveLoginRequest(env, row, request, ctx, method = 'email link') {
  const now = Date.now()
  const claimed = await env.DB.prepare(
    "UPDATE login_requests SET status = 'approved', used_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
  )
    .bind(now, row.id, now)
    .run()
  if (Number(claimed?.meta?.changes ?? claimed?.changes ?? 0) < 1) {
    return { ok: false, message: 'That sign-in link was already used.' }
  }
  const user = await env.DB.prepare(
    'SELECT id, username, email, role, created_at, email_verified_at FROM users WHERE id = ?',
  )
    .bind(row.user_id)
    .first()
  if (!user) return { ok: false, message: 'That sign-in link is invalid.' }
  const ban = await activeBan(env, row.user_id)
  if (ban) return { ok: false, banned: true, ban, message: 'That account is suspended.' }
  await env.DB.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), account_locked_at = NULL WHERE id = ?')
    .bind(new Date(now).toISOString(), row.user_id)
    .run()
  const verified = await env.DB.prepare(
    'SELECT id, username, email, role, created_at, email_verified_at FROM users WHERE id = ?',
  )
    .bind(row.user_id)
    .first()
  const session = await createSession(env, publicUser(verified))
  await env.DB.prepare(
    "UPDATE login_requests SET status = 'ready', session_token = ?, session_expires_at = ? WHERE id = ?",
  )
    .bind(session.token, Date.parse(session.expiresAt), row.id)
    .run()
  queueLoginAlert(env, ctx, request, row.user_id, method)
  return { ok: true, session }
}

async function approveLoginToken(env, token, request, ctx) {
  if (String(token).trim().length < 20) return { ok: false, message: 'That sign-in link is not valid.' }
  const tokenHash = await sha256(String(token).trim())
  const now = Date.now()
  const row = await env.DB.prepare(
    'SELECT id, user_id, status, expires_at FROM login_requests WHERE email_token_hash = ?',
  )
    .bind(tokenHash)
    .first()
  if (!row || !row.user_id || row.status !== 'pending' || Number(row.expires_at) <= now) {
    return { ok: false, message: 'That sign-in link is invalid, expired or already used.' }
  }
  return approveLoginRequest(env, row, request, ctx, 'email link')
}

async function currentAccount(request, env) {
  if (!env.DB) return null
  const header = request.headers.get('authorization') || ''
  if (!header.toLowerCase().startsWith('bearer ')) return null
  const token = header.slice(7).trim()
  if (!token.startsWith('jv_')) return null
  await ensureAuthSchema(env)
  const tokenHash = await sha256(token)
  const row = await env.DB.prepare(
    'SELECT u.id AS id, u.username AS username, u.email AS email, u.role AS role, u.created_at AS created_at, u.email_verified_at AS email_verified_at, s.expires_at AS expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  )
    .bind(tokenHash)
    .first()
  if (!row || Number(row.expires_at) <= Date.now()) return null
  return publicUser(row)
}

async function activeBan(env, userId) {
  if (!env.DB || !userId) return null
  const row = await env.DB.prepare(
    'SELECT banned_at, ban_reason, ban_expires_at FROM users WHERE id = ?',
  )
    .bind(userId)
    .first()
  if (!row?.banned_at) return null
  if (row.ban_expires_at && Date.parse(row.ban_expires_at) <= Date.now()) return null
  return {
    reason: row.ban_reason || 'No reason was provided.',
    expiresAt: row.ban_expires_at || null,
    bannedAt: row.banned_at,
  }
}

async function currentUser(request, env) {
  const user = await currentAccount(request, env)
  if (!user) return null
  return (await activeBan(env, user.id)) ? null : user
}

async function currentSessionUser(request, env) {
  const user = await currentAccount(request, env)
  if (!user) return null
  return { user, ban: await activeBan(env, user.id) }
}

function isAdminRole(role) {
  return role === 'owner' || role === 'staff'
}

function bannedAuthError(ban) {
  return authError(
    'This account is suspended. Contact support if you believe this is a mistake.',
    'ACCOUNT_BANNED',
    403,
    { ban },
  )
}

function adminUser(row) {
  const banActive = Boolean(row.banned_at) && (!row.ban_expires_at || Date.parse(row.ban_expires_at) > Date.now())
  return {
    ...publicUser(row),
    banned: banActive,
    bannedAt: row.banned_at || null,
    banReason: row.ban_reason || null,
    banExpiresAt: row.ban_expires_at || null,
  }
}

function securitySettings(row, user, env) {
  return {
    requireEmailVerification: Number(row.require_email_verification) === 1,
    loginAlerts: Number(row.login_alerts) !== 0,
    emailVerified: Boolean(user.emailVerified),
    emailConfigured: emailConfigured(env),
    locked: Boolean(row.account_locked_at),
  }
}

function cleanAdminText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

async function findAdminTarget(env, identifier) {
  const value = String(identifier ?? '').trim()
  if (!value) return null
  const lower = value.toLowerCase()
  return env.DB.prepare(
    'SELECT id, username, email, role, created_at, email_verified_at, banned_at, ban_reason, ban_expires_at FROM users WHERE id = ? OR username_lower = ? OR email_lower = ?',
  )
    .bind(value, lower, lower)
    .first()
}

async function logAdminAction(env, action, targetId, actorId, reason, expiresAt = null) {
  try {
    await env.DB.prepare(
      'INSERT INTO moderation_actions (id, action, target_user_id, actor_user_id, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(crypto.randomUUID(), action, targetId, actorId, reason, Date.now(), expiresAt)
      .run()
  } catch {
    /* moderation still applies if the audit write fails */
  }
}

async function handleAdmin(request, env, path) {
  const actor = await currentUser(request, env)
  if (!actor) return authError('Sign in with an owner or staff account.', 'SESSION_EXPIRED', 401)
  if (!isAdminRole(actor.role)) return authError('Admin access is required.', 'ADMIN_REQUIRED', 403)

  if (path === '/admin/users' || path === '/admin/stats') {
    if (request.method !== 'GET') return authError('Use GET.', 'METHOD_NOT_ALLOWED', 405)
    const rows = await env.DB.prepare(
      'SELECT id, username, email, role, created_at, email_verified_at, banned_at, ban_reason, ban_expires_at FROM users ORDER BY created_at DESC LIMIT 200',
    ).all()
    const allUsers = rows?.results ?? []
    if (path === '/admin/stats') {
      const now = Date.now()
      const activeBans = allUsers.filter((row) => row.banned_at && (!row.ban_expires_at || Date.parse(row.ban_expires_at) > now)).length
      return json({
        total: allUsers.length,
        owners: allUsers.filter((row) => row.role === 'owner').length,
        staff: allUsers.filter((row) => row.role === 'staff').length,
        members: allUsers.filter((row) => row.role === 'member').length,
        banned: activeBans,
      })
    }
    const query = cleanAdminText(new URL(request.url).searchParams.get('query'), 80).toLowerCase()
    const users = allUsers
      .filter((row) => !query || row.username.toLowerCase().includes(query) || row.email.toLowerCase().includes(query))
      .slice(0, 100)
      .map(adminUser)
    return json({ users })
  }

  if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
  const body = await readAuthBody(request)
  if (!body) return authError('The request body must be JSON.', 'INVALID_JSON')
  const target = await findAdminTarget(env, body.identifier || body.userId)
  if (!target) return authError('That account was not found.', 'ADMIN_USER_NOT_FOUND', 404)
  if (target.id === actor.id) return authError('You cannot change your own moderation status.', 'ADMIN_SELF_TARGET', 400)
  if (target.role === 'owner') return authError('Owner accounts are protected from moderation changes.', 'ADMIN_OWNER_PROTECTED', 403)
  if (actor.role === 'staff' && target.role !== 'member') {
    return authError('Staff can only moderate member accounts.', 'ADMIN_ROLE_REQUIRED', 403)
  }

  if (path === '/admin/ban') {
    const reason = cleanAdminText(body.reason, 300) || 'No reason provided.'
    const days = body.days === undefined || body.days === null || body.days === 0 ? 0 : Number(body.days)
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      return authError('Ban duration must be between 1 and 3650 days, or permanent.', 'INVALID_BAN_DURATION', 400)
    }
    const now = new Date()
    const expiresAt = days ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString() : null
    await env.DB.prepare('UPDATE users SET banned_at = ?, ban_reason = ?, ban_expires_at = ?, banned_by = ? WHERE id = ?')
      .bind(now.toISOString(), reason, expiresAt, actor.id, target.id)
      .run()
    // Keep the session row so an already-open app can receive the ban details
    // from /me and show the suspension screen. Every authenticated route still
    // rejects the session while the ban is active.
    await logAdminAction(env, 'ban', target.id, actor.id, reason, expiresAt)
    const notification = await sendBanEmail(env, target, { reason, expiresAt })
    return json({
      ok: true,
      user: adminUser({ ...target, banned_at: now.toISOString(), ban_reason: reason, ban_expires_at: expiresAt }),
      notification,
    })
  }

  if (path === '/admin/unban') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run()
    await env.DB.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL, ban_expires_at = NULL, banned_by = NULL WHERE id = ?')
      .bind(target.id)
      .run()
    await logAdminAction(env, 'unban', target.id, actor.id, cleanAdminText(body.reason, 300) || null)
    return json({ ok: true, user: adminUser({ ...target, banned_at: null, ban_reason: null, ban_expires_at: null }) })
  }

  if (path === '/admin/role') {
    if (actor.role !== 'owner') return authError('Only the owner can change staff roles.', 'OWNER_REQUIRED', 403)
    const role = String(body.role || '').toLowerCase()
    if (role !== 'staff' && role !== 'member') return authError('Choose staff or member.', 'INVALID_ROLE', 400)
    await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, target.id).run()
    await logAdminAction(env, `role:${role}`, target.id, actor.id, null)
    return json({ ok: true, user: adminUser({ ...target, role }) })
  }

  return authError('Not found.', 'NOT_FOUND', 404)
}

async function handleAuth(request, env, path, ctx) {
  try {
    await ensureAuthSchema(env)
  } catch {
    return authError('Account storage is not available right now.', 'AUTH_UNAVAILABLE', 503)
  }

  if (path.startsWith('/admin/')) return handleAdmin(request, env, path)

  if (path === '/signup') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    if (!body) return authError('The request body must be JSON.', 'INVALID_JSON')

    const username = String(body.username ?? '').trim()
    const email = String(body.email ?? '').trim()
    const password = String(body.password ?? '')
    const ownerCode = String(body.ownerCode ?? '')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,23}$/.test(username)) {
      return authError('Use 3–24 letters, numbers, dots, dashes or underscores for the username.', 'INVALID_USERNAME')
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return authError('Enter a valid email address.', 'INVALID_EMAIL')
    }
    if (password.length < 8 || password.length > 200) {
      return authError('Use a password between 8 and 200 characters.', 'INVALID_PASSWORD')
    }

    const usernameLower = username.toLowerCase()
    const emailLower = email.toLowerCase()
    const wantsOwner = usernameLower === OWNER_USERNAME
    if (wantsOwner) {
      if (!env.OWNER_SIGNUP_CODE) return authError('Owner signup is not configured on this server.', 'OWNER_NOT_CONFIGURED', 403)
      if (!equalText(ownerCode, env.OWNER_SIGNUP_CODE)) return authError('That owner setup code is not valid.', 'INVALID_OWNER_CODE', 403)
    }

    const existingUsername = await env.DB.prepare('SELECT id FROM users WHERE username_lower = ?').bind(usernameLower).first()
    if (existingUsername) return authError('That username is already taken.', 'USERNAME_TAKEN', 409)
    const existingEmail = await env.DB.prepare('SELECT id FROM users WHERE email_lower = ?').bind(emailLower).first()
    if (existingEmail) return authError('An account with that email already exists.', 'EMAIL_TAKEN', 409)

    const salt = crypto.getRandomValues(new Uint8Array(16))
    const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS)
    const row = {
      id: crypto.randomUUID(),
      username,
      username_lower: usernameLower,
      email,
      email_lower: emailLower,
      password_hash: bytesToBase64(hash),
      password_salt: bytesToBase64(salt),
      iterations: PASSWORD_ITERATIONS,
      role: wantsOwner ? 'owner' : 'member',
      created_at: new Date().toISOString(),
    }
    try {
      await env.DB.prepare(
        'INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, password_salt, iterations, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(row.id, row.username, row.username_lower, row.email, row.email_lower, row.password_hash, row.password_salt, row.iterations, row.role, row.created_at)
        .run()
    } catch {
      return authError('That username or email is already registered.', 'ACCOUNT_EXISTS', 409)
    }
    const user = publicUser(row)
    const emailDelivery = await sendVerificationEmail(env, request, user)
    return json({ session: await createSession(env, user), email: emailDelivery }, 201)
  }

  if (path === '/login') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    if (!body) return authError('The request body must be JSON.', 'INVALID_JSON')
    const identifier = String(body.identifier ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    if (!identifier || !password) return authError('Enter your username or email and password.', 'MISSING_CREDENTIALS')
    const row = await env.DB.prepare(
      'SELECT id, username, email, role, created_at, email_verified_at, password_hash, password_salt, iterations, require_email_verification, account_locked_at FROM users WHERE username_lower = ? OR email_lower = ?',
    )
      .bind(identifier, identifier)
      .first()
    if (!row) return authError('The username or password is incorrect.', 'INVALID_CREDENTIALS', 401)
    const actual = await derivePassword(password, base64ToBytes(row.password_salt), Number(row.iterations) || PASSWORD_ITERATIONS)
    if (!equalBytes(actual, base64ToBytes(row.password_hash))) {
      return authError('The username or password is incorrect.', 'INVALID_CREDENTIALS', 401)
    }
    const ban = await activeBan(env, row.id)
    if (ban) return bannedAuthError(ban)
    if (row.account_locked_at) {
      return authError(
        'This account is locked. Use the email sign-in link or 6-digit code to unlock it.',
        'ACCOUNT_LOCKED',
        403,
      )
    }
    if (Number(row.require_email_verification) === 1) {
      // Requiring verification applies to every password sign-in, including
      // accounts whose email was verified before the setting was enabled.
      // Issue the same one-time email challenge used by the Email link tab.
      const verification = await createEmailLoginRequest(env, request, row.email)
      if (verification.error) return verification.error
      const details = {
        email: row.email,
        emailSent: Boolean(verification.requestId) && !verification.cooldown,
        cooldown: Boolean(verification.cooldown),
      }
      if (verification.requestId) {
        details.requestId = verification.requestId
        details.pollToken = verification.pollToken
      }
      return authError(
        verification.cooldown
          ? 'Email verification is required. A sign-in email was sent recently. Use the link in that email, or wait a minute and try again.'
          : 'Email verification is required. We sent a sign-in link and 6-digit code to your email.',
        'EMAIL_VERIFICATION_REQUIRED',
        403,
        details,
      )
    }
    const session = await createSession(env, publicUser(row))
    queueLoginAlert(env, ctx, request, row.id, 'password')
    return json({ session })
  }

  if (path === '/email-login/request') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    if (!body) return authError('The request body must be JSON.', 'INVALID_JSON')
    const email = String(body.email ?? '').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return authError('Enter a valid email address.', 'INVALID_EMAIL')
    }
    const result = await createEmailLoginRequest(env, request, email)
    if (result.error) return result.error
    return json({
      ok: true,
      ...(result.cooldown ? { cooldown: true } : {
        requestId: result.requestId,
        pollToken: result.pollToken,
        expiresAt: result.expiresAt,
      }),
    })
  }

  if (path === '/email-login/approve') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    const token = String(body?.token ?? '').trim()
    const result = await approveLoginToken(env, token, request, ctx)
    if (result.banned) return bannedAuthError(result.ban)
    if (!result.ok) return authError(result.message || 'That sign-in link is invalid.', 'INVALID_LOGIN_TOKEN', 400)
    return json({ ok: true, signedIn: true })
  }

  if (path === '/email-login/code') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    const requestId = String(body?.requestId ?? '').trim()
    const code = String(body?.code ?? '').trim()
    if (!requestId || !/^\d{6}$/.test(code)) return authError('Enter the 6-digit code from the email.', 'INVALID_LOGIN_CODE', 400)
    const now = Date.now()
    const row = await env.DB.prepare(
      'SELECT id, user_id, status, expires_at, login_code_hash, code_attempts FROM login_requests WHERE id = ?',
    )
      .bind(requestId)
      .first()
    if (!row || !row.user_id || row.status !== 'pending' || Number(row.expires_at) <= now || Number(row.code_attempts) >= 5) {
      return authError('That code is invalid or has expired. Request a new sign-in email.', 'INVALID_LOGIN_CODE', 400)
    }
    const codeHash = await sha256(code)
    if (!row.login_code_hash || !equalText(row.login_code_hash, codeHash)) {
      await env.DB.prepare('UPDATE login_requests SET code_attempts = code_attempts + 1 WHERE id = ? AND status = \'pending\'')
        .bind(row.id)
        .run()
      return authError('That code is not valid. Check the email and try again.', 'INVALID_LOGIN_CODE', 400)
    }
    const result = await approveLoginRequest(env, row, request, ctx, 'email code')
    if (result.banned) return bannedAuthError(result.ban)
    if (!result.ok) return authError(result.message || 'That code is no longer valid.', 'INVALID_LOGIN_CODE', 400)
    return json({ ok: true, signedIn: true, session: result.session })
  }

  if (path === '/email-login/poll') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    const requestId = String(body?.requestId ?? '').trim()
    const pollToken = String(body?.pollToken ?? '').trim()
    if (!requestId || !pollToken) return authError('Missing sign-in request details.', 'INVALID_LOGIN_REQUEST', 400)
    const pollHash = await sha256(pollToken)
    const row = await env.DB.prepare(
      'SELECT id, user_id, status, session_token, session_expires_at, expires_at FROM login_requests WHERE id = ? AND poll_token_hash = ?',
    )
      .bind(requestId, pollHash)
      .first()
    if (!row) return authError('This sign-in request is not valid.', 'INVALID_LOGIN_REQUEST', 404)
    if (Number(row.expires_at) <= Date.now() || row.status === 'expired' || row.status === 'consumed') {
      return json({ status: 'expired' })
    }
    if (row.status === 'pending' || row.status === 'approved') return json({ status: 'pending' })
    if (row.status !== 'ready' || !row.session_token || !row.session_expires_at) {
      return json({ status: 'expired' })
    }
    const sessionToken = row.session_token
    const sessionExpiresAt = row.session_expires_at
    const user = await env.DB.prepare(
      'SELECT id, username, email, role, created_at, email_verified_at FROM users WHERE id = ?',
    )
      .bind(row.user_id)
      .first()
    if (!user) return json({ status: 'expired' })
    const ban = await activeBan(env, user.id)
    if (ban) return bannedAuthError(ban)
    const consumed = await env.DB.prepare(
      "UPDATE login_requests SET status = 'consumed', session_token = NULL WHERE id = ? AND status = 'ready'",
    )
      .bind(row.id)
      .run()
    if (Number(consumed?.meta?.changes ?? consumed?.changes ?? 0) < 1) return json({ status: 'expired' })
    return json({
      status: 'signed-in',
      session: {
        token: sessionToken,
        expiresAt: new Date(Number(sessionExpiresAt)).toISOString(),
        user: publicUser(user),
      },
    })
  }

  if (path === '/history') {
    const user = await currentUser(request, env)
    if (!user) return authError('Your session has expired. Sign in again.', 'SESSION_EXPIRED', 401)

    if (request.method === 'GET') {
      const row = await env.DB.prepare('SELECT payload, updated_at FROM chat_history WHERE user_id = ?')
        .bind(user.id)
        .first()
      let history = { version: 1, conversations: [], deleted: {} }
      if (row?.payload) {
        try {
          history = normalizeHistoryDocument(JSON.parse(row.payload))
        } catch {
          history = { version: 1, conversations: [], deleted: {} }
        }
      }
      return json({ history, updatedAt: Number(row?.updated_at) || null })
    }

    if (request.method !== 'POST') return authError('Use GET or POST.', 'METHOD_NOT_ALLOWED', 405)
    const contentLength = Number(request.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > HISTORY_MAX_BYTES) {
      return authError('This chat history is too large to sync.', 'HISTORY_TOO_LARGE', 413)
    }
    const body = await readAuthBody(request)
    if (!body) return authError('The request body must be JSON.', 'INVALID_JSON')
    const incoming = body.history ?? body
    if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.conversations)) {
      return authError('The request does not contain a chat history.', 'INVALID_HISTORY', 400)
    }

    const row = await env.DB.prepare('SELECT payload FROM chat_history WHERE user_id = ?')
      .bind(user.id)
      .first()
    let existing = null
    if (row?.payload) {
      try {
        existing = JSON.parse(row.payload)
      } catch {
        existing = null
      }
    }
    const merged = mergeHistoryPayloads(existing, incoming)
    const serialized = JSON.stringify(merged)
    if (new TextEncoder().encode(serialized).length > HISTORY_MAX_BYTES) {
      return authError('This chat history is too large to sync.', 'HISTORY_TOO_LARGE', 413)
    }
    const updatedAt = Date.now()
    await env.DB.prepare(
      'INSERT INTO chat_history (user_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
    )
      .bind(user.id, serialized, updatedAt)
      .run()
    return json({ history: merged, updatedAt })
  }

  if (path === '/me') {
    if (request.method !== 'GET') return authError('Use GET.', 'METHOD_NOT_ALLOWED', 405)
    const session = await currentSessionUser(request, env)
    if (!session) return authError('Your session has expired. Sign in again.', 'SESSION_EXPIRED', 401)
    if (session.ban) return bannedAuthError(session.ban)
    return json({ user: session.user })
  }

  if (path === '/logout') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const header = request.headers.get('authorization') || ''
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    if (token) {
      const tokenHash = await sha256(token)
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    }
    return json({ ok: true })
  }

  if (path === '/config') {
    if (request.method !== 'GET') return authError('Use GET.', 'METHOD_NOT_ALLOWED', 405)
    return json({ emailConfigured: emailConfigured(env), emailVerification: true, emailLogin: true, passwordReset: true })
  }

  if (path === '/security') {
    const user = await currentUser(request, env)
    if (!user) return authError('Your session has expired. Sign in again.', 'SESSION_EXPIRED', 401)
    if (request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT require_email_verification, login_alerts, account_locked_at FROM users WHERE id = ?',
      ).bind(user.id).first()
      if (!row) return authError('That account was not found.', 'ACCOUNT_NOT_FOUND', 404)
      return json({ settings: securitySettings(row, user, env) })
    }
    if (request.method !== 'POST') return authError('Use GET or POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    if (!body) return authError('The request body must be JSON.', 'INVALID_JSON')
    let verification = null
    let changed = false
    if (Object.prototype.hasOwnProperty.call(body, 'requireEmailVerification')) {
      const enabled = parseBoolean(body.requireEmailVerification, false)
      if (enabled && !user.emailVerified && !emailConfigured(env)) {
        return authError('Email delivery is not configured, so email verification cannot be required yet.', 'EMAIL_NOT_CONFIGURED', 503)
      }
      await env.DB.prepare('UPDATE users SET require_email_verification = ? WHERE id = ?')
        .bind(enabled ? 1 : 0, user.id)
        .run()
      changed = true
      if (enabled && !user.emailVerified) verification = await sendVerificationEmail(env, request, user)
    }
    if (Object.prototype.hasOwnProperty.call(body, 'loginAlerts')) {
      await env.DB.prepare('UPDATE users SET login_alerts = ? WHERE id = ?')
        .bind(parseBoolean(body.loginAlerts, true) ? 1 : 0, user.id)
        .run()
      changed = true
    }
    if (!changed) return authError('Choose a security setting to update.', 'NO_SETTING_CHANGED', 400)
    const row = await env.DB.prepare(
      'SELECT require_email_verification, login_alerts, account_locked_at FROM users WHERE id = ?',
    ).bind(user.id).first()
    return json({ settings: securitySettings(row, user, env), verification })
  }

  if (path === '/security/lock') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    if (!emailConfigured(env)) return authError('Email delivery is not configured, so account locking is unavailable.', 'EMAIL_NOT_CONFIGURED', 503)
    const user = await currentUser(request, env)
    if (!user) return authError('Your session has expired. Sign in again.', 'SESSION_EXPIRED', 401)
    await env.DB.prepare('UPDATE users SET account_locked_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), user.id)
      .run()
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run()
    return json({ ok: true, locked: true })
  }

  if (path === '/verify-email') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    const token = String(body?.token ?? '').trim()
    if (token.length < 20) return authError('That verification link is not valid.', 'INVALID_VERIFICATION_TOKEN', 400)
    const tokenHash = await sha256(token)
    const row = await env.DB.prepare('SELECT user_id, kind, expires_at, used_at FROM email_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .first()
    if (!row || row.kind !== 'verify' || row.used_at || Number(row.expires_at) <= Date.now()) {
      return authError('That verification link is invalid or has expired. Request a new one.', 'INVALID_VERIFICATION_TOKEN', 400)
    }
    const now = Date.now()
    const consumed = await env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .bind(now, tokenHash, now)
      .run()
    if (Number(consumed?.meta?.changes ?? consumed?.changes ?? 0) < 1) {
      return authError('That verification link was already used.', 'INVALID_VERIFICATION_TOKEN', 400)
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').bind(new Date(now).toISOString(), row.user_id),
      env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').bind(now, row.user_id, 'verify'),
    ])
    return json({ ok: true, verified: true })
  }

  if (path === '/verify-email/resend') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const user = await currentUser(request, env)
    if (!user) return authError('Your session has expired. Sign in again.', 'SESSION_EXPIRED', 401)
    if (user.emailVerified) return json({ ok: true, alreadyVerified: true })
    const now = Date.now()
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS count, MAX(created_at) AS last FROM email_tokens WHERE user_id = ? AND kind = ? AND created_at > ?',
    )
      .bind(user.id, 'verify', now - 60 * 60 * 1000)
      .first()
    if (Number(recent?.count ?? 0) >= EMAIL_HOURLY_LIMIT || Number(recent?.last ?? 0) > now - EMAIL_COOLDOWN_MS) {
      return json({ ok: true, cooldown: true })
    }
    const delivery = await sendVerificationEmail(env, request, user)
    return json({ ok: true, sent: delivery.sent, configured: delivery.configured })
  }

  if (path === '/password-reset/request') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    if (!emailConfigured(env)) return authError('Email delivery is not configured on this server yet.', 'EMAIL_NOT_CONFIGURED', 503)
    const body = await readAuthBody(request)
    const email = String(body?.email ?? '').trim()
    if (!email) return json({ ok: true })
    const row = await env.DB.prepare('SELECT id, username, email, email_verified_at FROM users WHERE email_lower = ?')
      .bind(email.toLowerCase())
      .first()
    if (!row) return json({ ok: true })
    const now = Date.now()
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS count, MAX(created_at) AS last FROM email_tokens WHERE user_id = ? AND kind = ? AND created_at > ?',
    )
      .bind(row.id, 'reset', now - 60 * 60 * 1000)
      .first()
    if (Number(recent?.count ?? 0) < EMAIL_HOURLY_LIMIT && Number(recent?.last ?? 0) <= now - EMAIL_COOLDOWN_MS) {
      await sendPasswordResetEmail(env, request, { ...publicUser(row), email: row.email })
    }
    // Always answer the same way: this endpoint must not reveal whether an account exists.
    return json({ ok: true })
  }

  if (path === '/password-reset/confirm') {
    if (request.method !== 'POST') return authError('Use POST.', 'METHOD_NOT_ALLOWED', 405)
    const body = await readAuthBody(request)
    const token = String(body?.token ?? '').trim()
    const password = String(body?.password ?? '')
    if (password.length < 8 || password.length > 200) {
      return authError('Use a password between 8 and 200 characters.', 'INVALID_PASSWORD')
    }
    if (token.length < 20) return authError('That reset link is not valid.', 'INVALID_RESET_TOKEN', 400)
    const tokenHash = await sha256(token)
    const row = await env.DB.prepare('SELECT user_id, kind, expires_at, used_at FROM email_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .first()
    if (!row || row.kind !== 'reset' || row.used_at || Number(row.expires_at) <= Date.now()) {
      return authError('That reset link is invalid or has expired. Request a new one.', 'INVALID_RESET_TOKEN', 400)
    }
    const now = Date.now()
    const consumed = await env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .bind(now, tokenHash, now)
      .run()
    if (Number(consumed?.meta?.changes ?? consumed?.changes ?? 0) < 1) {
      return authError('That reset link was already used.', 'INVALID_RESET_TOKEN', 400)
    }
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS)
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
        .bind(bytesToBase64(hash), bytesToBase64(salt), PASSWORD_ITERATIONS, new Date(now).toISOString(), row.user_id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
      env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').bind(now, row.user_id, 'reset'),
    ])
    return json({ ok: true, passwordReset: true })
  }

  return authError('Not found.', 'NOT_FOUND', 404)
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    // `authorization` is allowed so a client that still holds an old key is not blocked
    // by the preflight; the proxy always uses its own server-side key.
    'Access-Control-Allow-Headers': 'content-type, authorization, x-javelin-install',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function errorResponse(message, status) {
  return json({ error: { message, type: 'javelin_cloud_error' } }, status)
}

function accountPageHtml(kind) {
  const isReset = kind === 'reset'
  const title = isReset ? 'Choose a new password' : 'Verify your email'
  const intro = isReset
    ? 'Enter a new password for your Javelin account. This signs out your other devices.'
    : 'Confirm this address so we can help you recover your Javelin account.'
  const body = isReset
    ? `<form id="reset-form"><label>New password<input id="password" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label><label>Confirm password<input id="confirmation" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label><button id="reset" type="submit">Update password</button></form><p id="success" class="success" hidden>Password updated. Return to Javelin and sign in with your new password.</p>`
    : `<button id="verify" type="button">Verify email</button><p id="success" class="success" hidden>Email verified. Return to Javelin.</p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · Javelin AI</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ee;color:#24231f;font-family:Segoe UI,Helvetica,Arial,sans-serif;padding:24px}.card{width:min(100%,460px);background:#fffdf8;border:1px solid #ded8cb;border-radius:16px;padding:32px;box-shadow:0 20px 60px rgba(66,52,32,.08)}.kicker{font-size:11px;letter-spacing:2px;font-weight:700;color:#b45309;margin-bottom:18px}h1{font-size:24px;line-height:1.25;margin:0 0 12px}p{font-size:14px;line-height:1.65;color:#5d584f;margin:0 0 20px}label{display:grid;gap:7px;font-size:13px;font-weight:600;color:#4d4840;margin-bottom:14px}input{width:100%;border:1px solid #d4cdbf;border-radius:8px;background:#fff;color:#24231f;font:inherit;padding:11px 12px;outline:none}input:focus{border-color:#b45309;box-shadow:0 0 0 3px rgba(180,83,9,.12)}button{width:100%;border:0;border-radius:8px;background:#b45309;color:#fff;font:inherit;font-weight:700;padding:12px 16px;cursor:pointer}button:hover{background:#9a4b08}button:disabled{cursor:wait;opacity:.65}.success{color:#166534;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;margin:18px 0 0}.error{color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:18px 0 0}.note{font-size:12px;color:#8a8377;margin-top:22px}.note a{color:#9a4b08}.note a{color:#9a4b08}
</style>
</head>
<body><main class="card"><div class="kicker">JAVELIN ACCOUNTS</div><h1>${title}</h1><p>${intro}</p>${body}<p id="error" class="error" hidden></p><p class="note">If you did not request this, you can close this page safely. Need help? <a href="mailto:${SUPPORT_EMAIL}">Email Javelin support</a>.</p></main>
<script>
const token = new URLSearchParams(location.search).get('token') || ''
const errorBox = document.getElementById('error')
const success = document.getElementById('success')
function showError(message) { errorBox.textContent = message; errorBox.hidden = false }
${
  isReset
    ? `const form = document.getElementById('reset-form')
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  errorBox.hidden = true
  const password = document.getElementById('password').value
  const confirmation = document.getElementById('confirmation').value
  if (password !== confirmation) return showError('The passwords do not match.')
  if (password.length < 8) return showError('Use a password between 8 and 200 characters.')
  const button = document.getElementById('reset')
  button.disabled = true
  button.textContent = 'Updating…'
  try {
    const response = await fetch('/v1/auth/password-reset/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload?.error?.message || 'The password could not be updated.')
    form.hidden = true
    success.hidden = false
  } catch (error) {
    showError(error.message)
    button.disabled = false
    button.textContent = 'Update password'
  }
})`
    : `const button = document.getElementById('verify')
async function verify() {
  errorBox.hidden = true
  button.disabled = true
  button.textContent = 'Verifying…'
  try {
    const response = await fetch('/v1/auth/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload?.error?.message || 'The email could not be verified.')
    button.hidden = true
    success.hidden = false
  } catch (error) {
    showError(error.message)
    button.disabled = false
    button.textContent = 'Verify email'
  }
}
button.addEventListener('click', verify)
if (!token) { button.disabled = true; showError('This link is missing its verification token.') }`
}
</script>
</body>
</html>`
}

function loginPageHtml(token = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in to Javelin</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ee;color:#24231f;font-family:Segoe UI,Helvetica,Arial,sans-serif;padding:24px}.card{width:min(100%,460px);background:#fffdf8;border:1px solid #ded8cb;border-radius:16px;padding:32px;box-shadow:0 20px 60px rgba(66,52,32,.08)}.kicker{font-size:11px;letter-spacing:2px;font-weight:700;color:#b45309;margin-bottom:18px}h1{font-size:24px;line-height:1.25;margin:0 0 12px}p{font-size:14px;line-height:1.65;color:#5d584f;margin:0 0 20px}button{width:100%;border:0;border-radius:8px;background:#b45309;color:#fff;font:inherit;font-weight:700;padding:13px 16px;cursor:pointer;transition:background .16s ease,transform .16s ease}button:hover{background:#9a4b08;transform:translateY(-1px)}button:disabled{cursor:wait;opacity:.65;transform:none}.success{color:#166534;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;margin:18px 0 0}.error{color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:18px 0 0}.note{font-size:12px;color:#8a8377;margin-top:22px}.note a{color:#9a4b08}.status{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#8a8377;margin-top:18px}.dot{width:7px;height:7px;border-radius:50%;background:#b45309;animation:pulse 1.4s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}
</style>
</head>
<body><main class="card"><div class="kicker">JAVELIN ACCOUNTS</div><h1>Sign in to Javelin</h1><p>Press the button below. The Javelin IDE will finish signing you in automatically.</p><form id="login-form" method="post" action="/account/email-login/approve"><input type="hidden" id="token" name="token" value="${escapeHtml(token)}"><button id="login" type="submit">Sign in to Javelin</button></form><p id="waiting" class="status"><span class="dot"></span>Waiting for confirmation…</p><p id="success" class="success" hidden>You're signed in. Return to the Javelin IDE — it will finish automatically.</p><p id="error" class="error" hidden></p><p class="note">This link expires in 10 minutes and can be used once. If you did not request it, you can close this page. Need help? <a href="mailto:${SUPPORT_EMAIL}">Email Javelin support</a>.</p></main>
<script>
const tokenInput = document.getElementById('token')
const token = tokenInput.value || new URLSearchParams(location.search).get('token') || ''
const form = document.getElementById('login-form')
const button = document.getElementById('login')
const waiting = document.getElementById('waiting')
const success = document.getElementById('success')
const errorBox = document.getElementById('error')
function showError(message) { errorBox.textContent = message; errorBox.hidden = false }
async function approve() {
  errorBox.hidden = true
  button.disabled = true
  button.textContent = 'Signing in…'
  try {
    const response = await fetch('/v1/auth/email-login/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload?.error?.message || 'This sign-in link could not be used.')
    button.hidden = true
    waiting.hidden = true
    success.hidden = false
    document.title = 'Signed in · Javelin AI'
  } catch (error) {
    showError(error.message)
    button.disabled = false
    button.textContent = 'Sign in to Javelin'
  }
}
form.addEventListener('submit', (event) => { event.preventDefault(); approve() })
if (!token) { button.disabled = true; waiting.hidden = true; showError('This link is missing its sign-in token.') }
</script>
</body>
</html>`
}

function loginResultHtml(ok, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${ok ? 'Signed in' : 'Sign-in link issue'} · Javelin AI</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ee;color:#24231f;font-family:Segoe UI,Helvetica,Arial,sans-serif;padding:24px}.card{width:min(100%,460px);background:#fffdf8;border:1px solid #ded8cb;border-radius:16px;padding:32px;box-shadow:0 20px 60px rgba(66,52,32,.08)}.kicker{font-size:11px;letter-spacing:2px;font-weight:700;color:#b45309;margin-bottom:18px}h1{font-size:24px;line-height:1.25;margin:0 0 12px}p{font-size:14px;line-height:1.65;color:#5d584f;margin:0 0 20px}.status{color:${ok ? '#166534' : '#991b1b'};background:${ok ? '#f0fdf4' : '#fef2f2'};border:1px solid ${ok ? '#bbf7d0' : '#fecaca'};border-radius:8px;padding:12px;margin:18px 0 0}.note{font-size:12px;color:#8a8377;margin-top:22px}.note a{color:#9a4b08}
</style>
</head>
<body><main class="card"><div class="kicker">JAVELIN ACCOUNTS</div><h1>${ok ? 'You are signed in' : 'That link did not work'}</h1><p>${ok ? 'Return to the Javelin IDE. It will finish signing you in automatically.' : 'Return to the Javelin IDE and request a new sign-in email.'}</p><p class="status">${escapeHtml(message)}</p><p class="note">You can close this page. Need help? <a href="mailto:${SUPPORT_EMAIL}">Email Javelin support</a>.</p></main></body>
</html>`
}

function accountLockPageHtml(token = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Lock your Javelin account</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ee;color:#24231f;font-family:Segoe UI,Helvetica,Arial,sans-serif;padding:24px}.card{width:min(100%,470px);background:#fffdf8;border:1px solid #ded8cb;border-radius:16px;padding:32px;box-shadow:0 20px 60px rgba(66,52,32,.08)}.kicker{font-size:11px;letter-spacing:2px;font-weight:700;color:#b45309;margin-bottom:18px}h1{font-size:24px;line-height:1.25;margin:0 0 12px}p{font-size:14px;line-height:1.65;color:#5d584f;margin:0 0 20px}button{width:100%;border:0;border-radius:8px;background:#b91c1c;color:#fff;font:inherit;font-weight:700;padding:13px 16px;cursor:pointer}button:hover{background:#991b1b}.note{font-size:12px;color:#8a8377;margin-top:22px}.note a{color:#9a4b08}.warning{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:12px;font-size:13px;line-height:1.55;margin:0 0 20px}
</style>
</head>
<body><main class="card"><div class="kicker">JAVELIN ACCOUNTS</div><h1>Lock this account?</h1><div class="warning">This signs out every device. You will need the email sign-in link or 6-digit code to unlock the account.</div><p>Only continue if you do not recognize the sign-in that triggered this safety email.</p><form method="post" action="/account/lock"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Lock my account</button></form><p class="note">If you recognize the sign-in, close this page. Need help? <a href="mailto:${SUPPORT_EMAIL}">Email Javelin support</a>.</p></main></body>
</html>`
}

function lockResultHtml(ok, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${ok ? 'Account locked' : 'Lock link issue'} · Javelin AI</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ee;color:#24231f;font-family:Segoe UI,Helvetica,Arial,sans-serif;padding:24px}.card{width:min(100%,460px);background:#fffdf8;border:1px solid #ded8cb;border-radius:16px;padding:32px;box-shadow:0 20px 60px rgba(66,52,32,.08)}.kicker{font-size:11px;letter-spacing:2px;font-weight:700;color:#b45309;margin-bottom:18px}h1{font-size:24px;line-height:1.25;margin:0 0 12px}p{font-size:14px;line-height:1.65;color:#5d584f;margin:0 0 20px}.status{color:${ok ? '#166534' : '#991b1b'};background:${ok ? '#f0fdf4' : '#fef2f2'};border:1px solid ${ok ? '#bbf7d0' : '#fecaca'};border-radius:8px;padding:12px;margin:18px 0 0}.note{font-size:12px;color:#8a8377;margin-top:22px}.note a{color:#9a4b08}
</style>
</head>
<body><main class="card"><div class="kicker">JAVELIN ACCOUNTS</div><h1>${ok ? 'Account locked' : 'That link did not work'}</h1><p>${ok ? 'Every device is signed out. Use the email sign-in link or 6-digit code to unlock your account.' : 'This safety link is invalid, expired, or already used. If you need help, contact Javelin support.'}</p><p class="status">${escapeHtml(message)}</p><p class="note">You can close this page. Need help? <a href="mailto:${SUPPORT_EMAIL}">Email Javelin support</a>.</p></main></body>
</html>`
}

/**
 * Where the completion goes.
 *
 * With an operator key (Gemini or any OpenAI-compatible host) that host is used. With
 * no key configured the service falls back to a keyless public inference endpoint, so
 * Javelin Cloud works for users out of the box instead of answering 503.
 */
const KEYLESS_UPSTREAM = 'https://text.pollinations.ai/openai'

function usingOperatorKey(env) {
  return Boolean(env.UPSTREAM_KEY)
}

/**
 * The public keyless pool is opt-in only.
 *
 * It allows one reply per 45 seconds per IP, which is far too little for an agent, so
 * answering with its 429s by default would look like the service is broken. Without an
 * operator key the service says exactly what is missing instead.
 */
function keylessAllowed(env) {
  return env.ALLOW_KEYLESS === '1'
}

function upstreamUrl(env) {
  if (!usingOperatorKey(env) && keylessAllowed(env)) {
    // A token lifts the keyless pool's single-concurrent-request rule.
    return env.POLLEN_TOKEN ? `${KEYLESS_UPSTREAM}?token=${encodeURIComponent(env.POLLEN_TOKEN)}` : KEYLESS_UPSTREAM
  }
  const base = (env.UPSTREAM_BASE || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '')
  return `${base}/chat/completions`
}

function upstreamModel(env) {
  if (env.UPSTREAM_MODEL) return env.UPSTREAM_MODEL
  return usingOperatorKey(env) ? 'gemini-2.5-flash' : 'openai'
}

function dailyLimit(env) {
  const value = Number(env.DAILY_LIMIT)
  return Number.isFinite(value) && value > 0 ? value : 80
}

/**
 * Count one request against an install's daily allowance.
 * With no D1 binding the count is skipped (local development, or storage not yet added).
 */
async function takeQuota(env, install) {
  const limit = dailyLimit(env)
  if (!env.DB) return { ok: true, limit, used: 0 }
  const day = new Date().toISOString().slice(0, 10)
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS usage (install TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (install, day))',
  ).run()
  const row = await env.DB.prepare('SELECT count FROM usage WHERE install = ? AND day = ?')
    .bind(install, day)
    .first()
  const used = Number(row?.count ?? 0)
  if (used >= limit) return { ok: false, limit, used }
  await env.DB.prepare(
    'INSERT INTO usage (install, day, count) VALUES (?, ?, 1) ON CONFLICT(install, day) DO UPDATE SET count = count + 1',
  )
    .bind(install, day)
    .run()
  return { ok: true, limit, used: used + 1 }
}

export { buildSmtpMessage, sendSmtpEmail, smtpConfig }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })

    if (url.pathname === '/account/email-login/approve') {
      if (request.method !== 'POST') return errorResponse('Not found.', 404)
      let token = ''
      try {
        const form = await request.formData()
        token = String(form.get('token') ?? '')
      } catch {
        /* the result page explains the missing token */
      }
      let result = { ok: false, message: 'That sign-in link is not valid.' }
      try {
        await ensureAuthSchema(env)
        result = await approveLoginToken(env, token, request, ctx)
      } catch {
        result = { ok: false, message: 'The account service could not complete that request. Try again in a moment.' }
      }
      return new Response(loginResultHtml(result.ok, result.ok ? 'Your sign-in was confirmed. The IDE will pick it up automatically.' : result.message), {
        status: result.ok ? 200 : 400,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      })
    }

    if (url.pathname === '/account/lock') {
      const pageHeaders = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      }
      if (request.method === 'GET') {
        const token = String(url.searchParams.get('token') || '').trim()
        if (token.length < 20) return new Response(lockResultHtml(false, 'This safety link is missing its token.'), { status: 400, headers: pageHeaders })
        try {
          await ensureAuthSchema(env)
          const tokenHash = await sha256(token)
          const row = await env.DB.prepare('SELECT kind, expires_at, used_at FROM email_tokens WHERE token_hash = ?')
            .bind(tokenHash)
            .first()
          if (!row || row.kind !== 'lock' || row.used_at || Number(row.expires_at) <= Date.now()) {
            return new Response(lockResultHtml(false, 'This safety link is invalid, expired, or already used.'), { status: 400, headers: pageHeaders })
          }
        } catch {
          return new Response(lockResultHtml(false, 'The account service could not check that link. Try again in a moment.'), { status: 500, headers: pageHeaders })
        }
        return new Response(accountLockPageHtml(token), { headers: pageHeaders })
      }
      if (request.method !== 'POST') return errorResponse('Use GET or POST.', 405)
      let token = ''
      try {
        const form = await request.formData()
        token = String(form.get('token') || '').trim()
      } catch {
        /* the result page explains the missing token */
      }
      if (token.length < 20) return new Response(lockResultHtml(false, 'This safety link is missing its token.'), { status: 400, headers: pageHeaders })
      try {
        await ensureAuthSchema(env)
        const tokenHash = await sha256(token)
        const row = await env.DB.prepare('SELECT user_id, kind, expires_at, used_at FROM email_tokens WHERE token_hash = ?')
          .bind(tokenHash)
          .first()
        if (!row || row.kind !== 'lock' || row.used_at || Number(row.expires_at) <= Date.now()) {
          return new Response(lockResultHtml(false, 'This safety link is invalid, expired, or already used.'), { status: 400, headers: pageHeaders })
        }
        const now = Date.now()
        const consumed = await env.DB.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
          .bind(now, tokenHash, now)
          .run()
        if (Number(consumed?.meta?.changes ?? consumed?.changes ?? 0) < 1) {
          return new Response(lockResultHtml(false, 'This safety link was already used.'), { status: 400, headers: pageHeaders })
        }
        await env.DB.prepare('UPDATE users SET account_locked_at = ? WHERE id = ?')
          .bind(new Date(now).toISOString(), row.user_id)
          .run()
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id).run()
        return new Response(lockResultHtml(true, 'Your Javelin account has been locked. Every device is signed out.'), { status: 200, headers: pageHeaders })
      } catch {
        return new Response(lockResultHtml(false, 'The account could not be locked. Try again in a moment.'), { status: 500, headers: pageHeaders })
      }
    }

    if (url.pathname === '/account/verify' || url.pathname === '/account/reset' || url.pathname === '/account/email-login') {
      if (request.method !== 'GET') return errorResponse('Not found.', 404)
      return new Response(
        url.pathname.endsWith('/email-login') ? loginPageHtml(url.searchParams.get('token') || '') : accountPageHtml(url.pathname.endsWith('/reset') ? 'reset' : 'verify'),
        {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      })
    }

    const authPath = url.pathname.startsWith('/v1/auth/') ? url.pathname.slice('/v1/auth'.length) : ''
    if (authPath) {
      try {
        return await handleAuth(request, env, authPath, ctx)
      } catch {
        return authError('The account service could not complete that request.', 'AUTH_INTERNAL', 500)
      }
    }

    if (url.pathname === '/v1/support' || url.pathname === '/support') {
      try {
        return await handleSupport(request, env)
      } catch {
        return errorResponse('The support service could not send that message.', 500)
      }
    }

    if (url.pathname === '/health') {
      return json({
        ok: true,
        configured: true,
        mode: usingOperatorKey(env) ? 'operator-key' : keylessAllowed(env) ? 'keyless-free' : 'unconfigured',
        configured: usingOperatorKey(env) || keylessAllowed(env),
        models: [...ALLOWED_MODELS],
        dailyLimit: dailyLimit(env),
        accounts: true,
        memberTokenLimit: MEMBER_TOKEN_LIMIT,
        emailConfigured: emailConfigured(env),
        emailVerification: true,
        emailLogin: true,
        passwordReset: true,
        supportForm: true,
        admin: true,
        historySync: true,
      })
    }

    if (url.pathname === '/v1/models') {
      return json({
        object: 'list',
        data: [...ALLOWED_MODELS].map((id) => ({ id, object: 'model', owned_by: 'javelin' })),
      })
    }

    if (url.pathname !== '/v1/chat/completions') return errorResponse('Not found.', 404)
    if (request.method !== 'POST') return errorResponse('Use POST.', 405)
    if (!usingOperatorKey(env) && !keylessAllowed(env)) {
      return errorResponse(
        'Javelin Cloud is deployed but has no upstream model key yet. The operator must add UPSTREAM_KEY in the hosting secrets.',
        503,
      )
    }

    const install = (request.headers.get('x-javelin-install') || '').trim().slice(0, 80)
    if (!install) return errorResponse('Missing x-javelin-install header.', 400)

    let quota
    try {
      quota = await takeQuota(env, install)
    } catch {
      // A storage hiccup must not take the whole service down.
      quota = { ok: true, limit: dailyLimit(env), used: 0 }
    }
    if (!quota.ok) {
      return errorResponse(
        `The free daily limit of ${quota.limit} requests is used up for this machine. It resets at midnight UTC.`,
        429,
      )
    }

    let body
    try {
      body = await request.json()
    } catch {
      return errorResponse('The request body must be JSON.', 400)
    }
    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return errorResponse('`messages` must be a non-empty array.', 400)
    }

    const payload = {
      ...body,
      model: upstreamModel(env),
      // Never let a caller smuggle a different upstream model through.
      stream: body.stream !== false,
    }

    const upstreamHeaders = { 'Content-Type': 'application/json' }
    if (usingOperatorKey(env)) upstreamHeaders.Authorization = `Bearer ${env.UPSTREAM_KEY}`

    let upstream
    try {
      // The keyless pool accepts one request at a time per IP, so a busy answer is
      // usually transient: wait for the previous request to clear and try again.
      for (let attempt = 0; attempt < 3; attempt++) {
        upstream = await fetch(upstreamUrl(env), {
          method: 'POST',
          headers: upstreamHeaders,
          body: JSON.stringify(payload),
        })
        if (upstream.status !== 402 && upstream.status !== 429) break
        await upstream.body?.cancel?.().catch(() => {})
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)))
      }
    } catch (error) {
      return errorResponse(`Could not reach the model provider: ${error?.message ?? 'network error'}`, 502)
    }

    if (upstream.status === 402 || upstream.status === 429) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              'Javelin Cloud is busy: the free model is still answering another request. Try again in a few seconds.',
            type: 'javelin_cloud_busy',
          },
        }),
        {
          status: 429,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '3' },
        },
      )
    }

    if (!upstream.ok) {
      // Pass the provider's status through so the app can classify it (rate limit, auth).
      const text = await upstream.text().catch(() => '')
      return errorResponse(text.slice(0, 800) || `Provider error ${upstream.status}.`, upstream.status)
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
        'Cache-Control': 'no-store',
      },
    })
  },
}
