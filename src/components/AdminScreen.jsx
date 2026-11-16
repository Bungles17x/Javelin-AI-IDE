import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle, Ban, CheckCircle2, Clock, EyeOff, RefreshCw, Search, ShieldCheck, Terminal, User, Users, X,
} from 'lucide-react'
import {
  banAccount, fetchAdminStats, fetchAdminUsers, setAccountRole, unbanAccount,
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
  const commandRef = useRef(null)
  const token = session?.token
  const isOwner = session?.user?.role === 'owner'

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
    void load('')
    const timer = setTimeout(() => commandRef.current?.focus(), 80)
    return () => clearTimeout(timer)
  }, [open, load])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && !commandBusy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, commandBusy, onClose])

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
      </div>
    </div>
  )
}
