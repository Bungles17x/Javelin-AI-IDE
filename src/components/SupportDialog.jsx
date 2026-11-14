import { useEffect, useState } from 'react'
import {
  ArrowLeft, Bug, CheckCircle2, LifeBuoy, Lightbulb, Loader2, LogIn, MessageCircleQuestion, Send, X,
} from 'lucide-react'
import { sendSupportMessage } from '../lib/support'

const TOPICS = [
  {
    id: 'bug',
    title: 'Report a bug',
    description: 'Something broke, stalled, or behaved unexpectedly.',
    messageLabel: 'What happened?',
    placeholder: 'What did you do, what happened, and what did you expect instead?',
    icon: Bug,
  },
  {
    id: 'feature',
    title: 'Request a feature',
    description: 'Tell us what would make Javelin more useful.',
    messageLabel: 'What should Javelin do?',
    placeholder: 'Describe the feature and the problem it would solve for you.',
    icon: Lightbulb,
  },
  {
    id: 'account',
    title: 'Account or sign-in help',
    description: 'Trouble with an email link, code, or account access.',
    messageLabel: 'What happened?',
    placeholder: 'Tell us where you got stuck. Do not include your password or a sign-in code.',
    icon: LogIn,
  },
  {
    id: 'other',
    title: 'Something else',
    description: 'Questions, feedback, or anything not covered above.',
    messageLabel: 'How can we help?',
    placeholder: 'Write your question or feedback here.',
    icon: MessageCircleQuestion,
  },
]

const MIN_MESSAGE_LENGTH = 10
const MAX_MESSAGE_LENGTH = 4000

export function SupportDialog({
  open, onClose, appVersion = '1.0.0', mode = 'agent', providerLabel = '', account = null,
}) {
  const [topicId, setTopicId] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return undefined
    setTopicId('')
    setEmail(account?.email || '')
    setMessage('')
    setSending(false)
    setSent(null)
    setError('')
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // Reset once per opening; a background account refresh must not wipe a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const topic = TOPICS.find((item) => item.id === topicId)
  const TopicIcon = topic?.icon
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const canSend = Boolean(topic) && emailValid && message.trim().length >= MIN_MESSAGE_LENGTH

  const chooseTopic = (nextTopic) => {
    setTopicId(nextTopic.id)
    setMessage('')
    setError('')
  }

  const reset = () => {
    setTopicId('')
    setMessage('')
    setSent(null)
    setError('')
  }

  const submit = async (event) => {
    event.preventDefault()
    if (!canSend || sending) return
    setSending(true)
    setError('')
    try {
      const result = await sendSupportMessage({
        topic: topic.id,
        email: email.trim(),
        message: message.trim(),
        context: {
          appVersion,
          mode,
          provider: providerLabel,
          platform: navigator.platform || navigator.userAgent,
        },
      })
      setSent({ email: email.trim(), requestId: result?.requestId || '' })
    } catch (failure) {
      setError(failure?.message || 'Could not send your message. Try again in a moment.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="owner-login-backdrop" role="dialog" aria-modal="true" aria-labelledby="support-title">
      <div className="owner-login-card support-card">
        <button className="owner-login-close" type="button" aria-label="Close support" title="Close" onClick={onClose}>
          <X size={16} />
        </button>

        <div className="account-avatar"><LifeBuoy size={22} /></div>
        <span className="owner-login-kicker">JAVELIN SUPPORT</span>

        {sent ? (
          <>
            <h2 id="support-title">Message sent</h2>
            <div className="support-result">
              <span className="support-result-icon"><CheckCircle2 size={24} /></span>
              <p>
                Your message is on its way to Javelin support. We’ll reply to{' '}
                <strong>{sent.email}</strong>.
              </p>
              {sent.requestId && <small className="support-reference">Reference: {sent.requestId.slice(0, 8)}</small>}
            </div>
            <div className="support-result-actions">
              <button className="support-secondary" type="button" onClick={reset}>Send another</button>
              <button className="support-primary" type="button" onClick={onClose}>Done</button>
            </div>
          </>
        ) : topic ? (
          <>
            <h2 id="support-title">{topic.title}</h2>
            <p className="owner-login-copy">
              Send it straight from Javelin. We’ll reply to the email address below.
            </p>

            <div className="support-form-head">
              <button className="support-back" type="button" onClick={() => setTopicId('')}>
                <ArrowLeft size={13} /> All topics
              </button>
              <span className="support-form-topic">{TopicIcon && <TopicIcon size={13} />} {topic.description}</span>
            </div>

            <form className="support-form" onSubmit={submit}>
              <label className="support-field">
                <span>Your email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  maxLength={254}
                  required
                />
                <small>We reply here, so use an address you can check.</small>
              </label>

              <label className="support-field">
                <span>{topic.messageLabel}</span>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={topic.placeholder}
                  rows={6}
                  minLength={MIN_MESSAGE_LENGTH}
                  maxLength={MAX_MESSAGE_LENGTH}
                  required
                />
                <small>{message.length}/{MAX_MESSAGE_LENGTH} characters</small>
              </label>

              <div className="support-form-meta">
                App version, mode, provider, and platform are included automatically.
              </div>

              {error && <p className="owner-login-error" role="alert">{error}</p>}

              <button className="support-primary support-submit" type="submit" disabled={!canSend || sending}>
                {sending ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
                {sending ? 'Sending…' : 'Send to support'}
              </button>
            </form>

            <p className="support-note">
              Never include passwords, sign-in codes, API keys, or private file contents.
            </p>
          </>
        ) : (
          <>
            <h2 id="support-title">How can we help?</h2>
            <p className="owner-login-copy">
              Choose a topic and send a message without leaving Javelin. No email app needed.
            </p>

            <div className="support-topics">
              {TOPICS.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="support-topic"
                    onClick={() => chooseTopic(item)}
                  >
                    <span className="support-topic-icon"><Icon size={15} /></span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                )
              })}
            </div>

            <p className="support-note">
              Support messages go to Javelin support and replies come back to the email you provide.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
