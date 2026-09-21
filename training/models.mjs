/**
 * Javelin model catalog.
 * ======================
 *
 *   npm run models                 # list every declared Javelin model + honest status
 *   npm run models -- javelin-coder-80b   # detail for one model
 *
 * This lists what Javelin *is defined to be*, and then tells the truth about which
 * of those definitions have actually been built. A catalog entry is a plan, not a
 * model. The status column is corroborated against the filesystem — a manifest that
 * says "trained: true" is not believed unless a verified adapter is on disk.
 */

import { listModels, verdictFor, getManifest, resolveStatus } from './model-registry.mjs'
import { profileHardware } from './hardware.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function statusLabel(s) {
  if (s.served) return 'SERVED  '
  if (s.trained) return 'TRAINED '
  return 'declared'
}

function main() {
  const want = process.argv.slice(2).find((a) => !a.startsWith('-'))

  console.log('\n=== Javelin model catalog ===\n')

  const models = listModels()

  if (models.length === 0) {
    console.log('  No model manifests found in training/models/.')
    console.log('  A Javelin model is defined by a JSON manifest there.\n')
    return
  }

  if (want) {
    const entry = models.find((m) => m.id === want)
    if (!entry) {
      console.error(`  No model declared with id "${want}".`)
      console.error(`  Known ids: ${models.map((m) => m.id).join(', ')}\n`)
      process.exit(1)
    }
    printDetail(entry)
    return
  }

  // ---- Catalog table -------------------------------------------------------
  for (const entry of models) {
    const s = entry.statusResolved
    console.log(`  [${statusLabel(s)}] ${entry.displayName}  (${entry.id})`)
    console.log(`              base    : ${entry.base?.model ?? 'unspecified'}${entry.base?.approximate ? '  (approximate class)' : ''}`)
    console.log(`              method  : ${String(entry.method ?? 'unspecified').toUpperCase()}`)
    console.log(`              needs   : ~${entry.requirements?.trainVramGb ?? '?'}GB VRAM to train`)
    console.log(`              status  : ${s.detail}`)
    if (s.drift) {
      console.log('              WARNING : identity changed since training — retrain to match')
    }
    console.log('')
  }

  // ---- Honest verdict ------------------------------------------------------
  const anyBuilt = models.some((m) => m.statusResolved.trained)
  console.log('Verdict')
  if (!anyBuilt) {
    console.log('  NO Javelin model has been built yet.')
    console.log('  Every entry above is a declared target, not a working model.')
    console.log('  The running agent uses whichever provider you selected, not these.')
  } else {
    for (const entry of models.filter((m) => m.statusResolved.trained)) {
      console.log(`  ${verdictFor(entry)}`)
    }
  }

  console.log('\n  Detail for one model:  npm run models -- <id>')
  console.log('  Training status:       npm run train:status\n')
}

function printDetail(entry) {
  const s = resolveStatus(entry)
  console.log(`  ${entry.displayName}  (${entry.id})`)
  console.log(`  ${entry.summary ?? ''}\n`)

  console.log('  Base model')
  console.log(`    ${entry.base?.model ?? 'unspecified'}`)
  if (entry.base?.note) {
    console.log(`    ${entry.base.note}`)
  }
  console.log('')

  console.log('  Training')
  console.log(`    method     : ${String(entry.method ?? 'unspecified').toUpperCase()}`)
  console.log(`    adapter    : ${entry.adapterName ?? '(unnamed)'}`)
  console.log(`    output     : ${entry.output?.dir ?? '(unset)'}`)
  console.log(`    dataset    : ${entry.training?.recommendedDataset ?? '(unset)'} (min ${entry.training?.minRecords ?? '?'} records)`)
  if (entry.training?.note) {
    console.log(`    ${entry.training.note}`)
  }
  console.log('')

  console.log('  Hardware required')
  console.log(`    train      : ~${entry.requirements?.trainVramGb ?? '?'}GB VRAM — ${entry.requirements?.trainNote ?? ''}`)
  console.log(`    merge      : ~${entry.requirements?.mergeVramGb ?? '?'}GB VRAM — ${entry.requirements?.mergeNote ?? ''}`)
  console.log(`    serve      : ~${entry.requirements?.serveVramGb ?? '?'}GB VRAM — ${entry.requirements?.serveNote ?? ''}`)
  console.log('')

  console.log('  Paths')
  for (const [name, path] of Object.entries(entry.paths ?? {})) {
    const mark = path.viable ? 'VIABLE' : 'NOT   '
    console.log(`    [${mark}] ${name}: ${path.detail}`)
  }
  console.log('')

  // ---- Reality check against THIS machine ---------------------------------
  const hw = profileHardware()
  console.log('  On this machine')
  console.log(`    GPU        : ${hw.primaryGpu?.name ?? 'none detected'} (${hw.vramGb ? hw.vramGb + 'GB' : 'VRAM unknown'})`)
  const needed = entry.requirements?.trainVramGb ?? Infinity
  const canHere = (hw.vramGb ?? 0) >= needed
  console.log(`    trainable  : ${canHere ? 'yes' : 'NO — this model cannot be trained here'}`)
  if (!canHere) {
    console.log(`                 it needs ~${needed}GB VRAM; this machine has ${hw.vramGb ?? 0}GB.`)
    console.log(`                 Use a rented GPU (see the "rented" path above).`)
  }
  console.log('')

  console.log('  Status')
  console.log(`    ${s.detail}`)
  if (s.adapterFiles) {
    console.log(`    adapter files: ${s.adapterFiles}`)
  }
  console.log('')

  console.log('  To build it (on suitable hardware):')
  console.log(`    1. npm run train:dataset --out ${entry.training?.recommendedDataset ?? 'datasets/<name>'}`)
  console.log(`    2. npm run train:prepare --dataset ${entry.training?.recommendedDataset ?? 'datasets/<name>'} \\`)
  console.log(`         --base-model ${entry.base?.model ?? '<base>'} \\`)
  console.log(`         --output ${entry.output?.dir ?? 'training/runs/<name>'} --method ${entry.method ?? 'qlora'}`)
  console.log(`    3. npm run train:run --run ${entry.output?.dir ?? 'training/runs/<name>'}`)
  console.log('    4. npm run models          # confirm it now reads TRAINED, not declared\n')
}

main()
