/**
 * Training status.
 * ================
 *
 * Answers one question honestly: **is there a trained Javelin model, yes or no?**
 *
 *   npm run train:status
 *
 * Everything it reports is corroborated against files on disk. It cannot claim a
 * model exists because a run was started; only a completed, verified run counts.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyProvenance } from './provenance.mjs'
import { profileHardware, recommendMethod, recommendBaseModel } from './hardware.mjs'
import { identityFingerprint, IDENTITY_VERSION } from '../src/core/identity.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function main() {
  console.log('\n=== Javelin model status ===\n')

  // ---- Hardware ------------------------------------------------------------
  const hw = profileHardware()
  const method = recommendMethod(hw, 'auto')
  const base = recommendBaseModel(hw)

  console.log('Hardware')
  console.log(`  GPU      : ${hw.primaryGpu?.name ?? 'none detected'}`)
  console.log(`  VRAM     : ${hw.vramGb ? hw.vramGb + ' GB' : 'unknown'}`)
  console.log(`  RAM      : ${hw.ramGb ? hw.ramGb + ' GB' : 'unknown'}`)
  console.log(`  best path: ${hw.recommendation.best?.name ?? 'none'}`)
  console.log(`  would use: ${method.method} on ${base.model}`)

  // ---- Trained model -------------------------------------------------------
  console.log('\nTrained model')
  const runsDir = join(root, 'training', 'runs')
  const runs = existsSync(runsDir)
    ? readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : []

  if (runs.length === 0) {
    console.log('  No training runs exist.')
    console.log('  Nothing has been trained. Javelin currently runs on the provider you selected.')
    reportNextSteps()
    return
  }

  let anyTrained = false
  let driftWarning = false

  for (const run of runs) {
    const runDir = join(runsDir, run)
    const v = verifyProvenance(runDir)
    const mark = v.trained ? 'TRAINED ' : 'not     '
    console.log(`  [${mark}] ${run}`)
    console.log(`             ${v.detail}`)
    if (v.trained) {
      anyTrained = true
      console.log(`             adapter: ${v.files.length} file(s)`)
      if (v.drift) {
        driftWarning = true
      }
    }
  }

  // ---- Honest verdict ------------------------------------------------------
  console.log('\nVerdict')
  if (!anyTrained) {
    console.log('  NO trained Javelin model.')
    console.log('  No run has completed successfully. Do not serve anything as "Javelin".')
    reportNextSteps()
    return
  }

  console.log('  A trained Javelin model exists.')
  if (driftWarning) {
    console.log('  WARNING: a completed run was trained against a different identity version.')
    console.log(`  current identity: ${IDENTITY_VERSION} (${identityFingerprint()})`)
    console.log('  Retrain so the model matches the identity it will be served with.')
  }
  console.log('\n  Still required before use:')
  console.log('    1. Merge the adapter:      python training/finetune/merge.py')
  console.log('    2. Evaluate it:            reportEngineFitness() — a trained model is not automatically a good one')
  console.log('    3. Serve it:               ollama create javelin -f Modelfile')
  console.log('    4. Select it in VS Code:   "Javelin (fine-tuned)" provider')
  console.log('')
}

function reportNextSteps() {
  console.log('\n  To train one:')
  console.log('    1. npm run train:dataset                     # build a dataset')
  console.log('    2. npm run train:prepare --dataset datasets/<name>')
  console.log('    3. npm run train:run --run training/runs/javelin-lora')
  console.log('')
  console.log('  The pipeline runs on CPU for a small model; see docs/TRAINING.md.')
  console.log('')
}

main()
