import { useEffect, useRef, useState } from 'react'
import { KeyRound, Lock, ShieldCheck, X } from 'lucide-react'
import { createOwnerCredential, GUEST_DAILY_LIMIT, OWNER_USERNAME, verifyOwnerPassphrase } from '../lib/ownerAuth'

const REASON_COPY = {
  debug: 'The debug console contains system internals and is reserved for the owner account.',
  limit: `You have used all ${GUEST_DAILY_LIMIT} guest AI requests for today. The owner account is unlimited.`,
  unlimited: 'Owner access unlocks unlimited AI use and the debug console on this computer.',
  reload: 'The app needs to restart. Sign in as the owner to reopen diagnostics after it reloads.',
}

/**
 * Local owner gate.
 *
 * First use creates the owner credential; later uses verify the passphrase.
 * Guests can close this screen and keep using the app within their daily limit.
 */
export function OwnerLogin({ open, credential, reason = 'unlimited', onClose, onAuthenticated, onCreateCredential }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const passphraseRef = useRef(null)
  const setup = !credential

  useEffect(() => {
    if (!open) return
    setPassphrase('')
    setConfirmation('')
    setError('')
    setBusy(false)
    const timer = setTimeout(() => passphraseRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [open, setup])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      if (setup) {
        if (passphrase !== confirmation) throw new Error('The passphrases do not match.')
        const nextCredential = await createOwnerCredential(passphrase)
        onCreateCredential(nextCredential)
        return
      }
      const valid = await verifyOwnerPassphrase(credential, passphrase)
      if (!valid) {
        setError('That passphrase does not match the owner account on this computer.')
        setPassphrase('')
        passphraseRef.current?.focus()
        return
      }
      onAuthenticated()
    } catch (authError) {
      setError(authError.message || String(authError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="owner-login-backdrop" role="dialog" aria-modal="true" aria-labelledby="owner-login-title">
      <div className="owner-login-card">
        <button className="owner-login-close" type="button" aria-label="Continue as guest" title="Continue as guest" onClick={onClose} disabled={busy}>
          <X size={16} />
        </button>

        <div className="owner-login-emblem"><Lock size={22} /></div>
        <span className="owner-login-kicker">OWNER ACCESS</span>
        <h2 id="owner-login-title">{setup ? 'Set up owner access' : 'Welcome back'}</h2>
        <p className="owner-login-copy">
          {setup
            ? 'Create the local owner passphrase for this computer. It unlocks the debug console and unlimited AI use.'
            : REASON_COPY[reason] ?? REASON_COPY.unlimited}
        </p>

        <form className="owner-login-form" onSubmit={submit}>
          <label>
            <span>Owner account</span>
            <div className="owner-account-display"><ShieldCheck size={14} /> {OWNER_USERNAME}</div>
          </label>
          <label>
            <span>{setup ? 'New passphrase' : 'Passphrase'}</span>
            <input
              ref={passphraseRef}
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={setup ? 'At least 8 characters' : 'Enter the owner passphrase'}
              autoComplete={setup ? 'new-password' : 'current-password'}
              minLength={setup ? 8 : undefined}
              disabled={busy}
            />
          </label>
          {setup && (
            <label>
              <span>Confirm passphrase</span>
              <input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="Repeat the passphrase"
                autoComplete="new-password"
                minLength={8}
                disabled={busy}
              />
            </label>
          )}
          {error && <p className="owner-login-error" role="alert">{error}</p>}
          <button className="owner-login-submit" type="submit" disabled={busy || (setup && (!passphrase || !confirmation))}>
            <KeyRound size={15} />
            {busy ? 'Checking…' : setup ? 'Create owner access' : 'Unlock owner access'}
          </button>
        </form>

        <div className="owner-login-footnote">
          <p>
            {setup
              ? 'The passphrase is hashed with PBKDF2 and stored only on this computer. It cannot be recovered if you forget it.'
              : `Guests can use ${GUEST_DAILY_LIMIT} AI requests per day. Owner sessions are not stored on disk.`}
          </p>
          <button type="button" onClick={onClose} disabled={busy}>Continue as guest</button>
        </div>
      </div>
    </div>
  )
}
