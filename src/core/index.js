/**
 * Javelin Core — public facade
 * ============================
 *
 * One import surface for the whole system. This is what makes Javelin feel like a
 * single product rather than a pile of modules.
 *
 *   import { createJavelin } from './core'
 *   const javelin = createJavelin({ provider, model, apiKey, persist })
 *   await javelin.think({ task, workspace, runCommand, onEvent, requestApproval })
 *
 * Javelin is the system. The model underneath is an engine it drives.
 */

import { EngineRegistry, providerEngine, scriptedEngine, CAPABILITY } from './engines.js'
import { JavelinMemory } from './memory.js'
import { createStandardToolset, ToolRegistry, RISK, AUTONOMY, isSafeCommand, isBlockedCommand } from './tools.js'
import { runJavelin, DEFAULT_MAX_STEPS } from './runtime.js'
import { PHASE, PHASE_LABEL, JAVELIN_IDENTITY } from './brain.js'
import { buildProjectIndex } from './memory.js'
import { makeTrajectoryHook } from './traceSink.js'
import { identityFingerprint } from './identity.js'

export {
  EngineRegistry,
  providerEngine,
  scriptedEngine,
  CAPABILITY,
  JavelinMemory,
  ToolRegistry,
  createStandardToolset,
  RISK,
  AUTONOMY,
  isSafeCommand,
  isBlockedCommand,
  runJavelin,
  DEFAULT_MAX_STEPS,
  PHASE,
  PHASE_LABEL,
  JAVELIN_IDENTITY,
  buildProjectIndex,
}

/**
 * Construct a Javelin instance.
 *
 * @param {object} opts
 * @param {object} [opts.provider]  a provider descriptor (from providers.js)
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]
 * @param {object} [opts.engines]   a pre-built EngineRegistry (advanced)
 * @param {(snapshot: object) => void} [opts.persist]  memory persistence hook
 * @param {(snapshot: object) => object} [opts.load]   memory restore hook
 */
export function createJavelin(opts = {}) {
  const engines = opts.engines ?? buildRegistry(opts)
  const memory = opts.load ? JavelinMemory.restore(opts.load()) : new JavelinMemory()
  memory.persist = opts.persist
  const tools = createStandardToolset()

  let activeRun = null

  const api = {
    /** The engines Javelin can reason with. */
    engines,
    /** Javelin's memory stores. */
    memory,
    /** The tool registry, for inspection or per-session tweaks. */
    tools,

    /**
     * Think about a task and act on it.
     * Returns a full run result including what was changed and whether it verified.
     */
    async think({
      task,
      workspace,
      runCommand,
      onEvent,
      requestApproval,
      signal,
      maxSteps = DEFAULT_MAX_STEPS,
      autoApproveSafeCommands = true,
      autonomy = AUTONOMY.ASK,
      // Opt-in training-data capture. Off by default; when on, each run is written
      // as a JDF trajectory so normal use builds the fine-tune dataset on its own.
      autoCapture = false,
      captureDir = 'traces',
      onCaptured,
      priorMessages = [],
    }) {
      if (activeRun) {
        throw new Error('Javelin is already running a task.')
      }

      const controller = new AbortController()
      const combined = combineSignals(signal, controller.signal)
      activeRun = controller
      const restoreCommandTool = !runCommand && tools.has('run_command')
      if (restoreCommandTool) tools.disable('run_command')

      try {
        // Reserve the instance before awaiting a disk-backed workspace snapshot.
        // Otherwise two callers can start overlapping runs during indexing.
        if (workspace && typeof workspace.toJSON === 'function') {
          memory.indexProject(workspace.toJSON())
        } else if (workspace && typeof workspace.snapshotFiles === 'function') {
          memory.indexProject(await workspace.snapshotFiles())
        }

        // Build the capture hook for this run. It writes the finished trajectory and
        // reports the outcome; a failure to write never fails the run.
        const captureHook = autoCapture
          ? makeTrajectoryHook({
            enabled: true,
            dir: captureDir,
            meta: {
              model: opts.model ?? null,
              provider: opts.provider?.id ?? null,
              identityFingerprint: identityFingerprint(),
            },
            onCaptured,
          })
          : null

        const result = await runJavelin({
          task,
          priorMessages,
          workspace,
          engines,
          signal: combined,
          memory,
          tools,
          runCommand,
          onEvent,
          requestApproval,
          maxSteps,
          autoApproveSafeCommands,
          autonomy,
          onTrajectory: autoCapture ? captureHook : undefined,
        })
        return result
      } finally {
        if (restoreCommandTool) tools.enable('run_command')
        activeRun = null
      }
    },

    /** Stop the in-flight run, if any. */
    stop() {
      activeRun?.abort()
    },

    /** Is Javelin currently working? */
    get busy() {
      return Boolean(activeRun)
    },

    /** Check which engines are reachable. */
    async diagnose() {
      const health = await engines.probeAll()
      return {
        engines: engines.list(),
        health,
        memory: {
          facts: memory.semantic.strong().length,
          episodes: memory.episodic.episodes.length,
          deadActions: memory.episodic.failedSignatures().size,
        },
      }
    },

    /** Record what Javelin has learned, for display. */
    learnings() {
      return {
        strong: memory.semantic.strong(),
        recentEpisodes: memory.episodic.recent(10),
        blocked: [...memory.episodic.failedSignatures()],
      }
    },
  }

  return api
}

function buildRegistry(opts) {
  const registry = new EngineRegistry()
  if (opts.provider) {
    const engine = providerEngine(
      { ...opts.provider, apiKey: opts.apiKey },
      {
        id: 'javelin-primary',
        label: opts.provider.label,
        model: opts.model,
        capabilities: opts.provider.requiresKey
          ? [CAPABILITY.TOOLS, CAPABILITY.STRONG_REASONING]
          : [CAPABILITY.TOOLS, CAPABILITY.LONG_CONTEXT],
      },
    )
    registry.register(engine)
    registry.assign('primary', engine.id)
  }
  // A deterministic engine is always present, so Javelin can be exercised and
  // demonstrated even with no model installed. It is never chosen while a real
  // engine is healthy.
  if (opts.dryRun) {
    registry.register(scriptedEngine(opts.dryRun))
  }
  return registry
}

/** Combine an external abort signal with an internal controller. */
function combineSignals(a, b) {
  if (!a) {
    return b
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (a.aborted || b.aborted) {
    controller.abort()
    return controller.signal
  }
  a.addEventListener('abort', abort)
  b.addEventListener('abort', abort)
  return controller.signal
}
