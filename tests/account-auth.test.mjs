/**
 * Online account API checks.
 *
 * The Worker is exercised with a small in-memory D1 double so signup, login,
 * sessions, logout and owner-role rules are tested without touching the live
 * database.
 */

import net from 'node:net'
import { once } from 'node:events'
import { Readable, Writable } from 'node:stream'
import worker, { buildSmtpMessage, sendSmtpEmail, smtpConfig } from '../javelin-cloud/src/index.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db
    this.sql = sql.replace(/\s+/g, ' ').trim()
    this.params = params
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params)
  }

  first() {
    return this.db.first(this.sql, this.params)
  }

  run() {
    return this.db.run(this.sql, this.params)
  }

  all() {
    return this.db.all(this.sql, this.params)
  }
}

class FakeD1 {
  constructor() {
    this.users = []
    this.sessions = []
    this.tokens = []
    this.logins = []
    this.support = []
    this.history = []
    this.moderation = []
  }

  prepare(sql) {
    return new Statement(this, sql)
  }

  async batch(statements) {
    for (const statement of statements) await statement.run()
    return []
  }

  async first(sql, params) {
    if (/^SELECT id FROM users WHERE username_lower = \?$/.test(sql)) {
      const user = this.users.find((row) => row.username_lower === params[0])
      return user ? { id: user.id } : null
    }
    if (/^SELECT id FROM users WHERE email_lower = \?$/.test(sql)) {
      const user = this.users.find((row) => row.email_lower === params[0])
      return user ? { id: user.id } : null
    }
    if (/^SELECT id, username, email, email_verified_at FROM users WHERE email_lower = \?$/.test(sql)) {
      return this.users.find((row) => row.email_lower === params[0]) ?? null
    }
    if (/^SELECT id, username, email, role, created_at, email_verified_at FROM users WHERE email_lower = \?$/.test(sql)) {
      return this.users.find((row) => row.email_lower === params[0]) ?? null
    }
    if (/^SELECT id, username, email, role, created_at, email_verified_at FROM users WHERE id = \?$/.test(sql)) {
      return this.users.find((row) => row.id === params[0]) ?? null
    }
    if (/^SELECT username, email, login_alerts FROM users WHERE id = \?$/.test(sql)) {
      return this.users.find((row) => row.id === params[0]) ?? null
    }
    if (/^SELECT require_email_verification, login_alerts, account_locked_at FROM users WHERE id = \?$/.test(sql)) {
      return this.users.find((row) => row.id === params[0]) ?? null
    }
    if (/^SELECT banned_at, ban_reason, ban_expires_at FROM users WHERE id = \?$/.test(sql)) {
      return this.users.find((row) => row.id === params[0]) ?? null
    }
    if (/^SELECT payload, updated_at FROM chat_history WHERE user_id = \?$/.test(sql)) {
      return this.history.find((row) => row.user_id === params[0]) ?? null
    }
    if (/^SELECT id, username, email, role, created_at, email_verified_at, banned_at, ban_reason, ban_expires_at FROM users WHERE id = \? OR username_lower = \? OR email_lower = \?$/.test(sql)) {
      return this.users.find((row) => row.id === params[0] || row.username_lower === params[1] || row.email_lower === params[2]) ?? null
    }
    if (/FROM users WHERE username_lower = \? OR email_lower = \?$/.test(sql)) {
      return this.users.find((row) => row.username_lower === params[0] || row.email_lower === params[1]) ?? null
    }
    if (/FROM sessions s JOIN users u ON u\.id = s\.user_id WHERE s\.token_hash = \?$/.test(sql)) {
      const session = this.sessions.find((row) => row.token_hash === params[0])
      if (!session) return null
      const user = this.users.find((row) => row.id === session.user_id)
      if (!user) return null
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        created_at: user.created_at,
        email_verified_at: user.email_verified_at,
        expires_at: session.expires_at,
      }
    }
    if (/^SELECT user_id, kind, expires_at, used_at FROM email_tokens WHERE token_hash = \?$/.test(sql)) {
      return this.tokens.find((row) => row.token_hash === params[0]) ?? null
    }
    if (/^SELECT kind, expires_at, used_at FROM email_tokens WHERE token_hash = \?$/.test(sql)) {
      return this.tokens.find((row) => row.token_hash === params[0]) ?? null
    }
    if (/^SELECT COUNT\(\*\) AS count, MAX\(created_at\) AS last FROM email_tokens WHERE user_id = \? AND kind = \? AND created_at > \?$/.test(sql)) {
      const rows = this.tokens.filter((row) => row.user_id === params[0] && row.kind === params[1] && row.created_at > params[2])
      return {
        count: rows.length,
        last: rows.reduce((latest, row) => Math.max(latest, row.created_at), 0),
      }
    }
    if (/^SELECT COUNT\(\*\) AS count, MAX\(created_at\) AS last FROM login_requests WHERE email_lower = \? AND created_at > \?$/.test(sql)) {
      const rows = this.logins.filter((row) => row.email_lower === params[0] && row.created_at > params[1])
      return {
        count: rows.length,
        last: rows.reduce((latest, row) => Math.max(latest, row.created_at), 0),
      }
    }
    if (/^SELECT COUNT\(\*\) AS count, MAX\(created_at\) AS last FROM support_requests WHERE client_hash = \? AND created_at > \?$/.test(sql)) {
      const rows = this.support.filter((row) => row.client_hash === params[0] && row.created_at > params[1])
      return {
        count: rows.length,
        last: rows.reduce((latest, row) => Math.max(latest, row.created_at), 0),
      }
    }
    if (/^SELECT id, user_id, status, expires_at FROM login_requests WHERE email_token_hash = \?$/.test(sql)) {
      return this.logins.find((row) => row.email_token_hash === params[0]) ?? null
    }
    if (/^SELECT id, user_id, status, session_token, session_expires_at, expires_at FROM login_requests WHERE id = \? AND poll_token_hash = \?$/.test(sql)) {
      return this.logins.find((row) => row.id === params[0] && row.poll_token_hash === params[1]) ?? null
    }
    if (/^SELECT id, user_id, status, expires_at, login_code_hash, code_attempts FROM login_requests WHERE id = \?$/.test(sql)) {
      return this.logins.find((row) => row.id === params[0]) ?? null
    }
    return null
  }

  async all(sql) {
    if (/^SELECT id, username, email, role, created_at, email_verified_at, banned_at, ban_reason, ban_expires_at FROM users ORDER BY created_at DESC LIMIT 200$/.test(sql)) {
      return {
        results: [...this.users].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
      }
    }
    return { results: [] }
  }

  async run(sql, params) {
    const changed = (changes) => ({ success: true, changes, meta: { changes } })
    if (/^CREATE (TABLE|INDEX)/.test(sql)) return changed(0)
    if (/^ALTER TABLE users ADD COLUMN/.test(sql)) return changed(0)
    if (/^DELETE FROM login_requests WHERE expires_at <= \?$/.test(sql)) {
      const before = this.logins.length
      this.logins = this.logins.filter((row) => row.expires_at > params[0])
      return changed(before - this.logins.length)
    }
    if (/^DELETE FROM login_requests WHERE id = \?$/.test(sql)) {
      const before = this.logins.length
      this.logins = this.logins.filter((row) => row.id !== params[0])
      return changed(before - this.logins.length)
    }
    if (/^INSERT INTO login_requests /.test(sql)) {
      this.logins.push({
        id: params[0],
        user_id: params[1],
        email_lower: params[2],
        email_token_hash: params[3],
        poll_token_hash: params[4],
        login_code_hash: params[5],
        code_attempts: 0,
        status: 'pending',
        session_token: null,
        session_expires_at: null,
        created_at: params[6],
        expires_at: params[7],
        used_at: null,
      })
      return changed(1)
    }
    if (/^UPDATE login_requests SET status = 'approved', used_at = \? WHERE id = \? AND status = 'pending' AND expires_at > \?$/.test(sql)) {
      const login = this.logins.find((row) => row.id === params[1] && row.status === 'pending' && row.expires_at > params[2])
      if (!login) return changed(0)
      login.status = 'approved'
      login.used_at = params[0]
      return changed(1)
    }
    if (/^UPDATE login_requests SET status = 'ready', session_token = \?, session_expires_at = \? WHERE id = \?$/.test(sql)) {
      const login = this.logins.find((row) => row.id === params[2])
      if (!login) return changed(0)
      login.status = 'ready'
      login.session_token = params[0]
      login.session_expires_at = params[1]
      return changed(1)
    }
    if (/^UPDATE login_requests SET status = 'consumed', session_token = NULL WHERE id = \? AND status = 'ready'$/.test(sql)) {
      const login = this.logins.find((row) => row.id === params[0] && row.status === 'ready')
      if (!login) return changed(0)
      login.status = 'consumed'
      login.session_token = null
      return changed(1)
    }
    if (/^UPDATE login_requests SET code_attempts = code_attempts \+ 1 WHERE id = \? AND status = 'pending'$/.test(sql)) {
      const login = this.logins.find((row) => row.id === params[0] && row.status === 'pending')
      if (!login) return changed(0)
      login.code_attempts += 1
      return changed(1)
    }
    if (/^INSERT INTO users /.test(sql)) {
      this.users.push({
        id: params[0],
        username: params[1],
        username_lower: params[2],
        email: params[3],
        email_lower: params[4],
        password_hash: params[5],
        password_salt: params[6],
        iterations: params[7],
        role: params[8],
        created_at: params[9],
        email_verified_at: null,
        require_email_verification: 0,
        login_alerts: 1,
        account_locked_at: null,
        banned_at: null,
        ban_reason: null,
        ban_expires_at: null,
        banned_by: null,
      })
      return changed(1)
    }
    if (/^UPDATE users SET banned_at = \?, ban_reason = \?, ban_expires_at = \?, banned_by = \? WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[4])
      if (!user) return changed(0)
      user.banned_at = params[0]
      user.ban_reason = params[1]
      user.ban_expires_at = params[2]
      user.banned_by = params[3]
      return changed(1)
    }
    if (/^UPDATE users SET banned_at = NULL, ban_reason = NULL, ban_expires_at = NULL, banned_by = NULL WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[0])
      if (!user) return changed(0)
      user.banned_at = null
      user.ban_reason = null
      user.ban_expires_at = null
      user.banned_by = null
      return changed(1)
    }
    if (/^UPDATE users SET role = \? WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[1])
      if (!user) return changed(0)
      user.role = params[0]
      return changed(1)
    }
    if (/^INSERT INTO moderation_actions /.test(sql)) {
      this.moderation.push({
        id: params[0],
        action: params[1],
        target_user_id: params[2],
        actor_user_id: params[3],
        reason: params[4],
        created_at: params[5],
        expires_at: params[6],
      })
      return changed(1)
    }
    if (/^INSERT INTO support_requests /.test(sql)) {
      this.support.push({
        id: params[0],
        client_hash: params[1],
        topic: params[2],
        created_at: params[3],
      })
      return changed(1)
    }
    if (/^UPDATE email_tokens SET used_at = \? WHERE user_id = \? AND kind = \? AND used_at IS NULL$/.test(sql)) {
      let count = 0
      for (const token of this.tokens) {
        if (token.user_id === params[1] && token.kind === params[2] && !token.used_at) {
          token.used_at = params[0]
          count += 1
        }
      }
      return changed(count)
    }
    if (/^INSERT INTO email_tokens /.test(sql)) {
      this.tokens.push({
        token_hash: params[0],
        user_id: params[1],
        kind: params[2],
        created_at: params[3],
        expires_at: params[4],
        used_at: null,
      })
      return changed(1)
    }
    if (/^UPDATE email_tokens SET used_at = \? WHERE token_hash = \? AND used_at IS NULL AND expires_at > \?$/.test(sql)) {
      const token = this.tokens.find((row) => row.token_hash === params[1] && !row.used_at && row.expires_at > params[2])
      if (!token) return changed(0)
      token.used_at = params[0]
      return changed(1)
    }
    if (/^UPDATE users SET email_verified_at = \? WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[1])
      if (!user) return changed(0)
      user.email_verified_at = params[0]
      return changed(1)
    }
    if (/^UPDATE users SET email_verified_at = COALESCE\(email_verified_at, \?\) WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[1])
      if (!user) return changed(0)
      user.email_verified_at = user.email_verified_at || params[0]
      return changed(1)
    }
    if (/^UPDATE users SET email_verified_at = COALESCE\(email_verified_at, \?\), account_locked_at = NULL WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[1])
      if (!user) return changed(0)
      user.email_verified_at = user.email_verified_at || params[0]
      user.account_locked_at = null
      return changed(1)
    }
    if (/^UPDATE users SET require_email_verification = \? WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[1])
      if (!user) return changed(0)
      user.require_email_verification = params[0]
      return changed(1)
    }
    if (/^UPDATE users SET login_alerts = \? WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[1])
      if (!user) return changed(0)
      user.login_alerts = params[0]
      return changed(1)
    }
    if (/^UPDATE users SET account_locked_at = \? WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[1])
      if (!user) return changed(0)
      user.account_locked_at = params[0]
      return changed(1)
    }
    if (/^UPDATE users SET password_hash = \?, password_salt = \?, iterations = \?, email_verified_at = COALESCE\(email_verified_at, \?\) WHERE id = \?$/.test(sql)) {
      const user = this.users.find((row) => row.id === params[4])
      if (!user) return changed(0)
      user.password_hash = params[0]
      user.password_salt = params[1]
      user.iterations = params[2]
      user.email_verified_at = user.email_verified_at || params[3]
      return changed(1)
    }
    if (/^DELETE FROM sessions WHERE user_id = \? AND expires_at < \?$/.test(sql)) {
      this.sessions = this.sessions.filter((row) => !(row.user_id === params[0] && row.expires_at < params[1]))
      return changed(1)
    }
    if (/^DELETE FROM sessions WHERE user_id = \?$/.test(sql)) {
      const before = this.sessions.length
      this.sessions = this.sessions.filter((row) => row.user_id !== params[0])
      return changed(before - this.sessions.length)
    }
    if (/^INSERT INTO sessions /.test(sql)) {
      this.sessions.push({
        token_hash: params[0],
        user_id: params[1],
        created_at: params[2],
        expires_at: params[3],
      })
      return changed(1)
    }
    if (/^DELETE FROM sessions WHERE token_hash = \?$/.test(sql)) {
      this.sessions = this.sessions.filter((row) => row.token_hash !== params[0])
      return changed(1)
    }
    throw new Error(`FakeD1 does not understand: ${sql}`)
  }
}

