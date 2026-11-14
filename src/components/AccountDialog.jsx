import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle, ArrowLeft, Bell, CheckCircle2, Lock, LogIn, LogOut, Mail, RefreshCw, ShieldCheck, User, UserPlus, X,
} from 'lucide-react'
import {
  fetchAuthConfig, fetchSecuritySettings, lockAccount, pollEmailLogin, requestEmailLogin, requestPasswordReset,
  resendVerification, signIn, signUp, submitEmailCode, updateSecuritySettings,
} from '../lib/accountAuth'
import { formatTokenCount, MEMBER_TOKEN_LIMIT } from '../lib/usage'

const REASON_COPY = {
  limit: `You have used the guest allowance for today. Create a free account with ${formatTokenCount(MEMBER_TOKEN_LIMIT)} tokens.`,
  account: `Sign in to use your ${formatTokenCount(MEMBER_TOKEN_LIMIT)}-token allowance and keep your identity on every device.`,
  locked: 'Your account is locked. Use the email sign-in link or 6-digit code to unlock it.',
  default: `Create a Javelin account with ${formatTokenCount(MEMBER_TOKEN_LIMIT)} tokens, or sign in to one you already have.`,
}

/**
 * Online account screen. The local owner login is separate: this is for normal
 * Javelin users, while the owner gate still protects the local debug console.
 */
