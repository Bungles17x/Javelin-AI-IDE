/**
 * Training runner.
 * ================
 *
 * Launches the fine-tune and records the truth about what happened.
 *
 * This exists because "I ran the training script" and "a model was trained" are not
 * the same statement. This runner:
 *
 *   1. Checks prerequisites BEFORE starting, so failures are fast and legible.
 *   2. Writes a provenance record in the `started` state, so a crash leaves evidence.
 *   3. Streams the real subprocess output — no invented progress.
 *   4. On exit, verifies the adapter actually exists and is usable, then records
 *      `completed`. Non-zero exit, missing artifacts, or an interrupt are recorded
 *      as exactly that.
 *
 * It never prints a success message it cannot substantiate.
 *
 *   node training/train.mjs --run training/runs/javelin-lora
 */

//! IMPORTANT: DO NOT mess with this file unless instructed to, as this file is critical to the system, training process and any changes may break the training pipeline.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  beginRun, completeRun, failRun, interruptRun,
  verifyProvenance, looksLikeUsableAdapter, describeProvenance,
} from './provenance.mjs'
import { profileHardware, recommendMethod, recommendBaseModel } from './hardware.mjs'
import { fromJsonl } from './dataset/format.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function parseArgs(argv) {
  const args = {
    run: null,
    dataset: null,
    image: false,
    dryRun: false,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--run') {
      args.run = argv[++i]
    } else if (a === '--dataset') {
      args.dataset = argv[++i]
    } else if (a === '--dry-run') {
      args.dryRun = true
    } else if (a === '--verbose') {
      args.verbose = true
    } else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Javelin training runner

  --run <dir>        Run directory written by prepare.mjs (required)
  --dataset <dir>    Override the dataset directory from the config
  --dry-run          Validate everything, then stop without training
  --verbose          Pass through all subprocess output