const db = new FakeD1()
const outbox = []
const env = {
  DB: db,
  OWNER_SIGNUP_CODE: 'owner-test-code',
  EMAIL_SENDER: async (message) => {
    outbox.push(message)
    return true
  },
}

function emailTokenFor(subject) {
  const message = [...outbox].reverse().find((entry) => entry.subject === subject)
  const link = message?.text?.match(/https?:\/\/\S+/)?.[0]
  return link ? new URL(link).searchParams.get('token') : ''
}

function emailCodeFor(subject) {
  const message = [...outbox].reverse().find((entry) => entry.subject === subject)
  return message?.text?.match(/enter this code in the Javelin IDE:\s*(\d{6})/i)?.[1] || ''
}

async function call(path, { method = 'POST', body, token } = {}, runtimeEnv = env) {
  const request = new Request(`https://javelin.test/v1/auth${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const pending = []
  const response = await worker.fetch(request, runtimeEnv, { waitUntil: (promise) => pending.push(promise) })
  await Promise.all(pending)
  return { status: response.status, data: await response.json().catch(() => ({})) }
}

async function callPage(path, { method = 'GET', body } = {}, runtimeEnv = env) {
  const response = await worker.fetch(new Request(`https://javelin.test${path}`, {
    method,
    body,
  }), runtimeEnv, { waitUntil: () => {} })
  return { status: response.status, text: await response.text() }
}

