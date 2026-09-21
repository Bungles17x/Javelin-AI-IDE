/**
 * Trace sink — optional auto-capture of Javelin runs.
 * ===================================================
 *
 * When enabled, every run writes a JDF `trajectory` record to a traces directory.
 * This is what makes "your own model" improve on its own: normal use of Javelin
 * quietly produces the training data a fine-tune needs, instead of requiring a
 * separate `capture` step you have to remember to run.
 *
 * DESIGN CONSTRAINTS (why it looks like this):
 *
 *  1. **Opt-in, always.** Capturing writes to disk; that is never a silent default.
 *     Enable it explicitly (`autoCapture`), and it stays off otherwise.
 *  2. **Never important enough to break a run.** If the disk is full, the path is
 *     wrong, or serialisation throws, the sink swallows the error and the run
 *     continues. Observation must not cost the task.
 *  3. **Node only.** The browser cannot write to a project directory, so the sink
 *     is a no-op there. It checks for `node:fs` availability rather than assuming.
 *  4. **Honest records.** It reuses `trajectoryFromRun`, so provenance, outcome
 *     labelling and the "no fabrication" guarantees are identical to manual capture.
 */

let fsModule = null
let pathModule = null
let loadFailed = false

/** Lazily load node fs/path. Returns null in environments without them (the browser). */
async function loadNodeFs() {
  if (fsModule && pathModule) {
    return { fs: fsModule, path: pathModule }
  }
  if (loadFailed) {
    return null
  }
  try {
    fsModule = await import('node:fs')
    pathModule = await import('node:path')
    return { fs: fsModule, path: pathModule }
  } catch {
    loadFailed = true
    return null
  }
}

/**
 * Write one run as a JDF trajectory record.
 *
 * @param {object} args
 * @param {object} args.run            { task, steps, hypotheses, verified, status, filesTouched, plan }
 * @param {object[]} args.events       the raw runtime event stream
 * @param {string} args.dir            directory to write into (created if missing)
 * @param {object} [args.meta]         model/provider/identity metadata
 * @returns {Promise<{ok: boolean, file?: string, error?: string, skipped?: string}>}
 */
export async function captureTrajectory({ run, events = [], dir, meta = {} }) {
  const node = await loadNodeFs()
  if (!node) {
    return { ok: false, skipped: 'no filesystem in this environment (browser build)' }
  }
  if (!dir) {
    return { ok: false, skipped: 'no capture directory configured' }
  }

  try {
    const { trajectoryFromRun, trajectoryToJsonl } = await import('./trace.js')
    const record = trajectoryFromRun({ ...run, events }, meta)

    node.fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = node.path.join(dir, `auto-${stamp}.jsonl`)
    node.fs.writeFileSync(file, trajectoryToJsonl(record) + '\n', 'utf8')

    return { ok: true, file }
  } catch (err) {
    // Capture is an observation, never a requirement. A failure here must not
    // surface as a task failure.
    return { ok: false, error: err.message }
  }
}

/**
 * Build the `onTrajectory` hook used by the runtime. The runtime calls this once per
 * run with the finished result and the event stream; the sink does the rest.
 *
 * @param {object} opts
 * @param {boolean} opts.enabled
 * @param {string}  [opts.dir]     default: <cwd>/traces
 * @param {object}  [opts.meta]
 * @param {(result: object) => void} [opts.onCaptured]  notified of write outcome
 */
export function makeTrajectoryHook({ enabled, dir = 'traces', meta = {}, onCaptured } = {}) {
  if (!enabled) {
    return null
  }
  return async (result, events) => {
    const outcome = await captureTrajectory({
      run: {
        task: result.task,
        steps: result.steps,
        hypotheses: result.hypotheses,
        verified: result.verified,
        status: result.status,
        filesTouched: result.filesTouched,
        plan: result.plan,
      },
      events,
      dir,
      meta,
    })
    onCaptured?.(outcome)
    return outcome
  }
}
