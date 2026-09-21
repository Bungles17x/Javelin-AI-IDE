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
export function useJavelin({ providerId, model, apiKey, baseUrl, workspaceFiles, memoryStore }) {
  const provider = getProvider(providerId)
  const javelinRef = useRef(null)
  const workspaceRef = useRef(null)
  const approvalResolver = useRef(null)

  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState(null)
  const [plan, setPlan] = useState(null)
  const [hypotheses, setHypotheses] = useState([])
  const [steps, setSteps] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [thinking, setThinking] = useState('')
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
    workspaceRef.current = new VirtualWorkspace(workspaceFiles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshDiagnostics = useCallback(async () => {
    if (!javelinRef.current) {
      return null
    }
    const diag = await javelinRef.current.diagnose()
    setDiagnostics(diag)
    return diag
  }, [])

  const think = useCallback(
    async (task, { onFileChanged, requestApprovalOverride, autonomy = 'ask' } = {}) => {
      if (!javelinRef.current || !task?.trim() || busy) {
        return null
      }

      setError(null)
      setResult(null)
      setPhase('understand')
      setSteps([])
      setCheckpoints([])
      setPlan(null)
      setHypotheses([])
      setThinking('')
      setBusy(true)

      const liveSteps = []

      try {
        const outcome = await javelinRef.current.think({
          task: task.trim(),
          workspace: workspaceRef.current,
          runCommand: undefined, // browser cannot execute shell commands
          // How much Javelin may do without prompting. 'ask' is the default;
          // 'auto-edit'/'full' let it run the whole job unattended.
          autonomy,
          onEvent: (evt) => {
            switch (evt.type) {
              case 'phase':
                setPhase(evt.phase)
                if (evt.label) {
                  setThinking('')
                }
                break
              case 'plan':
                setPlan(evt.plan)
                break
              case 'hypothesis':
                setHypotheses((prev) => [...prev, evt.hypothesis])
                break
              case 'thinking_delta':
                setThinking((prev) => prev + evt.delta)
                break
              case 'tool_call':
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
                if (evt.diff) {
                  onFileChanged?.(evt)
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
        setLearnings(javelinRef.current.learnings())
        // Persist any files Javelin changed.
        onFileChanged?.({ type: 'workspace_sync', files: workspaceRef.current.toJSON() })
        return outcome
      } catch (err) {
        setError(err.message || String(err))
        return null
      } finally {
        setBusy(false)
        setPhase(null)
        setThinking('')
      }
    },
    [busy],
  )

  const decideApproval = useCallback(({ approved, remember }) => {
    approvalResolver.current?.({ approved, remember })
    approvalResolver.current = null
    setApproval(null)
  }, [])

  const stop = useCallback(() => {
    javelinRef.current?.stop()
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
    hypotheses,
    steps,
    checkpoints,
    thinking,
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
