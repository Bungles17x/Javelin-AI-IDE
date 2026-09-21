/**
 * Fine-tune preparation CLI.
 * ==========================
 *
 * Reads a built dataset, generates `config.json` + `train.py` + `merge.py`, and
 * reports honestly whether the machine is actually ready to train.
 *
 *   node training/finetune/prepare.mjs --dataset datasets/javelin-2026-01-01
 *
 * This deliberately does NOT attempt to install or run PyTorch. It prepares the
 * run and tells the truth about what is missing, which is more useful than
 * failing mysteriously three steps into a GPU job.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { buildFinetuneConfig, buildTrainingScript, buildMergeScript } from './config.mjs'
import { fromJsonl, validateDataset } from '../dataset/format.js'
import { profileHardware, recommendMethod, recommendBaseModel, GPU_VENDOR } from '../hardware.mjs'
import { describeProvenance, provenancePath } from '../provenance.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

function parseArgs(argv) {
  const args = {
    dataset: null,
    baseModel: null, // chosen from detected hardware unless overridden
    outputDir: 'training/runs/javelin-lora',
    method: 'auto', // 'auto' | 'lora' | 'qlora'
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dataset') {
      args.dataset = argv[++i]
    } else if (a === '--base-model') {
      args.baseModel = argv[++i]
    } else if (a === '--output') {
      args.outputDir = argv[++i]
    } else if (a === '--method') {
      args.method = argv[++i]
    } else if (a === '--quantization') {
      // Back-compat: --quantization none previously meant plain LoRA.
      args.method = argv[++i] === 'none' ? 'lora' : 'qlora'
    } else if (a === '--dry-run') {
      args.dryRun = true
    } else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Javelin fine-tune preparation

  (no args)             Detect this machine's hardware and report viable paths
  --dataset <dir>       Directory produced by build-dataset.mjs
  --base-model <id>     Override the auto-selected base model
  --method <m>          auto | lora | qlora   (default auto)
  --output <dir>        Where the adapter will be written
  --dry-run             Generate configs, skip the Python environment check

Note: LoRA fine-tunes a base model's STYLE and POLICY. It does not create a
new model from scratch. See docs/TRAINING.md for what that would require.
`)
}

/**
 * Report the detected hardware and the paths that will actually work on it.
 * This replaces the old "a GPU is required" message, which was wrong on AMD
 * machines and gave no route forward.
 */
function reportHardware(hw, method, baseModel) {
  console.log('[0/4] Detecting hardware')
  console.log(`      GPU      ${hw.primaryGpu?.name ?? 'none detected'}`)
  console.log(`      VRAM     ${hw.vramGb ? hw.vramGb + ' GB' : 'unknown'}`)
  console.log(`      RAM      ${hw.ramGb ? hw.ramGb + ' GB' : 'unknown'}`)
  if (hw.vendor === GPU_VENDOR.AMD && hw.amdFamily) {
    console.log(`      AMD      ${hw.amdFamily.family} family`)
  }
  console.log(`      WSL      ${hw.wsl.available ? hw.wsl.distros.join(', ') || 'available' : 'not installed'}`)
  console.log(`      ROCm     ${hw.rocm.installed ? 'installed' : 'not detected'}`)

  console.log(`\n[1/4] Recommended configuration`)
  console.log(`      base model : ${baseModel.model}`)
  console.log(`      method     : ${method.method.toUpperCase()} — ${method.reason}`)
  console.log(`      why        : ${baseModel.reason}`)

  console.log(`\n[2/4] Training paths for this machine`)
  for (const path of hw.recommendation.paths) {
    const mark = path.works ? 'VIABLE' : 'NOT   '
    console.log(`\n      [${mark}] ${path.name}`)
    console.log(`               ${path.detail}`)
    for (const step of path.steps) {
      console.log(`                 - ${step}`)
    }
  }
}

