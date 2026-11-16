import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './components/Button'
import { Textarea } from './components/Textarea'
import { Markdown } from './components/Markdown'
import { SettingsDialog } from './components/SettingsDialog'
import { ApprovalDialog } from './components/ApprovalDialog'
import { OwnerLogin } from './components/OwnerLogin'
import { DebugScreen } from './components/DebugScreen'
import { SupportDialog } from './components/SupportDialog'
import { AccountDialog } from './components/AccountDialog'
import { AdminScreen } from './components/AdminScreen'
import { BanScreen } from './components/BanScreen'
import { ProjectWorkbench } from './components/ProjectWorkbench'
import { AgentPhase, AgentTimeline, CheckpointBar, RunControls, TaskList } from './components/AgentTimeline'
import {
  PhaseRail, PlanCard, HypothesisList, JavelinSteps, JavelinResult, JavelinDiagnostics,
} from './components/JavelinPanel'
import { streamChat, PROVIDERS, DEFAULT_CLOUD_PROVIDER } from './lib/ai'
import { errorTitle } from './engine/errors'
import { runAgent } from './lib/agent'
import { createDesktopCommandRunner } from './lib/desktopCommand'
import { VirtualWorkspace } from './lib/virtualWorkspace'
import { getProvider, providerNeedsLocalRuntime } from './lib/providers'
import { useJavelin } from './hooks/useJavelin'
import { isSmallTalk, shouldRunWorkspaceAgent } from './core/taskIntent'
import { GUEST_DAILY_LIMIT, OWNER_USERNAME, todayKey } from './lib/ownerAuth'
import { estimateMessageTokens, estimateTokens, formatTokenCount, MEMBER_TOKEN_LIMIT, tokensForExchange } from './lib/usage'
import { fetchAccount, readStoredAccountSession, signOut as signOutOnlineAccount, storeAccountSession, syncChatHistory } from './lib/accountAuth'
import { isConversational, isEcho, ECHO_RETRY_INSTRUCTION } from './core/conversation'
import { createSpeaker, voiceCapabilities } from './lib/voice'
import { createLocalDictation, openMicStream } from './lib/localSpeech'
import { speakCloud, stopCloudSpeech, isCloudVoice, primeCloudSpeech } from './lib/cloudTts'
import { createBargeIn } from './lib/bargeIn'
import {
  Sparkles, Send, Square, Trash2, Settings, Sun, Moon, User, Bot, AlertCircle, KeyRound,
  MessageSquare, FolderOpen, Zap, CheckCircle2, XCircle, Brain, Mic, MicOff, Volume2, VolumeX,
  Bug, LifeBuoy, Lock, ShieldCheck, PanelRightClose, Copy, Check, SquarePen, Code2, History,
  Plus, X, FileText, ImagePlus, Download, Search, Pencil, RefreshCw, Cloud,
} from 'lucide-react'
import { generateImage, imagePromptIssue, imageRequestSubject, isImageRequest } from './lib/imageGeneration'
import { readImageForTextModel } from './lib/imageReading'
import { buildSyncPayload, historyFingerprint, mergeHistory, pruneDeletedConversations } from './lib/chatHistory'
import { generateChatTitle } from './lib/chatTitles'

const STORAGE = {
  apiKey: 'javelin.apiKey',
  model: 'javelin.model',
  provider: 'javelin.provider',
  baseUrl: 'javelin.baseUrl',
  providerEndpoints: 'javelin.providerEndpoints',
  theme: 'javelin.theme',
  messages: 'javelin.messages',
  mode: 'javelin.mode',
  workspace: 'javelin.workspace',
  directories: 'javelin.workspaceDirectories',
  memory: 'javelin.memory',
  autonomy: 'javelin.autonomy',
  cloudDefault: 'javelin.cloudDefaultAppliedV4',
  mobileCloud: 'javelin.mobileCloudProviderV1',
  speakReplies: 'javelin.voice.speak',
  liveVoice: 'javelin.voice.live',
  voiceURI: 'javelin.voice.uri',
  ttsProvider: 'javelin.voice.ttsProvider',
  ttsKey: 'javelin.voice.ttsKey',
  ttsVoice: 'javelin.voice.ttsVoice',
  ownerCredential: 'javelin.ownerCredential',
  guestUsage: 'javelin.guestUsage',
  accountUsage: 'javelin.accountUsage',
  assistantWidth: 'javelin.assistantWidth',
  assistantCollapsed: 'javelin.assistantCollapsed',
  conversations: 'javelin.conversations',
  activeConversation: 'javelin.activeConversation',
  deletedConversations: 'javelin.deletedConversations',
}

const MAX_SAVED_CONVERSATIONS = 30

// Chat replies are independent. A busy answer must not lock the composer; the
// only shared limit is the number of requests this install will keep in flight.
const MAX_CONCURRENT_RESPONSES = 100
// The keyless upstream accepts one reply at a time. Keep those requests queued so
// they do not race, but do not add a fixed cooldown between starts.
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_FILE_TEXT_CHARS = 20_000
const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'php', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sql',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'yaml', 'yml',
  'toml', 'ini', 'conf', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'env',
])

let messageCounter = 0
function nextMessageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  messageCounter += 1
  return `msg-${Date.now().toString(36)}-${messageCounter}`
}

function formatAttachmentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileExtension(name) {
  return String(name ?? '').split('.').pop()?.toLowerCase() ?? ''
}

function isTextAttachment(file) {
  if (String(file?.type || '').startsWith('text/')) return true
  return TEXT_FILE_EXTENSIONS.has(fileExtension(file?.name))
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.readAsDataURL(file)
  })
}

async function prepareImageAttachment(file) {
  const source = await readFileAsDataUrl(file)
  const image = new Image()
  await new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = () => reject(new Error(`${file.name} is not an image this browser can read.`))
    image.src = source
  })
  const maxEdge = 1280
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth || 1, image.naturalHeight || 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale))
  canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error(`Could not prepare ${file.name}.`)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return {
    id: nextMessageId(),
    kind: 'image',
    name: file.name,
    mime: 'image/jpeg',
    size: file.size,
    dataUrl: canvas.toDataURL('image/jpeg', 0.82),
  }
}

async function prepareTextAttachment(file) {
  const text = await file.text()
  const truncated = text.length > MAX_FILE_TEXT_CHARS
  return {
    id: nextMessageId(),
    kind: 'file',
    name: file.name,
    mime: file.type || 'text/plain',
    size: file.size,
    text: truncated ? text.slice(0, MAX_FILE_TEXT_CHARS) : text,
    truncated,
  }
}

function messageForApi(message, { textOnly = false } = {}) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : []
  const files = attachments.filter((attachment) => attachment?.kind === 'file' && attachment.text)
  const images = attachments.filter((attachment) => attachment?.kind === 'image' && attachment.dataUrl)
  const parts = []
  if (message?.content) parts.push(String(message.content))
  for (const file of files) {
    parts.push(`<attached_file name="${String(file.name).replace(/"/g, '&quot;')}"${file.truncated ? ' truncated="true"' : ''}>\n${file.text}\n</attached_file>`)
  }
  // A text-only model cannot receive image parts. Use the reading produced when the
  // image was attached; older images without one are clearly marked instead of
  // silently vanishing from the conversation.
  if (textOnly) {
    for (const image of images) {
      parts.push(`<attached_image name="${String(image.name || 'attachment').replace(/"/g, '&quot;')}">\n${image.analysis || 'An image was attached, but its contents were not read automatically.'}\n</attached_image>`)
    }
  }
  const text = parts.join('\n\n').trim()
  if (textOnly || !images.length) return { role: message.role, content: text }
  return {
    role: message.role,
    content: [
      { type: 'text', text: text || 'Please take a look at the attached image.' },
      ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
    ],
  }
}

const IMAGE_EXAMPLES = [
  { text: 'A quiet cabin in a snowy pine forest at dusk, warm windows', mode: 'image' },
  { text: 'A geometric fox in a wildflower meadow, flat vector illustration', mode: 'image' },
  { text: 'A future city skyline at sunset, wide cinematic view', mode: 'image' },
  { text: 'A hand-drawn botanical pattern of ferns and wildflowers', mode: 'image' },
]

const EXAMPLES = [
  { text: 'Explain this code and suggest improvements', mode: 'chat' },
  { text: 'Create a React counter component with TypeScript', mode: 'chat' },
  { text: 'Explain the difference between debounce and throttle', mode: 'chat' },
  { text: 'Write a SQL query to find duplicate emails in a users table', mode: 'chat' },
  { text: 'Add input validation to the form and make sure tests pass', mode: 'agent' },
  { text: 'Find the bug in the parser and fix it', mode: 'agent' },
  { text: 'Refactor utils.js to remove duplication, then run the tests', mode: 'agent' },
  { text: 'Generate unit tests for the selected code', mode: 'chat' },
  { text: 'Add error handling to all database calls', mode: 'agent' },
  { text: 'Review this code for security vulnerabilities', mode: 'chat' },
  { text: 'Optimize this code for better performance', mode: 'chat' },
  { text: 'Generate API documentation for this module', mode: 'chat' },
  { text: 'Fix the off-by-one error in calc.js and verify it', mode: 'javelin' },
  { text: 'Find and fix the bug in the code, then confirm it is fixed', mode: 'javelin' },
]

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => load(key, initial))
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* quota / private mode - ignore */
    }
  }, [key, value])
  return [value, setValue]
}

function nextConversationId() {
  return `chat-${nextMessageId()}`
}

function conversationTitle(messages = []) {
  const first = messages.find((message) => (
    message?.role === 'user' && String(message.content ?? '').trim()
  ))
  const text = String(first?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return 'New chat'
  return text.length > 58 ? `${text.slice(0, 57).trimEnd()}…` : text
}

function conversationFromMessages(messages, id = nextConversationId()) {
  const now = Date.now()
  return {
    id,
    title: conversationTitle(messages),
    titleSource: 'auto',
    autoName: true,
    createdAt: now,
    updatedAt: now,
    messages,
  }
}

function normalizeConversation(value) {
  if (!value || typeof value !== 'object') return null
  if (!value.id || !Array.isArray(value.messages) || value.messages.length === 0) return null
  const updatedAt = Number(value.updatedAt)
  const createdAt = Number(value.createdAt)
  return {
    id: String(value.id),
    title: String(value.title || conversationTitle(value.messages)),
    titleSource: ['manual', 'ai', 'auto'].includes(value.titleSource) ? value.titleSource : 'auto',
    // Legacy histories already have a usable name. Only chats created by this
    // version opt into one automatic model naming pass.
    autoName: value.autoName === true,
    createdAt: Number.isFinite(createdAt) ? createdAt : (Number.isFinite(updatedAt) ? updatedAt : Date.now()),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    messages: value.messages.filter(Boolean),
  }
}

/** Keep the most recent copy at the top and drop abandoned empty drafts. */
function upsertConversation(list, id, messages) {
  const existingList = (Array.isArray(list) ? list : []).filter(
    (conversation) => conversation?.id && Array.isArray(conversation.messages),
  )
  if (!id || !Array.isArray(messages) || messages.length === 0) return existingList
  const existing = existingList.find((conversation) => conversation.id === id)
  // A name the user chose, or one the model generated, outranks the fallback
  // derived from the first message.
  const generatedName = existing && ['manual', 'ai'].includes(existing.titleSource)
  const title = generatedName ? existing.title : conversationTitle(messages)
  const titleSource = generatedName ? existing.titleSource : 'auto'
  const autoName = generatedName ? false : existing?.autoName === true
  const sameMessages = existing && JSON.stringify(existing.messages) === JSON.stringify(messages)
  if (existing && existing.title === title && existing.titleSource === titleSource && existing.autoName === autoName && sameMessages) {
    return existingList
  }
  const snapshot = existing
    ? { ...existing, title, titleSource, autoName, updatedAt: Date.now(), messages }
    : conversationFromMessages(messages, id)
  return [snapshot, ...existingList.filter((conversation) => conversation.id !== id)]
    .slice(0, MAX_SAVED_CONVERSATIONS)
}

function conversationDayLabel(timestamp, now = Date.now()) {
  const date = new Date(Number(timestamp) || now)
  const current = new Date(now)
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime()
  const daysAgo = Math.round((today - day) / 86_400_000)
  if (daysAgo <= 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo < 7) return 'Previous 7 days'
  return 'Older'
}

function groupConversations(conversations = [], now = Date.now()) {
  const sorted = (Array.isArray(conversations) ? conversations : [])
    .filter((conversation) => conversation?.id)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
  const groups = []
  for (const conversation of sorted) {
    const label = conversationDayLabel(conversation.updatedAt, now)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.items.push(conversation)
    else groups.push({ label, items: [conversation] })
  }
  return groups
}

function useMobileChatViewport() {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 820px)').matches
  ))
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const query = window.matchMedia('(max-width: 820px)')
    const update = () => setMatches(query.matches)
    update()
    query.addEventListener?.('change', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      query.removeEventListener?.('change', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])
  return matches
}

function changedWorkspacePaths(before, after) {
  const paths = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...paths].filter((path) => before?.[path] !== after?.[path])
}

function changedDirectoryPaths(before = [], after = []) {
  const prior = new Set(before)
  const next = new Set(after)
  return [...new Set([...prior, ...next])].filter((path) => prior.has(path) !== next.has(path))
}

function projectFilesForSnapshot(files, existingFiles = []) {
  const existing = new Map(existingFiles.map((file) => [file.path, file]))
  return Object.keys(files)
    .map((path) => existing.get(path) ?? { path, type: 'file' })
    .sort((a, b) => a.path.localeCompare(b.path))
}

