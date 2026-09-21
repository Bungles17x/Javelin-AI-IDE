/**
 * Trace recording — turn a real Javelin run into JDF training data.
 * =================================================================
 *
 * This is the bridge between "Javelin did a task" and "Javelin can be taught".
 * A completed run already contains everything a training example needs — the task,
 * the tools it chose, their exact arguments, the outputs, the failures, the repair
 * that followed, and whether the result was verified. The only thing missing is a
 * faithful, versioned record of it.
 *
 * So this module does one job: given a run result and its event stream, emit a JDF
 * `trajectory` record. It is deliberately strict about provenance:
 *
 *   - It records what ACTUALLY happened, including failures. Nothing is smoothed.
 *   - It labels the outcome honestly (`verified` only when verification truly ran).
 *   - A run with no successful action is still recorded — the exporter will simply
 *     decline to make training examples from it. Silently dropping it would hide
 *     the fact that the task failed.
 *
 * The record is written in the same shape `dataset/exporter.js` consumes, so capture
 * → dataset → fine-tune is one continuous pipeline with no translation layer to rot.
 */

import { JDF_VERSION, recordId, SOURCE } from '../../training/dataset/format.js'

/**
 * Build a JDF `trajectory` record from a completed Javelin run.
 *
 * @param {object} run
 * @param {string}   run.task
 * @param {object[]} run.steps        runJavelin result.steps: {name,args,ok,output,diff}
 * @param {object[]} [run.hypotheses]
 * @param {boolean}  [run.verified]
 * @param {string}   [run.status]
 * @param {object[]} [run.events]     the raw event stream (for repeat_blocked etc.)
 * @param {object}   [meta]           model, provider, timestamp, workspace signature
 * @returns {object} a kind==='trajectory' JDF record
 */
export function trajectoryFromRun(run, meta = {}) {
  const steps = run.steps ?? []

  const toolCalls = steps.map((s, i) => ({
    id: s.id ?? `step_${i + 1}`,
    name: s.name,
    args: s.args ?? {},
  }))

  const toolResults = steps.map((s, i) => ({
    id: s.id ?? `step_${i + 1}`,
    name: s.name,
    ok: Boolean(s.ok),
    output: String(s.output ?? ''),
    diff: s.diff ?? null,
  }))

  // The plan is the first assistant prose the run produced. Callers may pass it
  // directly (run.plan) or leave it in the event stream, as the runtime emits it.
  const plan =
    run.plan ??
    meta.plan ??
    (run.events ?? []).find((e) => e.type === 'plan')?.plan ??
    null

  return {
    id: recordId(run.task ?? '', 'trajectory', String(toolCalls.length), meta.timestamp ?? ''),
    version: JDF_VERSION,
    kind: 'trajectory',
    source: SOURCE.RUNTIME_TRACE,
    trajectory: {
      task: run.task ?? '',
      plan,
      toolCalls,
      toolResults,
      hypotheses: run.hypotheses ?? [],
      events: normaliseEvents(run.events ?? []),
    },
    outcome: {
      status: run.status ?? 'unknown',
      // Verified is true ONLY when the run actually verified. Never inferred.
      verified: Boolean(run.verified),
      steps: steps.length,
      filesTouched: run.filesTouched ?? [],
    },
    tools: meta.toolSchemas ?? [],
    meta: {
      task: run.task ?? '',
      model: meta.model ?? null,
      provider: meta.provider ?? null,
      timestamp: meta.timestamp ?? new Date().toISOString(),
      workspace: meta.workspaceSignature ?? null,
      identityFingerprint: meta.identityFingerprint ?? null,
    },
    tags: deriveTags(run),
  }
}

/**
 * Keep only the events the exporter knows how to learn from, and shrink them to the
 * fields that matter. A trace is training data, not a debug log — retaining the whole
 * stream would bloat the dataset with UI noise.
 */
function normaliseEvents(events) {
  const keep = new Set(['repeat_blocked', 'verification_required', 'tool_refused', 'hypothesis', 'plan'])
  return events
    .filter((e) => keep.has(e.type))
    .map((e) => {
      switch (e.type) {
        case 'repeat_blocked':
          return { type: e.type, signature: e.signature ?? null }
        case 'verification_required':
          return { type: e.type, note: e.note ?? null }
        case 'tool_refused':
          return { type: e.type, name: e.name ?? null }
        case 'hypothesis':
          return { type: e.type, hypothesis: e.hypothesis ?? null }
        case 'plan':
          return { type: e.type, plan: e.plan ?? null }
        default:
          return { type: e.type }
      }
    })
}

/** Coarse labels so a dataset can be sliced later without re-reading every trace. */
function deriveTags(run) {
  const tags = []
  const steps = run.steps ?? []
  const anyWrite = steps.some((s) => s.name === 'edit_file' || s.name === 'write_file')
  const anyRead = steps.some((s) => s.name === 'read_file' || s.name === 'list_files' || s.name === 'search_code')
  const anyCommand = steps.some((s) => s.name === 'run_command')
  const anyFailure = steps.some((s) => !s.ok)

  if (anyRead) tags.push('inspected')
  if (anyWrite) tags.push('edited')
  if (anyCommand) tags.push('ran-command')
  if (anyFailure) tags.push('had-failure')
  if (run.verified) tags.push('verified')
  if (run.status === 'done') tags.push('completed')
  if (run.status === 'failed') tags.push('failed')
  if (!steps.length) tags.push('no-action')

  return tags
}

/**
 * Serialise a trajectory record to a single JSONL line.
 * Newline-safe: JSON.stringify escapes embedded newlines, so one record is one line.
 */
export function trajectoryToJsonl(record) {
  return JSON.stringify(record)
}