export function AccountDialog({
  open, session, reason = 'default', onClose, onAuthenticated, onSignOut,
  onOpenOwnerLogin, onOpenDebug, onOpenAdmin, onRefreshAccount, onBanned, onAccountLocked,
}) {
  const [mode, setMode] = useState('signin')
  const [signInMethod, setSignInMethod] = useState('email')
  const [identifier, setIdentifier] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [ownerCode, setOwnerCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [emailConfigured, setEmailConfigured] = useState(true)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifyNotice, setVerifyNotice] = useState('')
  const [emailLogin, setEmailLogin] = useState(null)
  const [emailCode, setEmailCode] = useState('')
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeError, setCodeError] = useState('')
  const [security, setSecurity] = useState(null)
  const [securityBusy, setSecurityBusy] = useState(false)
  const [securityNotice, setSecurityNotice] = useState('')
  const [lockConfirm, setLockConfirm] = useState(false)
  const firstFieldRef = useRef(null)

  const isOwner = session?.user?.role === 'owner'
  const isStaff = session?.user?.role === 'staff'
  const ownerName = String(username).trim().toLowerCase() === 'bungles17x'
  const emailVerified = Boolean(session?.user?.emailVerified)

  useEffect(() => {
    if (!open) return
    setIdentifier('')
    setUsername('')
    setEmail('')
    setPassword('')
    setConfirmation('')
    setOwnerCode('')
    setBusy(false)
    setError('')
    setNotice('')
    setVerifyNotice('')
    setVerifyBusy(false)
    setSignInMethod('email')
    setEmailLogin(null)
    setEmailCode('')
    setCodeBusy(false)
    setCodeError('')
    setSecurity(null)
    setSecurityBusy(false)
    setSecurityNotice('')
    setLockConfirm(false)
    setMode('signin')
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  useEffect(() => {
    if (!open) return undefined
    let active = true
    setEmailConfigured(true)
    fetchAuthConfig()
      .then((config) => {
        if (!active) return
        setEmailConfigured(Boolean(config.emailConfigured))
        if (!config.emailConfigured) setSignInMethod('password')
      })
      .catch(() => {
        /* the resend/signup requests will explain a delivery failure */
      })
    return () => { active = false }
  }, [open])

  useEffect(() => {
    if (!open || !session?.token) return undefined
    let active = true
    fetchSecuritySettings(session.token)
      .then((result) => {
        if (active) setSecurity(result.settings || null)
      })
      .catch(() => {
        /* account polling reports an expired or locked session */
      })
    return () => { active = false }
  }, [open, session?.token])

  useEffect(() => {
    if (!open || !emailLogin || mode !== 'signin' || signInMethod !== 'email') return undefined
    let cancelled = false
    let timer
    const wait = (milliseconds) => {
      timer = setTimeout(poll, milliseconds)
    }
    const poll = async () => {
      try {
        const result = await pollEmailLogin(emailLogin)
        if (cancelled) return
        if (result.status === 'signed-in' && result.session) {
          onAuthenticated(result.session)
          return
        }
        if (result.status === 'expired') {
          setError('That sign-in link expired. Request a new one.')
          setEmailLogin(null)
          return
        }
        setError('')
        wait(2500)
      } catch (pollError) {
        if (cancelled) return
        if (reportBan(pollError)) {
          setEmailLogin(null)
          return
        }
        setError(pollError.message || String(pollError))
        wait(5000)
      }
    }
    wait(800)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, emailLogin, mode, signInMethod, onAuthenticated])

  useEffect(() => {
    if (!open || !session?.token || !onRefreshAccount) return
    // Opening the account screen is a good moment to pick up a verification
    // completed in the browser's email link.
    onRefreshAccount().catch(() => {})
    // Deliberately once per opening, not on every refreshed user object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const reportBan = (authFailure) => {
    if (authFailure?.code !== 'ACCOUNT_BANNED') return false
    onBanned?.(authFailure.details?.ban || { reason: authFailure.message })
    return true
  }

  const changeMode = (next) => {
    setMode(next)
    setError('')
    setNotice('')
    setPassword('')
    setConfirmation('')
    setEmailLogin(null)
    setEmailCode('')
    setCodeError('')
  }

  const changeSignInMethod = (next) => {
    setSignInMethod(next)
    setEmailLogin(null)
    setEmailCode('')
    setCodeError('')
    setError('')
    setNotice('')
  }

  const submitCode = async (event) => {
    event.preventDefault()
    if (!emailLogin || codeBusy || emailCode.length !== 6) return
    setCodeBusy(true)
    setCodeError('')
    try {
      const result = await submitEmailCode({
        requestId: emailLogin.requestId,
        code: emailCode,
      })
      if (result.session) onAuthenticated(result.session)
      else setCodeError('That code could not be used. Request a new sign-in email.')
    } catch (codeFailure) {
        if (reportBan(codeFailure)) {
          setEmailLogin(null)
          return
        }
      setCodeError(codeFailure.message || String(codeFailure))
    } finally {
      setCodeBusy(false)
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mode === 'forgot') {
        await requestPasswordReset(email)
        setNotice('If an account exists for that email, a reset link is on its way.')
      } else if (mode === 'signup') {
        if (password !== confirmation) throw new Error('The passwords do not match.')
        const next = await signUp({ username, email, password, ownerCode })
        onAuthenticated(next)
      } else if (signInMethod === 'email') {
        const result = await requestEmailLogin(email)
        if (result.cooldown) {
          setNotice('A sign-in link was requested recently. Check your inbox, or wait a minute before trying again.')
        } else {
          setEmailLogin({
            email: email.trim(),
            requestId: result.requestId,
            pollToken: result.pollToken,
          })
          setEmailCode('')
          setCodeError('')
          setNotice('')
        }
      } else {
        const next = await signIn({ identifier, password })
        onAuthenticated(next)
      }
    } catch (authError) {
      if (reportBan(authError)) return
      if (authError?.code === 'ACCOUNT_LOCKED') {
        setSignInMethod('email')
      }
      if (authError?.code === 'EMAIL_VERIFICATION_REQUIRED') {
        const details = authError.details || {}
        setSignInMethod('email')
        if (details.email) setEmail(details.email)
        if (details.requestId && details.pollToken) {
          setEmailLogin({
            email: details.email || email.trim(),
            requestId: details.requestId,
            pollToken: details.pollToken,
          })
          setEmailCode('')
          setCodeError('')
          setNotice('')
        }
      }
      setError(authError.message || String(authError))
    } finally {
      setBusy(false)
    }
  }

  const resendEmail = async () => {
    if (!session?.token || verifyBusy) return
    setVerifyBusy(true)
    setVerifyNotice('')
    setError('')
    try {
      const result = await resendVerification(session.token)
      if (result.alreadyVerified) {
        setVerifyNotice('This email is already verified.')
        await onRefreshAccount?.()
      } else if (result.cooldown) {
        setVerifyNotice('A verification email was sent recently. Wait a minute before resending.')
      } else if (result.configured && result.sent) {
        setVerifyNotice('Verification email sent. Check your inbox and spam folder.')
      } else if (!result.configured) {
        setVerifyNotice('Email delivery is not configured on the account server yet.')
      } else {
        setVerifyNotice('The verification email could not be sent. Try again in a moment.')
      }
    } catch (resendError) {
      setVerifyNotice(resendError.message || String(resendError))
    } finally {
      setVerifyBusy(false)
    }
  }

  const toggleSecurity = async (key) => {
    if (!session?.token || !security || securityBusy) return
    setSecurityBusy(true)
    setSecurityNotice('')
    setError('')
    try {
      const nextValue = !security[key]
      const result = await updateSecuritySettings(session.token, { [key]: nextValue })
      setSecurity(result.settings || security)
      if (key === 'requireEmailVerification' && result.verification) {
        setSecurityNotice(result.verification.sent
          ? 'Verification email sent. Password sign-ins now use an emailed link or code.'
          : 'The setting is on, but the verification email could not be sent. Use Resend above.')
      } else if (key === 'requireEmailVerification') {
        setSecurityNotice(nextValue
          ? 'Password sign-in now requires an emailed verification link or code.'
          : 'Password sign-in no longer requires an emailed verification step.')
      } else {
        setSecurityNotice(nextValue ? 'New-login alert emails are on.' : 'New-login alert emails are off.')
      }
      await onRefreshAccount?.()
    } catch (securityError) {
      setError(securityError.message || String(securityError))
    } finally {
      setSecurityBusy(false)
    }
  }

  const confirmAccountLock = async () => {
    if (!session?.token || securityBusy) return
    setSecurityBusy(true)
    setSecurityNotice('')
    setError('')
    try {
      await lockAccount(session.token)
      setLockConfirm(false)
      setNotice('Account locked. Use the email sign-in link or 6-digit code to unlock it.')
      onAccountLocked?.()
    } catch (lockError) {
      setError(lockError.message || String(lockError))
    } finally {
      setSecurityBusy(false)
    }
  }

  const canSubmit = mode === 'forgot'
    ? Boolean(email.trim())
    : mode === 'signin'
      ? signInMethod === 'email'
        ? Boolean(email.trim())
        : Boolean(identifier && password)
      : Boolean(username && email && password && confirmation)

  return (
    <div className="owner-login-backdrop" role="dialog" aria-modal="true" aria-labelledby="account-title">
      <div className="owner-login-card account-card">
        <button className="owner-login-close" type="button" aria-label="Close account" title="Close" onClick={onClose} disabled={busy}>
          <X size={16} />
        </button>

        {session ? (
          <>
            <div className="account-avatar"><User size={22} /></div>
            <span className="owner-login-kicker">JAVELIN ACCOUNT</span>
            <h2 id="account-title">{session.user.username}</h2>
            <p className="owner-login-copy">{session.user.email}</p>

            {emailVerified ? (
              <div className="account-verified">
                <CheckCircle2 size={14} /> Email verified
              </div>
            ) : (
              <div className="account-verify">
                <Mail size={17} />
                <div>
                  <strong>Verify your email</strong>
                  <small>Check your inbox for a verification link.</small>
                </div>
                <button type="button" onClick={resendEmail} disabled={verifyBusy}>
                  {verifyBusy ? <RefreshCw size={13} className="spin" /> : <RefreshCw size={13} />}
                  {verifyBusy ? 'Sending…' : 'Resend'}
                </button>
              </div>
            )}
            {verifyNotice && <p className="account-notice" role="status"><Mail size={13} /> {verifyNotice}</p>}
            {!emailVerified && !emailConfigured && (
              <p className="account-notice is-warning" role="status">
                <AlertCircle size={13} /> Email delivery is not configured on the account server yet.
              </p>
            )}

            <div className="account-plan">
              <ShieldCheck size={15} />
              <div>
                <strong>{isOwner ? 'Owner account' : isStaff ? 'Staff account' : 'Member account'}</strong>
                <small>
                  {isOwner
                    ? 'Unlimited AI access and debug console'
                    : isStaff
                      ? `Moderation tools · ${formatTokenCount(MEMBER_TOKEN_LIMIT)} tokens included`
                      : `${formatTokenCount(MEMBER_TOKEN_LIMIT)} tokens included`}
                </small>
              </div>
            </div>

            <div className="account-security">
              <div className="account-security-head">
                <ShieldCheck size={15} />
                <div>
                  <strong>Account security</strong>
                  <small>Choose how sign-in protects this account.</small>
                </div>
              </div>

              {security ? (
                <>
                  <label className="account-toggle">
                    <input
                      type="checkbox"
                      checked={security.requireEmailVerification}
                      onChange={() => toggleSecurity('requireEmailVerification')}
                      disabled={securityBusy || !security.emailConfigured}
                    />
                    <span>
                      <strong>Require email verification</strong>
                      <small>
                        {security.requireEmailVerification
                          ? security.emailVerified
                            ? 'Every password sign-in asks for a one-time email link or 6-digit code.'
                            : 'Password sign-in uses an emailed link or code, which also verifies this address.'
                          : security.emailVerified
                            ? 'Your email is verified. Turn this on to require a fresh email check for each password sign-in.'
                            : 'Turn this on to require an emailed link or code before password sign-in; this also verifies your address.'}
                      </small>
                    </span>
                  </label>

                  <label className="account-toggle">
                    <input
                      type="checkbox"
                      checked={security.loginAlerts}
                      onChange={() => toggleSecurity('loginAlerts')}
                      disabled={securityBusy || !security.emailConfigured}
                    />
                    <span>
                      <strong>Email me about new sign-ins</strong>
                      <small>Get a security email whenever this account signs in, with the time and device.</small>
                    </span>
                  </label>

                  {security.locked && (
                    <p className="account-notice is-warning" role="status"><Lock size={13} /> This account is locked until an email verification sign-in.</p>
                  )}
                  {!security.emailConfigured && (
                    <p className="account-notice is-warning" role="status"><AlertCircle size={13} /> Email delivery is not configured, so these controls are unavailable.</p>
                  )}

                  {lockConfirm ? (
                    <div className="account-lock-confirm" role="alert">
                      <p><Lock size={13} /> Lock this account and sign out every device? You will need the email sign-in link or code to get back in.</p>
                      <div>
                        <button type="button" className="account-lock-button" onClick={confirmAccountLock} disabled={securityBusy}>
                          {securityBusy ? 'Locking…' : 'Yes, lock my account'}
                        </button>
                        <button type="button" className="account-inline-link" onClick={() => setLockConfirm(false)} disabled={securityBusy}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="account-lock-button"
                      onClick={() => setLockConfirm(true)}
                      disabled={securityBusy || !security.emailConfigured}
                    >
                      <Lock size={13} /> Lock my account
                    </button>
                  )}
                </>
              ) : (
                <p className="account-security-loading"><RefreshCw size={13} className={securityBusy ? 'spin' : ''} /> Loading security settings…</p>
              )}
              {securityNotice && <p className="account-notice" role="status"><CheckCircle2 size={13} /> {securityNotice}</p>}
            </div>
            <div className="account-signed-actions">
              {(isOwner || isStaff) && onOpenAdmin && (
                <button type="button" className="account-secondary" onClick={onOpenAdmin}>
                  <ShieldCheck size={14} /> Moderation console
                </button>
              )}
              {isOwner && (
                <button type="button" className="account-secondary" onClick={onOpenDebug}>
                  <ShieldCheck size={14} /> Owner diagnostics
                </button>
              )}
              <button type="button" className="account-signout" onClick={onSignOut} disabled={busy}>
                <LogOut size={14} /> {busy ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
            <p className="account-fineprint">
              Your account is hosted by Javelin Cloud. Passwords are hashed on the server and never stored in this app.
              {emailVerified ? ' Password reset is available from the sign-in screen.' : ' Verify your email to secure password recovery.'}
            </p>
          </>
        ) : (
          <>
            <div className="account-avatar"><User size={22} /></div>
            <span className="owner-login-kicker">JAVELIN ACCOUNTS</span>
            <h2 id="account-title">
              {mode === 'forgot'
                ? 'Reset your password'
                : mode === 'signin'
                  ? signInMethod === 'email' ? 'Sign in with email' : 'Sign in'
                  : 'Create your account'}
            </h2>
            <p className="owner-login-copy">
              {mode === 'forgot'
                ? 'Enter the email on your account and we will send a one-time reset link.'
                : mode === 'signin' && signInMethod === 'email'
                  ? 'Enter your account email. We will send a one-click sign-in link — no password to remember.'
                : REASON_COPY[reason] ?? REASON_COPY.default}
            </p>

            {mode === 'forgot' ? (
              <button type="button" className="account-back" onClick={() => changeMode('signin')} disabled={busy}>
                <ArrowLeft size={13} /> Back to sign in
              </button>
            ) : (
              <div className="account-tabs" role="tablist" aria-label="Account action">
                <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'is-active' : ''} onClick={() => changeMode('signin')} disabled={busy}>
                  <LogIn size={13} /> Sign in
                </button>
                <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-active' : ''} onClick={() => changeMode('signup')} disabled={busy}>
                  <UserPlus size={13} /> Sign up
                </button>
              </div>
            )}

            {mode === 'signin' && !emailLogin && (
              <div className="account-methods" role="tablist" aria-label="Sign-in method">
                <button
                  type="button"
                  role="tab"
                  aria-selected={signInMethod === 'email'}
                  className={signInMethod === 'email' ? 'is-active' : ''}
                  onClick={() => changeSignInMethod('email')}
                  disabled={busy || !emailConfigured}
                  title={emailConfigured ? 'Email me a one-click sign-in link' : 'Email delivery is not configured'}
                >
                  <Mail size={13} /> Email link
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={signInMethod === 'password'}
                  className={signInMethod === 'password' ? 'is-active' : ''}
                  onClick={() => changeSignInMethod('password')}
                  disabled={busy}
                >
                  <LogIn size={13} /> Password
                </button>
              </div>
            )}

            {mode === 'signin' && signInMethod === 'email' && emailLogin ? (
              <div className="account-email-wait" role="status" aria-live="polite">
                <div className="account-email-orbit"><Mail size={21} /></div>
                <h3>Check your inbox</h3>
                <p>
                  We sent a one-click link to <strong>{emailLogin.email}</strong>. Open it and press{' '}
                  <strong>Sign in to Javelin</strong>; this window will finish signing you in automatically.
                </p>
                <div className="account-email-status"><span className="account-status-dot" /> Waiting for confirmation…</div>
                {notice && <p className="account-notice" role="status"><CheckCircle2 size={13} /> {notice}</p>}
                {error && <p className="owner-login-error" role="alert"><AlertCircle size={13} /> {error}</p>}
                <form className="account-code-form" onSubmit={submitCode}>
                  <label>
                    <span>Button not working? Use the 6-digit code from the email.</span>
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={emailCode}
                      onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      disabled={codeBusy}
                    />
                  </label>
                  <button type="submit" className="account-secondary" disabled={codeBusy || emailCode.length !== 6}>
                    {codeBusy ? 'Checking…' : 'Use code'}
                  </button>
                </form>
                {codeError && <p className="owner-login-error" role="alert"><AlertCircle size={13} /> {codeError}</p>}
                <div className="account-email-wait-actions">
                  <button type="button" className="account-secondary" onClick={() => { setEmailLogin(null); setEmailCode(''); setCodeError(''); setError(''); setNotice('') }} disabled={busy}>
                    Use a different email
                  </button>
                  <button type="button" className="account-inline-link" onClick={() => changeSignInMethod('password')} disabled={busy}>
                    Use password instead
                  </button>
                </div>
              </div>
            ) : (
            <form className="owner-login-form" onSubmit={submit}>
              {mode === 'forgot' ? (
                <label>
                  <span>Email</span>
                  <input
                    ref={firstFieldRef}
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    disabled={busy}
                  />
                </label>
              ) : mode === 'signin' ? (
                signInMethod === 'email' ? (
                  <label>
                    <span>Account email</span>
                    <input
                      ref={firstFieldRef}
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                      disabled={busy}
                    />
                  </label>
                ) : (
                  <label>
                    <span>Username or email</span>
                    <input
                      ref={firstFieldRef}
                      value={identifier}
                      onChange={(event) => setIdentifier(event.target.value)}
                      placeholder="you@example.com"
                      autoComplete="username"
                      disabled={busy}
                    />
                  </label>
                )
              ) : (
                <>
                  <label>
                    <span>Username</span>
                    <input
                      ref={firstFieldRef}
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="3–24 letters, numbers, dots, dashes"
                      autoComplete="username"
                      minLength={3}
                      maxLength={24}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    <span>Email</span>
                    <input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                      disabled={busy}
                    />
                  </label>
                </>
              )}

              {mode !== 'forgot' && (mode === 'signup' || signInMethod === 'password') && (
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    minLength={mode === 'signup' ? 8 : undefined}
                    disabled={busy}
                  />
                </label>
              )}

              {mode === 'signin' && signInMethod === 'password' && (
                <button
                  type="button"
                  className="account-inline-link"
                  onClick={() => changeMode('forgot')}
                  disabled={busy}
                >
                  Forgot password?
                </button>
              )}

              {mode === 'signup' && (
                <>
                  <label>
                    <span>Confirm password</span>
                    <input
                      type="password"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      placeholder="Repeat your password"
                      autoComplete="new-password"
                      minLength={8}
                      disabled={busy}
                    />
                  </label>
                  {ownerName && (
                    <label className="account-owner-code">
                      <span>Owner setup code</span>
                      <input
                        value={ownerCode}
                        onChange={(event) => setOwnerCode(event.target.value)}
                        placeholder="Required for Bungles17x"
                        autoComplete="off"
                        disabled={busy}
                      />
                      <small>Use the code in <code>.javelin-owner-code</code> on the owner’s computer.</small>
                    </label>
                  )}
                </>
              )}

              {notice && <p className="account-notice" role="status"><CheckCircle2 size={13} /> {notice}</p>}
              {error && <p className="owner-login-error" role="alert"><AlertCircle size={13} /> {error}</p>}

              <button
                className="owner-login-submit"
                type="submit"
                disabled={busy || !canSubmit}
              >
                {mode === 'forgot' || (mode === 'signin' && signInMethod === 'email')
                  ? <Mail size={15} />
                  : mode === 'signin' ? <LogIn size={15} /> : <UserPlus size={15} />}
                {busy
                  ? (mode === 'forgot'
                    ? 'Sending…'
                    : mode === 'signin' && signInMethod === 'email' ? 'Sending sign-in link…' : 'Please wait…')
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : mode === 'signin'
                      ? signInMethod === 'email' ? 'Email me a sign-in link' : 'Sign in'
                      : 'Create account'}
              </button>
            </form>
            )}

            <div className="owner-login-footnote">
              <p>
                {emailConfigured
                  ? 'Accounts are hosted online. Email-link sign-in, verification and password reset all use your email.'
                  : 'Accounts are hosted online. Email delivery is not configured on the account server yet, so verification and password reset are unavailable.'}
              </p>
              <button type="button" onClick={onOpenOwnerLogin} disabled={busy}>Local owner access</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
