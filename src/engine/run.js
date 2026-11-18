/**
 * Javelin Engine — orchestrator.
 *
 * One bounded loop over a bounded transcript:
 *
 *   inspect → plan → act → verify → recover → done
 *
 * Design rules that keep it reliable:
 *
 *   • Every await is cancellable, and every loop has a hard bound (steps, time,
 *     repeated calls, repeated text, stalled turns).
 *   • Tool results always go back to the model, one per call id, in order.
 *   • A tool's claim of success is verified against the workspace before the model
 *     is told it worked.
 *   • Duplicate calls are blocked against an unchanged workspace, but a retry is
 *     allowed once the workspace actually changes — that is the verify/fix loop.
 *   • Independent reads in one turn run together; mutations stay strictly ordered.
 */

import { TOOL_DEFS, signatureOf, normalizeToolArgs } from '../lib/agentTools.js'
import { PROVIDERS } from '../lib/providers.js'
import { ERROR_CODES, classifyModelError } from './errors.js'
import { dropLastAssistantText } from './memory.js'
import { missingRequestedPaths, requestedPaths } from './taskPaths.js'
import { AUTONOMY, canonicalizeToolCall } from '../core/tools.js'
import { resolveContinuationTask, taskRequiresWorkspaceChange } from '../core/taskIntent.js'
import { sanitizeAssistantOutput } from '../core/assistantOutput.js'
import { requestCompletion, resolveTransport, MAX_MODEL_RETRIES } from './providers.js'
import {
  buildProjectContext,
  buildWorkspaceIndex,
  detectVerificationCommands,
  refreshProjectIndex,
  unresolvedImports,
} from './projectIndex.js'
import {
  buildTranscript,
  canAttempt,
  createMemory,
  ensureToolResultPairing,
  noteProgress,
  noteSignature,
  normalizeText,
  recordAttempt,
  recordStep,
  repeatingSequence,
  snapshotMetrics,
  truncateOutput,
} from './memory.js'
import { approvalKeyFor, executeTool, hasMissingRequiredArgs, isReadOnlyTool, requiresApproval, verifyMutation, MUTATING_TOOLS } from './tools.js'
import {
  AGENT_SYSTEM_PROMPT,
  CONTINUE_AFTER_REFUSAL,
  FINAL_STEP_NOTE,
  FINISH_REFUSAL,
  PHASE,
  buildTaskMessage,
  extractPlan,
  hasSuccessfulMutation,
  insertFailureReminder,
  noActionNudge,
  OUTPUT_LIMIT_NOTE,
  sanitizePriorMessages,
  VERIFICATION_CLAIM_NOTE,
  DIAGNOSIS_NOTE,
} from './reasoning.js'
import {
  DEFAULT_CONTEXT_CHARS,
  DEFAULT_RUN_BUDGET_MS,
  MAX_IDENTICAL_RESPONSES,
  MAX_NO_ACTION_TURNS,
  MAX_REPEATED_ACTIONS,
  MAX_STALLED_STEPS,
  MAX_STEPS,
  MAX_TOOL_RESULT_IN_TRANSCRIPT,
} from './limits.js'

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' }))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' }))
      },
      { once: true },
    )
  })
}

function isContextOverflow(error) {
  return /exceeds (?:the )?available context|context (?:size|window)|n_ctx|too many tokens|maximum context/i.test(
    String(error?.message ?? ''),
  )
}

function isRetryable(error) {
  if (error?.status === 429 || error?.status >= 500) return true
  return /could not reach|network|fetch failed|econnreset|etimedout|eai_again|socket hang up|timed out|idle|provider error (?:429|5\d\d)/i.test(
    String(error?.message ?? ''),
  )
}

/**
 * Run the agent against a task until it finishes, fails, or is aborted.
 *
 * @param {object} opts
 * @param {string} opts.task
 * @param {object} opts.workspace                 VirtualWorkspace or VS Code adapter
 * @param {object} opts.provider                  {providerId, baseUrl, apiKey, model, hosted?}
 * @param {AbortSignal} [opts.signal]
 * @param {{emit?: Function, requestApproval?: Function}} [opts.events]
 * @param {Function} [opts.runCommand]
 * @param {object[]} [opts.priorMessages]
 * @param {'ask'|'auto-edit'|'full'} [opts.autonomy]
 * @param {Function} [opts.generate]              injectable model call (tests, custom transports)
 * @param {{maxSteps?: number, maxRunMs?: number, temperature?: number}} [opts.limits]
 * @param {boolean} [opts.autoVerify]  run the project's checks before accepting `finish`
 * @returns {Promise<{status: 'done'|'aborted'|'failed', summary: string, steps: object[], checkpoints: object[], metrics: object}>}
 */