async function callSupport(body, headers = {}, runtimeEnv = env) {
  const request = new Request('https://javelin.test/v1/support', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const pending = []
  const response = await worker.fetch(request, runtimeEnv, { waitUntil: (promise) => pending.push(promise) })
  await Promise.all(pending)
  return { status: response.status, data: await response.json().catch(() => ({})) }
}

async function startSmtpTestServer() {
  const received = { commands: [], message: '' }
  const server = net.createServer((socket) => {
    socket.on('error', () => { /* the test client may close while the server is replying */ })
    socket.setEncoding('utf8')
    socket.write('220 test ESMTP\r\n')
    let buffer = ''
    let inData = false
    const processInput = () => {
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          received.message += buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write('250 2.0.0 queued\r\n')
          continue
        }
        const newline = buffer.indexOf('\r\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)
        if (!line) continue
        received.commands.push(line)
        if (/^EHLO /i.test(line)) socket.write('250-test\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n')
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 2.7.0 authenticated\r\n')
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 2.1.0 ok\r\n')
        else if (/^RCPT TO:/i.test(line)) socket.write('250 2.1.5 ok\r\n')
        else if (/^DATA$/i.test(line)) {
          inData = true
          socket.write('354 end with .\r\n')
        } else if (/^QUIT$/i.test(line)) socket.end('221 2.0.0 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    }
    socket.on('data', (chunk) => {
      buffer += chunk
      processInput()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, received }
}

const member = {
  username: 'BuilderOne',
  email: 'builder@example.com',
  password: 'correct-horse-battery',
}

console.log('\n1. Signup creates a member account and a session')
const signup = await call('/signup', { body: member })
check('signup returns 201', signup.status === 201, JSON.stringify(signup.data))
check('the username is preserved', signup.data.session?.user?.username === member.username)
check('the role is member', signup.data.session?.user?.role === 'member')
check('a session token is returned', typeof signup.data.session?.token === 'string')
check('the response does not echo the password', !JSON.stringify(signup.data).includes(member.password))
check('the stored password is a salted hash, not the password', !db.users[0]?.password_hash?.includes(member.password) && db.users[0]?.password_salt)
check('the session stores a hash, not the raw token', db.sessions[0]?.token_hash !== signup.data.session.token)

const token = signup.data.session.token

console.log('\n2. Email verification')
check('signup reports that a verification email was sent', signup.data.email?.configured === true && signup.data.email?.sent === true)
check('a new account starts unverified', signup.data.session?.user?.emailVerified === false)
check('the verification email contains a link', Boolean(emailTokenFor('Verify your Javelin email')))
const verificationToken = emailTokenFor('Verify your Javelin email')
const verified = await call('/verify-email', { body: { token: verificationToken } })
check('the verification token is accepted', verified.status === 200 && verified.data.verified === true, JSON.stringify(verified.data))
const meAfterVerify = await call('/me', { method: 'GET', token })
check('the account is marked verified', meAfterVerify.data.user?.emailVerified === true)
check('a verification token cannot be reused', (await call('/verify-email', { body: { token: verificationToken } })).status === 400)
check('verification can be resent only when needed', (await call('/verify-email/resend', { token })).data.alreadyVerified === true)
const config = await call('/config', { method: 'GET' })
check('the service reports email delivery configured', config.data.emailConfigured === true && config.data.emailVerification === true && config.data.emailLogin === true)

console.log('\n2b. One-click email sign-in')
const emailLoginRequest = await call('/email-login/request', { body: { email: member.email } })
check('the email sign-in request starts', emailLoginRequest.status === 200 && emailLoginRequest.data.requestId && emailLoginRequest.data.pollToken, JSON.stringify(emailLoginRequest.data))
const emailLoginSubject = 'Your Javelin sign-in link and code'
check('the sign-in email contains a link', Boolean(emailTokenFor(emailLoginSubject)))
const loginCode = emailCodeFor(emailLoginSubject)
check('the sign-in email contains a fallback code', /^\d{6}$/.test(loginCode))
const emailLoginPoll = { requestId: emailLoginRequest.data.requestId, pollToken: emailLoginRequest.data.pollToken }
const beforeApproval = await call('/email-login/poll', { body: emailLoginPoll })
check('the IDE waits for the email button', beforeApproval.status === 200 && beforeApproval.data.status === 'pending')
check('a wrong fallback code is refused', (await call('/email-login/code', { body: { requestId: emailLoginRequest.data.requestId, code: loginCode === '000000' ? '111111' : '000000' } })).status === 400)
const emailLoginToken = emailTokenFor(emailLoginSubject)
const approved = await call('/email-login/approve', { body: { token: emailLoginToken } })
check('the email button approves the sign-in', approved.status === 200 && approved.data.signedIn === true, JSON.stringify(approved.data))
const afterApproval = await call('/email-login/poll', { body: emailLoginPoll })
check('the IDE receives a session automatically', afterApproval.status === 200 && afterApproval.data.status === 'signed-in' && Boolean(afterApproval.data.session?.token), JSON.stringify(afterApproval.data))
const emailLoginMe = await call('/me', { method: 'GET', token: afterApproval.data.session.token })
check('the emailed sign-in marks the email verified', emailLoginMe.status === 200 && emailLoginMe.data.user?.emailVerified === true)
check('the sign-in email link is one-time', (await call('/email-login/approve', { body: { token: emailLoginToken } })).status === 400)
check('the poll cannot be replayed', (await call('/email-login/poll', { body: emailLoginPoll })).data.status === 'expired')
const duplicateLoginRequest = await call('/email-login/request', { body: { email: member.email } })
check('a second email is rate-limited', duplicateLoginRequest.status === 200 && duplicateLoginRequest.data.cooldown === true)
const outboxBeforeUnknownLogin = outbox.length
const unknownLogin = await call('/email-login/request', { body: { email: 'nobody@example.com' } })
check('an unknown email gets a generic request', unknownLogin.status === 200 && Boolean(unknownLogin.data.requestId))
check('an unknown email receives no message', outbox.length === outboxBeforeUnknownLogin)

console.log('\n3. Session lookup')
const me = await call('/me', { method: 'GET', token })
check('a valid token identifies the user', me.status === 200 && me.data.user?.username === member.username)
check('a missing token is refused', (await call('/me', { method: 'GET' })).status === 401)
check('a random token is refused', (await call('/me', { method: 'GET', token: 'jv_not-a-real-token' })).status === 401)

console.log('\n4. Login')
const login = await call('/login', { body: { identifier: member.username, password: member.password } })
check('username login succeeds', login.status === 200)
check('login returns a new session token', login.data.session?.token && login.data.session.token !== token)
const emailLogin = await call('/login', { body: { identifier: member.email, password: member.password } })
check('email login succeeds', emailLogin.status === 200)
check('wrong password is refused', (await call('/login', { body: { identifier: member.username, password: 'wrong-password' } })).status === 401)
check('unknown account is refused', (await call('/login', { body: { identifier: 'nobody', password: member.password } })).status === 401)

console.log('\n5. Duplicates and validation')
check('duplicate username is refused', (await call('/signup', { body: { ...member, email: 'other@example.com' } })).status === 409)
check('duplicate email is refused', (await call('/signup', { body: { ...member, username: 'AnotherBuilder' } })).status === 409)
check('short password is refused', (await call('/signup', { body: { ...member, username: 'Shorty', password: 'short' } })).status === 400)
check('invalid username is refused', (await call('/signup', { body: { ...member, username: 'x', password: 'a-long-password' } })).status === 400)
check('invalid email is refused', (await call('/signup', { body: { ...member, username: 'NoMail', email: 'not-an-email' } })).status === 400)

console.log('\n6. Owner role is gated by the setup code')
check('owner signup without a code is refused', (await call('/signup', { body: { ...member, username: 'Bungles17x', email: 'owner@example.com' } })).status === 403)
check('owner signup with a wrong code is refused', (await call('/signup', { body: { ...member, username: 'Bungles17x', email: 'owner@example.com', ownerCode: 'wrong' } })).status === 403)
const ownerSignup = await call('/signup', {
  body: { ...member, username: 'Bungles17x', email: 'owner@example.com', ownerCode: 'owner-test-code' },
})
check('owner signup with the right code succeeds', ownerSignup.status === 201)
check('the owner role is assigned', ownerSignup.data.session?.user?.role === 'owner')
check('the owner session works', (await call('/me', { method: 'GET', token: ownerSignup.data.session.token })).status === 200)
const ownerEmailLogin = await call('/email-login/request', { body: { email: 'owner@example.com' } })
const ownerLoginCode = emailCodeFor('Your Javelin sign-in link and code')
const ownerCodeSignIn = await call('/email-login/code', { body: { requestId: ownerEmailLogin.data.requestId, code: ownerLoginCode } })
check('the email fallback code signs in', ownerCodeSignIn.status === 200 && ownerCodeSignIn.data.session?.user?.role === 'owner', JSON.stringify(ownerCodeSignIn.data))

console.log('\n6b. Admin commands, bans and staff roles')
const ownerToken = ownerSignup.data.session.token
const adminUsers = await call('/admin/users', { method: 'GET', token: ownerToken })
check('the owner can list accounts', adminUsers.status === 200 && adminUsers.data.users?.some((user) => user.username === member.username), JSON.stringify(adminUsers.data))
check('the owner scope is unrestricted', adminUsers.data.scope?.restricted === false && adminUsers.data.scope?.viewerRole === 'owner', JSON.stringify(adminUsers.data.scope))
const adminStats = await call('/admin/stats', { method: 'GET', token: ownerToken })
check('the owner can read moderation stats', adminStats.status === 200 && adminStats.data.total >= 2 && adminStats.data.owners === 1, JSON.stringify(adminStats.data))
check('owner stats are unrestricted', adminStats.data.restricted === false, JSON.stringify(adminStats.data))
check('members cannot use admin commands', (await call('/admin/users', { method: 'GET', token })).status === 403)
const banResult = await call('/admin/ban', {
  token: ownerToken,
  body: { identifier: member.username, reason: 'Testing the ban system', days: 7 },
})
check('the owner can ban a member', banResult.status === 200 && banResult.data.user?.banned === true, JSON.stringify(banResult.data))
check('the ban records its reason and expiry', banResult.data.user?.banReason === 'Testing the ban system' && Boolean(banResult.data.user?.banExpiresAt))
const banNotice = outbox.find((message) => message.to === member.email && /suspended/i.test(message.subject))
check('banning immediately emails the suspended account', Boolean(banNotice), JSON.stringify(banResult.data.notification))
check('the ban email includes the reason and access date', banNotice?.text?.includes('Testing the ban system') && banNotice?.text?.includes('Access returns:'))
const bannedLogin = await call('/login', { body: { identifier: member.username, password: member.password } })
check('a banned account cannot log in', bannedLogin.status === 403 && bannedLogin.data.error?.code === 'ACCOUNT_BANNED', JSON.stringify(bannedLogin.data))
check('the ban response includes reason and expiry', bannedLogin.data.error?.ban?.reason === 'Testing the ban system' && Boolean(bannedLogin.data.error?.ban?.expiresAt), JSON.stringify(bannedLogin.data))
const bannedSession = await call('/me', { method: 'GET', token })
check('an existing session is revoked by the ban', bannedSession.status === 403 && bannedSession.data.error?.code === 'ACCOUNT_BANNED', JSON.stringify(bannedSession.data))
check('the revoked session receives the ban details', bannedSession.data.error?.ban?.reason === 'Testing the ban system')
const unbanResult = await call('/admin/unban', { token: ownerToken, body: { identifier: member.username } })
check('the owner can unban a member', unbanResult.status === 200 && unbanResult.data.user?.banned === false)
check('unbanning revokes the preserved banned session', (await call('/me', { method: 'GET', token })).status === 401)
const staffPromotion = await call('/admin/role', { token: ownerToken, body: { identifier: member.username, role: 'staff' } })
check('the owner can promote a member to staff', staffPromotion.status === 200 && staffPromotion.data.user?.role === 'staff')
const staffLogin = await call('/login', { body: { identifier: member.username, password: member.password } })
const staffToken = staffLogin.data.session?.token
check('staff login carries the staff role', staffLogin.data.session?.user?.role === 'staff')
const targetSignup = await call('/signup', {
  body: { username: 'TargetUser', email: 'target@example.com', password: 'target-password' },
})
const staffDirectory = await call('/admin/users', { method: 'GET', token: staffToken })
check('staff can list member accounts', staffDirectory.status === 200 && staffDirectory.data.users?.some((user) => user.username === 'TargetUser'), JSON.stringify(staffDirectory.data))
check('staff cannot see an account ranked above them', !staffDirectory.data.users?.some((user) => user.role === 'owner' || user.email === 'owner@example.com'), JSON.stringify(staffDirectory.data))
check('staff directory reports its rank-limited scope', staffDirectory.data.scope?.restricted === true && staffDirectory.data.scope?.viewerRole === 'staff', JSON.stringify(staffDirectory.data.scope))
const staffOwnerSearch = await call('/admin/users?query=Bungles17x', { method: 'GET', token: staffToken })
check('staff search cannot reveal a higher-ranked account', staffOwnerSearch.status === 200 && staffOwnerSearch.data.users?.length === 0, JSON.stringify(staffOwnerSearch.data))
const staffStats = await call('/admin/stats', { method: 'GET', token: staffToken })
check('staff stats only count visible accounts', staffStats.status === 200 && staffStats.data.restricted === true && staffStats.data.total === staffDirectory.data.users.length && staffStats.data.owners === undefined, JSON.stringify(staffStats.data))
db.history.push({
  user_id: targetSignup.data.session.user.id,
  payload: JSON.stringify({
    version: 1,
    conversations: [{
      id: 'target-chat-1',
      title: 'Debugging the parser',
      titleSource: 'manual',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      messages: [
        { id: 'msg-1', role: 'user', content: 'The parser breaks on nested arrays.', ts: Date.now() - 55_000 },
        { id: 'msg-2', role: 'assistant', content: 'I found the tokenizer boundary issue.', ts: Date.now() - 50_000 },
        {
          id: 'msg-3',
          role: 'user',
          content: 'Here is the trace.',
          ts: Date.now() - 45_000,
          attachments: [{ id: 'att-1', kind: 'file', name: 'trace.txt', mime: 'text/plain', size: 2048 }],
        },
      ],
    }],
    deleted: {},
  }),
  updated_at: Date.now(),
})
const ownHistory = await call('/history', { method: 'GET', token: targetSignup.data.session.token })
check('an account can still read its own synced history', ownHistory.status === 200 && ownHistory.data.history?.conversations?.[0]?.title === 'Debugging the parser', JSON.stringify(ownHistory.data))
const staffTargetChats = await call('/admin/user-history?identifier=TargetUser', { method: 'GET', token: staffToken })
check('staff can read a visible account\'s chat history', staffTargetChats.status === 200 && staffTargetChats.data.user?.username === 'TargetUser' && staffTargetChats.data.history?.conversations?.[0]?.messages?.[0]?.content === 'The parser breaks on nested arrays.', JSON.stringify(staffTargetChats.data))
check('the chat history includes attachment metadata', staffTargetChats.data.history?.conversations?.[0]?.messages?.[2]?.attachments?.[0]?.name === 'trace.txt', JSON.stringify(staffTargetChats.data))
check('opening a chat history writes a moderation audit record', db.moderation.some((row) => row.action === 'view_chat_history' && row.target_user_id === targetSignup.data.session.user.id && row.actor_user_id === staffLogin.data.session.user.id), JSON.stringify(db.moderation))
const staffOwnerChats = await call('/admin/user-history?identifier=Bungles17x', { method: 'GET', token: staffToken })
check('staff cannot read a higher-ranked account\'s chat history', staffOwnerChats.status === 403 && staffOwnerChats.data.error?.code === 'ADMIN_RANK_RESTRICTED', JSON.stringify(staffOwnerChats.data))
const ownerTargetChats = await call('/admin/user-history?identifier=TargetUser', { method: 'GET', token: ownerToken })
check('the owner can read any account\'s chat history', ownerTargetChats.status === 200 && ownerTargetChats.data.history?.conversations?.[0]?.title === 'Debugging the parser', JSON.stringify(ownerTargetChats.data))
const staffBan = await call('/admin/ban', {
  token: staffToken,
  body: { identifier: 'TargetUser', reason: 'Staff moderation test' },
})
check('staff can ban a member', staffBan.status === 200 && staffBan.data.user?.banned === true, JSON.stringify(staffBan.data))
check('staff cannot change roles', (await call('/admin/role', { token: staffToken, body: { identifier: 'TargetUser', role: 'owner' } })).status === 403)
check('staff cannot ban the owner', (await call('/admin/ban', { token: staffToken, body: { identifier: 'Bungles17x', reason: 'nope' } })).status === 403)
check('an owner cannot ban themselves', (await call('/admin/ban', { token: ownerToken, body: { identifier: 'Bungles17x', reason: 'nope' } })).status === 400)
check('the promoted staff member remains a valid account', (await call('/me', { method: 'GET', token: staffToken })).data.user?.role === 'staff')

console.log('\n6c. Account security settings and login alerts')
const securityUser = {
  username: 'SecurityUser',
  email: 'security@example.com',
  password: 'security-password',
}
const securitySignup = await call('/signup', { body: securityUser })
const securityToken = securitySignup.data.session?.token
check('a security-test account starts signed in', securitySignup.status === 201 && Boolean(securityToken))
const defaultSecurity = await call('/security', { method: 'GET', token: securityToken })
check('security settings default to alerts on and verification optional', defaultSecurity.status === 200 && defaultSecurity.data.settings?.loginAlerts === true && defaultSecurity.data.settings?.requireEmailVerification === false, JSON.stringify(defaultSecurity.data))
const requireVerification = await call('/security', { token: securityToken, body: { requireEmailVerification: true } })
check('the account can require email verification', requireVerification.status === 200 && requireVerification.data.settings?.requireEmailVerification === true, JSON.stringify(requireVerification.data))
check('turning on the requirement sends a verification email', requireVerification.data.verification?.sent === true)
const blockedPassword = await call('/login', { body: { identifier: securityUser.username, password: securityUser.password } })
check('an unverified account cannot use password login when required', blockedPassword.status === 403 && blockedPassword.data.error?.code === 'EMAIL_VERIFICATION_REQUIRED', JSON.stringify(blockedPassword.data))
check('the password attempt sends an email verification challenge', blockedPassword.data.error?.emailSent === true && Boolean(blockedPassword.data.error?.requestId), JSON.stringify(blockedPassword.data))
const securityChallengeRequestId = blockedPassword.data.error?.requestId
const securityVerifyToken = emailTokenFor('Verify your Javelin email')
check('the required account has a verification token', Boolean(securityVerifyToken))
check('the required account can verify its email', (await call('/verify-email', { body: { token: securityVerifyToken } })).data.verified === true)
const stillBlockedPassword = await call('/login', { body: { identifier: securityUser.username, password: securityUser.password } })
check('a verified account still needs the email challenge on every password login', stillBlockedPassword.status === 403 && stillBlockedPassword.data.error?.code === 'EMAIL_VERIFICATION_REQUIRED', JSON.stringify(stillBlockedPassword.data))
const securityChallengeCode = emailCodeFor('Your Javelin sign-in link and code')
const alertsBefore = outbox.filter((message) => message.subject === 'New sign-in to your Javelin account').length
const securityLogin = await call('/email-login/code', { body: { requestId: securityChallengeRequestId, code: securityChallengeCode } })
const alertsAfter = outbox.filter((message) => message.subject === 'New sign-in to your Javelin account').length
check('the emailed verification challenge completes the password sign-in', securityLogin.status === 200 && Boolean(securityLogin.data.session?.token), JSON.stringify(securityLogin.data))
check('every completed sign-in sends a new-login alert', alertsAfter === alertsBefore + 1)
const loginAlert = [...outbox].reverse().find((message) => message.subject === 'New sign-in to your Javelin account' && message.to === securityUser.email)
check('the new-login alert names the account and time', loginAlert?.text?.includes('A new sign-in') && loginAlert?.text?.includes('SecurityUser') && loginAlert?.text?.includes('Time:'))
check('the new-login alert has a lock-account button', loginAlert?.html?.includes('Lock my account') && /account\/lock\?token=/.test(loginAlert?.text || ''))
const alertsOff = await call('/security', { token: securityToken, body: { loginAlerts: false } })
check('new-login alerts can be turned off', alertsOff.status === 200 && alertsOff.data.settings?.loginAlerts === false)
const relaxVerification = await call('/security', { token: securityToken, body: { requireEmailVerification: false } })
check('the requirement can be turned off', relaxVerification.status === 200 && relaxVerification.data.settings?.requireEmailVerification === false)
const alertsBeforeOff = outbox.filter((message) => message.subject === 'New sign-in to your Javelin account').length
const quietLogin = await call('/login', { body: { identifier: securityUser.username, password: securityUser.password } })
const alertsAfterOff = outbox.filter((message) => message.subject === 'New sign-in to your Javelin account').length
check('a login with alerts off sends no new-login email', quietLogin.status === 200 && alertsAfterOff === alertsBeforeOff)
const lockResult = await call('/security/lock', { token: securityToken })
check('the account can be locked', lockResult.status === 200 && lockResult.data.locked === true, JSON.stringify(lockResult.data))
check('locking revokes the current session', (await call('/me', { method: 'GET', token: securityToken })).status === 401)
const lockedPassword = await call('/login', { body: { identifier: securityUser.username, password: securityUser.password } })
check('a locked account cannot use password login', lockedPassword.status === 403 && lockedPassword.data.error?.code === 'ACCOUNT_LOCKED', JSON.stringify(lockedPassword.data))
// Let the earlier challenge age out of the per-email cooldown for this unlock test.
env.DB.logins = env.DB.logins.filter((row) => row.email_lower !== securityUser.email)
const lockedEmailRequest = await call('/email-login/request', { body: { email: securityUser.email } })
const lockedCode = emailCodeFor('Your Javelin sign-in link and code')
const lockedUnlock = await call('/email-login/code', { body: { requestId: lockedEmailRequest.data.requestId, code: lockedCode } })
check('email verification unlocks the account', lockedUnlock.status === 200 && Boolean(lockedUnlock.data.session?.token), JSON.stringify(lockedUnlock.data))
const unlockedSecurity = await call('/security', { method: 'GET', token: lockedUnlock.data.session.token })
check('the unlocked account reports no lock and keeps its alert preference', unlockedSecurity.status === 200 && unlockedSecurity.data.settings?.locked === false && unlockedSecurity.data.settings?.loginAlerts === false, JSON.stringify(unlockedSecurity.data))

const emailLockUser = {
  username: 'EmailLockUser',
  email: 'email-lock@example.com',
  password: 'email-lock-password',
}
const emailLockSignup = await call('/signup', { body: emailLockUser })
check('the email-lock test account signs up', emailLockSignup.status === 201)
const emailLockLogin = await call('/login', { body: { identifier: emailLockUser.username, password: emailLockUser.password } })
check('the email-lock test account signs in', emailLockLogin.status === 200)
const emailLockAlert = [...outbox].reverse().find((message) => message.subject === 'New sign-in to your Javelin account' && message.to === emailLockUser.email)
const emailLockUrl = emailLockAlert?.text?.match(/https?:\/\/\S+\/account\/lock\?token=\S+/)?.[0] || ''
const emailLockToken = emailLockUrl ? new URL(emailLockUrl).searchParams.get('token') : ''
check('the alert contains a usable account-lock link', Boolean(emailLockToken), emailLockAlert?.text || '')
const lockPage = await callPage(`/account/lock?token=${encodeURIComponent(emailLockToken)}`)
check('the email lock button opens a confirmation page', lockPage.status === 200 && lockPage.text.includes('Lock my account'))
const emailLockPost = await callPage('/account/lock', {
  method: 'POST',
  body: new URLSearchParams({ token: emailLockToken }),
})
check('confirming from the email lock page locks the account', emailLockPost.status === 200 && emailLockPost.text.includes('Account locked'))
check('the email lock link cannot be reused', (await callPage(`/account/lock?token=${encodeURIComponent(emailLockToken)}`)).status === 400)
const emailLockedPassword = await call('/login', { body: { identifier: emailLockUser.username, password: emailLockUser.password } })
check('the email-locked account blocks password login', emailLockedPassword.status === 403 && emailLockedPassword.data.error?.code === 'ACCOUNT_LOCKED')
const emailUnlockRequest = await call('/email-login/request', { body: { email: emailLockUser.email } })
const emailUnlockCode = emailCodeFor('Your Javelin sign-in link and code')
const emailUnlock = await call('/email-login/code', { body: { requestId: emailUnlockRequest.data.requestId, code: emailUnlockCode } })
check('email verification unlocks the email-locked account', emailUnlock.status === 200 && Boolean(emailUnlock.data.session?.token))

console.log('\n7. Password reset')
const loginToken = login.data.session.token
const outboxBeforeUnknown = outbox.length
const unknownReset = await call('/password-reset/request', { body: { email: 'nobody@example.com' } })
check('an unknown email gets the same harmless answer', unknownReset.status === 200 && unknownReset.data.ok === true)
check('an unknown email sends no message', outbox.length === outboxBeforeUnknown)
const resetRequest = await call('/password-reset/request', { body: { email: member.email } })
check('a known email is accepted without exposing account details', resetRequest.status === 200 && resetRequest.data.ok === true)
const resetToken = emailTokenFor('Reset your Javelin password')
check('the reset email contains a one-time token', Boolean(resetToken))
const reset = await call('/password-reset/confirm', { body: { token: resetToken, password: 'new-correct-horse-battery' } })
check('the reset token sets a new password', reset.status === 200 && reset.data.passwordReset === true, JSON.stringify(reset.data))
check('the old password no longer works', (await call('/login', { body: { identifier: member.username, password: member.password } })).status === 401)
const newLogin = await call('/login', { body: { identifier: member.username, password: 'new-correct-horse-battery' } })
check('the new password works', newLogin.status === 200)
check('the reset revokes existing sessions', (await call('/me', { method: 'GET', token: loginToken })).status === 401)
check('a reset token cannot be reused', (await call('/password-reset/confirm', { body: { token: resetToken, password: 'another-password' } })).status === 400)

console.log('\n8. Accounts still work without email delivery')
const unconfiguredDb = new FakeD1()
const unconfiguredEnv = { DB: unconfiguredDb, OWNER_SIGNUP_CODE: 'owner-test-code' }
const unconfiguredSignup = await call('/signup', {
  body: { username: 'NoMailYet', email: 'nomail@example.com', password: 'a-long-password' },
}, unconfiguredEnv)
check('signup succeeds without an email provider', unconfiguredSignup.status === 201)
check('it reports that email was not sent', unconfiguredSignup.data.email?.configured === false && unconfiguredSignup.data.email?.sent === false)
const unconfiguredConfig = await call('/config', { method: 'GET' }, unconfiguredEnv)
check('the config endpoint says email is not configured', unconfiguredConfig.data.emailConfigured === false)
const unconfiguredEmailLogin = await call('/email-login/request', { body: { email: 'nomail@example.com' } }, unconfiguredEnv)
check('email sign-in refuses when delivery is unavailable', unconfiguredEmailLogin.status === 503)

console.log('\n9. Hosted email pages')
const resetPage = await worker.fetch(new Request('https://javelin.test/account/reset?token=test'), env)
const resetPageText = await resetPage.text()
check('the reset page is served as HTML', resetPage.status === 200 && resetPage.headers.get('content-type')?.includes('text/html'))
check('the reset page has a password form', resetPageText.includes('Update password') && resetPageText.includes('New password'))
check('the reset page links to support', resetPageText.includes('mailto:JavelinAIServices@gmail.com'))
check('the reset page has a strict CSP', resetPage.headers.get('content-security-policy')?.includes("default-src 'none'"))
const loginPage = await worker.fetch(new Request('https://javelin.test/account/email-login?token=test'), env)
const loginPageText = await loginPage.text()
check('the sign-in page is served as HTML', loginPage.status === 200 && loginPage.headers.get('content-type')?.includes('text/html'))
check('the sign-in page has one button', loginPageText.includes('Sign in to Javelin') && loginPageText.includes('email-login/approve'))
check('the sign-in page has a no-script form fallback', loginPageText.includes('action="/account/email-login/approve"') && loginPageText.includes('name="token"'))
check('the sign-in page links to support', loginPageText.includes('mailto:JavelinAIServices@gmail.com'))
check('the sign-in page has a strict CSP', loginPage.headers.get('content-security-policy')?.includes("default-src 'none'"))

const formMember = { username: 'FormFallback', email: 'form@example.com', password: 'a-long-password' }
await call('/signup', { body: formMember })
const formLoginRequest = await call('/email-login/request', { body: { email: formMember.email } })
const formLoginToken = emailTokenFor('Your Javelin sign-in link and code')
const formApproval = await worker.fetch(new Request('https://javelin.test/account/email-login/approve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: formLoginToken }).toString(),
}), env)
const formApprovalText = await formApproval.text()
const formApprovalMessage = formApprovalText.match(/<p class="status">([^<]*)<\/p>/)?.[1] || formApprovalText.slice(0, 160)
check('the form approval works without JavaScript', formApproval.status === 200 && formApprovalText.includes('You are signed in'), `${formApproval.status} ${formApprovalMessage}`)
const formPoll = await call('/email-login/poll', { body: { requestId: formLoginRequest.data.requestId, pollToken: formLoginRequest.data.pollToken } })
check('the no-script form also gives the IDE a session', formPoll.status === 200 && formPoll.data.status === 'signed-in')

console.log('\n10. Logout invalidates the session')
const secondLogin = await call('/login', { body: { identifier: member.username, password: 'new-correct-horse-battery' } })
const currentSession = secondLogin.data.session.token
check('logout succeeds', (await call('/logout', { token: currentSession })).status === 200)
check('the logged-out token is refused', (await call('/me', { method: 'GET', token: currentSession })).status === 401)
check('a different session still works', (await call('/me', { method: 'GET', token: newLogin.data.session.token })).status === 200)

console.log('\n11. Email providers receive an API request')
const providerDb = new FakeD1()
const providerEnv = {
  DB: providerDb,
  OWNER_SIGNUP_CODE: 'owner-test-code',
  BREVO_API_KEY: 'brevo-test-key',
  EMAIL_FROM_EMAIL: 'accounts@example.com',
  EMAIL_FROM_NAME: 'Javelin Accounts',
}
const originalFetch = globalThis.fetch
let providerRequest = null
globalThis.fetch = async (url, options) => {
  providerRequest = { url: String(url), options }
  return new Response(JSON.stringify({ messageId: 'test' }), { status: 201 })
}
try {
  const providerSignup = await call('/signup', { body: { ...member, username: 'ProviderUser', email: 'provider@example.com' } }, providerEnv)
  check('signup succeeds when Brevo is configured', providerSignup.status === 201)
  const body = JSON.parse(providerRequest?.options?.body || '{}')
  check('the email request goes to Brevo', providerRequest?.url === 'https://api.brevo.com/v3/smtp/email')
  check('the provider key is sent as a header', providerRequest?.options?.headers?.['api-key'] === 'brevo-test-key')
  check('the sender and recipient are set', body.sender?.email === 'accounts@example.com' && body.to?.[0]?.email === 'provider@example.com')
  check('the email contains the verification page', String(body.htmlContent).includes('/account/verify?token='))
} finally {
  globalThis.fetch = originalFetch
}

console.log('\n11b. In-app support form')
const supportHeaders = { 'x-javelin-install': 'support-test-install' }
const shortSupport = await callSupport({ topic: 'bug', email: 'builder@example.com', message: 'Too short' }, supportHeaders)
check('the support form rejects a too-short message', shortSupport.status === 400)
const unknownTopic = await callSupport({ topic: 'nonsense', email: 'builder@example.com', message: 'This should not be accepted by the support endpoint.' }, supportHeaders)
check('the support form rejects an unknown topic', unknownTopic.status === 400)
const outboxBeforeSupport = outbox.length
const supportResult = await callSupport({
  topic: 'bug',
  email: 'builder@example.com',
  message: 'The editor froze when I opened a folder.\n\nSteps: open a folder from the workbench.',
  appVersion: '1.0.0',
  mode: 'agent',
  provider: 'Javelin Cloud',
  platform: 'win32',
}, supportHeaders)
check('the support form accepts a complete request', supportResult.status === 200 && supportResult.data.ok === true && Boolean(supportResult.data.requestId), JSON.stringify(supportResult.data))
const supportMessage = outbox[outbox.length - 1]
check('the support message is addressed to the support inbox', supportMessage?.to === 'JavelinAIServices@gmail.com')
check('the support message replies to the sender', supportMessage?.replyTo === 'builder@example.com')
check('the support message contains the report and context', supportMessage?.text?.includes('The editor froze when I opened a folder.') && supportMessage?.text?.includes('Platform: win32') && supportMessage?.text?.includes('Mode: agent'))
check('the support message did not go through the email app', outbox.length === outboxBeforeSupport + 1)
const duplicateSupport = await callSupport({ topic: 'other', email: 'builder@example.com', message: 'This second message should be rate limited.' }, supportHeaders)
check('the support form rate limits repeated messages', duplicateSupport.status === 429)

console.log('\n12. SMTP mailbox support')
const smtpEnv = { SMTP_USER: 'builder@gmail.com', SMTP_PASS: 'app-password' }
const smtp = smtpConfig(smtpEnv)
check('Gmail is recognized with only a user and app password', smtp?.host === 'smtp.gmail.com' && smtp?.port === 465 && smtp?.secure === true)
check('the sender defaults to the mailbox address', smtp?.fromEmail === 'builder@gmail.com')
const yahooSmtp = smtpConfig({ SMTP_USER: 'javelinai_services@yahoo.com', SMTP_PASS: 'app-password' })
check('Yahoo is recognized with only a user and app password', yahooSmtp?.host === 'smtp.mail.yahoo.com' && yahooSmtp?.port === 465 && yahooSmtp?.secure === true)
const customSmtp = smtpConfig({ SMTP_USER: 'mailer@example.com', SMTP_PASS: 'secret', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587' })
check('a custom SMTP host uses STARTTLS on port 587', customSmtp?.host === 'smtp.example.com' && customSmtp?.port === 587 && customSmtp?.secure === false)
const smtpConfigResponse = await call('/config', { method: 'GET' }, { DB: new FakeD1(), ...smtpEnv })
check('the service reports SMTP email delivery configured', smtpConfigResponse.data.emailConfigured === true)
const smtpMime = buildSmtpMessage(smtp, { to: 'member@example.com', subject: 'Verify your Javelin email', text: 'Hello there', html: '<p>Hello there</p>' })
check('the SMTP message has sender, recipient and subject headers', smtpMime.includes('From: Javelin Accounts <builder@gmail.com>') && smtpMime.includes('To: <member@example.com>') && smtpMime.includes('Subject: Verify your Javelin email'))
const supportMime = buildSmtpMessage(smtp, { to: 'JavelinAIServices@gmail.com', replyTo: 'member@example.com', subject: '[Javelin Support] Bug report', text: 'Hello there', html: '<p>Hello there</p>' })
check('the SMTP message can reply to the support sender', supportMime.includes('Reply-To: Javelin Accounts <member@example.com>'))
check('the SMTP message has transactional delivery headers', smtpMime.includes('Reply-To: Javelin Accounts <builder@gmail.com>') && smtpMime.includes('Auto-Submitted: auto-generated') && smtpMime.includes('X-Auto-Response-Suppress: All'))
check('the SMTP message has both text and HTML bodies', smtpMime.includes('text/plain') && smtpMime.includes('text/html') && smtpMime.includes('Content-Transfer-Encoding: base64'))

const smtpServer = await startSmtpTestServer()
try {
  const smtpTestConfig = { ...smtp, host: '127.0.0.1', port: smtpServer.port }
  const connect = async () => {
    const socket = net.connect({ host: '127.0.0.1', port: smtpServer.port })
    socket.on('error', () => { /* sendSmtpEmail may close after QUIT */ })
    await once(socket, 'connect')
    return {
      readable: Readable.toWeb(socket),
      writable: Writable.toWeb(socket),
      opened: Promise.resolve(),
      close: () => socket.destroy(),
      startTls: () => { throw new Error('not used') },
    }
  }
  await sendSmtpEmail(smtpTestConfig, { to: 'member@example.com', subject: 'Verify your Javelin email', text: 'Hello there', html: '<p>Hello there</p>' }, { connect })
  check('the SMTP conversation authenticates and submits the message', smtpServer.received.commands.some((line) => line.startsWith('AUTH PLAIN ')) && smtpServer.received.commands.includes('MAIL FROM:<builder@gmail.com>') && smtpServer.received.commands.includes('RCPT TO:<member@example.com>') && smtpServer.received.commands.includes('DATA'))
  check('the SMTP server received the message body', smtpServer.received.message.includes('Subject: Verify your Javelin email') && smtpServer.received.message.includes('text/html'))
} finally {
  await new Promise((resolve) => smtpServer.server.close(resolve))
}

if (failures) {
  console.error(`\n${failures} account auth check(s) failed.`)
  process.exit(1)
}
console.log('\nALL ACCOUNT AUTH CHECKS PASSED\n')
