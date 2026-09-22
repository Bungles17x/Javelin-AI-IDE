import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './components/Button'
import { Textarea } from './components/Textarea'
import { Markdown } from './components/Markdown'
import { SettingsDialog } from './components/SettingsDialog'
import { ApprovalDialog } from './components/ApprovalDialog'
import { AgentPhase, AgentTimeline, CheckpointBar, RunControls, TaskList } from './components/AgentTimeline'
import {
  PhaseRail, PlanCard, HypothesisList, JavelinSteps, JavelinResult, JavelinDiagnostics,
} from './components/JavelinPanel'
import { streamChat, PROVIDERS, DEFAULT_PROVIDER } from './lib/ai'
import { runAgent } from './lib/agent'
import { VirtualWorkspace } from './lib/virtualWorkspace'
import { getProvider } from './lib/providers'
import { useJavelin } from './hooks/useJavelin'
import {
  Sparkles, Send, Square, Trash2, Settings, Sun, Moon, User, Bot, AlertCircle, KeyRound,
  MessageSquare, FolderOpen, Zap, CheckCircle2, XCircle, Brain,
} from 'lucide-react'

const STORAGE = {
  apiKey: 'javelin.apiKey',
  model: 'javelin.model',
  provider: 'javelin.provider',
  baseUrl: 'javelin.baseUrl',
  theme: 'javelin.theme',
  messages: 'javelin.messages',
  mode: 'javelin.mode',
  workspace: 'javelin.workspace',
  memory: 'javelin.memory',
  autonomy: 'javelin.autonomy',
}