This runner will not report success unless the trainer exited 0 AND a usable
adapter exists on disk. A partial run is recorded as failed or interrupted.
`)
}

/** Find a usable Python interpreter. */
function findPython() {
  return process.env.JAVELIN_PYTHON || 'python'
}

/** Run a command and resolve with its exit code and captured output. */
function runProcess(command, args, { cwd, onOutput, echo }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (buf) => {
      const text = buf.toString()
      stdout += text
      if (echo) {
        process.stdout.write(text)
      }
      onOutput?.({ stream: 'stdout', text })
    })
    child.stderr?.on('data', (buf) => {
      const text = buf.toString()
      stderr += text
      if (echo) {
        process.stderr.write(text)
      }
      onOutput?.({ stream: 'stderr', text })
    })

    child.on('error', (err) => {
      resolve({ code: null, error: err, stdout, stderr })
    })
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** Resolve the run directory from --run, or null if it cannot be determined. */
function resolveRunDir(argRun) {
  if (!argRun) {
    return null
  }
  return join(root, argRun)
}

/**
 * Record a preflight failure so the ledger is complete.
 * A run that never started is still a run worth accounting for — otherwise the
 * absence of a record is ambiguous between "never attempted" and "failed early".
 */
function recordPreflightFailure(runDir, { reason, dataset }) {
  if (!runDir) {
    return
  }
  try {
    const record = beginRun({
      runDir,
      baseModel: '(unknown — preflight failed)',
      method: '(unknown)',
      dataset: dataset ?? { dir: null, trainRecords: 0 },
      datasetRecords: dataset?.trainRecords ?? 0,
      hardware: null,
      command: null,
    })
    failRun(runDir, record, { error: `preflight: ${reason}` })
  } catch {
    // Never let bookkeeping mask the real error.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('\n=== Javelin training ===\n')

  if (!args.run) {
    console.error('ERROR: --run <dir> is required.')
    console.error('  Generate it first:  npm run train:prepare --dataset datasets/<name>')
    console.error('  Or run with no arguments for hardware guidance.\n')
    process.exit(1)
  }

  const runDir = resolveRunDir(args.run)
  const configPath = join(root, 'training', 'finetune', 'config.json')
  const trainerPath = join(root, 'training', 'finetune', 'train.py')

  // ---- Preflight: fail fast and legibly ----------------------------------
  console.log('[1/5] Checking prerequisites')

  if (!existsSync(configPath)) {
    console.error(`  ERROR: no config at ${configPath}`)
    console.error('  Run:  npm run train:prepare --dataset datasets/<name>\n')
    recordPreflightFailure(runDir, { reason: 'no fine-tune config found' })
    process.exit(1)
  }
  if (!existsSync(trainerPath)) {
    console.error(`  ERROR: no trainer at ${trainerPath}`)
    recordPreflightFailure(runDir, { reason: 'no trainer script found' })
    process.exit(1)
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'))

  // ---- Dataset ------------------------------------------------------------
  const datasetDir = args.dataset
    ? join(root, args.dataset)
    : join(root, config.dataset.trainPath.replace(/\/train\.jsonl$/, ''))

  const trainPath = join(datasetDir, 'train.jsonl')
  if (!existsSync(trainPath)) {
    console.error(`  ERROR: dataset not found at ${trainPath}`)
    console.error('  Build it:  npm run train:dataset --out datasets/<name>\n')
    recordPreflightFailure(runDir, { reason: `dataset not found at ${trainPath}` })
    process.exit(1)
  }

  const { records: trainRecords, errors: parseErrors } = fromJsonl(readFileSync(trainPath, 'utf8'))
  if (parseErrors.length) {
    console.error(`  ERROR: dataset has ${parseErrors.length} unparseable line(s)`)
    for (const e of parseErrors.slice(0, 3)) {
      console.error(`    ! ${e}`)
    }
    recordPreflightFailure(runDir, { reason: `dataset has ${parseErrors.length} unparseable line(s)` })
    process.exit(1)
  }
  if (trainRecords.length === 0) {
    console.error('  ERROR: dataset is empty.\n')
    recordPreflightFailure(runDir, { reason: 'dataset is empty' })
    process.exit(1)
  }
  console.log(`  dataset   : ${trainRecords.length} training record(s)`)

  // ---- Python and torch ---------------------------------------------------
  const python = findPython()
  const versionCheck = await runProcess(python, ['--version'], { cwd: root, echo: false })
  if (versionCheck.code !== 0) {
    console.error(`  ERROR: python not usable ("${python}")`)
    console.error(`    ${(versionCheck.stderr || versionCheck.error?.message || '').trim()}`)
    console.error('\n  Install Python 3.10+ and make it available, or set JAVELIN_PYTHON.\n')
    recordPreflightFailure(runDir, {
      reason: `python not usable ("${python}"): ${(versionCheck.error?.message || '').trim()}`,
      dataset: { dir: datasetDir, trainRecords: trainRecords.length },
    })
    process.exit(1)
  }
  console.log(`  python    : ${versionCheck.stdout.trim() || versionCheck.stderr.trim()}`)

  const torchCheck = await runProcess(
    python,
    ['-c', 'import torch, transformers, peft; print(torch.__version__)'],
    { cwd: root, echo: false },
  )
  if (torchCheck.code !== 0) {
    console.error('  ERROR: training dependencies are not installed.')
    console.error(`    ${(torchCheck.stderr || '').trim().split('\n').slice(-3).join('\n    ')}`)
    console.error('\n  Install for your hardware path — run  node training/finetune/prepare.mjs')
    console.error('  for the exact command. CPU is a supported path.\n')
    recordPreflightFailure(runDir, {
      reason: 'training dependencies missing (torch/transformers/peft)',
      dataset: { dir: datasetDir, trainRecords: trainRecords.length },
    })
    process.exit(1)
  }
  console.log(`  torch     : ${torchCheck.stdout.trim()}`)

  // ---- Hardware -----------------------------------------------------------
  const hw = profileHardware()
  const method = recommendMethod(hw, config.method ?? 'auto')
  const suggested = recommendBaseModel(hw)
  console.log(`  hardware  : ${hw.recommendation.summary}`)
  console.log(`  method    : ${method.method}${method.downgraded ? ` (downgraded: ${method.reason})` : ''}`)
  console.log(`  base      : ${config.baseModel}`)

  if (config.baseModel !== suggested.model && args.verbose) {
    console.log(`  note      : the generator would now suggest ${suggested.model} (${suggested.reason})`)
  }

  if (args.dryRun) {
    console.log('\n[2/5] --dry-run: stopping before training.')
    console.log('      Everything checked out; nothing was trained.\n')
    return
  }

  // ---- Begin the run with honest provenance -------------------------------
  console.log('\n[2/5] Starting run')
  mkdirSync(runDir, { recursive: true })

  let record = beginRun({
    runDir,
    baseModel: config.baseModel,
    method: method.method,
    dataset: { dir: datasetDir, trainRecords: trainRecords.length },
    datasetRecords: trainRecords.length,
    hardware: { vendor: hw.vendor, vramGb: hw.vramGb, ramGb: hw.ramGb, bestPath: hw.recommendation.best?.id },
    command: `${python} training/finetune/train.py`,
  })
  console.log(`  provenance written (state: ${record.state})`)

  // ---- Train --------------------------------------------------------------
  console.log('\n[3/5] Training')
  console.log('  (output streams below; this is real, not simulated)\n')

  const started = await runProcess(python, ['training/finetune/train.py'], {
    cwd: root,
    echo: true,
  })

  // ---- Interpret the outcome honestly -------------------------------------
  console.log('\n[4/5] Checking outcome')

  if (started.error && !started.code) {
    record = failRun(runDir, record, { error: started.error.message })
    report(record, 'The trainer could not be started.')
    process.exit(1)
  }

  if (started.signal) {
    record = interruptRun(runDir, record, `terminated by signal ${started.signal}`)
    report(record, 'Training was interrupted.')
    process.exit(130)
  }

  if (started.code !== 0) {
    record = failRun(runDir, record, {
      error: `trainer exited with code ${started.code}`,
      exitCode: started.code,
    })
    report(record, 'Training failed.')
    process.exit(started.code ?? 1)
  }

  // Exit code 0 is necessary but NOT sufficient: the adapter must exist.
  const adapterDir = join(root, config.output.dir)
  const usable = looksLikeUsableAdapter(adapterDir)
  if (!usable.ok) {
    record = failRun(runDir, record, {
      error: `trainer exited 0 but the adapter is not usable: ${usable.detail}`,
      exitCode: 0,
    })
    report(record, 'Training exited successfully but produced no usable adapter.')
    process.exit(1)
  }

  record = completeRun(runDir, record, {
    adapterDir,
    exitCode: 0,
    notes: [`adapter verified: ${usable.detail}`],
  })

  // ---- Verify independently ----------------------------------------------
  console.log('\n[5/5] Verifying')
  const verification = verifyProvenance(runDir)

  console.log('\n=== Success ===\n')
  console.log(`  adapter   : ${adapterDir}`)
  console.log(`  files     : ${verification.files?.length ?? 0}`)
  console.log(`  state     : ${verification.state}`)
  if (verification.drift) {
    console.log('  WARNING   : the identity changed since training; retrain to match.')
  }
  console.log('\n  Next steps:')
  console.log('    1. Merge into the base weights:  python training/finetune/merge.py')
  console.log('    2. Evaluate it before trusting it:')
  console.log('         (see reportEngineFitness in src/core/javelinEngine.js)')
  console.log('    3. Serve it:  ollama create javelin -f Modelfile')
  console.log('    4. Select "Javelin (fine-tuned)" as the provider in VS Code.')
  console.log('\n  A trained adapter is not a good model until fitness says so.\n')
}

function report(record, headline) {
  console.log(`\n=== ${headline} ===\n`)
  console.log(`  state     : ${record.state}`)
  console.log(`  reason    : ${record.error}`)
  console.log(`\n  No model was trained. Nothing should be served as "Javelin" yet.`)
  console.log(`  Provenance recorded at training/runs/ (for diagnosis).\n`)
}

main()