function App() {
  const desktopApi = window.javelinDesktop ?? null
  const mobileViewport = useMobileChatViewport()
  const mobileChatOnly = !desktopApi && mobileViewport
  // Phones use the keyless hosted model by default. Every provider, including
  // Ollama, remains selectable in Settings.
  const mobileDefaultProvider = 'javelinclouddirect'
  const initialProvider = mobileChatOnly ? mobileDefaultProvider : DEFAULT_CLOUD_PROVIDER
  const [providerId, setProviderId] = useLocalStorage(
    STORAGE.provider,
    initialProvider,
  )
  const [apiKey, setApiKey] = useLocalStorage(STORAGE.apiKey, '')
  const [legacyBaseUrl] = useLocalStorage(STORAGE.baseUrl, '')
  const [providerEndpoints, setProviderEndpoints] = useLocalStorage(STORAGE.providerEndpoints, {})
  const savedBaseUrl = String(providerEndpoints[providerId] ?? '').trim()
  const baseUrl = savedBaseUrl || (
    providerId === 'javelin' || providerId === 'javelinlocal'
      ? PROVIDERS[providerId].baseUrl
      : providerId === 'custom'
        ? legacyBaseUrl
        : ''
  )
  const [model, setModel] = useLocalStorage(STORAGE.model, PROVIDERS[initialProvider].defaultModel)
  const [theme, setTheme] = useLocalStorage(
    STORAGE.theme,
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const [messages, setMessages] = useLocalStorage(STORAGE.messages, [])
  const [conversations, setConversations] = useLocalStorage(STORAGE.conversations, [])
  const [activeConversationId, setActiveConversationId] = useLocalStorage(STORAGE.activeConversation, null)
  const [deletedConversations, setDeletedConversations] = useLocalStorage(STORAGE.deletedConversations, {})
  const [historySync, setHistorySync] = useState({ state: 'idle', at: null, error: '' })
  const [historyReady, setHistoryReady] = useState(false)
  const historyInitializedRef = useRef(false)
  const creatingConversationRef = useRef(false)
  const historyRef = useRef({ conversations: [], deleted: {} })
  const activeConversationIdRef = useRef(activeConversationId)
  const historySyncInFlightRef = useRef(false)
  const historySyncedFingerprintRef = useRef('')
  const titleAttemptsRef = useRef(new Set())

  historyRef.current = { conversations, deleted: deletedConversations }
  activeConversationIdRef.current = activeConversationId

  // An interrupted run can leave an empty assistant message behind, which renders as
  // a permanent "Thinking…" bubble. Drop those on load rather than showing a ghost.
  useEffect(() => {
    setMessages((previous) => {
      const cleaned = previous.filter((m) => !(m?.role === 'assistant' && !String(m.content ?? '').trim()))
      return cleaned.length === previous.length ? previous : cleaned
    })
  }, [setMessages])

  // Bring the previous single-thread storage into the saved-chat list. The
  // separate messages key remains the live thread, so streaming and all of the
  // existing chat behavior keep working exactly as before.
  useEffect(() => {
    if (historyInitializedRef.current) return
    historyInitializedRef.current = true
    const stored = Array.isArray(conversations)
      ? conversations.map(normalizeConversation).filter(Boolean).slice(0, MAX_SAVED_CONVERSATIONS)
      : []
    if (stored.length) setConversations(stored)
    const active = stored.find((conversation) => conversation.id === activeConversationId)
    if (active) {
      if (!Array.isArray(messages) || messages.length === 0) {
        if (active.messages.length) setMessages(active.messages)
      }
    } else if (activeConversationId) {
      setActiveConversationId(null)
    }
    setHistoryReady(true)
    // This migration runs once, before any conversation can be selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A saved chat is created lazily on the first message of a new thread. This
  // avoids filling history with empty "New chat" entries.
  useEffect(() => {
    if (!historyReady) return
    if (activeConversationId) {
      creatingConversationRef.current = false
      return
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      creatingConversationRef.current = false
      return
    }
    if (creatingConversationRef.current) return
    creatingConversationRef.current = true
    const id = nextConversationId()
    setConversations((previous) => upsertConversation(previous, id, messages))
    setActiveConversationId(id)
  }, [activeConversationId, historyReady, messages, setActiveConversationId, setConversations])

  // Streaming updates messages often, so persist the thread after a short pause
  // instead of writing the full history on every token.
  useEffect(() => {
    if (!historyReady || !activeConversationId || !Array.isArray(messages) || messages.length === 0) {
      return undefined
    }
    const timer = window.setTimeout(() => {
      setConversations((previous) => upsertConversation(previous, activeConversationId, messages))
    }, 450)
    return () => window.clearTimeout(timer)
  }, [activeConversationId, historyReady, messages, setConversations])
  const [mode, setMode] = useLocalStorage(STORAGE.mode, 'chat')
  useEffect(() => {
    if (mobileChatOnly && mode !== 'chat') setMode('chat')
    document.title = mobileChatOnly ? 'Javelin AI Chat' : 'Javelin AI IDE'
  }, [mobileChatOnly, mode, setMode])

  const [mobileCloudMigrated, setMobileCloudMigrated] = useLocalStorage(STORAGE.mobileCloud, false)
  // A phone that previously opened the web app may still have the old Gemini
  // default, or the proxy-based cloud provider whose shared upstream slot is slow.
  // Move it to the direct keyless cloud provider once; after that, the user's
  // explicit provider choice is left alone.
  useEffect(() => {
    if (!mobileChatOnly || mobileCloudMigrated) return
    setMobileCloudMigrated(true)
    const oldSharedCloud = providerId === 'javelincloud'
    const unconfiguredDefault = providerId === DEFAULT_CLOUD_PROVIDER && !apiKey
    if (!oldSharedCloud && !unconfiguredDefault) return
    setProviderId(mobileDefaultProvider)
    setModel(PROVIDERS[mobileDefaultProvider].defaultModel)
    setMessages((previous) => [
      ...previous,
      {
        role: 'system',
        content: 'Javelin Cloud Direct is ready on mobile — no API key or Ollama needed. All providers are still available in Settings.',
        ts: Date.now(),
      },
    ])
  }, [apiKey, mobileChatOnly, mobileCloudMigrated, providerId, setMessages, setMobileCloudMigrated, setModel, setProviderId])
  const [cloudDefaultApplied, setCloudDefaultApplied] = useLocalStorage(STORAGE.cloudDefault, false)
  const [showAllExamples, setShowAllExamples] = useState(false)
  const [workspaceFiles, setWorkspaceFiles] = useLocalStorage(STORAGE.workspace, {})
  const [workspaceDirectories, setWorkspaceDirectories] = useLocalStorage(STORAGE.directories, [])
  const [agentMemory, setAgentMemory] = useLocalStorage(STORAGE.memory, null)
  const [desktopProject, setDesktopProject] = useState(null)
  // Desktop starts in the shared chat surface. The workbench is one click away
  // for real files, so the chat keeps the same shape as the website.
  const [desktopView, setDesktopView] = useState('chat')
  const [commandOutput, setCommandOutput] = useState([])
  const [runtimeStatus, setRuntimeStatus] = useState(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [runtimeError, setRuntimeError] = useState('')
  // How much Javelin may do without stopping to ask. 'ask' is the default.
  const [autonomy, setAutonomy] = useLocalStorage(STORAGE.autonomy, 'ask')

  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])
  const [attachmentError, setAttachmentError] = useState('')
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [imageReadStage, setImageReadStage] = useState('')
  const attachmentInputRef = useRef(null)
  const [imageMode, setImageMode] = useState(false)
  const [imageBusy, setImageBusy] = useState(false)
  const [imageError, setImageError] = useState('')
  const imageAbortRef = useRef(null)
  // Replies stream into their own bubbles; this is the only shared chat limit.
  const [activeChats, setActiveChats] = useState(0)
  const activeChatsRef = useRef(0)
  // Voice: spoken replies, hands-free live mode, and the chosen system voice.
  const [speakReplies, setSpeakReplies] = useLocalStorage(STORAGE.speakReplies, false)
  const [liveVoice, setLiveVoice] = useLocalStorage(STORAGE.liveVoice, false)
  const [voiceURI, setVoiceURI] = useLocalStorage(STORAGE.voiceURI, null)
  const [ttsProvider, setTtsProvider] = useLocalStorage(STORAGE.ttsProvider, 'system')
  const [ttsKey, setTtsKey] = useLocalStorage(STORAGE.ttsKey, '')
  const [ttsVoice, setTtsVoice] = useLocalStorage(STORAGE.ttsVoice, '')
  const [listening, setListening] = useState(false)
  const [voiceNotice, setVoiceNotice] = useState('')
  const [speakingMessageId, setSpeakingMessageId] = useState(null)
  const speakerRef = useRef(null)
  const dictationRef = useRef(null)
  // Live voice keeps ONE microphone stream for its whole session: recording uses it,
  // and so does the interruption monitor while the assistant is speaking.
  const micStreamRef = useRef(null)
  const micStreamPromiseRef = useRef(null)
  const bargeRef = useRef(null)
  const speechAbortRef = useRef(null)
  const interruptRef = useRef(null)
  const startBargeInRef = useRef(null)
  const stopBargeInRef = useRef(null)
  const sendRef = useRef(null)
  const suppressAutoResumeRef = useRef(false)

  const removeAttachment = useCallback((id) => {
    setAttachments((previous) => previous.filter((attachment) => attachment.id !== id))
    setAttachmentError('')
  }, [])

  const toggleImageMode = useCallback(() => {
    if (imageBusy) return
    if (!imageMode && attachments.length > 0) {
      setAttachmentError('Remove attachments before creating an image.')
      return
    }
    setImageMode((value) => !value)
    setImageError('')
    setAttachmentError('')
  }, [attachments.length, imageBusy, imageMode])

  const handleAttachmentFiles = useCallback(async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    setImageMode(false)
    setImageError('')
    setAttachmentError('')
    setAttachmentBusy(true)
    try {
      let next = [...attachments]
      for (const file of files) {
        if (next.length >= MAX_ATTACHMENTS) {
          setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} items per message.`)
          break
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setAttachmentError(`${file.name} is larger than ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}.`)
          continue
        }
        try {
          if (String(file.type || '').startsWith('image/')) {
            next.push(await prepareImageAttachment(file))
          } else if (isTextAttachment(file)) {
            next.push(await prepareTextAttachment(file))
          } else {
            setAttachmentError(`${file.name} is not an image or a text/code file.`)
          }
        } catch (error) {
          setAttachmentError(error?.message || `Could not attach ${file.name}.`)
        }
      }
      setAttachments(next)
    } finally {
      setAttachmentBusy(false)
      textareaRef.current?.focus()
    }
  }, [attachments])

  // Callbacks created once (dictation, send) read live mode through a ref, so a
  // stale closure can never silently end the loop.
  const liveVoiceRef = useRef(liveVoice)
  const startListeningRef = useRef(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [assistantWidth, setAssistantWidth] = useLocalStorage(STORAGE.assistantWidth, 410)
  const [assistantCollapsed, setAssistantCollapsed] = useLocalStorage(STORAGE.assistantCollapsed, false)

  // Owner access and guest quota are local to this machine. The owner credential
  // stores only a salted hash; ownerUnlocked lasts for this app session.
  const [ownerCredential, setOwnerCredential] = useLocalStorage(STORAGE.ownerCredential, null)
  const [ownerUnlocked, setOwnerUnlocked] = useState(() => {
    try {
      return sessionStorage.getItem('javelin.ownerSession') === '1'
    } catch {
      return false
    }
  })
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginReason, setLoginReason] = useState('unlimited')
  const [debugOpen, setDebugOpen] = useState(false)
  const [accountSession, setAccountSession] = useState(() => readStoredAccountSession())
  const [accountOpen, setAccountOpen] = useState(false)
  const [accountReason, setAccountReason] = useState('default')
  const [adminOpen, setAdminOpen] = useState(false)
  const [banNotice, setBanNotice] = useState(null)
  const [guestUsage, setGuestUsage] = useLocalStorage(STORAGE.guestUsage, { date: '', count: 0 })
  const [accountUsage, setAccountUsage] = useLocalStorage(STORAGE.accountUsage, {})
  const account = accountSession?.user ?? null
  const accountTokenRef = useRef(accountSession?.token ?? null)
  accountTokenRef.current = accountSession?.token ?? null
  const isOnlineOwner = account?.role === 'owner'
  const isOnlineStaff = account?.role === 'staff'
  const isAdmin = isOnlineOwner || isOnlineStaff
  const isOwner = Boolean((ownerCredential && ownerUnlocked) || isOnlineOwner)
  const usageDate = todayKey()
  const guestUsed = guestUsage?.date === usageDate ? Number(guestUsage.count) || 0 : 0
  const guestRemaining = Math.max(0, GUEST_DAILY_LIMIT - guestUsed)
  // Account usage is a lifetime token balance, not a daily request count. It is
  // keyed by the account id so signing out and back in does not reset it.
  const accountUsageKey = account?.id ?? ''
  const accountUsed = accountUsageKey ? Number(accountUsage?.[accountUsageKey]) || 0 : 0
  const accountRemaining = Math.max(0, MEMBER_TOKEN_LIMIT - accountUsed)

  // Agent-run state
  const [steps, setSteps] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [phase, setPhase] = useState(null)
  const [statusText, setStatusText] = useState('')
  const [approval, setApproval] = useState(null)
  const [runResult, setRunResult] = useState(null)
  const [dirty, setDirty] = useState(false)
  // The last run's automatic checkpoint id, and whether a keep/undo decision is pending.
  const [runBaseline, setRunBaseline] = useState(null)
  const [pendingDecision, setPendingDecision] = useState(null)

  const abortRef = useRef(null)
  // Every chat reply has its own controller and message id. Aborting one does not
  // disturb the others, and Stop can abort the whole set.
  const chatAbortsRef = useRef(new Set())
  const providerQueuesRef = useRef(new Map())

  const beginChatResponse = useCallback(() => {
    activeChatsRef.current += 1
    setActiveChats(activeChatsRef.current)
  }, [])

  const finishChatResponse = useCallback(() => {
    activeChatsRef.current = Math.max(0, activeChatsRef.current - 1)
    setActiveChats(activeChatsRef.current)
  }, [])

  const stopChatResponses = useCallback(() => {
    for (const controller of chatAbortsRef.current) controller.abort()
  }, [])

  // Some free endpoints accept a single request at a time. Keep those calls in a
  // per-provider queue so they do not race; there is deliberately no fixed cooldown
  // between starts. Keyed providers run fully in parallel.
  const enqueueProviderTask = useCallback((providerId, task, signal) => {
    const previous = providerQueuesRef.current.get(providerId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => {
      if (signal?.aborted) {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        throw error
      }
      return task()
    })
    providerQueuesRef.current.set(providerId, run.catch(() => {}))
    return run
  }, [])

  const workspaceRef = useRef(new VirtualWorkspace(workspaceFiles, workspaceDirectories))
  // One entry per user message: where it sits in the transcript and the checkpoint
  // taken just before it ran. Reverting a message needs both.
  const messageMarks = useRef([])
  const lastTouchedPaths = useRef([])
  const approvalResolver = useRef(null)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  const provider = getProvider(providerId)
  // A hosted model needs no local runtime: never start or probe Ollama for it.
  const needsLocalRuntime = useMemo(
    () => providerNeedsLocalRuntime(providerId, baseUrl),
    [providerId, baseUrl],
  )

  useEffect(() => {
    try {
      if (ownerUnlocked) sessionStorage.setItem('javelin.ownerSession', '1')
      else sessionStorage.removeItem('javelin.ownerSession')
    } catch {
      /* session storage is optional */
    }
  }, [ownerUnlocked])

  useEffect(() => {
    if (!ownerCredential) setOwnerUnlocked(false)
  }, [ownerCredential])

  // A crash screen can ask for diagnostics after reload. The flag survives the
  // reload, then this gate decides whether the owner is already unlocked.
  useEffect(() => {
    let pending = false
    try {
      pending = sessionStorage.getItem('javelin.openDebugAfterReload') === '1'
      if (pending) sessionStorage.removeItem('javelin.openDebugAfterReload')
    } catch {
      /* ignore */
    }
    if (!pending) return
    if (isOwner) setDebugOpen(true)
    else {
      setLoginReason('reload')
      setLoginOpen(true)
    }
  }, [isOwner])

  // Keep the online account session on this device, and reject it if the server
  // says it has expired. A network outage must not sign someone out locally.
  useEffect(() => {
    storeAccountSession(accountSession)
  }, [accountSession])

  useEffect(() => {
    const token = accountSession?.token
    if (!token) return undefined
    let cancelled = false
    let checking = false
    let timer = null
    const checkAccount = async () => {
      if (cancelled || checking) return
      checking = true
      try {
        const user = await fetchAccount(token)
        if (cancelled) return
        setAccountSession((previous) => (previous?.token === token ? { ...previous, user } : previous))
      } catch (accountError) {
        if (cancelled) return
        if (accountError?.code === 'ACCOUNT_BANNED') {
          storeAccountSession(null)
          setAccountSession(null)
          setAccountOpen(false)
          setAdminOpen(false)
          setBanNotice(accountError.details?.ban || { reason: accountError.message })
        } else if (accountError?.status === 401) {
          storeAccountSession(null)
          setAccountSession(null)
        }
      } finally {
        checking = false
      }
    }
    void checkAccount()
    // A ban is pushed to the account on the next check; focus/visibility checks
    // make it appear as soon as the user comes back to the app.
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void checkAccount()
    }, 30_000)
    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') void checkAccount()
    }
    window.addEventListener('focus', checkAccount)
    document.addEventListener('visibilitychange', checkWhenVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', checkAccount)
      document.removeEventListener('visibilitychange', checkWhenVisible)
    }
  }, [accountSession?.token])

  const requestAccount = (reason = 'default') => {
    setAccountReason(reason)
    setAccountOpen(true)
  }

  const handleAccountAuthenticated = (session) => {
    setAccountSession(session)
    storeAccountSession(session)
    setAccountOpen(false)
    setAccountReason('default')
    setBanNotice(null)
    setError(null)
  }

  const handleAccountBanned = (ban) => {
    storeAccountSession(null)
    setAccountSession(null)
    setAccountOpen(false)
    setAdminOpen(false)
    setBanNotice(ban && typeof ban === 'object' ? ban : { reason: String(ban || 'No reason provided.') })
  }

  const handleAccountLocked = () => {
    storeAccountSession(null)
    setAccountSession(null)
    setAccountOpen(true)
    setAccountReason('locked')
    setAdminOpen(false)
  }

  const handleAccountSignOut = async () => {
    const token = accountSession?.token
    setAccountSession(null)
    storeAccountSession(null)
    setAccountOpen(false)
    setAdminOpen(false)
    try {
      await signOutOnlineAccount(token)
    } catch {
      /* the local session is already gone; a failed remote sign-out is not blocking */
    }
  }

  // Used by the account screen after a verification email is sent or after the
  // user completes verification in another browser tab.
  const refreshAccount = useCallback(async () => {
    const token = accountSession?.token
    if (!token) return null
    const user = await fetchAccount(token)
    setAccountSession((previous) => (previous?.token === token ? { ...previous, user } : previous))
    return user
  }, [accountSession?.token])

  const requestOwnerLogin = (reason = 'unlimited') => {
    setLoginReason(reason)
    setLoginOpen(true)
  }

  const requestAdmin = () => {
    if (isAdmin) setAdminOpen(true)
    else requestAccount(account ? 'account' : 'default')
  }

  const requestDebug = () => {
    if (isOwner) {
      setDebugOpen(true)
      return
    }
    requestOwnerLogin('debug')
  }

  const handleOwnerCreated = (credential) => {
    setOwnerCredential(credential)
    setOwnerUnlocked(true)
    setLoginOpen(false)
    if (loginReason === 'debug') setDebugOpen(true)
  }

  const handleOwnerAuthenticated = () => {
    setOwnerUnlocked(true)
    setLoginOpen(false)
    if (loginReason === 'debug') setDebugOpen(true)
  }

  const lockOwner = () => {
    const onlineToken = isOnlineOwner ? accountSession?.token : null
    setOwnerUnlocked(false)
    setDebugOpen(false)
    try {
      sessionStorage.removeItem('javelin.ownerSession')
    } catch {
      /* ignore */
    }
    if (onlineToken) {
      setAccountSession(null)
      storeAccountSession(null)
      void signOutOnlineAccount(onlineToken).catch(() => {})
    }
  }

  /**
   * Add provider-reported tokens (or an estimate) to the signed-in balance.
   * The reservation is checked before a request; this records what it actually cost.
   */
  const recordAccountTokens = useCallback((amount) => {
    if (!account || isOwner) return
    const tokens = Math.max(0, Math.ceil(Number(amount) || 0))
    if (!tokens) return
    setAccountUsage((previous) => ({
      ...previous,
      [account.id]: (Number(previous?.[account.id]) || 0) + tokens,
    }))
  }, [account, isOwner, setAccountUsage])

  /** Agent and Javelin runs expose exact metrics when the provider reports usage. */
  const recordRunTokens = useCallback((result, task, priorMessages) => {
    if (!account || isOwner) return
    const metrics = result?.metrics ?? {}
    const exact = tokensForExchange({
      usage: {
        prompt_tokens: metrics.tokensIn,
        completion_tokens: metrics.tokensOut,
      },
    })
    const estimated = exact || (
      estimateMessageTokens(priorMessages) +
      estimateTokens(task) +
      estimateTokens(result?.summary) +
      (result?.steps ?? []).reduce((total, step) => total + estimateTokens(step?.output), 0)
    )
    recordAccountTokens(estimated)
  }, [account, isOwner, recordAccountTokens])

  /**
   * Reserve one AI call. Owners are unlimited, signed-in members have a
   * 100-million-token balance, and guests get the small local allowance. The
   * token balance is checked here before every chat, Agent and Javelin call.
   */
  const reserveAiUsage = useCallback(() => {
    if (isOwner) return true
    if (account) {
      if (accountRemaining <= 0) {
        setError(`Account token allowance reached — ${formatTokenCount(MEMBER_TOKEN_LIMIT)} tokens. Owner accounts are unlimited.`)
        return false
      }
      return true
    }
    if (guestUsed >= GUEST_DAILY_LIMIT) {
      setError(`Guest limit reached — ${GUEST_DAILY_LIMIT} AI requests per day. Create a free account for ${formatTokenCount(MEMBER_TOKEN_LIMIT)} tokens.`)
      setAccountReason('limit')
      setAccountOpen(true)
      return false
    }
    setGuestUsage({ date: usageDate, count: guestUsed + 1 })
    return true
  }, [account, accountRemaining, guestUsed, isOwner, setError, setGuestUsage, usageDate])

  // Surface the engine's stable error code alongside the human-readable message, so a
  // failure can be identified (and reported) without re-reading the whole run.
  const describeError = (err) => {
    const message = err?.message || String(err)
    return err?.code ? `${err.code} · ${errorTitle(err.code)} — ${message}` : message
  }

  /** Reject instead of waiting forever on a runtime call. */
  const withTimeout = (promise, ms, message) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ])

  const refreshRuntimeStatus = useCallback(async () => {
    if (!desktopApi) return null
    setRuntimeBusy(true)
    try {
      const status = await desktopApi.getRuntimeStatus()
      setRuntimeStatus(status)
      return status
    } finally {
      setRuntimeBusy(false)
    }
  }, [desktopApi])

  useEffect(() => {
    void refreshRuntimeStatus().catch((err) => setRuntimeError(err.message || String(err)))
  }, [refreshRuntimeStatus])

  const installedLocalModel = useMemo(() => {
    const installed = runtimeStatus?.ollama?.models ?? []
    if (installed.includes(model)) return model
    if (installed.includes(`${model}:latest`)) return `${model}:latest`
    const preferred = ['javelin-coder:latest', 'qwen2.5-coder:7b', 'qwen2.5-coder:latest', 'llama3.1:8b', 'llama3.2:1b']
    return preferred.find((candidate) => installed.includes(candidate)) ?? ''
  }, [model, runtimeStatus])

  useEffect(() => {
    if (!desktopApi || !runtimeStatus?.ollama?.ok || !needsLocalRuntime) return
    if (installedLocalModel && installedLocalModel !== model) {
      setModel(installedLocalModel)
      setMessages((previous) => [
        ...previous,
        { role: 'system', content: `Selected the installed local model ${installedLocalModel}.`, ts: Date.now() },
      ])
    }
  }, [desktopApi, installedLocalModel, model, runtimeStatus, needsLocalRuntime, setMessages, setModel])

  // One-time move off the old local default: someone who never chose a hosted provider
  // ends up on the free cloud model instead of a local runtime they did not ask for.
  useEffect(() => {
    if (cloudDefaultApplied) return
    setCloudDefaultApplied(true)
    // Mobile's keyless default is handled above; never move a phone to Gemini.
    if (mobileChatOnly) return
    // Still on the local default, or on the hosted service that is not activated yet:
    // land on the cloud provider that works right now.
    // Each new default bumps this key so an earlier default cannot strand the app on a
    // provider that is not usable yet.
    const shouldMigrate = providerId === 'javelin' || providerId === 'javelincloud'
    if (!shouldMigrate) return
    setProviderId(DEFAULT_CLOUD_PROVIDER)
    setModel(PROVIDERS[DEFAULT_CLOUD_PROVIDER].defaultModel)
    setMessages((previous) => [
      ...previous,
      {
        role: 'system',
        content:
          'Switched to the free cloud model (Google Gemini) — no Ollama needed. ' +
          'Javelin Cloud is still available in Settings once its hosted key is attached.',
        ts: Date.now(),
      },
    ])
    // Deliberately once per install.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A provider that needs an endpoint must never leave the app unable to answer.
  // If Javelin Hosted is selected without a URL, move to the best provider that is
  // actually reachable right now (the local model server, else the free cloud one)
  // and say why in the transcript. Sending to a URL that does not exist is not a
  // state the user should have to discover through an error.
  useEffect(() => {
    if (providerId !== 'javelinhosted') return
    if (String(providerEndpoints['javelinhosted'] ?? '').trim()) return
    let cancelled = false
    ;(async () => {
      let target = DEFAULT_CLOUD_PROVIDER
      try {
        const res = await fetch(`${PROVIDERS.javelinlocal.baseUrl}/models`, {
          signal: AbortSignal.timeout(1500),
        })
        if (res.ok) target = 'javelinlocal'
      } catch {
        // Nothing is listening on the local model server; fall back to the cloud one.
      }
      if (cancelled) return
      setProviderId(target)
      setModel(PROVIDERS[target].defaultModel)
      setMessages((previous) => [
        ...previous,
        {
          role: 'system',
          content:
            `Javelin Hosted needs an endpoint URL, so I switched to ${PROVIDERS[target].label}. ` +
            'Paste your model server URL in Settings once it is deployed.',
          ts: Date.now(),
        },
      ])
    })()
    return () => {
      cancelled = true
    }
  }, [providerId, providerEndpoints, setMessages, setModel, setProviderId])

  const startLocalRuntime = useCallback(async () => {
    if (!desktopApi) return
    setRuntimeBusy(true)
    setRuntimeError('')
    try {
      await desktopApi.startOllama()
      const status = await desktopApi.getRuntimeStatus()
      setRuntimeStatus(status)
      setProviderId('javelin')
      const installed = status.ollama.models ?? []
      const selected = ['javelin-coder:latest', 'qwen2.5-coder:7b', 'qwen2.5-coder:latest', 'llama3.1:8b', 'llama3.2:1b'].find((name) => installed.includes(name))
      if (selected) setModel(selected)
      setMessages((previous) => [
        ...previous,
        { role: 'system', content: `Ollama is ready${selected ? ` with ${selected}` : ''}.`, ts: Date.now() },
      ])
    } catch (err) {
      setRuntimeError(err.message || String(err))
    } finally {
      setRuntimeBusy(false)
    }
  }, [desktopApi, setMessages, setModel, setProviderId])

  const ensureDesktopRuntime = useCallback(async (signal) => {
    if (!desktopApi) return
    if (!needsLocalRuntime) return
    if (signal?.aborted) throw new Error('Stopped by user.')

    // A runtime call that never answers must not leave the app looking dead: the
    // composer stays editable, and this gives a real error instead of silence.
    let status = await withTimeout(
      desktopApi.getRuntimeStatus(),
      15000,
      'The local runtime did not respond within 15 seconds. Check that Ollama is running, then retry.',
    )
    if (!status.ollama?.ok) {
      // Javelin never starts Ollama on its own: a background model server is the user's
      // decision, not a side effect of pressing Run.
      throw new Error(
        'The local Javelin model needs Ollama running, and the IDE will not start it for you. ' +
        'Start Ollama yourself, or pick a hosted provider in Settings — hosted models never use Ollama.',
      )
    }
    setRuntimeStatus(status)
    setRuntimeError('')

    if (!status.ollama?.ok) {
      throw new Error('Could not start local Ollama. Check the Ollama installation, then retry.')
    }

    const installed = status.ollama.models ?? []
    const modelAvailable = installed.some((name) => name === model || name.startsWith(`${model}:`))
    if (!modelAvailable) {
      throw new Error(
        `Ollama is running, but the selected model "${model}" is not installed. ` +
        `Installed models: ${installed.join(', ') || 'none'}. Choose an installed model in Settings.`,
      )
    }
  }, [desktopApi, model, needsLocalRuntime])

  // Javelin's durable memory bridge: Core calls load() once and save() as it learns,
  // so learnings and known-dead actions survive a page reload.
  const memoryStore = useMemo(
    () => ({
      load: () => agentMemory,
      save: (snapshot) => setAgentMemory(snapshot),
    }),
    // Deliberately recreated only when the stored snapshot identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Javelin Core — its own reasoning runtime, independent of chat and agent modes.
  const javelin = useJavelin({
    providerId,
    model,
    apiKey,
    baseUrl,
    workspaceFiles,
    workspaceDirectories,
    memoryStore,
  })

  // Hold Javelin behind a ref so `send` stays stable across renders.
  const javelinRef = useRef(javelin)
  javelinRef.current = javelin
  const isBusy = isStreaming || activeChats > 0 || javelin.busy || imageBusy

  // Name a new chat with the selected model once its first exchange is saved.
  // The first-message fallback is already visible, so a failure is invisible and
  // harmless rather than a chat that looks broken.
  useEffect(() => {
    if (!historyReady || !activeConversationId || isBusy) return undefined
    if (provider.requiresKey && !apiKey) return undefined
    const conversation = conversations.find((item) => item.id === activeConversationId)
    if (!conversation || conversation.titleSource !== 'auto' || conversation.autoName !== true) return undefined
    if (titleAttemptsRef.current.has(conversation.id)) return undefined
    const hasUser = messages.some((message) => message.role === 'user' && String(message.content ?? '').trim())
    const hasAssistant = messages.some((message) => message.role === 'assistant' && String(message.content ?? '').trim())
    if (!hasUser || !hasAssistant) return undefined

    if (!isOwner) {
      if (account) {
        if (accountRemaining <= 0) return undefined
      } else {
        if (guestUsed >= GUEST_DAILY_LIMIT) return undefined
        setGuestUsage({ date: usageDate, count: guestUsed + 1 })
      }
    }
    titleAttemptsRef.current.add(conversation.id)
    // One automatic attempt per chat, even if the request fails or the page is
    // reloaded while it is in flight. The fallback title is already usable.
    setConversations((previous) => (Array.isArray(previous) ? previous : []).map((item) => (
      item.id === conversation.id && item.titleSource === 'auto' && item.autoName
        ? { ...item, autoName: false }
        : item
    )))
    const controller = new AbortController()
    const requestTitle = () => generateChatTitle({
      providerId,
      baseUrl: baseUrl || provider.baseUrl,
      apiKey,
      model,
      messages,
      signal: controller.signal,
    })
    const request = providerId === 'javelinclouddirect' || providerId === 'javelincloud'
      ? enqueueProviderTask(providerId, requestTitle, controller.signal)
      : requestTitle()
    request.then((result) => {
      if (!result?.title) return
      setConversations((previous) => (Array.isArray(previous) ? previous : []).map((item) => (
        item.id === conversation.id && item.titleSource === 'auto'
          ? { ...item, title: result.title, titleSource: 'ai', autoName: false, updatedAt: Date.now() }
          : item
      )))
      if (result.usage) recordAccountTokens(tokensForExchange({ usage: result.usage }))
    }).catch(() => {
      // The first-message title remains in place. A failed naming request did no
      // model work, so it must not cost a guest one of their daily requests.
      if (!isOwner && !account) {
        setGuestUsage((previous) => previous?.date === usageDate
          ? { ...previous, count: Math.max(0, (Number(previous.count) || 0) - 1) }
          : previous)
      }
    })
    return undefined
  }, [account, accountRemaining, activeConversationId, apiKey, baseUrl, conversations, enqueueProviderTask, guestUsed, historyReady, isBusy, isOwner, messages, model, provider, providerId, recordAccountTokens, setConversations, setGuestUsage, usageDate])

  const resetConversationRun = useCallback(() => {
    setSteps([])
    setCheckpoints([])
    setRunResult(null)
    setError(null)
    setPhase(null)
  }, [])

  // Cloud history is merged, never blind-overwritten: a device can be offline
  // for a while and still keep the chats it wrote in the meantime.
  const performHistorySync = useCallback(async () => {
    const token = accountSession?.token
    if (!token || !historyReady || historySyncInFlightRef.current) return
    historySyncInFlightRef.current = true
    setHistorySync((previous) => ({ ...previous, state: 'syncing', error: '' }))
    const sent = historyRef.current
    const sentFingerprint = historyFingerprint(sent.conversations, sent.deleted)
    try {
      const remote = await syncChatHistory(token, buildSyncPayload(sent.conversations, sent.deleted))
      // A response for a previous account must never be merged into the new one.
      if (accountTokenRef.current !== token) return
      const latest = historyRef.current
      const merged = mergeHistory(latest.conversations, latest.deleted, remote)
      setConversations(merged.conversations)
      setDeletedConversations(merged.deleted)
      historySyncedFingerprintRef.current = sentFingerprint
      setHistorySync({ state: 'synced', at: Date.now(), error: '' })
      const active = activeConversationIdRef.current
      if (active && !merged.conversations.some((conversation) => conversation.id === active)) {
        setActiveConversationId(null)
        setMessages([])
        resetConversationRun()
      }
    } catch (syncError) {
      if (accountTokenRef.current !== token) return
      setHistorySync({
        state: syncError?.status === 401 ? 'signed-out' : 'error',
        at: Date.now(),
        error: syncError?.message || String(syncError),
      })
    } finally {
      historySyncInFlightRef.current = false
    }
  }, [accountSession?.token, historyReady, resetConversationRun, setActiveConversationId, setConversations, setDeletedConversations, setMessages])

  useEffect(() => {
    historySyncedFingerprintRef.current = ''
    historySyncInFlightRef.current = false
    setHistorySync({ state: 'idle', at: null, error: '' })
  }, [accountSession?.token])

  // Wait until a stream settles, then upload the saved thread. The fingerprint
  // stops a successful merge from scheduling the same snapshot again.
  useEffect(() => {
    if (!historyReady || !accountSession?.token) return undefined
    if (historyFingerprint(conversations, deletedConversations) === historySyncedFingerprintRef.current) {
      return undefined
    }
    const timer = window.setTimeout(() => void performHistorySync(), 1_200)
    return () => window.clearTimeout(timer)
  }, [accountSession?.token, conversations, deletedConversations, historyReady, performHistorySync])

  const saveCurrentConversation = useCallback(() => {
    if (!Array.isArray(messages) || messages.length === 0) return
    if (activeConversationId) {
      setConversations((previous) => upsertConversation(previous, activeConversationId, messages))
      return
    }
    const id = nextConversationId()
    setConversations((previous) => upsertConversation(previous, id, messages))
  }, [activeConversationId, messages, setConversations])

  const switchConversation = useCallback((id) => {
    if (isBusy || !id || id === activeConversationId) return
    const target = conversations.find((conversation) => conversation.id === id)
    if (!target) return
    saveCurrentConversation()
    setActiveConversationId(id)
    setMessages(Array.isArray(target.messages) ? target.messages : [])
    resetConversationRun()
    setHistoryOpen(false)
  }, [activeConversationId, conversations, isBusy, resetConversationRun, saveCurrentConversation, setActiveConversationId, setMessages])

  const startNewChat = useCallback(() => {
    if (isBusy) return
    saveCurrentConversation()
    setActiveConversationId(null)
    setMessages([])
    resetConversationRun()
    setHistoryOpen(false)
  }, [isBusy, resetConversationRun, saveCurrentConversation, setActiveConversationId, setMessages])

  const deleteConversation = useCallback((id) => {
    if (isBusy || !id) return
    setConversations((previous) => (
      (Array.isArray(previous) ? previous : []).filter((conversation) => conversation.id !== id)
    ))
    setDeletedConversations((previous) => pruneDeletedConversations({
      ...(previous && typeof previous === 'object' ? previous : {}),
      [id]: Date.now(),
    }))
    if (id === activeConversationId) {
      setActiveConversationId(null)
      setMessages([])
      resetConversationRun()
    }
  }, [activeConversationId, isBusy, resetConversationRun, setActiveConversationId, setConversations, setDeletedConversations, setMessages])

  const renameConversation = useCallback((id, title) => {
    const nextTitle = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!id || !nextTitle) return
    setConversations((previous) => (Array.isArray(previous) ? previous : []).map((conversation) => (
      conversation.id === id
        ? { ...conversation, title: nextTitle, titleSource: 'manual', autoName: false, updatedAt: Date.now() }
        : conversation
    )))
    // A rename is a newer revision than any deletion for this chat.
    setDeletedConversations((previous) => {
      if (!previous?.[id]) return previous
      const next = { ...previous }
      delete next[id]
      return next
    })
  }, [setConversations, setDeletedConversations])

  const openDesktopProject = useCallback(async () => {
    const snapshot = await desktopApi?.openWorkspace()
    if (!snapshot) return null
    const files = snapshot.contents ?? {}
    const directories = snapshot.directories ?? []
    workspaceRef.current = new VirtualWorkspace(files, directories)
    setWorkspaceFiles(files)
    setWorkspaceDirectories(directories)
    setDesktopProject(snapshot)
    setDesktopView('code')
    setMessages((previous) => [
      ...previous,
      { role: 'system', content: `Opened project ${snapshot.name} with ${snapshot.files.length} file(s).`, ts: Date.now() },
    ])
    return snapshot
  }, [desktopApi, setMessages, setWorkspaceDirectories, setWorkspaceFiles])

  const createDesktopWorkspace = useCallback(async (name) => {
    if (!desktopApi) throw new Error('Workspace creation is only available in the desktop IDE.')
    const snapshot = await desktopApi.createWorkspace(name)
    if (!snapshot) return null
    const files = snapshot.contents ?? {}
    const directories = snapshot.directories ?? []
    workspaceRef.current = new VirtualWorkspace(files, directories)
    setWorkspaceFiles(files)
    setWorkspaceDirectories(directories)
    setDesktopProject(snapshot)
    setDesktopView('code')
    setMessages((previous) => [
      ...previous,
      { role: 'system', content: `Created workspace ${snapshot.name}.`, ts: Date.now() },
    ])
    return snapshot
  }, [desktopApi, setMessages, setWorkspaceDirectories, setWorkspaceFiles])

  const saveDesktopFile = useCallback(async (path, content) => {
    if (!desktopApi) return
    await desktopApi.writeFile(path, content)
    workspaceRef.current.write(path, content, true)
    setWorkspaceDirectories(workspaceRef.current.directoryPaths())
    setWorkspaceFiles((previous) => ({ ...previous, [path]: content }))
    setDesktopProject((previous) => previous ? {
      ...previous,
      files: previous.files.some((file) => file.path === path)
        ? previous.files
        : [...previous.files, { path, type: 'file', size: new TextEncoder().encode(content).length }].sort((a, b) => a.path.localeCompare(b.path)),
      directories: workspaceRef.current.directoryPaths(),
    } : previous)
  }, [desktopApi, setWorkspaceDirectories, setWorkspaceFiles])

  const renameDesktopFile = useCallback(async (oldPath, newPath) => {
    if (!desktopApi) throw new Error('File operations are only available in the desktop IDE.')
    if (!workspaceRef.current.exists(oldPath)) {
      workspaceRef.current.write(oldPath, await desktopApi.readFile(oldPath), true)
    }
    if (workspaceRef.current.exists(newPath)) throw new Error(`A project file already exists at ${newPath}.`)
    await desktopApi.renameFile(oldPath, newPath)
    workspaceRef.current.rename(oldPath, newPath)
    setWorkspaceFiles(workspaceRef.current.toJSON())
    setDesktopProject((previous) => previous ? {
      ...previous,
      files: previous.files.map((file) => file.path === oldPath ? { ...file, path: newPath } : file)
        .sort((a, b) => a.path.localeCompare(b.path)),
    } : previous)
  }, [desktopApi, setWorkspaceFiles])

  const deleteDesktopFile = useCallback(async (path) => {
    // A file can live on disk, in the in-memory workspace, or both (an agent may have
    // created it in memory only). Delete whichever exists instead of failing on the
    // one that does not.
    let diskError = null
    if (desktopApi) {
      try {
        await desktopApi.deleteFile(path)
      } catch (error) {
        diskError = error
      }
    }
    const inWorkspace = workspaceRef.current.exists(path)
    if (inWorkspace) {
      workspaceRef.current.delete(path)
      setWorkspaceFiles(workspaceRef.current.toJSON())
    } else if (diskError) {
      throw diskError
    } else if (!desktopApi) {
      throw new Error(`File not found in the workspace: ${path}`)
    }
    setDesktopProject((previous) => previous ? {
      ...previous,
      files: previous.files.filter((file) => file.path !== path),
    } : previous)
  }, [desktopApi, setWorkspaceFiles])

  const createDesktopFolder = useCallback(async (path) => {
    if (!desktopApi) return
    await desktopApi.createFolder(path)
    const outcome = workspaceRef.current.createDirectory(path)
    const directories = workspaceRef.current.directoryPaths()
    setWorkspaceDirectories(directories)
    setDesktopProject((previous) => previous ? { ...previous, directories } : previous)
    return outcome
  }, [desktopApi, setWorkspaceDirectories])

  const runDesktopCommand = useCallback((command, signal, onOutput) => {
    if (!desktopApi) throw new Error('Project command execution is only available in the desktop IDE.')
    return createDesktopCommandRunner(desktopApi)(command, signal, onOutput)
  }, [desktopApi])

  const syncDesktopChanges = useCallback(async (paths, changedDirectories = []) => {
    if (!desktopApi || !desktopProject || (!paths?.length && !changedDirectories.length)) return
    const uniquePaths = [...new Set(paths ?? [])]
    const directoryPaths = new Set([
      ...changedDirectories,
      ...uniquePaths.filter((path) => workspaceRef.current.isDirectory(path) || desktopProject.directories?.includes(path)),
    ])
    for (const path of uniquePaths.filter((candidate) => !directoryPaths.has(candidate))) {
      if (workspaceRef.current.exists(path)) {
        await desktopApi.writeFile(path, workspaceRef.current.read(path))
      } else {
        await desktopApi.deleteFile(path)
      }
    }
    for (const path of [...directoryPaths].sort((a, b) => b.length - a.length)) {
      if (workspaceRef.current.isDirectory(path)) await desktopApi.createFolder(path)
      else await desktopApi.deleteFolder(path)
    }
    const directories = workspaceRef.current.directoryPaths()
    setWorkspaceDirectories(directories)
    setDesktopProject((previous) => {
      if (!previous) return previous
      const entries = new Map(previous.files.map((file) => [file.path, file]))
      for (const path of uniquePaths.filter((candidate) => !directoryPaths.has(candidate))) {
        if (workspaceRef.current.exists(path)) entries.set(path, { path, type: 'file' })
        else entries.delete(path)
      }
      return { ...previous, files: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)), directories }
    })
  }, [desktopApi, desktopProject, setWorkspaceDirectories])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  // The phone composer grows with a long question, like a chat app, instead of
  // trapping the text behind an inner scrollbar after the first line.
  useEffect(() => {
    if (!mobileChatOnly) return
    const field = textareaRef.current
    if (!field) return
    field.style.height = 'auto'
    const limit = Math.max(42, window.innerHeight * 0.28)
    field.style.height = `${Math.min(field.scrollHeight, limit)}px`
  }, [input, mobileChatOnly])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleGlobalKeydown = (e) => {
      // Ctrl/Cmd + K: Focus input
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        textareaRef.current?.focus()
      }
      // Ctrl/Cmd + L: Clear conversation
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        startNewChat()
      }
      // Ctrl/Cmd + ,: Open settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      }
      // Ctrl/Cmd + Shift + A: Show or hide the assistant.
      if (desktopApi && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const next = !assistantCollapsed
        setAssistantCollapsed(next)
        if (!next) requestAnimationFrame(() => textareaRef.current?.focus())
      }
      // Escape: Stop or close dialogs
      if (e.key === 'Escape') {
        if (isBusy) {
          abortRef.current?.abort()
          stopChatResponses()
          javelinRef.current?.stop()
        } else if (settingsOpen) {
          setSettingsOpen(false)
        } else if (historyOpen) {
          setHistoryOpen(false)
        } else if (supportOpen) {
          setSupportOpen(false)
        }
      }
    }

    window.addEventListener('keydown', handleGlobalKeydown)
    return () => window.removeEventListener('keydown', handleGlobalKeydown)
  }, [assistantCollapsed, desktopApi, historyOpen, isBusy, setAssistantCollapsed, settingsOpen, startNewChat, stopChatResponses, supportOpen])

  useEffect(() => {
    const focusAssistant = () => {
      setAssistantCollapsed(false)
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
    const openSettings = () => setSettingsOpen(true)
    window.addEventListener('javelin:focus-assistant', focusAssistant)
    window.addEventListener('javelin:open-settings', openSettings)
    return () => {
      window.removeEventListener('javelin:focus-assistant', focusAssistant)
      window.removeEventListener('javelin:open-settings', openSettings)
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isStreaming, steps, phase])

  // Keep the model valid for the selected provider.
  useEffect(() => {
    const list = provider.models
    if (list.length && !list.some((m) => m.id === model)) {
      setModel(provider.defaultModel)
    }
  }, [model, provider, setModel])

  // ---- Voice ------------------------------------------------------------
  // Spoken replies use the platform's own synthesiser: no key, no network, no cost.
  // The voice is ranked by the module rather than taken as the first one offered.
  const voiceCaps = useMemo(() => voiceCapabilities(), [])
  const speaker = useMemo(() => createSpeaker(), [])

  /** Open speech from a real tap. Both mobile engines reject the first async
   * speak/play whether or not the user enabled spoken replies earlier. */
  const unlockSpeech = useCallback(async () => {
    const [systemReady] = await Promise.all([
      speaker.unlock?.() ?? false,
      isCloudVoice(ttsProvider) && ttsKey ? primeCloudSpeech() : false,
    ])
    return Boolean(systemReady)
  }, [speaker, ttsProvider, ttsKey])

  const speakReply = useCallback(async (text, messageId = null, { force = false } = {}) => {
    if ((!force && !speakReplies) || !text?.trim()) return false
    const abort = new AbortController()
    speechAbortRef.current?.abort()
    speechAbortRef.current = abort
    stopCloudSpeech()
    speaker.stop()
    setSpeakingMessageId(messageId)
    setVoiceNotice('')

    // While the answer is spoken, listen for the user cutting in. Speech is cancelled
    // from `interrupt`, which also starts recording, so the mic is never closed.
    if (liveVoice) startBargeInRef.current?.()

    const finish = (spoken) => {
      stopBargeInRef.current?.()
      if (speechAbortRef.current === abort) {
        speechAbortRef.current = null
        setSpeakingMessageId(null)
      }
      // Live mode is a loop, and the microphone is the half that must not depend on
      // the other: if speech synthesis fails or there is no voice installed, keep
      // listening anyway rather than ending the conversation silently.
      if (liveVoice && !abort.signal.aborted) {
        window.setTimeout(() => startListeningRef.current?.(), 300)
      }
      if (!spoken && !abort.signal.aborted) {
        setVoiceNotice(force
          ? 'Speech could not start. Check the phone volume and tap Play aloud again.'
          : 'Speech could not start automatically. Tap Play aloud on the reply.')
      }
      return spoken
    }

    // A configured cloud voice is the point of this feature; the system voice is the
    // safety net, not a competitor. A failure is reported once and then spoken anyway.
    if (isCloudVoice(ttsProvider) && ttsKey) {
      try {
        const played = await speakCloud({
          providerId: ttsProvider,
          text,
          voice: ttsVoice || undefined,
          apiKey: ttsKey,
          signal: abort.signal,
        })
        if (played) return finish(true)
      } catch (error) {
        if (abort.signal.aborted || error?.name === 'AbortError') return finish(false)
        setVoiceNotice(`Cloud voice failed (${String(error?.message ?? error).slice(0, 120)}). Using the system voice.`)
      }
    }

    try {
      const spoken = await speaker.speak(text, { voiceURI, lang: 'en' })
      return finish(spoken)
    } catch (error) {
      if (!abort.signal.aborted) setVoiceNotice(String(error?.message ?? error).slice(0, 160))
      return finish(false)
    }
  }, [liveVoice, speakReplies, speaker, ttsProvider, ttsKey, ttsVoice, voiceURI])

  const generateImageMessage = useCallback(async ({ content, subject, userMsg }) => {
    const assistantId = nextMessageId()
    setMessages((previous) => [
      ...previous,
      userMsg,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        image: { status: 'loading', prompt: content },
        ts: Date.now(),
      },
    ])
    setImageBusy(true)
    setImageError('')
    const controller = new AbortController()
    imageAbortRef.current = controller
    try {
      const image = await generateImage({ prompt: subject, signal: controller.signal })
      setMessages((previous) => previous.map((message) => (
        message.id === assistantId
          ? {
              ...message,
              content: `AI-generated image created from: “${content}”`,
              image: { status: 'ready', ...image },
            }
          : message
      )))
    } catch (error) {
      setMessages((previous) => previous.filter((message) => message.id !== assistantId))
      if (error?.name === 'AbortError') return
      setImageError(error?.message || 'Could not create that image. Try a different description.')
      setInput((current) => (current.trim() ? current : content))
    } finally {
      imageAbortRef.current = null
      setImageBusy(false)
      textareaRef.current?.focus()
    }
  }, [])

  const send = useCallback(async (text, forcedMode) => {
    const content = (text ?? input).trim()
    const target = mobileChatOnly ? 'chat' : (forcedMode ?? mode)
    const autoRouteToAgent = !mobileChatOnly && target === 'chat' && shouldRunWorkspaceAgent(content)
    const useAgent = target === 'agent' || autoRouteToAgent
    // Conversational covers greetings, laughs and reactions ("lol", "you?", "why?"),
    // so those never start a workspace run. A real task verb still does.
    const useJavelinMode = target === 'javelin' && !isConversational(content)
    const hasAttachments = attachments.length > 0
    const hasImages = attachments.some((attachment) => attachment.kind === 'image')
    const imageRequested = mobileChatOnly && !hasAttachments && (imageMode || isImageRequest(content))
    if (!content && !hasAttachments) return
    if (speakReplies) void unlockSpeech()
    if (imageRequested) {
      const subject = imageRequestSubject(content)
      if (!subject) {
        setImageError('Describe the subject you want in the image.')
        return
      }
      const promptIssue = imagePromptIssue(content)
      if (promptIssue) {
        setImageError(promptIssue)
        return
      }
      if (imageBusy || isStreaming || javelinRef.current?.busy) return
      if (!reserveAiUsage()) return
      setError(null)
      setImageError('')
      setInput('')
      await generateImageMessage({
        content,
        subject,
        userMsg: {
          id: nextMessageId(),
          role: 'user',
          content,
          attachments: [],
          ts: Date.now(),
        },
      })
      return
    }
    // Agent and Javelin runs are serial. Plain chat replies are independent and can
    // overlap, up to the per-install cap.
    if (useAgent || useJavelinMode) {
      if (isBusy) return
    } else if (isStreaming || javelinRef.current?.busy || imageBusy) {
      return
    } else if (activeChatsRef.current >= MAX_CONCURRENT_RESPONSES) {
      return
    }
    if (provider.requiresKey && !apiKey) {
      setSettingsOpen(true)
      return
    }
    if (!reserveAiUsage()) return

    setError(null)
    setInput('')
    setRunResult(null)
    setAttachmentError('')

    // The free default model only accepts text. OCR + a caption turn each attached
    // image into text before the request, so an image is never silently dropped and
    // the user does not need to configure a paid vision provider first.
    let preparedAttachments = attachments
    if (hasImages && provider.vision === false && !useAgent && !useJavelinMode) {
      setAttachmentBusy(true)
      setImageReadStage('Reading the image…')
      try {
        preparedAttachments = await Promise.all(attachments.map(async (attachment) => {
          if (attachment.kind !== 'image' || attachment.analysis) return attachment
          try {
            const reading = await readImageForTextModel(attachment, { onStage: setImageReadStage })
            return { ...attachment, analysis: reading.analysis }
          } catch {
            return {
              ...attachment,
              analysis: 'An image was attached, but its contents could not be read automatically.',
            }
          }
        }))
      } finally {
        setImageReadStage('')
        setAttachmentBusy(false)
      }
    }

    const userMsg = {
      id: nextMessageId(),
      role: 'user',
      content,
      attachments: preparedAttachments,
      ts: Date.now(),
    }
    setAttachments([])

    // ---- Javelin Core path ------------------------------------------------
    // Javelin runs on its own runtime: phase machine, memory, self-correction.
    if (useJavelinMode) {
      const filesBeforeRun = workspaceRef.current.toJSON()
      const directoriesBeforeRun = workspaceRef.current.directoryPaths()
      setMessages((prev) => [...prev, userMsg])
      setIsStreaming(true)
      try {
        await ensureDesktopRuntime()
        const outcome = await javelinRef.current.think(content, {
          autonomy,
          priorMessages: messages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
          runCommand: desktopApi ? runDesktopCommand : undefined,
          onFileChanged: (evt) => {
            if (evt.type === 'workspace_sync' && evt.files) {
              const changedPaths = changedWorkspacePaths(filesBeforeRun, evt.files)
              const directories = evt.directories ?? []
              const changedDirectories = changedDirectoryPaths(directoriesBeforeRun, directories)
              workspaceRef.current = new VirtualWorkspace(evt.files, directories)
              setWorkspaceFiles(evt.files)
              setWorkspaceDirectories(directories)
              setDesktopProject((previous) => previous ? {
                ...previous,
                files: projectFilesForSnapshot(evt.files, previous.files),
                directories,
              } : previous)
              void syncDesktopChanges(changedPaths, changedDirectories).catch((err) => setError(err.message || String(err)))
              return
            }
            if (evt.type === 'file_changed') {
              const files = workspaceRef.current.toJSON()
              if (evt.action === 'delete') delete files[evt.path]
              else if (evt.action === 'rename') {
                delete files[evt.old_path]
                files[evt.new_path] = evt.after
              } else if (evt.action === 'copy') {
                files[evt.dest_path] = evt.after
              } else if (evt.path && typeof evt.after === 'string') {
                files[evt.path] = evt.after
              }
              const directories = workspaceRef.current.directoryPaths()
              workspaceRef.current = new VirtualWorkspace(files, directories)
              setWorkspaceFiles(files)
              setWorkspaceDirectories(workspaceRef.current.directoryPaths())
              setDesktopProject((previous) => previous ? {
                ...previous,
                files: projectFilesForSnapshot(files, previous.files),
                directories: workspaceRef.current.directoryPaths(),
              } : previous)
              setDirty(true)
              return
            }
            if (evt.type === 'folder_created') {
              const directories = [...new Set([
                ...workspaceRef.current.directoryPaths(),
                ...(evt.created ?? []),
              ])]
              workspaceRef.current = new VirtualWorkspace(workspaceRef.current.toJSON(), directories)
              setWorkspaceDirectories(workspaceRef.current.directoryPaths())
              setDesktopProject((previous) => previous ? {
                ...previous,
                directories: workspaceRef.current.directoryPaths(),
              } : previous)
            }
          },
        })
        recordRunTokens(outcome, content, messages.map(({ role, content: messageContent }) => ({ role, content: messageContent })))
        if (outcome) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content:
                outcome.status === 'done'
                  ? `✅ **${outcome.summary}**`
                  : outcome.status === 'aborted'
                    ? `⏹️ **Stopped.** ${outcome.summary}`
                    : `❌ **Could not complete.** ${outcome.summary}`,
              ts: Date.now(),
            },
          ])
        }
      } catch (err) {
        setError(describeError(err))
      } finally {
        setIsStreaming(false)
        textareaRef.current?.focus()
      }
      return
    }
    const history = [...messages, userMsg]
    // A text-only provider rejects image parts. Its messages carry the OCR/caption
    // reading instead, including images from earlier turns that were already read.
    const apiHistory = history.map((message) => messageForApi(message, {
      textOnly: provider.vision === false,
    }))

    if (!useAgent) {
      // ---- Plain chat path (provider-agnostic) ----
      // Each reply owns its bubble and controller. Other replies keep streaming when
      // one finishes, so the composer stays free for the next question.
      const assistantId = nextMessageId()
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: 'assistant', content: '', ts: Date.now() },
      ])
      beginChatResponse()

      const controller = new AbortController()
      chatAbortsRef.current.add(controller)
      let acc = ''
      const updateAssistant = (nextContent) => {
        setMessages((prev) => prev.map((message) => (
          message.id === assistantId ? { ...message, content: nextContent } : message
        )))
      }
      const removeAssistant = () => {
        setMessages((prev) => prev.filter((message) => message.id !== assistantId))
      }
      const applyToken = (delta) => {
        acc += delta
        updateAssistant(acc)
      }
      const runReply = async () => {
        await streamChat({
          providerId,
          baseUrl: baseUrl || provider.baseUrl,
          apiKey,
          model,
          messages: apiHistory,
          signal: controller.signal,
          onToken: applyToken,
          onUsage: (payload) => recordAccountTokens(tokensForExchange(payload)),
        })

        // A small model sometimes answers "hi" with "hi". Retry once with the
        // failure named, replacing the text as it streams instead of appending to
        // the echo. One retry only: a model that echoes twice will not learn.
        if (isEcho(acc, content)) {
          acc = ''
          updateAssistant('')
          await streamChat({
            providerId,
            baseUrl: baseUrl || provider.baseUrl,
            apiKey,
            model,
            messages: [
              ...apiHistory,
              { role: 'system', content: ECHO_RETRY_INSTRUCTION },
            ],
            signal: controller.signal,
            onToken: applyToken,
            onUsage: (payload) => recordAccountTokens(tokensForExchange(payload)),
          })
        }

        // A provider that answers with nothing (empty stream, filtered response)
        // must not leave a silent, empty bubble. Say what happened.
        if (!acc.trim() && !controller.signal.aborted) {
          acc = 'I didn\'t get a reply back from the model on that one — say it again and I\'ll take another run at it.'
          updateAssistant(acc)
        }
      }
      try {
        await ensureDesktopRuntime()
        if (providerId === 'javelinclouddirect' || providerId === 'javelincloud') {
          await enqueueProviderTask(providerId, runReply, controller.signal)
        } else {
          await runReply()
        }

        // Read the finished answer aloud when voice output is on. With several
        // replies in flight, speaking all of them at once would be unusable.
        if (activeChatsRef.current <= 1) speakReply(acc, assistantId)
      } catch (err) {
        if (err?.name === 'AbortError') {
          if (!acc) removeAssistant()
        } else {
          const detail = describeError(err)
          updateAssistant(`⚠️ ${detail}`)
          if (activeChatsRef.current <= 1) setError(detail)
        }
      } finally {
        chatAbortsRef.current.delete(controller)
        finishChatResponse()
        textareaRef.current?.focus()
      }
      return
    }

    // ---- Agent path ----
    setMessages(history)
    setSteps([])
    setCheckpoints([])
    setPhase('inspect')
    setStatusText(autoRouteToAgent ? 'Workspace change detected · starting Agent…' : 'Starting…')
    setIsStreaming(true)
    setDirty(false)
    // A new run supersedes the previous keep/undo offer.
    setPendingDecision(null)
    setRunBaseline(null)

    const controller = new AbortController()
    abortRef.current = controller
    const filesBeforeRun = workspaceRef.current.toJSON()
    const directoriesBeforeRun = workspaceRef.current.directoryPaths()
    // Mirror of the agent's internal steps so the UI can show results as they land.
    const emittedSteps = []
    const refreshVisibleWorkspace = () => {
      const files = workspaceRef.current.toJSON()
      const directories = workspaceRef.current.directoryPaths()
      setWorkspaceFiles(files)
      setWorkspaceDirectories(directories)
      setDesktopProject((previous) => {
        if (!previous) return previous
        return {
          ...previous,
          files: projectFilesForSnapshot(files, previous.files),
          directories,
        }
      })
    }

    // Changes this run made that are not on disk yet. A shell command runs against the
    // real project, so anything pending has to be written before it starts.
    const pendingDiskPaths = new Set()
    const pendingDiskFolders = new Set()
    const flushPendingToDisk = async () => {
      if (!desktopApi) return
      for (const path of [...pendingDiskFolders].sort((a, b) => a.length - b.length)) {
        try {
          await desktopApi.createFolder(path)
        } catch (err) {
          if (!/exists/i.test(String(err?.message ?? err))) throw err
        }
      }
      pendingDiskFolders.clear()
      for (const path of [...pendingDiskPaths]) {
        if (workspaceRef.current.exists(path)) {
          await desktopApi.writeFile(path, workspaceRef.current.read(path))
        } else {
          try {
            await desktopApi.deleteFile(path)
          } catch {
            // Already gone from disk; nothing to remove.
          }
        }
        pendingDiskPaths.delete(path)
      }
    }

    const emit = (evt) => {
      switch (evt.type) {
        case 'phase':
          setPhase(evt.phase)
          break
        case 'status':
          setStatusText(evt.text)
          break
        case 'error':
          setStatusText(evt.code ? `${evt.code} · ${errorTitle(evt.code)}` : evt.error ?? 'Run failed')
          break
        case 'tool_call': {
          emittedSteps.push({
            id: evt.id,
            step: emittedSteps.length + 1,
            name: evt.name,
            args: evt.args,
            ok: null,
            output: '',
            timestamp: Date.now(),
          })
          setSteps([...emittedSteps])
          const target = evt.args?.path ?? evt.args?.command ?? evt.args?.query
          setStatusText(`${evt.name.replaceAll('_', ' ')}${target ? ` · ${target}` : ''}…`)
          break
        }
        case 'tool_result': {
          const record = emittedSteps.find((s) => s.id === evt.id)
          if (record) {
            record.ok = evt.ok
            record.output = evt.output
          }
          setSteps([...emittedSteps])
          break
        }
        case 'file_changed':
          setDirty(true)
          refreshVisibleWorkspace()
          if (evt.path) pendingDiskPaths.add(evt.path)
          break
        case 'folder_created':
          setDirty(true)
          refreshVisibleWorkspace()
          if (evt.path) pendingDiskFolders.add(evt.path)
          break
        case 'command_output': {
          const record = emittedSteps.find((step) => step.id === evt.id)
          if (record) {
            const prefix = evt.stream === 'stderr' ? '[stderr] ' : ''
            record.output = `${record.output}${prefix}${evt.text}`.slice(-12000)
            setSteps([...emittedSteps])
          }
          break
        }
        case 'checkpoint':
          setCheckpoints((prev) => [...prev, evt.checkpoint])
          break
        case 'reminder':
          setMessages((prev) => [
            ...prev,
            { role: 'system', content: `⚠️ ${evt.text}`, ts: Date.now() },
          ])
          break
        case 'command_started':
          setStatusText(`Running ${evt.command}…`)
          break
        case 'command_finished':
          setCommandOutput((previous) => [...previous, { type: evt.exitCode === 0 ? 'success' : 'error', text: evt.output }].slice(-50))
          break
        default:
          break
      }
    }

    const events = {
      emit,
      requestApproval: (req) =>
        new Promise((resolve) => {
          approvalResolver.current = resolve
          setApproval(req)
          // A stop while the dialog is open must release this wait, not deadlock it.
          controller.signal.addEventListener('abort', () => {
            if (approvalResolver.current !== resolve) return
            approvalResolver.current = null
            setApproval(null)
            resolve({ approved: false })
          }, { once: true })
        }),
    }

    try {
      await ensureDesktopRuntime(controller.signal)
      const result = await runAgent({
        task: content,
        workspace: workspaceRef.current,
        provider: { providerId, baseUrl: baseUrl || provider.baseUrl, apiKey, model },
        signal: controller.signal,
        events,
        autonomy,
        // With a real project and command runner, prove the change with the project's
        // own checks before accepting a finish. The approval dialog still applies.
        autoVerify: Boolean(desktopApi),
        // Commands run in the real project: flush this run's pending changes first, so
        // a test or build sees the files the agent just wrote.
        runCommand: desktopApi
          ? async (command, signal, onOutput) => {
              await flushPendingToDisk()
              return runDesktopCommand(command, signal, onOutput)
            }
          : undefined,
        priorMessages: messages.map(({ role, content: c }) => ({ role, content: c })),
      })

      recordRunTokens(result, content, messages.map(({ role, content: c }) => ({ role, content: c })))

      const changedPaths = changedWorkspacePaths(filesBeforeRun, workspaceRef.current.toJSON())
      const changedDirectories = changedDirectoryPaths(directoriesBeforeRun, workspaceRef.current.directoryPaths())
      await syncDesktopChanges(changedPaths, changedDirectories)
      setRunResult(result)
      // Record where this message sits and which checkpoint undoes it, so the user can
      // revert to it later. The runtime's automatic baseline is exactly that point.
      const lastUser = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1)
      if (lastUser !== -1) {
        messageMarks.current.push({
          index: lastUser,
          checkpointId: result.baseline ?? null,
          ts: Date.now(),
        })
      }
      // Offer the keep-or-undo decision when the run actually changed something.
      const touched = result.filesTouched ?? []
      setRunBaseline(result.baseline ?? null)
      setPendingDecision(
        result.baseline && touched.length
          ? { fileCount: touched.length, status: result.status, code: result.code ?? null }
          : null,
      )
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            (result.status === 'done'
              ? `✅ **Done.** ${result.summary}`
              : result.status === 'aborted'
                ? `⏹️ **Stopped.** ${result.summary}`
                : `❌ **Could not complete.** ${result.summary}` +
                  (result.code ? `\n\nError code: \`${result.code}\` — ${errorTitle(result.code)}.` : '')) +
            (result.confidence
              ? `\n\nConfidence: **${result.confidence.toUpperCase()}**` +
                (result.confidence === 'unverified'
                  ? ' — no file or command evidence supports this answer.'
                  : result.verification?.passed
                    ? ` — ${[...new Set(result.verification.checks.filter((check) => check.ok).map((check) => check.command))].join(', ')} passed.`
                    : result.verification?.checks?.length
                      ? ' — a check ran but did not pass; review the output above.'
                      : ' — no test, build or lint command passed after the change.')
              : '') +
            (result.verification?.warnings?.length
              ? `\n\n⚠️ ${result.verification.warnings.map((warning) => warning.message).join(' ')}`
              : ''),
          ts: Date.now(),
        },
      ])

      // Persist resulting files so they survive a reload.
      if (workspaceRef.current) setWorkspaceFiles(workspaceRef.current.toJSON())
    } catch (err) {
      setError(describeError(err))
    } finally {
      setIsStreaming(false)
      abortRef.current = null
      // No run is waiting any more, so an unanswered approval must not keep a modal
      // covering the app.
      approvalResolver.current = null
      setApproval(null)
      setPhase(null)
      setStatusText('')
      textareaRef.current?.focus()
    }
  }, [
    apiKey, attachments, baseUrl, autonomy, beginChatResponse, enqueueProviderTask, finishChatResponse, generateImageMessage, imageBusy, imageMode, input, isBusy, isStreaming, messages, mobileChatOnly, mode, model, provider, providerId,
    reserveAiUsage, recordAccountTokens, recordRunTokens,
    setMessages, setWorkspaceFiles, syncDesktopChanges, desktopApi, runDesktopCommand, ensureDesktopRuntime,
    // Without this, `send` kept the speakReply from the first render — whose live
    // mode was off — so the microphone never reopened after an answer.
    speakReply, unlockSpeech,
  ])

  // `send` changes on every message; dictation is created once. Call through a ref
  // so voice input always runs the current version, not the one from page load.
  useEffect(() => {
    sendRef.current = send
  }, [send])

  // ---- Dictation --------------------------------------------------------
  // Push-to-talk, and the hands-free loop in live mode. Created lazily so a build
  // without a recogniser shows a plain notice instead of a dead microphone button.

  /** One stream for the whole live session: recording and interruption share it. */
  const ensureMicStream = useCallback(async () => {
    const existing = micStreamRef.current
    if (existing?.getAudioTracks?.().some((track) => track.readyState === 'live')) return existing
    // Concurrent callers (toggling live voice also opens the mic) must share one
    // request, or the loser's stream is orphaned with the device still held.
    if (!micStreamPromiseRef.current) {
      micStreamPromiseRef.current = openMicStream().then(
        (stream) => {
          micStreamRef.current = stream
          micStreamPromiseRef.current = null
          return stream
        },
        (error) => {
          micStreamPromiseRef.current = null
          throw error
        },
      )
    }
    return micStreamPromiseRef.current
  }, [])

  const closeMicStream = useCallback(() => {
    micStreamRef.current?.getTracks?.().forEach((track) => track.stop())
    micStreamRef.current = null
    micStreamPromiseRef.current = null
  }, [])

  const stopBargeIn = useCallback(() => {
    bargeRef.current?.stop()
    bargeRef.current = null
  }, [])

  const startBargeIn = useCallback(() => {
    stopBargeIn()
    bargeRef.current = createBargeIn({
      frameMs: 50,
      framesNeeded: 2,
      getStream: ensureMicStream,
      onInterrupt: () => interruptRef.current?.(),
    })
    void bargeRef.current.start()
  }, [ensureMicStream, stopBargeIn])

  useEffect(() => {
    startBargeInRef.current = startBargeIn
    stopBargeInRef.current = stopBargeIn
  }, [startBargeIn, stopBargeIn])

  const startListening = useCallback(async () => {
    if (!dictationRef.current) {
      dictationRef.current = createLocalDictation({
        // Hands-free turn-taking: stop when the user stops talking.
        autoStop: true,
        // Borrowed, not owned: the stream must outlive one recording.
        getStream: ensureMicStream,
                onFinal: (text) => {
          suppressAutoResumeRef.current = false
          setListening(false)
          setInput('')
          void sendRef.current?.(text)
        },
        // Heard nothing (a pause, a closed door). In live mode keep the loop
        // alive instead of quietly switching the microphone off.
        onEmpty: () => {
          console.log('[voice] empty', { live: liveVoiceRef.current, suppress: suppressAutoResumeRef.current })
          setListening(false)
          // A deliberate stop must stay stopped; only an accidental silence resumes.
          if (suppressAutoResumeRef.current) {
            suppressAutoResumeRef.current = false
            return
          }
          if (liveVoiceRef.current) window.setTimeout(() => startListeningRef.current?.(), 200)
        },
        onError: (err) => {
          setListening(false)
          setLiveVoice(false)
          const reason = String(err)
          setVoiceNotice(
            reason.includes('not-allowed')
              ? 'Microphone permission was refused — allow it in the app, then try again.'
              : reason.includes('timeout')
                ? 'The microphone did not respond. Check Windows → Privacy → Microphone is on, and that no other app is holding the device.'
                : `Microphone error: ${reason}`,
          )
        },
        onState: (state) => {
          if (state === 'requesting') setVoiceNotice('Waiting for microphone permission…')
          else if (state === 'recording') setVoiceNotice('Listening — tap the mic again when you are done.')
          else if (state === 'transcribing') setVoiceNotice('Transcribing on this computer…')
          else setVoiceNotice('')
        },
        onProgress: (event) => {
          if (event?.status === 'progress' && event.total) {
            setVoiceNotice(`Downloading the speech model (once): ${Math.round((event.loaded / event.total) * 100)}%`)
          }
        },
      })
    }
    if (!dictationRef.current.supported) {
      setVoiceNotice('No microphone API is available in this runtime — typing still works.')
      setLiveVoice(false)
      return
    }
    console.log('[voice] start requested')
    setListening(true)
    const started = await dictationRef.current.start()
    console.log('[voice] start result', started)
    if (!started) setListening(false)
  }, [ensureMicStream, setLiveVoice])

  useEffect(() => {
    liveVoiceRef.current = liveVoice
  }, [liveVoice])

  useEffect(() => {
    startListeningRef.current = startListening
  }, [startListening])

  // Live voice survives a restart, so the session must actually resume: a button that
  // says "on" while nothing is listening is a promise the app does not keep.
  const liveSessionStartedRef = useRef(false)
  useEffect(() => {
    if (!liveVoice || liveSessionStartedRef.current) return
    liveSessionStartedRef.current = true
    ensureMicStream().catch(() => {})
    startListening()
  }, [ensureMicStream, liveVoice, startListening])

  const stopListening = useCallback(() => {
    setListening(false)
    suppressAutoResumeRef.current = true
    // Resolves when transcription finishes; onFinal sends the message.
    void dictationRef.current?.stop()
  }, [])

  /**
   * The user started talking over the answer. Cut the voice, keep the microphone.
   * Recording begins immediately on the same stream, so a follow-up needs no wake
   * word and no press.
   */
  const interrupt = useCallback(() => {
    stopBargeIn()
    speechAbortRef.current?.abort()
    speechAbortRef.current = null
    stopCloudSpeech()
    speaker.stop()
    setSpeakingMessageId(null)
    setVoiceNotice('Heard you — listening.')
    window.setTimeout(() => startListeningRef.current?.(), 40)
  }, [speaker, stopBargeIn])

  useEffect(() => {
    interruptRef.current = interrupt
  }, [interrupt])

  const stopSpeaking = useCallback(() => {
    speechAbortRef.current?.abort()
    speechAbortRef.current = null
    stopCloudSpeech()
    stopBargeIn()
    speaker.stop()
    setSpeakingMessageId(null)
    setVoiceNotice('')
  }, [speaker, stopBargeIn])

  /** A direct tap is the reliable mobile path: it opens the speech session and
   * plays this reply even when automatic speech was blocked. */
  const playMessage = useCallback((message, messageId) => {
    if (!message?.content?.trim()) return
    if (speakingMessageId === messageId) {
      stopSpeaking()
      return
    }
    void (async () => {
      await unlockSpeech()
      await speakReply(message.content, messageId, { force: true })
    })()
  }, [speakingMessageId, stopSpeaking, unlockSpeech, speakReply])

  // Hands-free conversation: listen, answer, speak, listen again. Switching it off
  // stops both halves, so the microphone is never left open by accident.
  const toggleLive = useCallback(() => {
    if (liveVoice) {
      setLiveVoice(false)
      stopListening()
      stopSpeaking()
      stopBargeIn()
      // The session is over: release the microphone so its indicator goes out.
      closeMicStream()
      return
    }
    void unlockSpeech()
    setSpeakReplies(true)
    setLiveVoice(true)
    // Open the microphone once, up front, and keep it for the whole session.
    // Dictation reports the failure; this call only shortens the wait.
    ensureMicStream().catch(() => {})
    startListening()
  }, [
    closeMicStream, ensureMicStream, liveVoice, setLiveVoice, setSpeakReplies,
    startListening, stopBargeIn, stopListening, stopSpeaking, unlockSpeech,
  ])

  useEffect(() => () => {
    speaker.stop()
    dictationRef.current?.stop()
    stopBargeIn()
    stopCloudSpeech()
    micStreamRef.current?.getTracks?.().forEach((track) => track.stop())
    micStreamRef.current = null
  }, [speaker, stopBargeIn])

  /** Resolve a pending approval request (from the dialog). */
  const decide = useCallback(({ approved, remember }) => {
    approvalResolver.current?.({ approved, remember })
    approvalResolver.current = null
    setApproval(null)
  }, [])

  /** Stop button: abort the run AND unblock any pending approval wait. */
  const stop = useCallback(() => {
    abortRef.current?.abort()
    stopChatResponses()
    imageAbortRef.current?.abort()
    javelinRef.current?.stop()
    if (approvalResolver.current) {
      approvalResolver.current({ approved: false })
      approvalResolver.current = null
      setApproval(null)
    }
    // A stop must leave the app usable even if the run never settles: the composer is
    // editable and a new task can be sent right away.
    setIsStreaming(false)
    setPhase(null)
    setStatusText('')
    textareaRef.current?.focus()
  }, [stopChatResponses])

  /** Revert the workspace to a checkpoint. */
  const restoreCheckpoint = useCallback((id) => {
    try {
      const changed = workspaceRef.current.restore(id)
      setWorkspaceFiles(workspaceRef.current.toJSON())
      setWorkspaceDirectories(workspaceRef.current.directoryPaths())
      void syncDesktopChanges(changed).catch((err) => setError(err.message || String(err)))
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: `↩️ Restored checkpoint — reverted ${changed.length} file(s).`, ts: Date.now() },
      ])
      setDirty(false)
    } catch (err) {
      setError(describeError(err))
    }
  }, [setMessages, setWorkspaceFiles, syncDesktopChanges])

  /**
   * Undo everything the last run changed, back to the automatic pre-run checkpoint.
   * Always available after a run that touched files, so a bad run is never final.
   */
  const revertAll = useCallback(async () => {
    if (!runBaseline) return
    try {
      const changed = workspaceRef.current.restore(runBaseline)
      setWorkspaceFiles(workspaceRef.current.toJSON())
      setWorkspaceDirectories(workspaceRef.current.directoryPaths())
      await syncDesktopChanges(changed)
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: `↩️ Reverted this run — ${changed.length} file(s) restored.`, ts: Date.now() },
      ])
      setPendingDecision(null)
      setRunBaseline(null)
      setDirty(false)
    } catch (err) {
      setError(describeError(err))
    }
  }, [runBaseline, setMessages, setWorkspaceFiles, syncDesktopChanges])

  /** Keep the last run's changes and retire the revert offer. */
  const acceptAll = useCallback(() => {
    setPendingDecision(null)
    setRunBaseline(null)
    setMessages((prev) => [
      ...prev,
      { role: 'system', content: desktopApi ? 'Changes kept in the project. Use a checkpoint to undo later.' : '✓ Changes kept. Export them to disk, or use a checkpoint to undo later.', ts: Date.now() },
    ])
  }, [desktopApi, setMessages])

  /**
   * Undo the last message you sent: drop it and everything after it, and restore the
   * files to before it ran. The message text goes back in the box so it can be edited
   * and resent rather than retyped.
   */
  const revertToLastMessage = useCallback(() => {
    let lastUser = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUser = i
        break
      }
    }
    if (lastUser === -1) return

    const text = messages[lastUser].content
    // The checkpoint taken just before this message, if the run made one.
    const mark = messageMarks.current[messageMarks.current.length - 1]
    if (mark?.checkpointId) {
      try {
        const changed = workspaceRef.current.restore(mark.checkpointId)
        setWorkspaceFiles(workspaceRef.current.toJSON())
        setWorkspaceDirectories(workspaceRef.current.directoryPaths())
        void syncDesktopChanges(changed).catch((err) => setError(err.message || String(err)))
      } catch (err) {
        setError(describeError(err))
      }
    }
    setMessages((prev) => prev.slice(0, lastUser))
    messageMarks.current = messageMarks.current.filter((m) => m.index < lastUser)
    setPendingDecision(null)
    setRunBaseline(null)
    // Put the text back in the box so it can be edited and resent, not retyped.
    setInput(text)
  }, [messages, setError, setMessages, setWorkspaceFiles, syncDesktopChanges])

  /** Import real files into the agent's virtual workspace. */
  const importFiles = async (fileList) => {
    const next = { ...workspaceFiles }
    for (const file of Array.from(fileList)) {
      if (file.size > 200_000) continue
      next[file.webkitRelativePath || file.name] = await file.text()
    }
    setWorkspaceFiles(next)
    workspaceRef.current = new VirtualWorkspace(next)
    setMessages((prev) => [
      ...prev,
      { role: 'system', content: `📁 Imported ${fileList.length} file(s) into the agent workspace.`, ts: Date.now() },
    ])
  }

  /** Download the (possibly agent-modified) workspace. */
  const exportWorkspace = () => {
    const data = JSON.stringify(workspaceRef.current.toJSON(), null, 2)
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'javelin-workspace.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const clear = startNewChat

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const currentModel = useMemo(() => {
    return provider.models.find((m) => m.id === model)?.label ?? model
  }, [model, provider])

  const assistantPanelWidth = Math.min(560, Math.max(320, Number(assistantWidth) || 410))

  const startAssistantResize = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = assistantPanelWidth
    const onMove = (moveEvent) => {
      setAssistantWidth(Math.min(560, Math.max(320, startWidth - (moveEvent.clientX - startX))))
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('is-resizing')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    document.body.classList.add('is-resizing')
  }

  const hasMessages = messages.length > 0
  const pendingImages = attachments.some((attachment) => attachment.kind === 'image')
  const availableExamples = mobileChatOnly ? EXAMPLES.filter((example) => example.mode === 'chat') : EXAMPLES
  const heroExamples = mobileChatOnly && imageMode ? IMAGE_EXAMPLES : availableExamples
  const examplePreviewCount = mobileChatOnly ? 4 : 6
  const fileCount = Object.keys(workspaceFiles).length
  const accountBadge = isOwner
    ? 'Owner'
    : account
      ? account.username
      : `Guest ${guestRemaining}/${GUEST_DAILY_LIMIT}`
  const accountBadgeClass = isOwner
    ? 'is-owner'
    : account
      ? 'is-account'
      : guestRemaining === 0 ? 'is-empty' : ''
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)
  const activeConversationTitle = activeConversation?.title || conversationTitle(messages)
  const historySyncLabel = !account
    ? 'Saved on this device'
    : historySync.state === 'syncing'
      ? 'Syncing chats…'
      : historySync.state === 'synced'
        ? 'Chats synced'
        : historySync.state === 'error' || historySync.state === 'signed-out'
          ? 'Sync paused'
          : 'Cloud sync ready'
  const historySyncTitle = !account
    ? 'Sign in to sync chats across devices'
    : historySync.state === 'error'
      ? historySync.error
      : historySync.at
        ? `Last synced ${new Date(historySync.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : 'Sync this account\'s chats across devices'

  const showDesktopCode = Boolean(desktopApi && desktopView === 'code')
  const desktopRootClass = showDesktopCode
    ? `javelin-desktop-layout is-code-view${assistantCollapsed ? ' is-assistant-collapsed' : ''}`
    : 'javelin-desktop-layout is-chat-view'

  return (
    <div
      className={desktopApi
        ? desktopRootClass
        : `javelin-browser-layout${mobileChatOnly ? ' is-mobile-chat' : ''}`}
      style={desktopApi ? { '--assistant-width': `${assistantPanelWidth}px` } : undefined}
    >
      <ChatSidebar
        desktopApi={Boolean(desktopApi)}
        codeView={showDesktopCode}
        project={desktopProject}
        onShowChat={() => setDesktopView('chat')}
        onShowCode={() => setDesktopView('code')}
        onNewChat={clear}
        canNewChat={!isBusy}
        conversations={conversations}
        activeConversationId={activeConversationId}
        activeConversationTitle={activeConversationTitle}
        onSelectChat={switchConversation}
        onDeleteChat={deleteConversation}
        onRenameChat={renameConversation}
        canSwitchChat={!isBusy}
        isSignedIn={Boolean(accountSession?.token)}
        syncLabel={historySyncLabel}
        syncTitle={historySyncTitle}
        syncState={historySync.state}
        onSyncChats={() => void performHistorySync()}
        onOpenProject={() => void openDesktopProject()}
        onSettings={() => setSettingsOpen(true)}
        onSupport={() => setSupportOpen(true)}
        onAccount={() => requestAccount(account ? 'account' : 'default')}
        accountName={account?.username ?? (isOwner ? 'Owner' : 'Guest')}
        accountBadge={accountBadge}
        accountTitle={isOwner
          ? `Owner ${account?.username ?? OWNER_USERNAME} · open diagnostics`
          : account
            ? `${account.username} · ${formatTokenCount(accountRemaining)} tokens left`
            : `Guest mode · ${guestRemaining} of ${GUEST_DAILY_LIMIT} AI requests left today`}
      />
      {desktopApi && showDesktopCode && (
        <ProjectWorkbench
          project={desktopProject}
          projectFiles={desktopProject?.files ?? []}
          projectDirectories={desktopProject?.directories ?? []}
          contents={workspaceFiles}
          onOpenProject={openDesktopProject}
          onCreateWorkspace={createDesktopWorkspace}
          onSaveFile={saveDesktopFile}
          onRenameFile={renameDesktopFile}
          onDeleteFile={deleteDesktopFile}
          onCreateFolder={createDesktopFolder}
          onRunCommand={runDesktopCommand}
          commandOutput={commandOutput}
          model={model}
          runtimeStatus={runtimeStatus}
          runtimeBusy={runtimeBusy}
          runtimeError={runtimeError}
          onStartOllama={startLocalRuntime}
          onRefreshRuntime={() => void refreshRuntimeStatus()}
        />
      )}
      {desktopApi && showDesktopCode && !assistantCollapsed && (
        <div
          className="panel-resizer assistant-resizer"
          role="separator"
          aria-label="Resize Javelin assistant"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={560}
          aria-valuenow={assistantPanelWidth}
          tabIndex={0}
          title="Drag to resize the assistant · double-click to reset"
          onPointerDown={startAssistantResize}
          onDoubleClick={() => setAssistantWidth(410)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              setAssistantWidth(Math.min(560, assistantPanelWidth + 16))
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              setAssistantWidth(Math.max(320, assistantPanelWidth - 16))
            } else if (event.key === 'Home') {
              event.preventDefault()
              setAssistantWidth(410)
            }
          }}
        />
      )}
      {desktopApi && showDesktopCode && assistantCollapsed && (
        <button
          className="assistant-restore"
          type="button"
          aria-label="Show assistant"
          title="Show assistant (Ctrl+Shift+A)"
          onClick={() => {
            setAssistantCollapsed(false)
            requestAnimationFrame(() => textareaRef.current?.focus())
          }}
        >
          <Sparkles size={16} />
          <span>Assistant</span>
        </button>
      )}
      <div className={desktopApi ? 'javelin-assistant-column' : 'javelin-browser-shell'}>
      <div className={`flex ${desktopApi ? 'h-full min-h-0' : 'h-screen'} flex-col app-shell bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800`}>
      {/* Header */}
      <header className="app-header border-b">
        <div className="container mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <div className="javelin-chat-context">
            <span className="javelin-chat-context-title">
              {mode === 'chat' ? 'Chat' : mode === 'agent' ? 'Agent' : 'Javelin'}
            </span>
            <button
              type="button"
              className="javelin-chat-model"
              onClick={() => setSettingsOpen(true)}
              title={`${provider.label} · ${currentModel} — change model`}
            >
              {currentModel}
              <span className="javelin-chat-model-caret" aria-hidden="true">⌄</span>
            </button>
          </div>
          <div className="brand-lockup">
            <span className="brand-emblem"><Sparkles size={14} /></span>
            <div className="brand-copy">
              <h1 className="bg-gradient-to-r from-primary to-blue-600 bg-clip-text text-xl font-bold text-transparent">
                {mobileChatOnly ? 'Javelin' : 'Javelin AI'}
              </h1>
              {mobileChatOnly ? (
                <button
                  type="button"
                  className="brand-tagline brand-model-button"
                  onClick={() => setSettingsOpen(true)}
                  title={`${provider.label} · ${currentModel} — change model`}
                  aria-label="Change model"
                >
                  {currentModel}
                </button>
              ) : (
                <span className="brand-tagline">LOCAL-FIRST CODING INTELLIGENCE</span>
              )}
            </div>
            <span className="glass-chip ml-2 hidden px-2 py-0.5 text-xs text-muted-foreground sm:inline">
              {provider.label} · {currentModel}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`owner-chip ${accountBadgeClass}`}
              onClick={() => (isOwner ? setDebugOpen(true) : requestAccount(account ? 'account' : 'default'))}
              title={isOwner
                ? `Owner ${account?.username ?? OWNER_USERNAME} · unlimited AI · open diagnostics`
                : account
                  ? `${account.username} · ${formatTokenCount(accountRemaining)} of ${formatTokenCount(MEMBER_TOKEN_LIMIT)} tokens left · account`
                  : `Guest mode · ${guestRemaining} of ${GUEST_DAILY_LIMIT} AI requests left today · sign in or create an account`}
            >
              {isOwner ? <ShieldCheck size={13} /> : account ? <User size={12} /> : <Lock size={12} />}
              <span>{accountBadge}</span>
            </button>
            {account && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => requestAccount('account')}
                aria-label="Account settings"
                title="Account settings"
              >
                <User className="h-4 w-4" />
              </Button>
            )}
            {isAdmin && (
              <Button
                variant="ghost"
                size="icon"
                className="mobile-desktop-only"
                onClick={requestAdmin}
                aria-label="Moderation console"
                title="Moderation console"
              >
                <ShieldCheck className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="mobile-desktop-only"
              onClick={requestDebug}
              aria-label="Debug console"
              title="Debug console (owner)"
            >
              <Bug className="h-4 w-4" />
            </Button>
            {dirty && (
              <Button variant="outline" size="sm" onClick={exportWorkspace} className="mobile-desktop-only h-8 text-xs">
                Export changes
              </Button>
            )}
            {mobileChatOnly && (
              <Button
                variant="ghost"
                size="icon"
                className="mobile-history-button"
                onClick={() => setHistoryOpen(true)}
                aria-label="Chat history"
                title="Chat history"
              >
                <History className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle theme"
              title="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={clear}
              disabled={!hasMessages || isBusy}
              aria-label={mobileChatOnly ? 'New chat' : 'Clear conversation'}
              title={mobileChatOnly ? 'New chat' : 'Clear conversation'}
            >
              {mobileChatOnly ? <SquarePen className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="mobile-desktop-only assistant-toggle"
              onClick={() => setAssistantCollapsed(true)}
              aria-label="Hide assistant"
              title="Hide assistant (Ctrl+Shift+A)"
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSupportOpen(true)}
              aria-label="Support"
              title="Email Javelin support"
            >
              <LifeBuoy className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings (Ctrl+,)"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Mode switch: Chat (simple) vs Agent (autonomous loop) */}
        {!mobileChatOnly && (
        <div className="container relative mx-auto flex max-w-4xl items-center gap-1 px-4 pb-2">
          <div className="mode-menu">
            <ModeTab active={mode === 'chat'} onClick={() => setMode('chat')} icon={MessageSquare} label="Chat" disabled={isBusy} />
            <ModeTab active={mode === 'agent'} onClick={() => setMode('agent')} icon={Bot} label="Agent" disabled={isBusy} />
            <ModeTab active={mode === 'javelin'} onClick={() => setMode('javelin')} icon={Brain} label="Javelin" disabled={isBusy} />

            {/* Autonomy: how much Javelin may do without stopping to ask. */}
            {mode !== 'chat' && (
              <label className="autonomy-menu flex items-center gap-1.5 text-xs text-muted-foreground">
                <Zap className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Autonomy</span>
                <select
                  value={autonomy}
                  onChange={(e) => setAutonomy(e.target.value)}
                  disabled={isBusy}
                  title="How much Javelin may do without stopping to ask"
                  className="glass-field rounded-lg border px-1.5 py-1 text-xs"
                >
                  <option value="ask">Ask every time</option>
                  <option value="auto-edit">Auto-edit (do it all)</option>
                  <option value="full">Full auto</option>
                </select>
              </label>
            )}
          </div>

          <span className="workspace-file-count text-xs text-muted-foreground">{fileCount} file(s) in workspace</span>
        </div>
        )}
      </header>

      {/* Conversation */}
      <main className="flex-1 overflow-y-auto">
        <div className="container mx-auto max-w-4xl space-y-4 px-4 py-6">
          {provider.requiresKey && !apiKey && !imageMode && (
            <div className="glass-banner flex items-start gap-3 rounded-xl border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">This provider needs an API key.</p>
                <p className="mt-1">
                  Switch to the keyless <strong>Local</strong> provider, or add a key in{' '}
                  <button className="underline underline-offset-2" onClick={() => setSettingsOpen(true)}>
                    Settings
                  </button>
                  .
                </p>
              </div>
            </div>
          )}

          {!hasMessages && (
            <div className="chat-hero">
              <span className="chat-hero-orb"><Bot size={23} /></span>
              <span className="chat-hero-kicker">{mobileChatOnly ? 'JAVELIN CHAT' : 'JAVELIN AI'}</span>
              <h2 className="chat-hero-title">{mobileChatOnly
                ? imageMode
                  ? 'What should we create?'
                  : 'What can I help you with?'
                : mode === 'chat'
                ? 'What can I help with?'
                : mode === 'agent'
                  ? 'What are we building?'
                  : 'What should Javelin tackle?'}</h2>
              <p className="chat-hero-copy">
                {mobileChatOnly
                  ? imageMode
                    ? 'Describe an original scene. I’ll generate an image and save it to your conversation.'
                    : 'Ask anything — questions, ideas, explanations, or a little help thinking it through.'
                  : mode === 'chat'
                  ? 'Ask anything. Switch to Code when you want to inspect or edit project files.'
                  : mode === 'agent'
                    ? 'It inspects the workspace, plans, edits with reviewable diffs, and reports what it verified.'
                    : 'Javelin runs its own reasoning loop: understand, plan, act, verify, and repair its own mistakes. It remembers what failed.'}
              </p>
              {!mobileChatOnly && <div className="chat-hero-capabilities">
                <span><Zap size={12} /> Agentic edits</span>
                <span><CheckCircle2 size={12} /> Evidence-based verification</span>
                <span><Brain size={12} /> Local reasoning memory</span>
              </div>}
              <div className="example-grid">
                {heroExamples.slice(0, showAllExamples ? heroExamples.length : examplePreviewCount).map((ex) => (
                  <button
                    key={ex.text}
                    className="example-card"
                    type="button"
                    onClick={() => send(ex.text, ex.mode)}
                  >
                    <span>{ex.text}</span>
                    <small>{ex.mode === 'image' ? 'Image' : ex.mode === 'chat' ? 'Ask' : ex.mode === 'agent' ? 'Agent' : 'Javelin'}</small>
                  </button>
                ))}
              </div>
              {heroExamples.length > examplePreviewCount && (
                <button className="example-more" type="button" onClick={() => setShowAllExamples((open) => !open)}>
                  {showAllExamples ? 'Show fewer ideas' : `More ideas (${heroExamples.length - examplePreviewCount})`}
                </button>
              )}

              {!mobileChatOnly && (mode === 'agent' || mode === 'javelin') && (
                <div className="glass-card mx-auto mt-6 max-w-md rounded-2xl p-4 text-left text-xs">
                  <p className="font-medium">The agent needs files to work on.</p>
                  <p className="mt-1 text-muted-foreground">
                    {desktopApi
                      ? 'Open a project folder in the Explorer. Javelin will work with those real files and keep edits behind the approval flow.'
                      : 'A browser page cannot read your disk directly, so import the files you want Javelin to edit and export the changes when you are ready.'}
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    Autonomy is <strong>{autonomy === 'ask' ? 'Ask every time' : autonomy === 'auto-edit' ? 'Auto-edit' : 'Full auto'}</strong>
                    {autonomy === 'ask'
                      ? ' — it will pause for you to approve each change.'
                      : ' — it will do the whole task end to end without stopping.'}
                  </p>
                  {desktopApi ? (
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => void openDesktopProject()}>
                      <FolderOpen className="mr-2 h-3.5 w-3.5" />
                      Open project folder
                    </Button>
                  ) : (
                    <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 hover:bg-accent">
                      <FolderOpen className="h-3.5 w-3.5" />
                      Import files
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => e.target.files?.length && importFiles(e.target.files)}
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          )}

          {!mobileChatOnly && checkpoints.length > 0 && (
            <CheckpointBar checkpoints={checkpoints} onRestore={restoreCheckpoint} />
          )}

          {!mobileChatOnly && pendingDecision && (
            <RunControls
              fileCount={pendingDecision.fileCount}
              status={pendingDecision.status}
              code={pendingDecision.code}
              summary={runResult?.summary}
              onAccept={acceptAll}
              onRevert={revertAll}
              onRevertMessage={revertToLastMessage}
            />
          )}

          {/* Always offer message-undo after a run, even if nothing changed. */}
          {!mobileChatOnly && !pendingDecision && runResult && (
            <RunControls
              fileCount={0}
              status={runResult.status}
              summary={runResult.summary}
              code={runResult.code}
              onAccept={acceptAll}
              onRevert={revertAll}
              onRevertMessage={revertToLastMessage}
            />
          )}

          {!mobileChatOnly && isStreaming && mode === 'agent' && <AgentPhase phase={phase} status={statusText} />}

          {/* Javelin Core: its own reasoning lifecycle, memory and self-correction */}
          {!mobileChatOnly && mode === 'javelin' && (
            <>
              {(javelin.busy || javelin.phase) && <PhaseRail phase={javelin.phase} busy={javelin.busy} />}
              <JavelinDiagnostics
                diagnostics={javelin.diagnostics}
                learnings={javelin.learnings}
                onRefresh={javelin.refreshDiagnostics}
              />
              <PlanCard plan={javelin.plan} />
              <TaskList steps={javelin.planSteps} />
              <HypothesisList hypotheses={javelin.hypotheses} />
              {javelin.busy && (
                <div className="glass-card rounded-2xl px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
                  <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-primary align-middle" />
                  {javelin.status || 'Working through the current step…'}
                </div>
              )}
            </>
          )}

          {messages.map((m, i) => (
            <Message
              key={m.id ?? m.ts ?? i}
              message={m}
              isStreaming={isStreaming && i === messages.length - 1 && m.role === 'assistant'}
              isSpeaking={speakingMessageId === (m.id ?? i)}
              onPlay={m.role === 'assistant' && m.content && !m.image
                ? () => playMessage(m, m.id ?? i)
                : undefined}
            />
          ))}

          {!mobileChatOnly && steps.length > 0 && <AgentTimeline steps={steps} />}

          {!mobileChatOnly && mode === 'javelin' && javelin.steps.length > 0 && <JavelinSteps steps={javelin.steps} />}

          {!mobileChatOnly && mode === 'javelin' && javelin.result && <JavelinResult result={javelin.result} />}

          {!mobileChatOnly && mode === 'javelin' && javelin.error && (
            <div role="alert" className="glass-banner flex items-start gap-3 rounded-2xl border-destructive/40 bg-destructive/10 p-4 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="flex-1">
                <p className="font-medium">Javelin error</p>
                <p className="mt-1 break-words text-muted-foreground">{javelin.error}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => javelin.setError(null)}>Dismiss</Button>
            </div>
          )}

          {!mobileChatOnly && runResult && (
            <div
              className={`glass-banner flex items-start gap-2 rounded-2xl border p-3 text-xs ${
                runResult.status === 'done'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100'
                  : runResult.status === 'aborted'
                    ? 'bg-muted'
                    : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100'
              }`}
            >
              {runResult.status === 'done' ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <div>
                <p className="font-medium">
                  {runResult.status === 'done'
                    ? 'Run complete'
                    : runResult.status === 'aborted'
                      ? 'Run stopped'
                      : 'Run failed'}
                </p>
                <p className="mt-0.5 opacity-80">
                  {runResult.steps?.length ?? 0} step(s) · {checkpoints.length} checkpoint(s)
                </p>
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="glass-banner flex items-start gap-3 rounded-2xl border-destructive/40 bg-destructive/10 p-4 text-sm"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="flex-1">
                <p className="font-medium">Request failed</p>
                <p className="mt-1 break-words text-muted-foreground">{error}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setError(null)}>
                Dismiss
              </Button>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </main>

      {/* Composer */}
      <footer className="app-footer border-t">
        <div className="container mx-auto max-w-4xl px-4 py-3">
          {attachments.length > 0 && (
            <div className="composer-attachments" aria-label="Attachments">
              {attachments.map((attachment) => (
                attachment.kind === 'image' ? (
                  <div className="composer-attachment" key={attachment.id}>
                    <img src={attachment.dataUrl} alt={attachment.name} title={attachment.name} />
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                      title={`Remove ${attachment.name}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className="composer-file" key={attachment.id} title={attachment.name}>
                    <FileText size={14} />
                    <span>{attachment.name}</span>
                    <small>{formatAttachmentSize(attachment.size)}</small>
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                      title={`Remove ${attachment.name}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              ))}
            </div>
          )}
          {attachments.length > 0 && !imageMode && (
            <>
              <p className="attachment-rights-note">Only attach files and images you have the right to use.</p>
              {pendingImages && provider.vision === false && (
                <p className="attachment-rights-note">
                  Javelin reads attached images with local text recognition and a free caption service.
                </p>
              )}
            </>
          )}
          {imageError && (
            <div className="attachment-notice is-warning" role="status">
              <span>{imageError}</span>
            </div>
          )}
          {!imageMode && imageReadStage && (
            <div className="attachment-notice" role="status">
              <span>{imageReadStage}</span>
            </div>
          )}
          {!imageMode && attachmentError && (
            <div className="attachment-notice" role="status">
              <span>{attachmentError}</span>
            </div>
          )}
          {imageMode && (
            <p className="image-mode-note">
              Original images only. Prompts are screened for known characters, brands, artists and real people.
            </p>
          )}
          <div className="composer-row flex items-end gap-2">
            {mobileChatOnly && !imageMode && (
              <>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept="image/*,text/*,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.rb,.php,.go,.rs,.java,.kt,.swift,.c,.h,.cc,.cpp,.hpp,.cs,.sql,.html,.htm,.css,.scss,.sass,.less,.xml,.svg,.yaml,.yml,.toml,.ini,.conf,.sh,.bash,.zsh,.ps1,.bat,.env"
                  onChange={handleAttachmentFiles}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="composer-attach"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={attachmentBusy || attachments.length >= MAX_ATTACHMENTS}
                  aria-label="Add image or file"
                  title="Add image or file"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </>
            )}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                if (imageError) setImageError('')
              }}
              onKeyDown={onKeyDown}
              placeholder={
                activeChats >= MAX_CONCURRENT_RESPONSES
                  ? `${MAX_CONCURRENT_RESPONSES} replies are already running — wait for one to finish`
                  : imageMode
                    ? 'Describe an original image'
                  : mobileChatOnly
                    ? (attachments.length > 0 ? 'Add a message' : 'Ask anything')
                  : mode === 'chat'
                    ? 'Ask anything... (Enter to send, Shift+Enter for newline)'
                  : mode === 'agent'
                    ? 'Describe the task — the agent will inspect, plan, edit and verify…'
                    : 'Describe the task — Javelin will plan, act, verify and repair its own mistakes…'
              }
              rows={mobileChatOnly ? 1 : 2}
              className="composer-field max-h-48 min-h-[56px] resize-y"
              aria-label="Message"
            />
            {(voiceCaps.speak || voiceCaps.listen) && (
              <div className="composer-voice flex shrink-0 flex-col gap-1">
                {voiceCaps.listen && (
                  <Button
                    variant={listening ? 'default' : 'outline'}
                    size="icon"
                    className="h-7 w-9"
                    onClick={() => {
                      if (listening) stopListening()
                      // Pressing the mic while Javelin talks is an interruption, not a
                      // second recording: stop the voice, then listen.
                      else if (speechAbortRef.current) interrupt()
                      else startListening()
                    }}
                    title={listening ? 'Stop listening' : 'Talk instead of typing'}
                    aria-label={listening ? 'Stop listening' : 'Start voice input'}
                  >
                    {listening ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  </Button>
                )}
                {voiceCaps.speak && (
                  <Button
                    variant={speakReplies ? 'default' : 'outline'}
                    size="icon"
                    className="h-7 w-9"
                    onClick={() => {
                      if (speakReplies) stopSpeaking()
                      else void unlockSpeech()
                      setSpeakReplies((value) => !value)
                    }}
                    title={speakReplies ? 'Stop reading replies aloud' : 'Read replies aloud'}
                    aria-label={speakReplies ? 'Disable spoken replies' : 'Enable spoken replies'}
                  >
                    {speakReplies ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
            )}
            <Button
              onClick={() => send()}
              disabled={(!input.trim() && attachments.length === 0) || attachmentBusy || imageBusy || isStreaming || javelin.busy || activeChats >= MAX_CONCURRENT_RESPONSES}
              className="composer-send h-10 shrink-0"
            >
              {imageMode ? <ImagePlus className="mr-2 h-4 w-4" /> : mobileChatOnly || mode === 'chat' ? <Send className="mr-2 h-4 w-4" /> : mode === 'agent' ? <Zap className="mr-2 h-4 w-4" /> : <Brain className="mr-2 h-4 w-4" />}
              <span className="composer-send-label">
                {imageMode ? 'Create' : mobileChatOnly || mode === 'chat' ? 'Send' : mode === 'agent' ? 'Run' : 'Think'}
              </span>
            </Button>
            {isBusy && (
              <Button
                variant="outline"
                size="icon"
                onClick={stop}
                className="composer-stop h-10 w-10 shrink-0"
                title="Stop all responses"
                aria-label="Stop all responses"
              >
                <Square className="h-4 w-4" />
              </Button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            {mobileChatOnly && (
              <Button
                variant={imageMode ? 'default' : 'ghost'}
                size="sm"
                className={`image-mode-chip h-6 px-2 text-[11px]${imageMode ? ' is-on' : ''}`}
                onClick={toggleImageMode}
                disabled={imageBusy}
                title={attachments.length > 0 ? 'Remove attachments to create an image' : 'Create an original image from a description'}
              >
                <ImagePlus className="h-3 w-3" />
                {imageMode ? 'Image mode on' : 'Create image'}
              </Button>
            )}
            {voiceCaps.speak && (
              <Button
                variant={liveVoice ? 'default' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={toggleLive}
                title="Hands-free: listen, answer out loud, listen again"
              >
                {liveVoice ? 'Live voice on' : 'Live voice'}
              </Button>
            )}
            {!voiceCaps.listen && (
              <span className="text-[11px] text-muted-foreground">
                Microphone input is not available in this build — spoken replies still work.
              </span>
            )}
            {voiceNotice && <span className="text-[11px] text-amber-600">{voiceNotice}</span>}
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {mobileChatOnly
              ? imageMode
                ? 'AI images: screened prompts only. Results can still resemble existing work; do not use them as a logo or trademark.'
                : 'Javelin can make mistakes. Check important info.'
              : mode === 'chat'
              ? 'Responses are generated by an LLM and may be wrong. Verify before shipping.'
              : mode === 'agent'
                ? 'The agent asks before every file change. You can stop it at any time.'
                : 'Javelin asks before every change, verifies its work, and never repeats a failed step twice.'}
          </p>
          {activeChats > 0 && (
            <p className="mt-1 text-center text-[11px] text-muted-foreground">
              {activeChats} {activeChats === 1 ? 'reply' : 'replies'} running
            </p>
          )}
          {!isOwner && (
            <p className="mt-1 text-center text-[11px] text-muted-foreground">
              {account
                ? `${isOnlineStaff ? 'Staff' : 'Member'} ${account.username} · ${formatTokenCount(accountRemaining)} of ${formatTokenCount(MEMBER_TOKEN_LIMIT)} tokens left`
                : `Guest mode · ${guestRemaining} of ${GUEST_DAILY_LIMIT} AI requests left today`}
              {' · '}
              <button className="underline underline-offset-2" onClick={() => requestAccount(account ? 'account' : 'default')}>
                {account ? 'account' : 'sign in or sign up'}
              </button>
            </p>
          )}
        </div>
      </footer>

      <AccountDialog
        open={accountOpen}
        session={accountSession}
        reason={accountReason}
        onClose={() => setAccountOpen(false)}
        onAuthenticated={handleAccountAuthenticated}
        onSignOut={handleAccountSignOut}
        onRefreshAccount={refreshAccount}
        onBanned={handleAccountBanned}
        onAccountLocked={handleAccountLocked}
        onOpenAdmin={() => {
          setAccountOpen(false)
          requestAdmin()
        }}
        onOpenOwnerLogin={() => {
          setAccountOpen(false)
          requestOwnerLogin('unlimited')
        }}
        onOpenDebug={() => {
          setAccountOpen(false)
          setDebugOpen(true)
        }}
      />

      <OwnerLogin
        open={loginOpen}
        credential={ownerCredential}
        reason={loginReason}
        onClose={() => setLoginOpen(false)}
        onAuthenticated={handleOwnerAuthenticated}
        onCreateCredential={handleOwnerCreated}
      />

      <DebugScreen
        open={debugOpen}
        providerLabel={provider.label}
        model={model}
        baseUrl={baseUrl}
        runtimeStatus={runtimeStatus}
        runtimeError={runtimeError}
        needsLocalRuntime={needsLocalRuntime}
        workspaceFiles={workspaceFiles}
        workspaceDirectories={workspaceDirectories}
        messages={messages}
        theme={theme}
        guestUsed={guestUsed}
        error={error}
        runResult={runResult}
        voiceNotice={voiceNotice}
        onClose={() => setDebugOpen(false)}
        onLock={lockOwner}
        onRefreshRuntime={() => void refreshRuntimeStatus()}
        onReload={() => window.location.reload()}
      />

      {/* Only a live run can be asking for approval; a leftover request must never
          leave a full-screen modal over an idle app. */}
      <ApprovalDialog
        request={isBusy ? (approval ?? javelin.approval) : null}
        onDecide={approval ? decide : javelin.decideApproval}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        isMobile={mobileChatOnly}
        providerId={providerId}
        apiKey={apiKey}
        baseUrl={baseUrl}
        model={model}
        ttsProvider={ttsProvider}
        ttsKey={ttsKey}
        ttsVoice={ttsVoice}
        onSave={({ providerId: p, apiKey: k, baseUrl: b, model: m, voice }) => {
          setProviderId(p)
          setApiKey(k)
          setProviderEndpoints((previous) => ({ ...previous, [p]: b }))
          setModel(m)
          if (voice) {
            setTtsProvider(voice.ttsProvider)
            setTtsKey(voice.ttsKey)
            setTtsVoice(voice.ttsVoice)
          }
        }}
        providerEndpoints={providerEndpoints}
      />
      <SupportDialog
        open={supportOpen}
        onClose={() => setSupportOpen(false)}
        mode={mobileChatOnly ? 'chat' : mode}
        providerLabel={provider.label}
        account={account}
      />
      </div>
      </div>
      {mobileChatOnly && historyOpen && (
        <div className="javelin-history-backdrop" onClick={() => setHistoryOpen(false)}>
          <aside
            className="javelin-history-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="javelin-history-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="javelin-history-head">
              <strong id="javelin-history-title">Chats</strong>
              <button
                type="button"
                className="javelin-history-close"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close chat history"
                title="Close"
              >
                <X size={17} />
              </button>
            </div>
            <button
              type="button"
              className="javelin-gpt-new"
              onClick={() => {
                clear()
                setHistoryOpen(false)
              }}
              disabled={isBusy}
              title="New chat"
            >
              <SquarePen size={17} />
              <span>New chat</span>
            </button>
            <div className="javelin-history-scroll">
              <ConversationHistory
                conversations={conversations}
                activeConversationId={activeConversationId}
                activeConversationTitle={activeConversationTitle}
                onSelectChat={(id) => {
                  switchConversation(id)
                  setHistoryOpen(false)
                }}
                onDeleteChat={deleteConversation}
                onRenameChat={renameConversation}
                disabled={isBusy}
                showEmpty
              />
            </div>
            <div className="javelin-history-note">
              <span>{historySyncLabel}</span>
              {accountSession?.token && (
                <button
                  type="button"
                  onClick={() => void performHistorySync()}
                  disabled={historySync.state === 'syncing'}
                  title={historySyncTitle}
                >
                  <RefreshCw size={12} />
                  Sync now
                </button>
              )}
            </div>
          </aside>
        </div>
      )}
      <AdminScreen open={adminOpen} session={accountSession} onClose={() => setAdminOpen(false)} />
      <BanScreen
        ban={banNotice}
        onClose={() => setBanNotice(null)}
        onContactSupport={() => {
          setBanNotice(null)
          setAssistantCollapsed(false)
          setSupportOpen(true)
        }}
      />
    </div>
  )
}

/** Chat / Agent switch. */
function ModeTab({ active, onClick, icon: Icon, label, disabled = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`mode-tab inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium ${
        active
          ? 'mode-tab is-active'
          : 'mode-tab text-muted-foreground'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

function GeneratedImage({ image }) {
  if (!image?.dataUrl) return null
  return (
    <figure className="generated-image">
      <a href={image.dataUrl} target="_blank" rel="noreferrer" title={image.prompt}>
        <img src={image.dataUrl} alt={image.prompt || 'AI-generated image'} />
      </a>
      <figcaption className="generated-caption">
        <span>
          <ShieldCheck size={13} /> AI-generated · screened prompt
        </span>
        <a
          className="generated-download"
          href={image.dataUrl}
          download={`javelin-ai-${image.seed || Date.now()}.${image.mime === 'image/png' ? 'png' : 'jpg'}`}
        >
          <Download size={13} /> Save
        </a>
      </figcaption>
      <p className="generated-disclaimer">
        Screened for known characters, brands, artists and real people. AI images can still resemble
        existing work — check before commercial use. Generated via Pollinations.
      </p>
    </figure>
  )
}

function ChatSidebar({
  desktopApi,
  codeView,
  project,
  onShowChat,
  onShowCode,
  onNewChat,
  canNewChat,
  conversations,
  activeConversationId,
  activeConversationTitle,
  onSelectChat,
  onDeleteChat,
  onRenameChat,
  canSwitchChat,
  isSignedIn,
  syncLabel,
  syncTitle,
  syncState,
  onSyncChats,
  onOpenProject,
  onSettings,
  onSupport,
  onAccount,
  accountName,
  accountBadge,
  accountTitle,
}) {
  return (
    <aside
      className={`javelin-gpt-sidebar${codeView ? ' is-compact' : ''}`}
      aria-label="Javelin navigation"
    >
      <div className="javelin-gpt-sidebar-head">
        <button type="button" className="javelin-gpt-brand" onClick={onShowChat} title="Javelin">
          <span className="javelin-gpt-brand-mark">J</span>
          <span className="javelin-gpt-brand-name">Javelin</span>
        </button>
      </div>

      <button
        type="button"
        className="javelin-gpt-new"
        onClick={onNewChat}
        disabled={!canNewChat}
        title="New chat"
      >
        <SquarePen size={17} />
        <span>New chat</span>
      </button>

      <nav className="javelin-gpt-nav" aria-label="Views">
        <button
          type="button"
          className={!codeView ? 'is-active' : ''}
          onClick={onShowChat}
          title="Chat"
          aria-current={!codeView ? 'page' : undefined}
        >
          <MessageSquare size={17} />
          <span>Chat</span>
        </button>
        {desktopApi && (
          <button
            type="button"
            className={codeView ? 'is-active' : ''}
            onClick={onShowCode}
            title="Code workspace"
            aria-current={codeView ? 'page' : undefined}
          >
            <Code2 size={17} />
            <span>Code workspace</span>
          </button>
        )}
      </nav>

      {!codeView && (
        <>
          <div className="javelin-gpt-history" aria-label="Chat history">
            <ConversationHistory
              conversations={conversations}
              activeConversationId={activeConversationId}
              activeConversationTitle={activeConversationTitle}
              onSelectChat={onSelectChat}
              onDeleteChat={onDeleteChat}
              onRenameChat={onRenameChat}
              disabled={!canSwitchChat}
            />
          </div>
          <div className={`javelin-gpt-sync is-${syncState || 'idle'}`}>
            <span className="javelin-gpt-sync-copy" title={syncTitle}>
              <Cloud size={13} />
              <span>{syncLabel}</span>
            </span>
            {isSignedIn && (
              <button
                type="button"
                onClick={onSyncChats}
                disabled={syncState === 'syncing'}
                title={syncTitle || 'Sync chats now'}
                aria-label="Sync chats now"
              >
                <RefreshCw size={12} />
              </button>
            )}
          </div>
        </>
      )}

      {desktopApi && (
        <div className="javelin-gpt-section">
          <span className="javelin-gpt-section-label">Workspace</span>
          <button
            type="button"
            className="javelin-gpt-workspace"
            onClick={project ? onShowCode : onOpenProject}
            title={project?.name ?? 'Open a project folder'}
          >
            <FolderOpen size={17} />
            <span>{project?.name ?? 'Open a project'}</span>
          </button>
        </div>
      )}

      <div className="javelin-gpt-sidebar-spacer" />

      <div className="javelin-gpt-footer">
        <button type="button" className="javelin-gpt-account" onClick={onAccount} title={accountTitle}>
          <span className="javelin-gpt-avatar"><User size={15} /></span>
          <span className="javelin-gpt-account-copy">
            <strong>{accountName}</strong>
            <small>{accountBadge}</small>
          </span>
        </button>
        <button type="button" onClick={onSettings} title="Settings (Ctrl+,)">
          <Settings size={17} />
          <span>Settings</span>
        </button>
        <button type="button" onClick={onSupport} title="Email Javelin support">
          <LifeBuoy size={17} />
          <span>Support</span>
        </button>
      </div>
    </aside>
  )
}

function ConversationHistory({
  conversations,
  activeConversationId,
  activeConversationTitle,
  onSelectChat,
  onDeleteChat,
  onRenameChat,
  disabled = false,
  showEmpty = false,
}) {
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const total = Array.isArray(conversations) ? conversations.length : 0
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    const list = Array.isArray(conversations) ? conversations : []
    if (!normalizedQuery) return list
    return list.filter((conversation) => {
      const title = String(conversation.title ?? '').toLowerCase()
      if (title.includes(normalizedQuery)) return true
      return (conversation.messages ?? []).some((message) => (
        String(message?.content ?? '').toLowerCase().includes(normalizedQuery)
      ))
    })
  }, [conversations, normalizedQuery])
  const groups = groupConversations(filtered)

  const beginRename = (conversation) => {
    if (disabled || !onRenameChat) return
    setEditingId(conversation.id)
    setDraft(conversation.title || 'New chat')
  }

  const finishRename = (id, save = true) => {
    if (save) {
      const title = draft.replace(/\s+/g, ' ').trim()
      if (title) onRenameChat?.(id, title)
    }
    setEditingId(null)
    setDraft('')
  }

  const emptyMessage = total === 0
    ? 'No saved chats yet. Start a conversation and it will appear here.'
    : normalizedQuery
      ? `No chats match “${query.trim()}”.`
      : ''

  return (
    <>
      {total > 0 && (
        <label className="javelin-gpt-history-search">
          <Search size={13} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear chat search" title="Clear search">
              <X size={12} />
            </button>
          )}
        </label>
      )}
      {groups.length === 0
        ? (emptyMessage ? <p className="javelin-gpt-history-empty">{emptyMessage}</p> : null)
        : groups.map((group) => (
          <div className="javelin-gpt-history-group" key={group.label}>
            <span className="javelin-gpt-history-label">{group.label}</span>
            {group.items.map((conversation) => {
              const isActive = conversation.id === activeConversationId
              const title = isActive && activeConversationTitle
                ? activeConversationTitle
                : (conversation.title || 'New chat')
              if (editingId === conversation.id) {
                return (
                  <form
                    className="javelin-gpt-chat-rename"
                    key={conversation.id}
                    onSubmit={(event) => {
                      event.preventDefault()
                      finishRename(conversation.id, true)
                    }}
                  >
                    <input
                      value={draft}
                      autoFocus
                      maxLength={80}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation()
                          finishRename(conversation.id, false)
                        }
                      }}
                      onBlur={(event) => {
                        if (!event.currentTarget.form?.contains(event.relatedTarget)) {
                          finishRename(conversation.id, true)
                        }
                      }}
                      aria-label={`Rename ${title}`}
                    />
                    <button type="submit" title="Save name" aria-label="Save name">
                      <Check size={12} />
                    </button>
                  </form>
                )
              }
              return (
                <div
                  className={`javelin-gpt-chat-row${isActive ? ' is-active' : ''}`}
                  key={conversation.id}
                >
                  <button
                    type="button"
                    className="javelin-gpt-chat-open"
                    onClick={() => onSelectChat?.(conversation.id)}
                    disabled={disabled}
                    title={title}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <MessageSquare size={14} />
                    <span>{title}</span>
                  </button>
                  <div className="javelin-gpt-chat-actions">
                    <button
                      type="button"
                      className="javelin-gpt-chat-rename-button"
                      onClick={() => beginRename(conversation)}
                      disabled={disabled || !onRenameChat}
                      title={`Rename ${title}`}
                      aria-label={`Rename ${title}`}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      className="javelin-gpt-chat-delete"
                      onClick={() => onDeleteChat?.(conversation.id)}
                      disabled={disabled}
                      title={`Delete ${title}`}
                      aria-label={`Delete ${title}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
    </>
  )
}

function MessageAttachments({ attachments }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null
  return (
    <div className="msg-attachments">
      {attachments.map((attachment) => (
        attachment.kind === 'image' ? (
          <a
            key={attachment.id}
            className="msg-image-link"
            href={attachment.dataUrl}
            target="_blank"
            rel="noreferrer"
            title={attachment.name}
          >
            <img className="msg-image" src={attachment.dataUrl} alt={attachment.name} />
          </a>
        ) : (
          <span className="msg-file" key={attachment.id} title={attachment.name}>
            <FileText size={14} />
            <span className="msg-file-name">{attachment.name}</span>
            <small>{formatAttachmentSize(attachment.size)}</small>
          </span>
        )
      ))}
    </div>
  )
}

function Message({ message, isStreaming, onPlay, isSpeaking = false }) {
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'

  // System notes (reminders, checkpoint restores) render as a centred strip.
  if (message.role === 'system') {
    return (
      <div className="glass-chip system-note mx-auto max-w-md px-4 py-2 text-center text-xs text-muted-foreground">
        {message.content}
      </div>
    )
  }

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={`message-row flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="msg-avatar mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-primary">
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div
        className={`msg max-w-[85%] px-4 py-3 ${
          isUser ? 'msg-user' : 'msg-assistant'
        }`}
      >
        {isUser ? (
          <>
            <MessageAttachments attachments={message.attachments} />
            {message.content && <p className="whitespace-pre-wrap text-sm">{message.content}</p>}
          </>
        ) : message.image?.status === 'loading' ? (
          <span className="generated-loading">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            Creating an original image…
          </span>
        ) : message.image?.status === 'ready' ? (
          <>
            <GeneratedImage image={message.image} />
            {message.content && <Markdown>{message.content}</Markdown>}
          </>
        ) : message.content ? (
          <Markdown>{message.content}</Markdown>
        ) : (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            Thinking...
          </span>
        )}
        {isStreaming && message.content && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/60 align-text-bottom" />
        )}
        {!isUser && message.content && !isStreaming && (
          <div className="msg-actions">
            {onPlay && (
              <button
                type="button"
                className={`msg-copy msg-play${isSpeaking ? ' is-playing' : ''}`}
                onClick={onPlay}
                aria-label={isSpeaking ? 'Stop reading this reply' : 'Play this reply aloud'}
                aria-pressed={isSpeaking}
              >
                {isSpeaking ? <Square size={14} /> : <Volume2 size={14} />}
                <span>{isSpeaking ? 'Stop' : 'Play aloud'}</span>
              </button>
            )}
            <button type="button" className="msg-copy" onClick={copyMessage} aria-label="Copy reply">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        )}
      </div>
      {isUser && (
        <div className="msg-avatar mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  )
}

export default App