/** Check the Python side honestly, so failures happen now rather than mid-job. */
function checkEnvironment() {
  const checks = []

  const python = findPython()
  if (!python) {
    checks.push({
      name: 'python',
      ok: false,
      detail: 'python not found on PATH. Install Python 3.10+.',
    })
    return checks
  }
  checks.push({ name: 'python', ok: true, detail: python.version })

  const torch = probePython(python.cmd, 'import torch; print(torch.__version__)')
  checks.push({
    name: 'torch',
    ok: torch.ok,
    detail: torch.ok ? torch.out : 'not installed — pip install torch',
  })

  const cuda = probePython(
    python.cmd,
    'import torch; print("yes" if torch.cuda.is_available() else "no")',
  )
  const hasCuda = cuda.ok && cuda.out.trim() === 'yes'
  checks.push({
    name: 'CUDA GPU',
    ok: hasCuda,
    detail: hasCuda
      ? 'detected'
      : 'not available — training will be extremely slow or impossible on CPU',
  })

  const transformers = probePython(python.cmd, 'import transformers; print(transformers.__version__)')
  checks.push({
    name: 'transformers',
    ok: transformers.ok,
    detail: transformers.ok ? transformers.out : 'not installed — pip install transformers',
  })

  const peft = probePython(python.cmd, 'import peft; print(peft.__version__)')
  checks.push({
    name: 'peft',
    ok: peft.ok,
    detail: peft.ok ? peft.out : 'not installed — pip install peft',
  })

  return checks
}

function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
    if (res.status === 0 && (res.stdout || res.stderr)) {
      return { cmd, version: (res.stdout || res.stderr).trim() }
    }
  }
  return null
}

