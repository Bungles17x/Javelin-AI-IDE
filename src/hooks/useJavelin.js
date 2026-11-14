import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createJavelin, PHASE_LABEL } from '../core/index.js'
import { getProvider } from '../lib/providers.js'
import { VirtualWorkspace } from '../lib/virtualWorkspace.js'

/**
 * Binds Javelin Core to React.
 *
 * Core is plain, engine-agnostic JavaScript with its own lifecycle. This hook is
 * the only place that knows about React: it forwards Core's events into state and
 * exposes a `think()` call plus a `stop()` for the Stop button.
 *
 * It deliberately does NOT touch the existing chat path — chat and Javelin are
 * independent modes over the same provider.
 */
export function useJavelin({ providerId, model, apiKey, baseUrl, workspaceFiles, workspaceDirectories = [], memoryStore }) {
  const provider = getProvider(providerId)
  const javelinRef = useRef(null)
  const activeJavelinRef = useRef(null)
  const workspaceRef = useRef(null)
  const runningRef = useRef(false)
  const approvalResolver = useRef(null)

  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState(null)
  const [plan, setPlan] = useState(null)
  const [planSteps, setPlanSteps] = useState([])
  const [hypotheses, setHypotheses] = useState([])
  const [steps, setSteps] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [thinking, setThinking] = useState('')
  const [status, setStatus] = useState('')
  const [diagnostics, setDiagnostics] = useState(null)
  const [learnings, setLearnings] = useState({ strong: [], blocked: [], recentEpisodes: [] })
  const [approval, setApproval] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  // (Re)build the Javelin instance when the engine configuration changes.
  useEffect(() => {
    javelinRef.current = createJavelin({
      provider: { ...provider, baseUrl: baseUrl || provider.baseUrl },
      model,
      apiKey,
      persist: memoryStore ? (snapshot) => memoryStore.save(snapshot) : undefined,
      load: memoryStore ? () => memoryStore.load() : undefined,
    })
    setLearnings(javelinRef.current.learnings())
  }, [provider, model, apiKey, baseUrl, memoryStore])

  // Keep a live workspace mirror so Javelin always sees the latest files.
  useEffect(() => {
    workspaceRef.current = new VirtualWorkspace(workspaceFiles, workspaceDirectories)
  }, [workspaceFiles, workspaceDirectories])

  const refreshDiagnostics = useCallback(async () => {
    if (!javelinRef.current) {
      return null
    }
    const diag = await javelinRef.current.diagnose()
    setDiagnostics(diag)
    return diag
  }, [])

  const think = useCallback(
    async (task, { onFileChanged, requestApprovalOverride, runCommand, autonomy = 'ask', priorMessages = [] } = {}) => {
      if (!javelinRef.current || !task?.trim() || runningRef.current) {
        return null
      }

      const instance = javelinRef.current
      runningRef.current = true
      activeJavelinRef.current = instance
      setError(null)
      setResult(null)
      setPhase('understand')
      setSteps([])
      setCheckpoints([])
      setPlan(null)
      setPlanSteps([])
      setHypotheses([])
      setThinking('')
      setStatus('Understanding the task and project…')
      setBusy(true)

      const liveSteps = []

      try {
        const outcome = await instance.think({
          task: task.trim(),
          priorMessages,
          workspace: workspaceRef.current,
          runCommand,
          // How much Javelin may do without prompting. 'ask' is the default;
          // 'auto-edit'/'full' let it run the whole job unattended.
          autonomy,
          onEvent: (evt) => {
            switch (evt.type) {
              case 'phase':
                setPhase(evt.phase)
                setStatus(evt.label || 'Working through the current step…')
                break
              case 'plan':
                setPlan(evt.plan)
                // The plan parsed into task steps, so the UI can tick them off.
                setPlanSteps(evt.steps ?? [])
                setStatus('Plan ready · preparing the first action…')
                break
              case 'hypothesis':
                setHypotheses((prev) => [...prev, evt.hypothesis])
                setStatus('Diagnosing a failed step…')
                break
              case 'thinking_delta':
                setStatus((current) => current || 'Preparing the next action…')
                break
              case 'thinking':
                setStatus(evt.repeated ? 'The model repeated itself; recovering…' : 'Preparing the next action…')
                break
              case 'tool_call':
                setStatus(`${evt.name.replaceAll('_', ' ')}${evt.args?.path ? ` · ${evt.args.path}` : evt.args?.command ? ` · ${evt.args.command}` : ''}…`)
                liveSteps.push({
                  id: evt.id,
                  step: liveSteps.length + 1,
                  name: evt.name,
                  args: evt.args,
                  ok: null,
                  output: '',
                  ts: Date.now(),
                })
                setSteps([...liveSteps])
                break
              case 'tool_result': {
                const record = liveSteps.find((s) => s.id === evt.id)
                if (record) {
                  record.ok = evt.ok
                  record.output = evt.output
                  record.diff = evt.diff
                }
                setSteps([...liveSteps])
                setStatus(`${evt.ok ? 'Completed' : 'Could not complete'} ${evt.name.replaceAll('_', ' ')}${record?.args?.path ? ` · ${record.args.path}` : ''}`)
                // Tick the next pending task off — only on success, so a retry of a
                // failed step never reads as progress.
                if (evt.ok && evt.name !== 'finish') {
                  setPlanSteps((prev) => {
                    const next = prev.findIndex((s) => !s.done)
                    if (next === -1) return prev
                    const copy = prev.slice()
                    copy[next] = { ...copy[next], done: true }
                    return copy
                  })
                }
                if (evt.diff) {
                  onFileChanged?.(evt)
                }
                break
              }
              case 'command_output': {
                const record = liveSteps.find((step) => step.id === evt.id)
                if (record) {
                  const prefix = evt.stream === 'stderr' ? '[stderr] ' : ''
                  record.output = `${record.output}${prefix}${evt.text}`.slice(-12000)
                  setSteps([...liveSteps])
                }
                break
              }
              case 'checkpoint':
                setCheckpoints((prev) => [...prev, evt.checkpoint])
                break
              case 'file_changed':
                onFileChanged?.(evt)
                break
              case 'repeat_blocked':
              case 'verification_required':
              case 'tool_refused':
                setSteps((prev) => [
                  ...prev,
                  {
                    step: prev.length + 1,
                    name: evt.type,
                    args: { note: evt.note ?? evt.name },
                    ok: false,
                    output: evt.note ?? '',
                    ts: Date.now(),
                  },
                ])
                break
              default:
                break
            }
          },
          requestApproval:
            requestApprovalOverride ??
            ((req) =>
              new Promise((resolve) => {
                approvalResolver.current = resolve
                setApproval(req)
              })),
        })

        setResult(outcome)
        setLearnings(instance.learnings())
        // Persist any files Javelin changed.
        onFileChanged?.({ type: 'workspace_sync', files: workspaceRef.current.toJSON(), directories: workspaceRef.current.directoryPaths() })
        return outcome
      } catch (err) {
        setError(err.message || String(err))
        return null
      } finally {
        runningRef.current = false
        activeJavelinRef.current = null
        // The run is over: drop any approval nobody is waiting for.
        approvalResolver.current = null
        setApproval(null)
        setBusy(false)
        setPhase(null)
        setThinking('')
        setStatus('')
      }
    },
    [],
  )

  const decideApproval = useCallback(({ approved, remember }) => {
    approvalResolver.current?.({ approved, remember })
    approvalResolver.current = null
    setApproval(null)
  }, [])

  const stop = useCallback(() => {
    const active = activeJavelinRef.current ?? javelinRef.current
    active?.stop()
    if (approvalResolver.current) {
      approvalResolver.current({ approved: false })
      approvalResolver.current = null
      setApproval(null)
    }
  }, [])

  const restoreCheckpoint = useCallback((id) => {
    try {
      const changed = workspaceRef.current.restore(id)
      return changed
    } catch (err) {
      setError(err.message)
      return []
    }
  }, [])

  const phaseLabel = useMemo(() => (phase ? PHASE_LABEL[phase] ?? phase : null), [phase])

  return {
    busy,
    phase,
    phaseLabel,
    plan,
    planSteps,
    hypotheses,
    steps,
    checkpoints,
    thinking,
    status,
    diagnostics,
    learnings,
    approval,
    result,
    error,
    workspace: workspaceRef,
    think,
    stop,
    decideApproval,
    restoreCheckpoint,
    refreshDiagnostics,
    setError,
  }
}