export async function runAgent({
  task,
  workspace,
  provider = {},
  signal,
  events,
  runCommand,
  priorMessages = [],
  autonomy = AUTONOMY.ASK,
  generate = null,
  limits = {},
  autoVerify = false,
}) {
  const emit = events?.emit ?? (() => {})
  const requestApproval = events?.requestApproval ?? (async () => ({ approved: false }))
  const memory = createMemory()
  const toolIds = { used: new Set(), seq: 0 }

  const effectiveTask = resolveContinuationTask(task, priorMessages)
  const wantsWorkspaceChange = taskRequiresWorkspaceChange(effectiveTask)
  const maxSteps = Math.max(1, Math.floor(limits.maxSteps ?? MAX_STEPS))
  const runBudgetMs = limits.maxRunMs ?? DEFAULT_RUN_BUDGET_MS
  memory.task = effectiveTask

  // Taken before any tool can run, so a broken or half-finished run is always
  // revertible in one step. This is the id the UI's Revert button uses.
  let baseline = null
  let baselineError = null
  try {
    if (typeof workspace?.snapshot === 'function') {
      const checkpoint = await workspace.snapshot('start of run')
      baseline = checkpoint.id
      memory.checkpoints.push(checkpoint)
      emit({ type: 'checkpoint', checkpoint })
    }
  } catch (error) {
    baselineError = error?.message ?? 'checkpoint failed'
    emit({ type: 'warning', text: `Could not take a safety checkpoint: ${baselineError}` })
  }

  /** Did a real verification command pass after the last successful change? */
  const verificationState = () => {
    const mutations = memory.steps.filter((record) => record.ok && MUTATING_TOOLS.includes(record.name))
    const lastMutationAt = mutations.reduce((latest, record) => Math.max(latest, record.timestamp ?? 0), 0)
    const commands = memory.evidence.commands ?? []
    const checks = commands.filter((entry) => entry.verification)
    const passing = checks.filter((entry) => entry.ok && entry.at >= lastMutationAt)
    return {
      changed: mutations.length > 0,
      lastMutationAt,
      passedAfterChange: passing.length > 0,
      lastPassedAt: passing.length ? passing[passing.length - 1].at : null,
      checks,
    }
  }

  /**
   * Outcome classified from evidence, not from the model's own claim.
   *
   *   VERIFIED  a change landed and a check passed after it
   *   LIKELY    evidence exists (verified writes or actual reads), but no check passed
   *   UNVERIFIED the run failed, was stopped, or produced no evidence
   */
  const finish = (status, summary, code) => {
    const state = verificationState()
    const notes = [...(memory.notes ?? [])]
    const warnings = memory.verificationWarnings ?? []
    let confidence = 'unverified'
    if (status === 'done') {
      // A passing check is strong evidence, but a known unresolved import or invented
      // API means the work is not fully verified even when the tests are green.
      if (state.changed && state.passedAfterChange && !warnings.length) confidence = 'verified'
      else if (state.changed) confidence = 'likely'
      else if ((memory.evidence.filesRead ?? []).size || (memory.evidence.searches ?? []).length || (memory.evidence.commands ?? []).length) confidence = 'likely'
      if (state.changed && !state.passedAfterChange) {
        notes.push('No passing test, typecheck, lint or build ran after the last change; reported as LIKELY, not VERIFIED.')
      }
    }
    if (baselineError) notes.push(`No safety checkpoint was taken: ${baselineError}.`)
    if (warnings.length && state.passedAfterChange) {
      notes.push('A check passed, but verification warnings remain; reported as LIKELY, not VERIFIED.')
    }
    if (warnings.length) {
      notes.push(`Verification warnings: ${warnings.map((warning) => warning.message).join(' ')}`)
    }
    const touched = [...memory.filesTouched]
    const impact = touched
      .map((path) => ({ path, dependents: (memory.projectIndex?.dependents?.get(path) ?? []).slice(0, 12) }))
      .filter((entry) => entry.dependents.length)

    return {
      status,
      summary,
      // A clean finish has no code; every other ending names itself.
      code: code ?? (status === 'done' ? null : ERROR_CODES.UNKNOWN),
      baseline,
      verified: status === 'done' && confidence === 'verified',
      confidence,
      verification: {
        passed: state.passedAfterChange,
        lastPassedAt: state.lastPassedAt,
        checks: state.checks.slice(-10),
        warnings,
      },
      notes,
      impact,
      evidence: {
        filesRead: [...(memory.evidence.filesRead ?? [])],
        searches: memory.evidence.searches ?? [],
        commands: (memory.evidence.commands ?? []).slice(-15),
      },
      steps: memory.steps,
      checkpoints: memory.checkpoints,
      filesTouched: touched,
      metrics: snapshotMetrics(memory),
    }
  }

  let transport = null
  if (!generate) {
    try {
      transport = resolveTransport(provider)
    } catch (error) {
      const code = classifyModelError(error)
      emit({ type: 'error', error: error.message, code })
      return finish('failed', error.message, code)
    }
  }

  // Index the project once, before the first turn. This is metadata only: the model
  // sees where to look, then reads the files it actually needs.
  try {
    const files =
      typeof workspace?.toJSON === 'function'
        ? workspace.toJSON()
        : typeof workspace?.snapshotFiles === 'function'
          ? await workspace.snapshotFiles()
          : null
    if (files) memory.projectIndex = buildWorkspaceIndex(files)
  } catch (error) {
    emit({ type: 'warning', text: `Project indexing was unavailable: ${error?.message ?? 'unknown error'}` })
  }
  const projectContext = buildProjectContext(memory.projectIndex, effectiveTask)

  memory.transcript.push(
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...(projectContext ? [{ role: 'system', content: projectContext }] : []),
    ...sanitizePriorMessages(priorMessages),
    { role: 'user', content: buildTaskMessage(effectiveTask, { requiresChange: wantsWorkspaceChange }) },
  )

  const availableTools = runCommand
    ? TOOL_DEFS
    : TOOL_DEFS.filter((tool) => tool.function.name !== 'run_command')

  emit({ type: 'phase', phase: PHASE.INSPECT })
  emit({ type: 'status', text: 'Inspecting the codebase…' })

  const prepareToolCall = (call) => {
    let normalized = normalizeToolArgs(canonicalizeToolCall(call))
    // A small model sometimes omits `path` from read_file. If the task names one
    // file, or the run already read one, use that file rather than failing and
    // repeating the empty call until the loop guard fires.
    if (normalized.name === 'read_file' && !normalized.args?.path) {
      const candidates = requestedPaths(effectiveTask)
      const lastRead = [...(memory.evidence.filesRead ?? [])]
        .filter((path) => typeof path === 'string' && path)
        .at(-1)
      const inferred = candidates.length === 1 ? candidates[0] : lastRead
      let usable = Boolean(inferred)
      if (usable && typeof workspace?.exists === 'function') {
        try {
          usable = Boolean(workspace.exists(inferred))
        } catch {
          usable = false
        }
      }
      if (usable) {
        normalized = { ...normalized, args: { ...(normalized.args ?? {}), path: inferred } }
      }
    }
    let id = typeof normalized?.id === 'string' && normalized.id.trim() ? normalized.id.trim() : ''
    if (!id || toolIds.used.has(id)) {
      toolIds.seq += 1
      id = `call_${toolIds.seq}`
      while (toolIds.used.has(id)) {
        toolIds.seq += 1
        id = `call_${toolIds.seq}`
      }
    }
    toolIds.used.add(id)
    return { ...normalized, id }
  }

  /**
   * One model turn, with a bounded retry that covers both the network client and
   * an injected generator.
   */
  // A hosted provider can offer several models. When one is saturated (503) or rate
  // limited (429), retrying the same model is pointless — the next attempt uses the
  // next model instead, so a busy free tier does not end the run.
  const hostedEntry = PROVIDERS[provider.providerId]
  const attemptModels = hostedEntry?.hosted
    ? [provider.model, ...(hostedEntry.models ?? []).map((entry) => entry.id)].filter(
      (id, index, list) => id && list.indexOf(id) === index,
    )
    : [provider.model]
  const maxAttempts = Math.max(MAX_MODEL_RETRIES, attemptModels.length - 1)

  const callModel = async (messages, { toolChoice } = {}) => {
    let lastError = null
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) return { aborted: true }
      const attemptModel = attemptModels[Math.min(attempt, attemptModels.length - 1)]
      const startedAt = Date.now()
      try {
        const result = generate
          ? await generate({ ...provider, messages, tools: availableTools, signal, toolChoice })
          : await requestCompletion({
            transport: { ...transport, model: attemptModel },
            messages,
            tools: availableTools,
            toolChoice,
            signal,
            temperature: limits.temperature,
            maxRetries: 0,
            onToken: undefined,
          })
        if (result?.finishReason === 'length') {
          // A truncated reply is only a file-continuation problem when it actually
          // contained a tool call. A prose reply that hit the limit is a different
          // failure: the model must stop narrating and take an action.
          emit({
            type: 'reminder',
            text: result.toolCalls?.length
              ? OUTPUT_LIMIT_NOTE
              : 'Your reply hit the output limit and contained no tool call. Do not continue the prose or restart the explanation: your next reply must be one tool call.',
          })
        }
        memory.metrics.modelCalls += 1
        memory.metrics.attempts += 1
        memory.metrics.modelLatencyMs += Date.now() - startedAt
        if (result?.usage) {
          memory.metrics.tokensIn += result.usage.prompt_tokens ?? 0
          memory.metrics.tokensOut += result.usage.completion_tokens ?? 0
        }
        return { result }
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) return { aborted: true }
        lastError = error
        memory.metrics.attempts += 1
        // The transcript outgrew the server's context. Shrink it and retry instead
        // of ending a long task with a provider error the user cannot act on.
        if (isContextOverflow(error) && (memory.contextChars ?? DEFAULT_CONTEXT_CHARS) > 24_000) {
          memory.contextChars = Math.max(24_000, Math.floor((memory.contextChars ?? DEFAULT_CONTEXT_CHARS) * 0.6))
          memory.metrics.contextTrims = (memory.metrics.contextTrims ?? 0) + 1
          emit({ type: 'status', text: 'The conversation exceeded the model context; trimming older output and retrying…' })
          // Rebuild the request with the smaller budget on the next loop turn. Retrying
          // the identical message list here would hit the same context limit again.
          return { contextOverflow: true }
        }
        if (attempt >= maxAttempts || !isRetryable(error)) break
        memory.metrics.retries += 1
        const nextModel = attemptModels[Math.min(attempt + 1, attemptModels.length - 1)]
        emit({
          type: 'status',
          text: `The model request failed (${error?.message ?? 'unknown error'}); retrying${nextModel !== attemptModel ? ` with ${nextModel}` : ''} (${attempt + 1}/${maxAttempts})…`,
        })
        try {
          // Free cloud tiers answer 503 "high demand" in short spikes; a slower retry
          // rides them out instead of failing the run on the first attempt.
          const overloaded = error?.status === 503 || /high demand|overloaded|temporarily unavailable/i.test(String(error?.message ?? ''))
          // A 429 from a one-slot provider means the previous request is still
          // finishing. A short retry gets a real turn instead of finishing the run
          // with the provider's busy message.
          const rateLimited = error?.status === 429
          await delay((rateLimited ? 1_500 : overloaded ? 900 : 120) * 2 ** attempt, signal)
        } catch {
          return { aborted: true }
        }
      }
    }
    return { error: lastError ?? new Error('The model request failed.') }
  }

  /** Record a tool result in the transcript exactly once. */
  const pushToolResult = (call, output) => {
    memory.transcript.push({
      role: 'tool',
      tool_call_id: call.id,
      content: truncateOutput(output, MAX_TOOL_RESULT_IN_TRANSCRIPT),
    })
  }

  const repeatedActionNote = () => memory.loop.lastBlockedSignature
    ? ` The repeated action was \`${String(memory.loop.lastBlockedSignature).slice(0, 180)}\`.`
    : ''

  /** A blocked duplicate: visible to the user, returned to the model, never executed. */
  const blockDuplicate = (call, reason) => {
    const signature = signatureOf(call.name, call.args)
    emit({ type: 'reminder', text: reason, signature })
    emit({ type: 'tool_result', id: call.id, name: call.name, ok: false, output: reason })
    pushToolResult(call, reason)
    // Only the *same* blocked call, repeatedly, is a loop. Three different cached
    // calls are a model re-orienting after context was trimmed, not a loop.
    if (memory.loop.lastBlockedSignature !== signature) memory.loop.repeatedActions = 0
    memory.loop.lastBlockedSignature = signature
    memory.loop.repeatedActions += 1
    memory.metrics.duplicatesBlocked += 1
  }

  /**
   * A run that repeats a step has still done the work when the requested files exist.
   * Ending it as a failure made a successful edit look broken (ER.0204 after the file
   * was created), so the workspace decides whether there is anything left to do.
   */
  const finishIfWorkIsDone = async () => {
    if (!wantsWorkspaceChange) return null
    // Only a task that names files has an objective "done" to check. "Build a game"
    // names none, so a repeated action there is a loop, not completion.
    if (!requestedPaths(effectiveTask).length) return null
    if (!hasSuccessfulMutation(memory.steps, MUTATING_TOOLS)) return null
    const missing = await missingRequestedPaths(effectiveTask, workspace)
    if (missing.length) return null
    emit({
      type: 'reminder',
      text: 'The model repeated an action after the work was already done; ending the run with the workspace verified.',
    })
    emit({ type: 'phase', phase: PHASE.DONE })
    return finish('done', 'Completed the requested changes.')
  }

  /**
   * A repeated call that is missing required arguments cannot make progress; stop
   * with the argument error instead of counting it as an ordinary tool loop.
   */
  const stopForInvalidArguments = async (call) => {
    const summary =
      `Stopped because ${call.name} was requested again with missing required arguments. ` +
      'The first attempt was rejected instead of executed; use the available tool output to choose a different call.'
    emit({ type: 'error', error: summary, code: ERROR_CODES.TOOL_ARGUMENTS })
    return (await finishIfWorkIsDone()) ?? finish('failed', summary, ERROR_CODES.TOOL_ARGUMENTS)
  }

  /**
   * Repeated failure triggers one root-cause turn. The note is added only after the
   * tool result is recorded, so the assistant tool_calls message stays paired with it.
   */
  const noteOutcome = (outcome) => {
    if (outcome.ok) {
      memory.loop.consecutiveFailures = 0
      memory.loop.diagnosisSent = false
      return
    }
    memory.loop.consecutiveFailures += 1
    if (memory.loop.consecutiveFailures >= 2 && !memory.loop.diagnosisSent) {
      memory.loop.diagnosisSent = true
      memory.transcript.push({ role: 'user', content: DIAGNOSIS_NOTE })
      emit({
        type: 'status',
        text: 'Two actions failed; requiring a root-cause hypothesis before the next attempt…',
      })
    }
  }

  const recordToolOutcome = (call, outcome, step) => {
    if (outcome.ok && MUTATING_TOOLS.includes(call.name)) {
      // Keep the index and its reverse dependencies current, then check that any
      // relative import the change introduced still resolves inside the workspace.
      refreshProjectIndex(memory, workspace)
      const changed = outcome.invalidated ?? [outcome.path ?? outcome.dest_path ?? outcome.new_path].filter(Boolean)
      const warnings = unresolvedImports(memory.projectIndex, changed)
      if (warnings.length) {
        const known = new Set((memory.verificationWarnings ?? []).map((warning) => warning.message))
        const fresh = warnings.filter((warning) => !known.has(warning.message))
        if (fresh.length) {
          memory.verificationWarnings = [...(memory.verificationWarnings ?? []), ...fresh]
          emit({
            type: 'reminder',
            text: `Import check: ${fresh.map((warning) => warning.message).join(' ')} Fix the path or confirm the file is intentionally absent.`,
          })
        }
      }
    }
    recordStep(memory, {
      step: step + 1,
      name: call.name,
      args: call.args,
      ok: outcome.ok,
      output: outcome.output,
      diff: outcome.diff,
      timestamp: Date.now(),
    })
    emit({ type: 'tool_result', id: call.id, name: call.name, ok: outcome.ok, output: outcome.output })
    pushToolResult(call, outcome.output)
  }

  /** Execute one call. Returns `{done}` when the run must end. */
  const processCall = async (call, step) => {
    const signature = signatureOf(call.name, call.args)
    const gate = canAttempt(memory, signature, { allowRepeat: call.name === 'read_file' })
    if (!gate.allowed) {
      blockDuplicate(call, gate.reason)
      if (hasMissingRequiredArgs(call)) {
        return { done: await stopForInvalidArguments(call) }
      }
      if (memory.loop.repeatedActions >= MAX_REPEATED_ACTIONS) {
        return {
          done:
            (await finishIfWorkIsDone()) ??
            finish(
              'failed',
              `Stopped after ${MAX_REPEATED_ACTIONS} repeated actions made no progress.${repeatedActionNote()} Review the latest tool result and retry with a different step.`,
              ERROR_CODES.REPEATED_ACTIONS,
            ),
        }
      }
      return null
    }
    memory.loop.repeatedActions = 0
    memory.loop.lastBlockedSignature = null
    recordAttempt(memory, signature)
    noteSignature(memory, signature)

    if (call.name === 'finish') {
      // A task that names files must actually create them; a mutation elsewhere is not
      // completion of what was asked.
      const missing = wantsWorkspaceChange
        ? await missingRequestedPaths(effectiveTask, workspace)
        : []
      if (wantsWorkspaceChange && (!hasSuccessfulMutation(memory.steps, MUTATING_TOOLS) || missing.length)) {
        const refusal = missing.length
          ? `${FINISH_REFUSAL} The task also names ${missing.join(', ')}, which ${missing.length === 1 ? 'does not exist' : 'do not exist'} yet — create ${missing.length === 1 ? 'it' : 'them'}.`
          : FINISH_REFUSAL
        emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args })
        emit({ type: 'reminder', text: refusal })
        emit({ type: 'tool_result', id: call.id, name: call.name, ok: false, output: refusal })
        emit({ type: 'phase', phase: PHASE.ACT })
        pushToolResult(call, refusal)
        // A refused finish is not a completed attempt. Forgetting it lets the model
        // retry after doing the missing work instead of being blocked as a duplicate.
        memory.attempts.delete(signature)
        memory.loop.finishRefusals += 1
        if (memory.loop.finishRefusals >= 3) {
          const code = missing.length ? ERROR_CODES.MISSING_FILES : ERROR_CODES.STALLED
          const summary = missing.length
            ? `Stopped after 3 attempts to finish before creating ${missing.join(', ')}.`
            : 'Stopped after 3 attempts to finish before any file or folder change succeeded.'
          emit({ type: 'error', error: summary, code })
          return { done: finish('failed', summary, code) }
        }
        memory.transcript.push({ role: 'user', content: CONTINUE_AFTER_REFUSAL })
        return null
      }
      // The strongest honesty guarantee: before a change task is accepted, run the
      // project's real checks once per workspace state. A failure goes back to the
      // model as evidence to fix, not as a success. Approval is still respected.
      const preFinish = verificationState()
      if (
        autoVerify &&
        runCommand &&
        wantsWorkspaceChange &&
        preFinish.changed &&
        !preFinish.passedAfterChange &&
        memory.autoVerifyVersion !== memory.progressVersion &&
        detectVerificationCommands(memory.projectIndex).length
      ) {
        memory.autoVerifyVersion = memory.progressVersion
        const verificationCall = { id: `auto_verify_${toolIds.seq + 1}`, name: 'verify_project', args: {} }
        toolIds.seq += 1
        let allowed = true
        if (requiresApproval(verificationCall, autonomy) && !memory.alwaysAllow.has(approvalKeyFor(verificationCall))) {
          emit({ type: 'approval_requested', ...verificationCall, diff: null })
          const decision = await requestApproval({ ...verificationCall, diff: null })
          allowed = Boolean(decision?.approved)
        }
        if (allowed) {
          emit({ type: 'status', text: 'Running the project’s checks before accepting the result…' })
          const outcome = await executeTool(verificationCall, {
            workspace,
            runCommand,
            memory,
            emit,
            signal,
            projectIndex: memory.projectIndex,
          })
          if (!outcome.ok) {
            const note =
              'Automatic verification failed. Read the failing command output, identify the root cause, fix it, and only then finish. Do not claim success.\n\n' +
              outcome.output
            emit({ type: 'tool_result', id: call.id, name: 'finish', ok: false, output: note })
            emit({ type: 'reminder', text: note })
            pushToolResult(call, note)
            memory.transcript.push({ role: 'user', content: note })
            return null
          }
        }
      }

      const summary = call.args?.summary ?? 'Completed.'
      const state = verificationState()
      if (call.args?.verified && state.changed && !state.passedAfterChange) {
        emit({ type: 'verification_required', reason: 'No verification command passed after the last change.' })
        emit({ type: 'reminder', text: VERIFICATION_CLAIM_NOTE })
        memory.notes = [...(memory.notes ?? []), 'The model claimed verification without a passing check after the last change.']
      }
      emit({ type: 'phase', phase: PHASE.DONE })
      emit({ type: 'finish', summary, verified: Boolean(call.args?.verified) && state.passedAfterChange })
      return { done: finish('done', summary) }
    }

    emit({ type: 'tool_call', name: call.name, args: call.args, id: call.id })

    const key = approvalKeyFor(call)
    const needsApproval = requiresApproval(call, autonomy) && !memory.alwaysAllow.has(key)
    if (needsApproval) {
      let preview = { diff: null }
      try {
        preview = (await workspace.preview?.(call.name, call.args)) ?? { diff: null }
      } catch {
        preview = { diff: null }
      }
      const request = { id: call.id, name: call.name, args: call.args, diff: preview.diff, path: call.args?.path }
      emit({ type: 'approval_requested', ...request })
      const decision = await requestApproval(request)
      if (decision?.remember) memory.alwaysAllow.add(key)
      if (!decision?.approved) {
        const note = `The user DENIED this action: ${call.name}. Do not retry it. Propose an alternative or stop and ask.`
        recordAttempt(memory, signature, { failed: true, denied: true })
        emit({ type: 'tool_result', id: call.id, name: call.name, ok: false, output: note })
        pushToolResult(call, note)
        return null
      }
    }

    let outcome = await executeTool(call, { workspace, runCommand, memory, emit, signal, projectIndex: memory.projectIndex })

    // A tool's success claim is not proof the workspace changed.
    if (outcome.ok && MUTATING_TOOLS.includes(call.name)) {
      const verification = await verifyMutation(call, workspace, outcome)
      if (!verification.ok) {
        outcome = {
          ...outcome,
          ok: false,
          progress: false,
          output: `${outcome.output}\n\nVERIFICATION FAILED: ${verification.reason}`,
        }
        emit({ type: 'status', text: `Checking ${call.name}: ${verification.reason}` })
      }
    }

    if (!outcome.ok) {
      recordAttempt(memory, signature, { failed: true })
      emit({ type: 'phase', phase: PHASE.RECOVER })
    } else if (MUTATING_TOOLS.includes(call.name)) {
      if (outcome.progress !== false) noteProgress(memory, outcome.invalidated ?? [])
      recordAttempt(memory, signature)
    }
    if (call.name === 'run_command') emit({ type: 'phase', phase: PHASE.VERIFY })

    recordToolOutcome(call, outcome, step)
    noteOutcome(outcome)
    return null
  }

  /** Consecutive read-only calls run together; their results land in call order. */
  const processReadBatch = async (calls, step) => {
    const prepared = []
    let invalidBlocked = null
    for (const call of calls) {
      const signature = signatureOf(call.name, call.args)
      const gate = canAttempt(memory, signature, { allowRepeat: call.name === 'read_file' })
      if (!gate.allowed) {
        blockDuplicate(call, gate.reason)
        if (hasMissingRequiredArgs(call)) invalidBlocked = call
        continue
      }
      memory.loop.repeatedActions = 0
      memory.loop.lastBlockedSignature = null
      recordAttempt(memory, signature)
      noteSignature(memory, signature)
      emit({ type: 'tool_call', name: call.name, args: call.args, id: call.id })
      prepared.push({ call, signature })
    }
    if (!prepared.length) {
      if (invalidBlocked) return { done: await stopForInvalidArguments(invalidBlocked) }
      if (memory.loop.repeatedActions >= MAX_REPEATED_ACTIONS) {
        return {
          done:
            (await finishIfWorkIsDone()) ??
            finish(
              'failed',
              `Stopped after ${MAX_REPEATED_ACTIONS} repeated actions made no progress.${repeatedActionNote()} Review the latest tool result and retry with a different step.`,
              ERROR_CODES.REPEATED_ACTIONS,
            ),
        }
      }
      return null
    }

    const outcomes = await Promise.all(
      prepared.map(({ call }) => executeTool(call, { workspace, runCommand, memory, emit, signal, projectIndex: memory.projectIndex })),
    )

    for (let index = 0; index < prepared.length; index++) {
      const { call, signature } = prepared[index]
      const outcome = outcomes[index]
      if (!outcome.ok) {
        recordAttempt(memory, signature, { failed: true })
        emit({ type: 'phase', phase: PHASE.RECOVER })
      }
      recordToolOutcome(call, outcome, step)
    }
    // Inject the diagnosis note only after every tool result in the turn is recorded:
    // a user message between an assistant tool_calls turn and its results is invalid.
    noteOutcome({ ok: outcomes.every((entry) => entry.ok) })

    if (invalidBlocked) {
      return { done: await stopForInvalidArguments(invalidBlocked) }
    }

    if (memory.loop.repeatedActions >= MAX_REPEATED_ACTIONS) {
      return {
        done:
          (await finishIfWorkIsDone()) ??
          finish(
            'failed',
            `Stopped after ${MAX_REPEATED_ACTIONS} repeated actions made no progress.${repeatedActionNote()} Review the latest tool result and retry with a different step.`,
            ERROR_CODES.REPEATED_ACTIONS,
          ),
      }
    }
    return null
  }

  let finalStepRequested = false
  // Set after a prose-only reply: the next request demands a tool call.
  let forceToolNext = false
  let planEmitted = false
  let sequenceWarned = false
  let lastMutationStep = 0

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      emit({ type: 'aborted' })
      return finish('aborted', 'Stopped by user.', ERROR_CODES.ABORTED)
    }
    if (Date.now() - memory.metrics.startedAt > runBudgetMs) {
      const summary = `Stopped after ${Math.round(runBudgetMs / 1000)}s; the run exceeded its time budget.`
      emit({ type: 'error', error: summary, code: ERROR_CODES.TIME_BUDGET })
      return finish('failed', summary, ERROR_CODES.TIME_BUDGET)
    }
    if (!finalStepRequested && step === maxSteps - 1) {
      finalStepRequested = true
      memory.transcript.push({ role: 'user', content: FINAL_STEP_NOTE })
    }

    const requestMessages = insertFailureReminder(
      ensureToolResultPairing(buildTranscript(memory, { maxChars: memory.contextChars ?? DEFAULT_CONTEXT_CHARS })),
      memory,
    )
    const generation = await callModel(requestMessages, {
      toolChoice: forceToolNext && availableTools.length ? 'required' : undefined,
    })
    forceToolNext = false
    if (generation.contextOverflow) continue
    if (generation.aborted) {
      emit({ type: 'aborted' })
      return finish('aborted', 'Stopped by user.', ERROR_CODES.ABORTED)
    }
    if (generation.error) {
      const code = classifyModelError(generation.error)
      emit({ type: 'error', error: generation.error.message, code })
      return finish('failed', generation.error.message, code)
    }

    const result = generation.result ?? {}
    const toolCalls = (result.toolCalls ?? []).map(prepareToolCall)
    const content = sanitizeAssistantOutput(result.content)

    let repeatedText = false
    if (content.trim()) {
      const normalized = normalizeText(content)
      repeatedText = Boolean(normalized && normalized === memory.loop.lastText)
      memory.loop.lastText = normalized
      if (step === 0 && !planEmitted) {
        planEmitted = true
        memory.plan = { text: content.trim(), steps: extractPlan(content) }
        emit({ type: 'phase', phase: PHASE.PLAN })
        emit({ type: 'status', text: 'Planning the requested changes…' })
      }
    } else {
      memory.loop.lastText = ''
    }

    // Record the assistant turn. A repeated narration with no tool calls is not
    // appended again: echoing it back teaches small models to keep repeating.
    if (toolCalls.length || (content.trim() && !repeatedText)) {
      memory.transcript.push({
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length
          ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          }
          : {}),
      })
    }

    if (!toolCalls.length) {
      // Informational tasks are answered directly — no artificial tool turn.
      if (!wantsWorkspaceChange && content.trim()) {
        return finish('done', content.trim())
      }
      memory.loop.noActionTurns += 1
      memory.loop.identicalResponses = repeatedText ? memory.loop.identicalResponses + 1 : 0
      // Remove the earlier copy of the repeated text and require a tool call, so the
      // model cannot simply echo itself again.
      if (repeatedText) dropLastAssistantText(memory)
      forceToolNext = true
      emit({
        type: 'status',
        text: repeatedText
          ? 'The model repeated itself; removing the duplicate and requiring a tool call…'
          : 'Turning the response into a workspace action…',
      })
      // The requested change has landed and the model is describing it instead of
      // calling `finish`. That is a real completion only when every file the task named
      // exists; otherwise the run must keep going (or fail honestly).
      const missing = wantsWorkspaceChange
        ? await missingRequestedPaths(effectiveTask, workspace)
        : []
      const completedSoFar =
        wantsWorkspaceChange &&
        hasSuccessfulMutation(memory.steps, MUTATING_TOOLS) &&
        missing.length === 0
      if (missing.length) {
        emit({
          type: 'reminder',
          text: `Still missing: ${missing.join(', ')}. Create ${missing.length === 1 ? 'it' : 'them'} before describing the task as complete.`,
        })
      }
      if (completedSoFar && (repeatedText || memory.loop.noActionTurns >= 2)) {
        const summary = content.trim() || 'Completed the requested changes.'
        emit({
          type: 'reminder',
          text: 'The model described the result instead of calling `finish`; ending the run with its summary.',
        })
        emit({ type: 'phase', phase: PHASE.DONE })
        return finish('done', summary)
      }

      const repeatedOutOfBudget =
        repeatedText && memory.loop.identicalResponses + 1 >= MAX_IDENTICAL_RESPONSES
      if (repeatedOutOfBudget || memory.loop.noActionTurns >= MAX_NO_ACTION_TURNS) {
        if (missing.length) {
          const summary =
            `Stopped without creating ${missing.join(', ')}. The model described the result instead of finishing the requested work.` +
            (memory.metrics.toolCalls === 0
              ? ' The model made no tool calls at all, which usually means it does not support tool calling — choose a tool-capable model, or restate the task with concrete file names.'
              : '')
          emit({ type: 'error', error: summary, code: ERROR_CODES.MISSING_FILES })
          return finish('failed', summary, ERROR_CODES.MISSING_FILES)
        }
        const toolHint =
          memory.metrics.toolCalls === 0
            ? ' The model made no tool calls at all, which usually means it does not support tool calling — choose a tool-capable model, or restate the task with concrete file names.'
            : wantsWorkspaceChange
              ? ' Changes were attempted but none could be verified as applied — check the tool results for the failing write.'
              : ''
        const summary =
          (repeatedText
            ? `Stopped after ${memory.loop.identicalResponses + 1} identical responses without a tool action; the model kept repeating itself.`
            : `Stopped after ${MAX_NO_ACTION_TURNS} consecutive responses without a tool action. Clarify the task or check the selected local model.`) +
          toolHint
        const code = repeatedText ? ERROR_CODES.IDENTICAL_RESPONSES : ERROR_CODES.NO_ACTION
        emit({ type: 'error', error: summary, code })
        return finish('failed', summary, code)
      }
      memory.transcript.push({ role: 'user', content: noActionNudge(repeatedText) })
      continue
    }

    memory.loop.noActionTurns = 0
    memory.loop.identicalResponses = 0
    emit({ type: 'phase', phase: PHASE.ACT })

    // Walk the turn: read-only runs go together, everything else stays ordered so
    // a read always observes the write that preceded it.
    let index = 0
    while (index < toolCalls.length) {
      const call = toolCalls[index]
      let outcome = null

      if (isReadOnlyTool(call.name)) {
        const batch = []
        while (index < toolCalls.length && isReadOnlyTool(toolCalls[index].name)) {
          batch.push(toolCalls[index])
          index += 1
        }
        outcome = await processReadBatch(batch, step)
      } else {
        outcome = await processCall(call, step)
        index += 1
      }

      if (outcome?.done) return outcome.done
      if (signal?.aborted) {
        emit({ type: 'aborted' })
        return finish('aborted', 'Stopped by user.', ERROR_CODES.ABORTED)
      }
    }

    if (MUTATING_TOOLS.some((name) => memory.steps.some((record) => record.name === name && record.ok && record.step === step + 1))) {
      lastMutationStep = step
    }

    // A repeating multi-step pattern is a loop even when no single call repeats.
    const sequence = repeatingSequence(memory)
    if (sequence && !sequenceWarned) {
      sequenceWarned = true
      emit({
        type: 'reminder',
        text: `Repeated action pattern detected (${sequence.join(' → ')}). Change the approach or finish with what is known.`,
      })
    }

    if (wantsWorkspaceChange && step - lastMutationStep >= MAX_STALLED_STEPS) {
      const summary = `Stopped after ${MAX_STALLED_STEPS} steps without changing the workspace. The requested change was not made.`
      emit({ type: 'error', error: summary, code: ERROR_CODES.STALLED })
      return finish('failed', summary, ERROR_CODES.STALLED)
    }
  }

  const summary = `Stopped after ${maxSteps} steps without an explicit finish.`
  emit({ type: 'error', error: summary, code: ERROR_CODES.STEP_LIMIT })
  return finish('failed', summary, ERROR_CODES.STEP_LIMIT)
}

export { MAX_STEPS, PHASE, AGENT_SYSTEM_PROMPT }