function probePython(cmd, code) {
  try {
    const res = spawnSync(cmd, ['-c', code], { encoding: 'utf8', timeout: 60_000 })
    if (res.status === 0) {
      return { ok: true, out: (res.stdout || '').trim() }
    }
    return { ok: false, out: (res.stderr || '').trim().split('\n').pop() ?? '' }
  } catch (err) {
    return { ok: false, out: err.message }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('\n=== Javelin fine-tune preparation ===\n')

  // Always profile first: the advice depends on it, and running with no dataset
  // is the most useful thing someone can do on a fresh machine.
  const hw = profileHardware()
  const method = recommendMethod(hw, args.method)
  const baseModel = args.baseModel
    ? { model: args.baseModel, reason: 'explicitly requested' }
    : recommendBaseModel(hw)

  if (!args.dataset) {
    reportHardware(hw, method, baseModel)
    console.log('\nNo --dataset given, so nothing was generated.')
    console.log('Build one, then re-run with it:')
    console.log('  npm run train:dataset --out datasets/javelin-v0')
    console.log('  npm run train:prepare --dataset datasets/javelin-v0\n')
    return
  }

  reportHardware(hw, method, baseModel)
  console.log('')

  // ---- Read and validate the dataset -------------------------------------
  const datasetDir = join(root, args.dataset)
  const trainPath = join(datasetDir, 'train.jsonl')
  const validationPath = join(datasetDir, 'validation.jsonl')

  console.log(`[1/4] Reading dataset from ${args.dataset}`)
  if (!existsSync(trainPath)) {
    console.error(`ERROR: ${trainPath} does not exist.`)
    console.error('       Run build-dataset.mjs first.\n')
    process.exit(1)
  }

  const trainText = readFileSync(trainPath, 'utf8')
  const valText = existsSync(validationPath) ? readFileSync(validationPath, 'utf8') : ''
  const { records: train, errors: trainErrors } = fromJsonl(trainText)
  const { records: validation } = fromJsonl(valText)

  for (const e of trainErrors) {
    console.warn(`  ! ${e}`)
  }
  console.log(`      ${train.length} training record(s)`)
  console.log(`      ${validation.length} validation record(s)`)

  if (train.length === 0) {
    console.error('\nERROR: the training split is empty. Nothing to train on.\n')
    process.exit(1)
  }

  // ---- Re-validate: never train on an unvalidated dataset -----------------
  console.log(`\n[2/4] Validating`)
  const validation3 = validateDataset([...train, ...validation])
  if (!validation3.ok) {
    console.error(`      ${validation3.errors.length} error(s) — refusing to prepare a run:`)
    for (const e of validation3.errors.slice(0, 10)) {
      console.error(`        ! ${e}`)
    }
    process.exit(1)
  }
  const stats = validation3.stats
  console.log(`      valid. skills: ${JSON.stringify(stats.bySkill)}`)
  console.log(`      sources:     ${JSON.stringify(stats.bySource)}`)

  // ---- Advise on data quality --------------------------------------------
  reportDataQuality(stats)

  // If a previous run exists, say plainly whether it trained anything. Selecting the
  // Javelin provider only makes sense if it did.
  const runDir = join(root, args.outputDir)
  if (existsSync(provenancePath(runDir))) {
    console.log(`\n[3/4] Existing run at ${args.outputDir}`)
    const summary = describeProvenance(runDir)
    console.log(`      ${summary.headline}`)
    for (const line of summary.lines) {
      console.log(`      ${line}`)
    }
  } else {
    console.log(`\n[3/4] Generating configuration`)
  }

  const config = buildFinetuneConfig({
    baseModel: baseModel.model,
    trainPath: args.dataset + '/train.jsonl',
    validationPath: args.dataset + '/validation.jsonl',
    outputDir: args.outputDir,
    trainCount: train.length,
    validationCount: validation.length,
    quantization: method.method === 'qlora' ? '4bit' : 'none',
    method: method.method,
    hardware: { vendor: hw.vendor, vramGb: hw.vramGb, ramGb: hw.ramGb },
  })

  const outDir = join(root, 'training', 'finetune')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
  writeFileSync(join(outDir, 'train.py'), buildTrainingScript(config), 'utf8')
  writeFileSync(join(outDir, 'merge.py'), buildMergeScript(), 'utf8')

  console.log(`      config.json  (${method.method.toUpperCase()} r=${config.lora.r}, lr=${config.training.learningRate}, epochs=${config.training.epochs})`)
  console.log(`      train.py`)
  console.log(`      merge.py`)
  if (method.downgraded) {
    console.log(`      · ${method.reason}`)
  }
  for (const note of config.notes) {
    console.log(`      · ${note}`)
  }

  // ---- Environment check --------------------------------------------------
  if (!args.dryRun) {
    console.log(`\n[4/4] Checking the Python environment`)
    const checks = checkEnvironment()
    let blocking = 0
    for (const c of checks) {
      const mark = c.ok ? 'ok  ' : 'MISS'
      if (!c.ok) {
        blocking++
      }
      console.log(`      [${mark}] ${c.name.padEnd(14)} ${c.detail}`)
    }

    if (blocking > 0) {
      console.log('\n      Python dependencies are missing. The exact install command depends')
      console.log('      on which training path you take — see the guidance above.')
    } else {
      console.log('\n      Python environment looks ready.')
    }

    console.log('\n      Start training with:')
    console.log('        python training/finetune/train.py')
  } else {
    console.log('\n[4/4] Environment check skipped (--dry-run)')
  }

  console.log('\nNote: this prepares a LoRA adapter that teaches Javelin\'s policy to a\n' +
    'base model. It does not train a model from scratch — see docs/TRAINING.md.\n')
}

/** Say plainly when the data is too thin to be worth a training run. */
function reportDataQuality(stats) {
  const issues = []

  if (stats.total < 100) {
    issues.push(
      `Only ${stats.total} examples. Fine-tuning on this will barely move the model. ` +
      `Aim for 500–5000+ real traces.`,
    )
  }
  const synthetic = stats.bySource.synthetic ?? 0
  if (synthetic > 0 && stats.total > 0) {
    const pct = Math.round((synthetic / stats.total) * 100)
    if (pct > 70) {
      issues.push(
        `${pct}% of examples are synthetic seeds. Train briefly, then replace them ` +
        `with real traces — a model trained mostly on generated data learns generated habits.`,
      )
    }
  }
  const repairCount = stats.bySkill.repair ?? 0
  if (stats.total > 50 && repairCount === 0) {
    issues.push(
      'No repair examples. Repair is the hardest and most valuable behaviour; ' +
      'capture runs where Javelin recovers from a failure.',
    )
  }
  if (stats.verified === 0) {
    issues.push(
      'No verified runs. Training on unverified output teaches the model to be unverified.',
    )
  }

  if (issues.length) {
    console.log('\n      --- data quality notes ---')
    for (const i of issues) {
      console.log(`      ! ${i}`)
    }
  }
}

main()