const EXAMPLES = [
  { text: 'Create a React counter component with TypeScript', mode: 'chat' },
  { text: 'Explain the difference between debounce and throttle', mode: 'chat' },
  { text: 'Write a SQL query to find duplicate emails in a users table', mode: 'chat' },
  { text: 'Add input validation to the form and make sure tests pass', mode: 'agent' },
  { text: 'Find the bug in the parser and fix it', mode: 'agent' },
  { text: 'Refactor utils.js to remove duplication, then run the tests', mode: 'agent' },
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

function App() {
  const [providerId, setProviderId] = useLocalStorage(STORAGE.provider, DEFAULT_PROVIDER)
  const [apiKey, setApiKey] = useLocalStorage(STORAGE.apiKey, import.meta.env.VITE_GROQ_API_KEY ?? '')
  const [baseUrl, setBaseUrl] = useLocalStorage(STORAGE.baseUrl, '')
  const [model, setModel] = useLocalStorage(STORAGE.model, PROVIDERS[DEFAULT_PROVIDER].defaultModel)
  const [theme, setTheme] = useLocalStorage(
    STORAGE.theme,
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const [messages, setMessages] = useLocalStorage(STORAGE.messages, [])
  const [mode, setMode] = useLocalStorage(STORAGE.mode, 'chat')
  const [workspaceFiles, setWorkspaceFiles] = useLocalStorage(STORAGE.workspace, {})
  const [agentMemory, setAgentMemory] = useLocalStorage(STORAGE.memory, null)
  // How much Javelin may do without stopping to ask. 'ask' is the default.
  const [autonomy, setAutonomy] = useLocalStorage(STORAGE.autonomy, 'ask')

  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

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
  const workspaceRef = useRef(new VirtualWorkspace(workspaceFiles))
  // One entry per user message: where it sits in the transcript and the checkpoint
  // taken just before it ran. Reverting a message needs both.
  const messageMarks = useRef([])
  const approvalResolver = useRef(null)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  const provider = getProvider(providerId)

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
    memoryStore,
  })

  // Hold Javelin behind a ref so `send` stays stable across renders.
  const javelinRef = useRef(javelin)
  javelinRef.current = javelin

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

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

  const send = useCallback(async (text, forcedMode) => {
    const content = (text ?? input).trim()
    const target = forcedMode ?? mode
    const useAgent = target === 'agent'
    const useJavelinMode = target === 'javelin'
    if (!content || isStreaming) return
    if (provider.requiresKey && !apiKey) {
      setSettingsOpen(true)
      return
    }

    setError(null)
    setInput('')
    setRunResult(null)

    const userMsg = { role: 'user', content, ts: Date.now() }

    // ---- Javelin Core path ------------------------------------------------
    // Javelin runs on its own runtime: phase machine, memory, self-correction.
    if (useJavelinMode) {
      setMessages((prev) => [...prev, userMsg])
      const outcome = await javelinRef.current.think(content, {
        autonomy,
        onFileChanged: (evt) => {
          if (evt.type === 'workspace_sync' && evt.files) {
            setWorkspaceFiles(evt.files)
          }
        },
      })
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
      return
    }
    const history = [...messages, userMsg]

    if (!useAgent) {
      // ---- Plain chat path (provider-agnostic) ----
      setMessages([...history, { role: 'assistant', content: '', ts: Date.now() }])
      setIsStreaming(true)

      const controller = new AbortController()
      abortRef.current = controller
      let acc = ''
      try {
        await streamChat({
          providerId,
          baseUrl: baseUrl || provider.baseUrl,
          apiKey,
          model,
          messages: history.map(({ role, content: c }) => ({ role, content: c })),
          signal: controller.signal,
          onToken: (delta) => {
            acc += delta
            setMessages((prev) => {
              const next = prev.slice()
              next[next.length - 1] = { ...next[next.length - 1], content: acc }
              return next
            })
          },
        })
      } catch (err) {
        if (err?.name === 'AbortError') {
          if (!acc) setMessages(history)
        } else {
          setError(err.message || String(err))
          setMessages(history)
        }
      } finally {
        setIsStreaming(false)
        abortRef.current = null
        textareaRef.current?.focus()
      }
      return
    }

    // ---- Agent path ----
    setMessages(history)
    setSteps([])
    setCheckpoints([])
    setPhase('inspect')
    setStatusText('Starting…')
    setIsStreaming(true)
    setDirty(false)
    // A new run supersedes the previous keep/undo offer.
    setPendingDecision(null)
    setRunBaseline(null)

    const controller = new AbortController()
    abortRef.current = controller
    // Mirror of the agent's internal steps so the UI can show results as they land.
    const emittedSteps = []

    const emit = (evt) => {
      switch (evt.type) {
        case 'phase':
          setPhase(evt.phase)
          break
        case 'status':
          setStatusText(evt.text)
          break
        case 'assistant_message':
          setMessages((prev) => [...prev, { role: 'assistant', content: evt.content, ts: Date.now() }])
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
          setStatusText(`${evt.name}…`)
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
          break
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
        }),
    }

    try {
      const result = await runAgent({
        task: content,
        workspace: workspaceRef.current,
        provider: { providerId, baseUrl: baseUrl || provider.baseUrl, apiKey, model },
        signal: controller.signal,
        events,
        autonomy,
        // The browser cannot execute shell commands; the agent is told so and
        // will explain what should be run instead.
        runCommand: undefined,
        priorMessages: messages.map(({ role, content: c }) => ({ role, content: c })),
      })

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
          ? { fileCount: touched.length, status: result.status }
          : null,
      )
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            result.status === 'done'
              ? `✅ **Done.** ${result.summary}`
              : result.status === 'aborted'
                ? `⏹️ **Stopped.** ${result.summary}`
                : `❌ **Could not complete.** ${result.summary}`,
          ts: Date.now(),
        },
      ])

      // Persist resulting files so they survive a reload.
      if (workspaceRef.current) setWorkspaceFiles(workspaceRef.current.toJSON())
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setIsStreaming(false)
      abortRef.current = null
      setPhase(null)
      setStatusText('')
      textareaRef.current?.focus()
    }
  }, [
    apiKey, baseUrl, autonomy, input, isStreaming, messages, mode, model, provider, providerId,
    setMessages, setWorkspaceFiles,
  ])

  /** Resolve a pending approval request (from the dialog). */
  const decide = useCallback(({ approved, remember }) => {
    approvalResolver.current?.({ approved, remember })
    approvalResolver.current = null
    setApproval(null)
  }, [])

  /** Stop button: abort the run AND unblock any pending approval wait. */
  const stop = useCallback(() => {
    abortRef.current?.abort()
    javelinRef.current?.stop()
    if (approvalResolver.current) {
      approvalResolver.current({ approved: false })
      approvalResolver.current = null
      setApproval(null)
    }
  }, [])

  /** Revert the workspace to a checkpoint. */
  const restoreCheckpoint = useCallback((id) => {
    try {
      const changed = workspaceRef.current.restore(id)
      setWorkspaceFiles(workspaceRef.current.toJSON())
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: `↩️ Restored checkpoint — reverted ${changed.length} file(s).`, ts: Date.now() },
      ])
      setDirty(false)
    } catch (err) {
      setError(err.message)
    }
  }, [setMessages, setWorkspaceFiles])

  /**
   * Undo everything the last run changed, back to the automatic pre-run checkpoint.
   * Always available after a run that touched files, so a bad run is never final.
   */
  const revertAll = useCallback(() => {
    if (!runBaseline) return
    try {
      const changed = workspaceRef.current.restore(runBaseline)
      setWorkspaceFiles(workspaceRef.current.toJSON())
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: `↩️ Reverted this run — ${changed.length} file(s) restored.`, ts: Date.now() },
      ])
      setPendingDecision(null)
      setRunBaseline(null)
      setDirty(false)
    } catch (err) {
      setError(err.message)
    }
  }, [runBaseline, setMessages, setWorkspaceFiles])

  /** Keep the last run's changes and retire the revert offer. */
  const acceptAll = useCallback(() => {
    setPendingDecision(null)
    setRunBaseline(null)
    setMessages((prev) => [
      ...prev,
      { role: 'system', content: '✓ Changes kept. Export them to disk, or use a checkpoint to undo later.', ts: Date.now() },
    ])
  }, [setMessages])

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
        workspaceRef.current.restore(mark.checkpointId)
        setWorkspaceFiles(workspaceRef.current.toJSON())
      } catch (err) {
        setError(err.message)
      }
    }
    setMessages((prev) => prev.slice(0, lastUser))
    messageMarks.current = messageMarks.current.filter((m) => m.index < lastUser)
    setPendingDecision(null)
    setRunBaseline(null)
    // Put the text back in the box so it can be edited and resent, not retyped.
    setInput(text)
  }, [messages, setError, setMessages, setWorkspaceFiles])

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

  const clear = () => {
    if (isStreaming) stop()
    setMessages([])
    setSteps([])
    setCheckpoints([])
    setRunResult(null)
    setError(null)
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const currentModel = useMemo(() => {
    return provider.models.find((m) => m.id === model)?.label ?? model
  }, [model, provider])

  const hasMessages = messages.length > 0
  const fileCount = Object.keys(workspaceFiles).length

  return (
    <div className="flex h-screen flex-col bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur">
        <div className="container mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            <h1 className="bg-gradient-to-r from-primary to-blue-600 bg-clip-text text-xl font-bold text-transparent">
              Javelin AI
            </h1>
            <span className="ml-2 hidden rounded-full border px-2 py-0.5 text-xs text-muted-foreground sm:inline">
              {provider.label} · {currentModel}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {dirty && (
              <Button variant="outline" size="sm" onClick={exportWorkspace} className="h-8 text-xs">
                Export changes
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
              disabled={!hasMessages}
              aria-label="Clear conversation"
              title="Clear conversation"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Mode switch: Chat (simple) vs Agent (autonomous loop) */}
        <div className="container mx-auto flex max-w-4xl items-center gap-1 px-4 pb-2">
          <ModeTab active={mode === 'chat'} onClick={() => setMode('chat')} icon={MessageSquare} label="Chat" />
          <ModeTab active={mode === 'agent'} onClick={() => setMode('agent')} icon={Bot} label="Agent" />
          <ModeTab active={mode === 'javelin'} onClick={() => setMode('javelin')} icon={Brain} label="Javelin" />

          {/* Autonomy: how much Javelin may do without stopping to ask. */}
          {mode !== 'chat' && (
            <label className="ml-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Zap className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Autonomy</span>
              <select
                value={autonomy}
                onChange={(e) => setAutonomy(e.target.value)}
                title="How much Javelin may do without stopping to ask"
                className="rounded-md border bg-background px-1.5 py-1 text-xs"
              >
                <option value="ask">Ask every time</option>
                <option value="auto-edit">Auto-edit (do it all)</option>
                <option value="full">Full auto</option>
              </select>
            </label>
          )}

          <span className="ml-auto text-xs text-muted-foreground">{fileCount} file(s) in workspace</span>
        </div>
      </header>

      {/* Conversation */}
      <main className="flex-1 overflow-y-auto">
        <div className="container mx-auto max-w-4xl space-y-4 px-4 py-6">
          {provider.requiresKey && !apiKey && (
            <div className="flex items-start gap-3 rounded-lg border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
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
            <div className="py-10 text-center">
              <Bot className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
              <h2 className="text-lg font-semibold">
                {mode === 'chat'
                  ? 'What are we building?'
                  : mode === 'agent'
                    ? 'Give the agent a task'
                    : 'Give Javelin a task'}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {mode === 'chat'
                  ? 'Ask for code, explanations, refactors, or debugging help.'
                  : mode === 'agent'
                    ? 'It inspects the workspace, plans, edits with reviewable diffs, and reports what it verified.'
                    : 'Javelin runs its own reasoning loop: understand, plan, act, verify, and repair its own mistakes. It remembers what failed.'}
              </p>
              <div className="mx-auto mt-6 grid max-w-2xl gap-2 sm:grid-cols-2">
                {EXAMPLES.map((ex) => (
                  <Button
                    key={ex.text}
                    variant="outline"
                    className="h-auto justify-start whitespace-normal py-2.5 text-left font-normal"
                    onClick={() => send(ex.text, ex.mode)}
                  >
                    {ex.text}
                  </Button>
                ))}
              </div>

              {(mode === 'agent' || mode === 'javelin') && (
                <div className="mx-auto mt-6 max-w-md rounded-lg border bg-card/60 p-4 text-left text-xs">
                  <p className="font-medium">The agent needs files to work on.</p>
                  <p className="mt-1 text-muted-foreground">
                    A web page cannot read your disk — that is a browser security rule, not a
                    setting. So in the browser, import the files you want it to edit: it creates,
                    edits and deletes them here, then <strong>Export changes</strong> writes them
                    back to disk. To have Javelin act on your real project directly, use the
                    <strong> VS Code extension</strong>.
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    Autonomy is <strong>{autonomy === 'ask' ? 'Ask every time' : autonomy === 'auto-edit' ? 'Auto-edit' : 'Full auto'}</strong>
                    {autonomy === 'ask'
                      ? ' — it will pause for you to approve each change.'
                      : ' — it will do the whole task end to end without stopping.'}
                  </p>
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
                </div>
              )}
            </div>
          )}

          {checkpoints.length > 0 && (
            <CheckpointBar checkpoints={checkpoints} onRestore={restoreCheckpoint} />
          )}

          {pendingDecision && (
            <RunControls
              fileCount={pendingDecision.fileCount}
              status={pendingDecision.status}
              onAccept={acceptAll}
              onRevert={revertAll}
              onRevertMessage={revertToLastMessage}
            />
          )}

          {/* Always offer message-undo after a run, even if nothing changed. */}
          {!pendingDecision && runResult && (
            <RunControls
              fileCount={0}
              status={runResult.status}
              onAccept={acceptAll}
              onRevert={revertAll}
              onRevertMessage={revertToLastMessage}
            />
          )}

          {isStreaming && mode === 'agent' && <AgentPhase phase={phase} status={statusText} />}

          {/* Javelin Core: its own reasoning lifecycle, memory and self-correction */}
          {mode === 'javelin' && (
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
              {javelin.busy && javelin.thinking && (
                <div className="rounded-lg border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
                  <span className="whitespace-pre-wrap">{javelin.thinking}</span>
                  <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/60 align-text-bottom" />
                </div>
              )}
            </>
          )}

          {messages.map((m, i) => (
            <Message
              key={m.ts ?? i}
              message={m}
              isStreaming={isStreaming && i === messages.length - 1 && m.role === 'assistant'}
            />
          ))}

          {steps.length > 0 && <AgentTimeline steps={steps} />}

          {mode === 'javelin' && javelin.steps.length > 0 && <JavelinSteps steps={javelin.steps} />}

          {mode === 'javelin' && javelin.result && <JavelinResult result={javelin.result} />}

          {mode === 'javelin' && javelin.error && (
            <div role="alert" className="flex items-start gap-3 rounded-lg border-destructive/40 bg-destructive/10 p-4 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="flex-1">
                <p className="font-medium">Javelin error</p>
                <p className="mt-1 break-words text-muted-foreground">{javelin.error}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => javelin.setError(null)}>Dismiss</Button>
            </div>
          )}

          {runResult && (
            <div
              className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
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
              className="flex items-start gap-3 rounded-lg border-destructive/40 bg-destructive/10 p-4 text-sm"
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
      <footer className="border-t bg-background/80 backdrop-blur">
        <div className="container mx-auto max-w-4xl px-4 py-3">
          <div className="flex items-end gap-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                mode === 'chat'
                  ? 'Ask anything... (Enter to send, Shift+Enter for newline)'
                  : mode === 'agent'
                    ? 'Describe the task — the agent will inspect, plan, edit and verify…'
                    : 'Describe the task — Javelin will plan, act, verify and repair its own mistakes…'
              }
              rows={2}
              className="max-h-48 min-h-[56px] resize-y"
              disabled={isStreaming}
            />
            {isStreaming || javelin.busy ? (
              <Button variant="outline" onClick={stop} className="h-10 shrink-0" title="Stop">
                <Square className="mr-2 h-4 w-4" />
                Stop
              </Button>
            ) : (
              <Button onClick={() => send()} disabled={!input.trim()} className="h-10 shrink-0">
                {mode === 'chat' ? <Send className="mr-2 h-4 w-4" /> : mode === 'agent' ? <Zap className="mr-2 h-4 w-4" /> : <Brain className="mr-2 h-4 w-4" />}
                {mode === 'chat' ? 'Send' : mode === 'agent' ? 'Run' : 'Think'}
              </Button>
            )}
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {mode === 'chat'
              ? 'Responses are generated by an LLM and may be wrong. Verify before shipping.'
              : mode === 'agent'
                ? 'The agent asks before every file change. You can stop it at any time.'
                : 'Javelin asks before every change, verifies its work, and never repeats a failed step twice.'}
          </p>
        </div>
      </footer>

      <ApprovalDialog request={approval ?? javelin.approval} onDecide={approval ? decide : javelin.decideApproval} />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providerId={providerId}
        apiKey={apiKey}
        baseUrl={baseUrl}
        model={model}
        onSave={({ providerId: p, apiKey: k, baseUrl: b, model: m }) => {
          setProviderId(p)
          setApiKey(k)
          setBaseUrl(b)
          setModel(m)
        }}
      />
    </div>
  )
}

/** Chat / Agent switch. */
function ModeTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

function Message({ message, isStreaming }) {
  const isUser = message.role === 'user'

  // System notes (reminders, checkpoint restores) render as a centred strip.
  if (message.role === 'system') {
    return (
      <div className="mx-auto max-w-[85%] rounded-lg border bg-muted/50 px-4 py-2 text-center text-xs text-muted-foreground">
        {message.content}
      </div>
    )
  }

  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 shadow-sm ${
          isUser ? 'bg-primary text-primary-foreground' : 'border bg-card text-card-foreground'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm">{message.content}</p>
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
      </div>
      {isUser && (
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  )
}

export default App
