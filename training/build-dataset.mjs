/**
 * Dataset builder CLI.
 * ===================
 *
 * The command that turns a pile of captured traces into a training-ready dataset.
 *
 *   node training/build-dataset.mjs                      # seeds only
 *   node training/build-dataset.mjs --traces traces/      # import captured traces
 *   node training/build-dataset.mjs --traces traces/ --out datasets/javelin-v0
 *
 * Pipeline stages, in order:
 *   load traces  →  export examples  →  merge seeds  →  dedupe  →  validate
 *   →  filter  →  split  →  write
 *
 * Each stage prints what it did, because a dataset you cannot inspect is a dataset
 * you cannot trust.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateDataset, dedupe, split, toJsonl, fromJsonl } from './dataset/format.js'
import { exportDataset } from './dataset/exporter.js'
import { buildSeedDataset, SEED_SYSTEM_PROMPT } from './dataset/seeds.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Minimal argument parsing — no dependency, and the flags are few. */
function parseArgs(argv) {
  const args = {
    traces: [],
    out: null,
    includeSeeds: true,
    minWeight: 0,
    validationFraction: 0.1,
    seed: 1337,
    verifyOnly: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--traces') {
      args.traces.push(argv[++i])
    } else if (a === '--out') {
      args.out = argv[++i]
    } else if (a === '--no-seeds') {
      args.includeSeeds = false
    } else if (a === '--min-weight') {
      args.minWeight = Number(argv[++i])
    } else if (a === '--validation-fraction') {
      args.validationFraction = Number(argv[++i])
    } else if (a === '--seed') {
      args.seed = Number(argv[++i])
    } else if (a === '--verify-only') {
      args.verifyOnly = true
    } else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Javelin dataset builder

  --traces <path>            Trace file or directory of .jsonl traces (repeatable)
  --out <dir>                Output directory (default: datasets/javelin-<timestamp>)
  --no-seeds                 Exclude the synthetic seed corpus
  --min-weight <n>           Drop examples below this weight (default 0)
  --validation-fraction <n>  Hold-out fraction (default 0.1)
  --seed <n>                 Shuffle seed for a reproducible split (default 1337)
  --verify-only              Validate and report, write nothing
`)
}

/** Collect .jsonl trace files from a file or directory path. */
function collectTraceFiles(paths) {
  const files = []
  for (const p of paths) {
    const abs = join(root, p)
    if (!existsSync(abs)) {
      console.warn(`  ! trace path does not exist: ${p}`)
      continue
    }
    const stat = safeStat(abs)
    if (stat?.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        if (entry.endsWith('.jsonl')) {
          files.push(join(abs, entry))
        }
      }
    } else {
      files.push(abs)
    }
  }
  return files
}

function safeStat(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function loadTraces(files) {
  const records = []
  const errors = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const { records: parsed, errors: parseErrors } = fromJsonl(text)
    errors.push(...parseErrors.map((e) => `${basename(file)}: ${e}`))
    for (const r of parsed) {
      if (r.kind === 'trajectory') {
        records.push(r)
      } else if (r.kind === 'sft') {
        // Already-exported examples can be merged directly.
        records.push({ __alreadySft: true, record: r })
      }
    }
  }
  return { records, errors }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('\n=== Javelin dataset builder ===\n')

  // ---- Stage 1: load traces -----------------------------------------------
  const traceFiles = collectTraceFiles(args.traces)
  console.log(`[1/7] Loading traces`)
  console.log(`      ${traceFiles.length} file(s)`)

  const { records: loaded, errors: loadErrors } = loadTraces(traceFiles)
  for (const e of loadErrors) {
    console.warn(`      ! ${e}`)
  }

  const trajectories = loaded.filter((r) => !r.__alreadySft)
  const preExported = loaded.filter((r) => r.__alreadySft).map((r) => r.record)
  console.log(`      ${trajectories.length} trajectory(ies), ${preExported.length} pre-exported example(s)`)

  // ---- Stage 2: export examples -------------------------------------------
  console.log(`\n[2/7] Exporting training examples from trajectories`)
  const exported = exportDataset(trajectories, {
    systemPrompt: SEED_SYSTEM_PROMPT,
    toolSchemas: [], // tool schemas are attached per-record when captured
  })
  const bySkill = countBy(exported, (r) => r.skill)
  console.log(`      ${exported.length} example(s)`)
  for (const [skill, n] of Object.entries(bySkill)) {
    console.log(`        ${skill.padEnd(18)} ${n}`)
  }
  if (trajectories.length && exported.length === 0) {
    console.log('      (no examples — runs may have been aborted or had no successful actions)')
  }

  // ---- Stage 3: merge seeds -----------------------------------------------
  console.log(`\n[3/7] Merging seed corpus`)
  const seeds = args.includeSeeds ? buildSeedDataset() : []
  console.log(`      ${seeds.length} seed example(s)${args.includeSeeds ? '' : ' (disabled)'}`)

  let all = [...exported, ...preExported, ...seeds]
  console.log(`      ${all.length} example(s) total before dedupe`)

  // ---- Stage 4: dedupe ----------------------------------------------------
  console.log(`\n[4/7] Deduplicating`)
  const beforeDedupe = all.length
  all = dedupe(all)
  console.log(`      removed ${beforeDedupe - all.length}, ${all.length} remaining`)

  // ---- Stage 5: filter by weight -----------------------------------------
  console.log(`\n[5/7] Filtering (min-weight ${args.minWeight})`)
  const beforeFilter = all.length
  all = all.filter((r) => (r.meta?.weight ?? 1) >= args.minWeight)
  console.log(`      removed ${beforeFilter - all.length}, ${all.length} remaining`)

  // ---- Stage 6: validate --------------------------------------------------
  console.log(`\n[6/7] Validating against JDF v1.0.0`)
  const validation = validateDataset(all)
  if (!validation.ok) {
    console.error(`      ${validation.errors.length} error(s):`)
    for (const e of validation.errors.slice(0, 20)) {
      console.error(`        ! ${e}`)
    }
    if (validation.errors.length > 20) {
      console.error(`        … and ${validation.errors.length - 20} more`)
    }
    console.error('\nAborting: fix the dataset before training on it.\n')
    process.exit(1)
  }
  console.log(`      all ${all.length} record(s) valid`)
  if (validation.duplicates.length) {
    console.warn(`      ! ${validation.duplicates.length} duplicate id(s) survived dedupe`)
  }

  const stats = validation.stats
  console.log(`\n      --- dataset summary ---`)
  console.log(`      total records : ${stats.total}`)
  console.log(`      by kind       : ${JSON.stringify(stats.byKind)}`)
  console.log(`      by source     : ${JSON.stringify(stats.bySource)}`)
  console.log(`      by skill      : ${JSON.stringify(stats.bySkill)}`)
  console.log(`      verified      : ${stats.verified}`)
  console.log(`      tool calls    : ${stats.totalToolCalls}`)
  console.log(`      avg msg/rec   : ${stats.avgMessages}`)

  if (args.verifyOnly) {
    console.log('\n--verify-only: nothing written.\n')
    return
  }

  // ---- Stage 7: split and write ------------------------------------------
  console.log(`\n[7/7] Splitting and writing`)
  const { train, validation: val } = split(all, {
    validationFraction: args.validationFraction,
    seed: args.seed,
  })

  const outDir = args.out
    ? join(root, args.out)
    : join(root, 'datasets', `javelin-${new Date().toISOString().slice(0, 10)}`)

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'train.jsonl'), toJsonl(train), 'utf8')
  writeFileSync(join(outDir, 'validation.jsonl'), toJsonl(val), 'utf8')
  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        format: 'JDF',
        version: '1.0.0',
        builtAt: new Date().toISOString(),
        trainCount: train.length,
        validationCount: val.length,
        stats,
        sources: [...new Set(all.map((r) => r.source))],
        seedUsed: args.seed,
        includeSeeds: args.includeSeeds,
      },
      null,
      2,
    ),
    'utf8',
  )

  console.log(`      train.jsonl       ${train.length} record(s)`)
  console.log(`      validation.jsonl  ${val.length} record(s)`)
  console.log(`      manifest.json`)
  console.log(`\n      written to ${outDir}`)

  // Honest warning: a tiny dataset will not teach much.
  if (all.length < 200) {
    console.log(
      `\n      NOTE: ${all.length} records is a very small dataset. Fine-tuning on it will\n` +
      `      have little effect. Capture more real runs with the trace recorder —\n` +
      `      quality mostly comes from volume and from verified runs.`,
    )
  }

  console.log('\nDone.\n')
}

function countBy(items, keyFn) {
  const out = {}
  for (const item of items) {
    const k = keyFn(item) ?? 'unknown'
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

main()
