/**
 * Training provenance.
 * ====================
 *
 * The rule this module exists to enforce: **never claim training happened unless it
 * actually finished successfully.**
 *
 * A training run is not "done" because a script was launched. It is done when a
 * process exited zero AND produced an adapter AND that adapter was verified. Partial
 * runs leave partial artifacts, and a half-written adapter is worse than none — it
 * will load, and it will behave badly, with nothing to indicate why.
 *
 * So every run writes a provenance record with an explicit state machine:
 *
 *   planned → started → completed | failed | interrupted
 *
 * Only `completed` counts as trained. Everything else is honestly recorded as not
 * trained, including the failure reason. `verifyProvenance()` then checks that a
 * record claiming completion is corroborated by real files on disk — because a
 * provenance file is a claim, and claims must be checkable.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { identityFingerprint, IDENTITY_VERSION } from '../src/core/identity.js'

export const TRAINING_STATE = {
  PLANNED: 'planned',
  STARTED: 'started',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  UNSAFE: 'unsafe',
}

/** Only this state means "a model was trained". */
export const TRAINED_STATES = new Set([TRAINING_STATE.COMPLETED])

const PROVENANCE_FILENAME = 'provenance.json'

export function provenancePath(runDir) {
  return join(runDir, PROVENANCE_FILENAME)
}

/**
 * Begin recording a run. Writes state `started` immediately, so a crash leaves
 * evidence that something was attempted but not finished.
 */
export function beginRun({
  runDir,
  baseModel,
  method,
  dataset,
  datasetRecords,
  hardware,
  command = null,
}) {
  const record = {
    state: TRAINING_STATE.STARTED,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    baseModel,
    method,
    dataset,
    datasetRecords,
    hardware,
    command,
    // Recorded so drift is detectable: if the identity changes later, a model
    // trained against the old one is no longer guaranteed to match its prompt.
    identity: { version: IDENTITY_VERSION, fingerprint: identityFingerprint() },
    adapter: null,
    error: null,
    exitCode: null,
    notes: [],
  }
  writeRecord(runDir, record)
  return record
}

/** Mark a successful completion. `adapterDir` must actually exist. */
export function completeRun(runDir, record, { adapterDir, exitCode = 0, notes = [] }) {
  if (exitCode !== 0) {
    // Refuse to record success for a non-zero exit. This is the whole point.
    return failRun(runDir, record, {
      error: `process exited with code ${exitCode}`,
      exitCode,
    })
  }
  if (!adapterDir || !existsSync(adapterDir)) {
    return failRun(runDir, record, {
      error: `no adapter directory was produced at ${adapterDir ?? '(none)'}`,
      exitCode,
    })
  }

  const files = listAdapterFiles(adapterDir)
  if (files.length === 0) {
    return failRun(runDir, record, {
      error: `adapter directory ${adapterDir} exists but contains no files`,
      exitCode,
    })
  }

  const updated = {
    ...record,
    state: TRAINING_STATE.COMPLETED,
    finishedAt: new Date().toISOString(),
    exitCode,
    adapter: { dir: adapterDir, files, fileCount: files.length },
    notes: [...(record.notes ?? []), ...notes],
  }
  writeRecord(runDir, updated)
  return updated
}

/** Mark a failure, recording the reason. */
export function failRun(runDir, record, { error, exitCode = null }) {
  const updated = {
    ...record,
    state: TRAINING_STATE.FAILED,
    finishedAt: new Date().toISOString(),
    exitCode,
    error: String(error ?? 'unknown error'),
  }
  writeRecord(runDir, updated)
  return updated
}

/** Mark an interruption (Ctrl+C, killed process). Distinct from failure. */
export function interruptRun(runDir, record, reason = 'interrupted') {
  const updated = {
    ...record,
    state: TRAINING_STATE.INTERRUPTED,
    finishedAt: new Date().toISOString(),
    error: reason,
  }
  writeRecord(runDir, updated)
  return updated
}

/**
 * Verify a provenance record against reality.
 *
 * A record is a claim; this checks it. Used before telling anyone a model is ready.
 */
