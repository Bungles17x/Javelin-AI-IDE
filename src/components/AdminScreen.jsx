import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle, ArrowLeft, Ban, CheckCircle2, Clock, EyeOff, MessageSquare, Paperclip, RefreshCw, Search, ShieldCheck, Terminal, User, Users, X,
} from 'lucide-react'
import {
  banAccount, fetchAdminStats, fetchAdminUserHistory, fetchAdminUsers, setAccountRole, unbanAccount,
} from '../lib/accountAuth'

const HELP = `help                         Show this command list
users [search]               Load accounts, optionally filtered
stats                        Account and active-ban totals
ban <user|email> [reason]    Permanently suspend an account
tempban <user|email> <days> [reason]
                             Suspend an account for 1–3650 days
unban <user|email>           Restore an account
staff <user|email>           Promote a member (owner only)
member <user|email>          Demote staff to member (owner only)`

function shortDate(value) {
  if (!value) return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function shortDateTime(value) {
  if (!value) return 'never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'never'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function roleLabel(role) {
  if (role === 'user') return 'Member'
  if (role === 'assistant') return 'Javelin'
  return 'System'
}

function expiryLabel(value) {
  if (!value) return 'Permanent'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Permanent'
  return `Until ${date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

/**
 * Owner/staff console. The server is the source of truth for every permission:
 * this screen only makes the moderation commands easier to reach.
 */
export function AdminScreen({ open, session, onClose }) {
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [command, setCommand] = useState('')
  const [commandBusy, setCommandBusy] = useState(false)
  const [output, setOutput] = useState('')
  const [chatUser, setChatUser] = useState(null)
  const [chatHistory, setChatHistory] = useState(null)
  const [chatUpdatedAt, setChatUpdatedAt] = useState(null)
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [activeChatId, setActiveChatId] = useState('')
  const commandRef = useRef(null)
  const chatRequestRef = useRef(0)
  const token = session?.token
  const isOwner = session?.user?.role === 'owner'

  const closeChatView = useCallback(() => {
    chatRequestRef.current += 1
    setChatUser(null)
    setChatHistory(null)
    setChatUpdatedAt(null)
    setChatLoading(false)
    setChatError('')
    setActiveChatId('')
  }, [])

  const load = useCallback(async (nextQuery = '') => {
    if (!token) return []
    setLoading(true)
    setError('')
    try {
      const [nextUsers, nextStats] = await Promise.all([
        fetchAdminUsers(token, nextQuery),
        fetchAdminStats(token),
      ])
      setUsers(nextUsers)
      setStats(nextStats)
      return nextUsers
    } catch (loadError) {
      setError(loadError.message || String(loadError))
      return []
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setUsers([])
    setStats(null)
    setError('')
    setCommand('')
    setOutput('')
    closeChatView()
    void load('')
    const timer = setTimeout(() => commandRef.current?.focus(), 80)
    return () => clearTimeout(timer)
  }, [open, load, closeChatView])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && !commandBusy) {
        if (chatUser) closeChatView()
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, commandBusy, onClose, chatUser, closeChatView])

  if (!open) return null

  const refresh = async () => {
    const next = await load(query)
    if (next.length >= 0) setOutput(`${next.length} account${next.length === 1 ? '' : 's'} loaded.`)
  }

  const runImmediate = async (work) => {
    setCommandBusy(true)
    setError('')
    try {
      const result = await work()
      await load(query)
      return result
    } catch (actionError) {
      setError(actionError.message || String(actionError))
      return null
    } finally {
      setCommandBusy(false)
    }
  }

  const runCommand = async (event) => {
    event.preventDefault()
    const raw = command.trim()
    if (!raw || commandBusy) return
    const words = raw.split(/\s+/)
    const name = words.shift().toLowerCase()
    setCommandBusy(true)
    setError('')
    setOutput('')
    try {
      if (name === 'help') {
        setOutput(HELP)
      } else if (name === 'users') {
        const nextQuery = words.join(' ')
        setQuery(nextQuery)
        const next = await load(nextQuery)
        setOutput(`${next.length} account${next.length === 1 ? '' : 's'} loaded${nextQuery ? ` for “${nextQuery}”` : ''}.`)
      } else if (name === 'stats') {
        const next = await load(query)
        setOutput(`${next.length} accounts shown. The stats panel shows totals for your visible scope.`)
      } else if (name === 'ban' || name === 'tempban') {
        const identifier = words.shift()
        if (!identifier) throw new Error(`Usage: ${name} <username|email|id> ${name === 'tempban' ? '<days> ' : ''}[reason]`)
        let days = 0
        if (name === 'tempban') {
          days = Number(words.shift())
          if (!Number.isInteger(days) || days < 1 || days > 3650) {
            throw new Error('The duration must be a whole number from 1 to 3650 days.')
          }
        }
        const reason = words.join(' ') || 'No reason provided.'
        const result = await banAccount(token, { identifier, reason, days })
        const target = result?.user
        const notification = result?.notification?.sent
          ? 'Ban email sent to the account.'
          : result?.notification?.configured === false
            ? 'Ban applied, but ban email is not configured on the server.'
            : 'Ban applied, but the ban email could not be sent.'
        setOutput(`Banned ${target?.username || identifier}. ${expiryLabel(target?.banExpiresAt)}.\nReason: ${target?.banReason || reason}\n${notification}`)
        await load(query)
      } else if (name === 'unban') {
        const identifier = words.shift()
        if (!identifier) throw new Error('Usage: unban <username|email|id>')
        const result = await unbanAccount(token, identifier)
        setOutput(`Restored access for ${result?.user?.username || identifier}.`)
        await load(query)
      } else if (name === 'staff' || name === 'member') {
        const identifier = words.shift()
        if (!identifier) throw new Error(`Usage: ${name} <username|email|id>`)
        const result = await setAccountRole(token, { identifier, role: name })
        setOutput(`${result?.user?.username || identifier} is now ${name}.`)
        await load(query)
      } else {
        throw new Error(`Unknown command “${name}”. Type help for the command list.`)
      }
    } catch (commandError) {
      setError(commandError.message || String(commandError))
    } finally {
      setCommandBusy(false)
    }
  }

  const quickUnban = (user) => runImmediate(async () => {
    const result = await unbanAccount(token, user.username)
    setOutput(`Restored access for ${result?.user?.username || user.username}.`)
  })

  const quickRole = (user) => runImmediate(async () => {
    const role = user.role === 'staff' ? 'member' : 'staff'
    const result = await setAccountRole(token, { identifier: user.username, role })
    setOutput(`${result?.user?.username || user.username} is now ${role}.`)
  })

  const quickBan = (user) => {
    setCommand(`ban ${user.username} `)
    setOutput(`Add a reason and press Run to ban ${user.username}, or use tempban ${user.username} 7 <reason> for a timed ban.`)
    commandRef.current?.focus()
  }

  const openChatView = async (user) => {
    const requestId = chatRequestRef.current + 1
    chatRequestRef.current = requestId
    setChatUser(user)
    setChatHistory(null)
    setChatUpdatedAt(null)
    setChatLoading(true)
    setChatError('')
    setActiveChatId('')
    try {
      const result = await fetchAdminUserHistory(token, user.id)
      if (requestId !== chatRequestRef.current) return
      const history = result?.history || { conversations: [] }
      setChatUser(result?.user || user)
      setChatHistory(history)
      setChatUpdatedAt(result?.updatedAt || null)
      setActiveChatId(history.conversations?.[0]?.id || '')
    } catch (loadError) {
      if (requestId !== chatRequestRef.current) return
      setChatError(loadError.message || String(loadError))
    } finally {
      if (requestId === chatRequestRef.current) setChatLoading(false)
    }
  }

  const conversations = chatHistory?.conversations || []
  const activeConversation = conversations.find((conversation) => conversation.id === activeChatId) || conversations[0] || null

  return (
    <div className="admin-backdrop" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <div className="admin-screen">
        <header className="admin-header">
          <div className="admin-brand">
            <span className="admin-emblem"><ShieldCheck size={19} /></span>
            <div>
              <span className="admin-kicker">JAVELIN STAFF</span>
              <h2 id="admin-title">Moderation console</h2>
            </div>
          </div>
          <div className="admin-header-actions">
            <span className={`admin-role is-${session?.user?.role || 'member'}`}>{session?.user?.role || 'member'}</span>
            <button type="button" className="admin-close" onClick={onClose} aria-label="Close moderation console" title="Close">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="admin-body">
          {stats?.restricted && (
            <div className="admin-scope-banner" role="status">
              <span className="admin-scope-icon"><EyeOff size={15} /></span>
              <div className="admin-scope-copy">
                <strong>Rank-limited view</strong>
                <span>Owner accounts are hidden because they rank above you. All member and staff accounts are visible.</span>
              </div>
            </div>
          )}

          <div className="admin-stats" aria-live="polite">
            <div className="admin-stat"><Users size={15} /><strong>{stats?.total ?? '—'}</strong><span>{stats?.restricted ? 'visible accounts' : 'accounts'}</span></div>
            <div className="admin-stat"><ShieldCheck size={15} /><strong>{stats?.staff ?? '—'}</strong><span>staff</span></div>
            <div className="admin-stat"><Ban size={15} /><strong>{stats?.banned ?? '—'}</strong><span>active bans</span></div>
            <div className="admin-stat"><User size={15} /><strong>{stats?.members ?? '—'}</strong><span>members</span></div>
          </div>

          <div className="admin-toolbar">
            <label className="admin-search">
              <Search size={15} />
              <span className="sr-only">Search accounts</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void refresh()
                  }
                }}
                placeholder="Search username or email"
                autoComplete="off"
                disabled={loading}
              />
            </label>
            <button type="button" className="admin-refresh" onClick={() => void refresh()} disabled={loading || commandBusy}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {error && <p className="admin-error" role="alert"><AlertCircle size={14} /> {error}</p>}

          <div className="admin-user-list" aria-label="Javelin accounts">
            {loading && users.length === 0 ? (
              <p className="admin-empty">Loading accounts…</p>
            ) : users.length === 0 ? (
              <p className="admin-empty">No accounts match that search.</p>
            ) : users.map((user) => (
              <article key={user.id} className={`admin-user${user.banned ? ' is-banned' : ''}`}>
                <span className="admin-avatar" aria-hidden="true">{String(user.username).slice(0, 2).toUpperCase()}</span>
                <div className="admin-user-info">
                  <div className="admin-user-name">
                    <strong>{user.username}</strong>
                    <span className={`admin-role is-${user.role}`}>{user.role}</span>
                    {user.banned && <span className="admin-ban-badge">Banned</span>}
                  </div>
                  <small>{user.email} · Joined {shortDate(user.createdAt)}</small>
                  {user.banned && (
                    <p className="admin-ban-detail">
                      <Clock size={12} /> {expiryLabel(user.banExpiresAt)} · {user.banReason || 'No reason provided.'}
                    </p>
                  )}
                </div>
                <div className="admin-user-actions">
                  <button type="button" className="admin-action is-chat" onClick={() => void openChatView(user)} disabled={commandBusy}>
                    <MessageSquare size={13} /> Chats
                  </button>
                  {user.role !== 'owner' && (isOwner || user.role === 'member') && (
                    user.banned ? (
                      <button type="button" className="admin-action is-restore" onClick={() => void quickUnban(user)} disabled={commandBusy}>
                        <CheckCircle2 size={13} /> Unban
                      </button>
                    ) : (
                      <button type="button" className="admin-action is-ban" onClick={() => quickBan(user)} disabled={commandBusy}>
                        <Ban size={13} /> Ban
                      </button>
                    )
                  )}
                  {isOwner && user.role !== 'owner' && (
                    <button type="button" className="admin-action" onClick={() => void quickRole(user)} disabled={commandBusy}>
                      {user.role === 'staff' ? 'Make member' : 'Make staff'}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>

          <section className="admin-command" aria-label="Admin commands">
            <div className="admin-command-head">
              <span><Terminal size={14} /> Command console</span>
              <small>Server-enforced · every action is audited</small>
            </div>
            <form onSubmit={runCommand} className="admin-command-form">
              <input
                ref={commandRef}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="ban username reason"
                aria-label="Admin command"
                autoComplete="off"
                spellCheck={false}
                disabled={commandBusy}
              />
              <button type="submit" disabled={commandBusy || !command.trim()}>
                {commandBusy ? 'Running…' : 'Run'}
              </button>
            </form>
            <pre className="admin-output" aria-live="polite">{output || HELP}</pre>
          </section>
        </div>

        {chatUser && (
          <section className="admin-chat-view" aria-labelledby="admin-chat-title">
            <header className="admin-chat-head">
              <button type="button" className="admin-chat-back" onClick={closeChatView}>
                <ArrowLeft size={14} /> Accounts
              </button>
              <div className="admin-chat-identity">
                <div className="admin-chat-name">
                  <strong id="admin-chat-title">{chatUser.username}</strong>
                  <span className={`admin-role is-${chatUser.role}`}>{chatUser.role}</span>
                  {chatUser.banned && <span className="admin-ban-badge">Banned</span>}
                </div>
                <small>
                  {chatUser.email} · Joined {shortDate(chatUser.createdAt)} · Last synced {shortDateTime(chatUpdatedAt)}
                </small>
              </div>
              <button type="button" className="admin-close" onClick={closeChatView} aria-label="Close chat history" title="Close chat history">
                <X size={17} />
              </button>
            </header>

            {chatUser.banned && (
              <p className="admin-chat-ban">
                <Clock size={12} /> {expiryLabel(chatUser.banExpiresAt)} · {chatUser.banReason || 'No reason provided.'}
              </p>
            )}

            {chatLoading ? (
              <p className="admin-chat-empty">Loading synced conversations…</p>
            ) : chatError ? (
              <div className="admin-chat-error" role="alert">
                <AlertCircle size={15} />
                <div>
                  <strong>Could not load this account’s chats.</strong>
                  <span>{chatError}</span>
                  <button type="button" onClick={() => void openChatView(chatUser)}>Retry</button>
                </div>
              </div>
            ) : (
              <div className="admin-chat-layout">
                <nav className="admin-chat-list" aria-label="Synced conversations">
                  <div className="admin-chat-list-head">
                    <span>Conversations</span>
                    <small>{conversations.length}</small>
                  </div>
                  {conversations.length === 0 ? (
                    <p className="admin-chat-empty">No synced conversations for this account.</p>
                  ) : conversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      className={`admin-chat-item${conversation.id === activeConversation?.id ? ' is-active' : ''}`}
                      onClick={() => setActiveChatId(conversation.id)}
                    >
                      <strong>{conversation.title || 'Untitled conversation'}</strong>
                      <small>{conversation.messages.length} message{conversation.messages.length === 1 ? '' : 's'} · {shortDateTime(conversation.updatedAt)}</small>
                    </button>
                  ))}
                </nav>

                <div className="admin-chat-thread">
                  {activeConversation ? (
                    <>
                      <div className="admin-chat-thread-head">
                        <div>
                          <strong>{activeConversation.title || 'Untitled conversation'}</strong>
                          <small>{activeConversation.messages.length} message{activeConversation.messages.length === 1 ? '' : 's'} · Updated {shortDateTime(activeConversation.updatedAt)}</small>
                        </div>
                        <span className="admin-chat-scope">{isOwner ? 'Owner view' : 'Rank-limited view'}</span>
                      </div>
                      <div className="admin-chat-messages">
                        {activeConversation.messages.length === 0 ? (
                          <p className="admin-chat-empty">This conversation has no messages.</p>
                        ) : activeConversation.messages.map((message, index) => (
                          <article key={message.id || `${activeConversation.id}-${index}`} className={`admin-chat-message is-${message.role || 'system'}`}>
                            <div className="admin-chat-meta">
                              <span>{roleLabel(message.role)}</span>
                              {message.ts ? <time>{shortDateTime(message.ts)}</time> : null}
                            </div>
                            <p>{message.content || '(empty message)'}</p>
                            {message.attachments?.length > 0 && (
                              <div className="admin-chat-attachments">
                                {message.attachments.map((attachment, attachmentIndex) => (
                                  <span key={attachment.id || `${index}-${attachmentIndex}`}>
                                    <Paperclip size={10} /> {attachment.name || attachment.kind}
                                    {attachment.mime ? ` · ${attachment.mime}` : ''}
                                    {formatBytes(attachment.size) ? ` · ${formatBytes(attachment.size)}` : ''}
                                  </span>
                                ))}
                              </div>
                            )}
                            {message.image && (message.image.prompt || message.image.seed || message.image.status) && (
                              <div className="admin-chat-image-meta">
                                {message.image.status && <span>Image {message.image.status}</span>}
                                {message.image.prompt && <span>Prompt: {message.image.prompt}</span>}
                                {message.image.seed && <span>Seed: {message.image.seed}</span>}
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="admin-chat-empty">Select a conversation to read it.</p>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
