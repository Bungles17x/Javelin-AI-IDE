import { AlertTriangle, LifeBuoy, ShieldOff, X } from 'lucide-react'

function readableDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * A full-screen stop for a suspended account. It deliberately does not expose
 * tokens or internal moderation identifiers; only the reason and expiry are shown.
 */
export function BanScreen({ ban, onClose, onContactSupport }) {
  if (!ban) return null
  const expires = readableDate(ban.expiresAt)
  return (
    <div className="ban-backdrop" role="dialog" aria-modal="true" aria-labelledby="ban-title">
      <div className="ban-card">
        <button type="button" className="ban-close" onClick={onClose} aria-label="Close suspension notice" title="Close">
          <X size={16} />
        </button>
        <span className="ban-emblem"><ShieldOff size={28} /></span>
        <span className="ban-kicker">ACCOUNT SUSPENDED</span>
        <h1 id="ban-title">This account is on hold.</h1>
        <p className="ban-copy">
          Javelin moderation has suspended this account. You can keep using the app as a guest on this device,
          or contact support if you think this was a mistake.
        </p>

        <div className="ban-detail">
          <span>Reason</span>
          <strong>{ban.reason || 'No reason was provided.'}</strong>
        </div>
        <div className="ban-detail">
          <span>Access returns</span>
          <strong>{expires || 'Permanent suspension'}</strong>
        </div>

        <div className="ban-actions">
          <button type="button" className="ban-primary" onClick={onContactSupport}>
            <LifeBuoy size={15} /> Contact support
          </button>
          <button type="button" className="ban-secondary" onClick={onClose}>
            Continue as guest
          </button>
        </div>

        <p className="ban-fineprint">
          <AlertTriangle size={13} /> If you contact support, include the account email and this notice. Do not send
          your password or a sign-in code.
        </p>
      </div>
    </div>
  )
}