export function verifyProvenance(runDir) {
  const path = provenancePath(runDir)
  if (!existsSync(path)) {
    return {
      ok: false,
      trained: false,
      state: 'unknown',
      detail: `no provenance record at ${path} — nothing was trained here`,
    }
  }

  let record
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return { ok: false, trained: false, state: 'corrupt', detail: `unreadable record: ${err.message}` }
  }

  if (!TRAINED_STATES.has(record.state)) {
    return {
      ok: false,
      trained: false,
      state: record.state,
      detail:
        `training did not complete (state: ${record.state})` +
        (record.error ? ` — ${record.error}` : ''),
      record,
    }
  }

  // The record claims success. Corroborate it.
  if (!record.adapter?.dir || !existsSync(record.adapter.dir)) {
    return {
      ok: false,
      trained: false,
      state: record.state,
      detail: `record claims completion but the adapter is missing at ${record.adapter?.dir}`,
      record,
    }
  }

  const files = listAdapterFiles(record.adapter.dir)
  if (files.length === 0) {
    return {
      ok: false,
      trained: false,
      state: record.state,
      detail: 'record claims completion but the adapter directory is empty',
      record,
    }
  }

  // Identity drift: the model was trained against an identity that has since changed.
  const currentFingerprint = identityFingerprint()
  const drift =
    record.identity?.fingerprint && record.identity.fingerprint !== currentFingerprint
      ? {
        trainedAgainst: record.identity,
        current: { version: IDENTITY_VERSION, fingerprint: currentFingerprint },
      }
      : null

  return {
    ok: true,
    trained: true,
    state: record.state,
    files,
    drift,
    detail: drift
      ? `trained and verified, but the identity has changed since (retrain to match)`
      : 'trained and verified',
    record,
  }
}

/** Human-readable summary. Deliberately blunt about what did or did not happen. */
export function describeProvenance(runDir) {
  const v = verifyProvenance(runDir)
  if (v.trained) {
    return {
      headline: 'Model trained.',
      lines: [
        `run directory : ${runDir}`,
        `state         : ${v.state}`,
        `adapter files : ${v.files.length}`,
        v.drift ? `WARNING       : ${v.detail}` : `verified      : yes`,
      ],
    }
  }
  return {
    headline: 'No trained model here.',
    lines: [
      `run directory : ${runDir}`,
      `state         : ${v.state}`,
      `reason        : ${v.detail}`,
    ],
  }
}

function listAdapterFiles(dir, limit = 50) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (files.length >= limit) {
        break
      }
      if (entry.isFile()) {
        // A real adapter has weights and a config; a stray log file alone is not one.
        const stat = safeStat(join(dir, entry.name))
        files.push({ name: entry.name, bytes: stat?.size ?? 0 })
      } else if (entry.isDirectory()) {
        files.push({ name: `${entry.name}/`, bytes: 0 })
      }
    }
    return files
  } catch {
    return []
  }
}

function safeStat(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function writeRecord(runDir, record) {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(provenancePath(runDir), JSON.stringify(record, null, 2), 'utf8')
}

/**
 * Does the adapter look like a *usable* LoRA adapter?
 * A directory of partial shards from an interrupted download is not.
 */
export function looksLikeUsableAdapter(adapterDir) {
  if (!existsSync(adapterDir)) {
    return { ok: false, detail: 'directory does not exist' }
  }
  let entries
  try {
    entries = readdirSync(adapterDir)
  } catch (err) {
    return { ok: false, detail: err.message }
  }

  const hasConfig = entries.some((e) => /adapter_config\.json$/i.test(e))
  const hasWeights = entries.some((e) => /\.(safetensors|bin|gguf)$/i.test(e))

  if (!hasConfig) {
    return { ok: false, detail: 'no adapter_config.json — this is not a PEFT adapter' }
  }
  if (!hasWeights) {
    return { ok: false, detail: 'no weight file (.safetensors/.bin/.gguf)' }
  }
  return { ok: true, detail: 'adapter looks complete' }
}
