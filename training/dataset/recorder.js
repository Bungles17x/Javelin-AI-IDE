/**
 * Trace Recorder — capture Javelin's own runs as training data.
 * ============================================================
 *
 * This is the first stage of the pipeline: run Javelin normally, record everything
 * it did. The recorder is an **observer** — it consumes the event stream that
 * `runJavelin()` already emits and never changes runtime behaviour.
 *
 * Why record the raw trajectory rather than jumping straight to training examples:
 * the interpretation of a run ("this repair attempt was the interesting part")
 * changes as the model improves. Raw traces are the durable asset; training
 * examples are a derived view that can be regenerated at any time.
 *
 * Usage — wrap the event sink you already pass to Javelin:
 *
 *   const recorder = createTraceRecorder({ task })
 *   await javelin.think({ task, workspace, onEvent: recorder.observe })
 *   const trajectory = recorder.finish({ status: 'done' })
 */
import { SOURCE, recordId, JDF_VERSION } from './format.js'

/**
 * Events Javelin Core emits that we care about. Recorded explicitly so that a new
 * event type added to the runtime cannot silently break the recorder — unknown
 * events are kept in a catch-all rather than dropped.
 */
const TRACKED = new Set([
  'run_started',
  'phase',
  'plan',
  'hypothesis',
  'thinking',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'repeat_blocked',
  'verification_required',
  'tool_refused',
  'checkpoint',
  'file_changed',
  'command_started',
  'command_finished',
  'engine_error',
  'error',
  'run_finished',
])

/**
 * Create a recorder. Pass `observe` as Javelin's `onEvent`.
 *
 * @param {object} opts
 * @param {string} opts.task          the task text given to Javelin
 * @param {object} [opts.meta]        anything extra to attach (model, repo hash…)
 */
export function createTraceRecorder({ task, meta = {} } = {}) {
  const events = []
  const unknown = []
  const startedAt = Date.now()

  /** The observer. Purely functional — no mutation of the event it receives. */
  function observe(evt) {
    if (!evt || typeof evt.type !== 'string') {
      return
    }
    // `thinking_delta` streams a token at a time. Storing each delta as its own
    // event would bloat traces enormously, so they are coalesced below.
    if (evt.type === 'thinking_delta') {
      const last = events[events.length - 1]
      if (last?.type === 'thinking_delta') {
        last.delta += evt.delta ?? ''
        return
      }
    }
    if (TRACKED.has(evt.type)) {
      events.push({ ...evt, ts: Date.now() - startedAt })
    } else {
      unknown.push(evt.type)
    }
  }

  /**
   * Produce the trajectory record.
   * Call once, after the run settles.
   */
  function finish({ status = 'failed', summary = '', verified = false, filesTouched = [] } = {}) {
    const plan = events.find((e) => e.type === 'plan')?.plan ?? null
    const hypotheses = events.filter((e) => e.type === 'hypothesis').map((e) => e.hypothesis)
    const toolCalls = events.filter((e) => e.type === 'tool_call')
    const toolResults = events.filter((e) => e.type === 'tool_result')
    const blocked = events.filter((e) => e.type === 'repeat_blocked')

    return {
      id: recordId(task, startedAt, events.length),
      version: JDF_VERSION,
      kind: 'trajectory',
      source: SOURCE.RUNTIME_TRACE,
      trajectory: {
        task,
        events,
        plan,
        hypotheses,
        toolCalls,
        toolResults,
        blockedRepeats: blocked.length,
        // Deltas are joined here so consumers do not have to reassemble them.
        thinking: joinThinking(events),
      },
      outcome: {
        status,
        summary,
        verified,
        steps: toolCalls.length,
        blockedRepeats: blocked.length,
        filesTouched,
      },
      meta: {
        ...meta,
        startedAt,
        durationMs: Date.now() - startedAt,
        unknownEvents: [...new Set(unknown)],
      },
      tags: deriveTags({ status, verified, hypotheses, blocked }),
    }
  }

  return {
    observe,
    finish,
    /** Live view, for progress reporting during capture. */
    get eventCount() {
      return events.length
    },
    get events() {
      return events
    },
  }
}

/** Reassemble streamed thinking deltas into one string per contiguous run. */
function joinThinking(events) {
  const chunks = []
  let current = ''
  for (const e of events) {
    if (e.type === 'thinking_delta') {
      current += e.delta ?? ''
    } else if (e.type === 'thinking') {
      // A complete thinking block supersedes any partial deltas before it.
      if (current) {
        current = ''
      }
      chunks.push(e.content ?? '')
    } else if (current) {
      chunks.push(current)
      current = ''
    }
  }
  if (current) {
    chunks.push(current)
  }
  return chunks.join('\n\n')
}

/**
 * Tags make a dataset queryable — you can train only on verified runs, or only on
 * repair episodes, without re-deriving that from the events every time.
 */
function deriveTags({ status, verified, hypotheses, blocked }) {
  const tags = []
  if (status === 'done') {
    tags.push('completed')
  } else if (status === 'aborted') {
    tags.push('aborted')
  } else {
    tags.push('failed')
  }
  if (verified) {
    tags.push('verified')
  }
  if (hypotheses?.length) {
    tags.push('self-repair')
  }
  if (blocked > 0) {
    tags.push('repeat-blocked')
  }
  return tags
}
