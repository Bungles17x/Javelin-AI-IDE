/**
 * Identity and provenance tests.
 *
 * Two guarantees are locked in here:
 *
 *   1. **One identity.** Training and inference must use the same Javelin identity,
 *      or a fine-tune would be taught one character and served with another.
 *      This was a real bug: the seed prompt was a drifting shortened copy.
 *
 *   2. **No false claims of training.** A run counts as trained only when it
 *      finished successfully AND a usable adapter exists on disk. Anything else is
 *      recorded as not trained, with the reason.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MODEL_IDENTITY, MODEL_PRINCIPLES, renderModelIdentity, renderAgentContract,
  composeIdentity, identityFingerprint, IDENTITY_VERSION, IDENTITY_TRAINING_PROMPT,
} from '../src/core/identity.js'
import { JAVELIN_IDENTITY } from '../src/core/brain.js'
import { SEED_SYSTEM_PROMPT } from '../training/dataset/seeds.js'
import { SYSTEM_PROMPT } from '../src/lib/ai.js'
import {
  beginRun, completeRun, failRun, interruptRun, verifyProvenance,
  looksLikeUsableAdapter, TRAINING_STATE,
} from '../training/provenance.mjs'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const tempDirs = []
function tempRunDir() {
  const dir = mkdtempSync(join(tmpdir(), 'javelin-prov-'))
  tempDirs.push(dir)
  return dir
}

console.log('\n1. There is exactly one identity')
{
  check('inference identity matches the shared source',
    JAVELIN_IDENTITY === renderModelIdentity())
  check('training prompt IS the identity (no drifting copy)',
    SEED_SYSTEM_PROMPT === IDENTITY_TRAINING_PROMPT,
    'the seed prompt must not be a shortened duplicate')
  check('training prompt is identical to what inference uses',
    SEED_SYSTEM_PROMPT === JAVELIN_IDENTITY)
  check('chat mode builds on the same identity',
    SYSTEM_PROMPT.includes(MODEL_IDENTITY.slice(0, 60)),
    'chat prompt should embed the shared identity')
}

console.log('\n2. Identity is separate from agent capability')
{
  const identity = renderModelIdentity()

  // The whole point: the durable identity must not name tools, because tool names
  // belong to a harness the model may not be given again.
  const toolNames = ['read_file', 'edit_file', 'run_command', 'list_files']
  const leakedTools = toolNames.filter((t) => identity.includes(t))
  check('identity does not name any tool', leakedTools.length === 0, leakedTools.join(','))

  const contract = renderAgentContract(toolNames, { canExecuteCommands: true })
  check('contract lists the tools', toolNames.every((t) => contract.includes(t)))
  check('contract is separate from identity', contract !== identity)
  check('contract is not part of the training prompt',
    !IDENTITY_TRAINING_PROMPT.includes('read_file'),
    'tools must never be baked into the fine-tune target')
}

console.log('\n3. The agent contract adapts to the session')
{
  const withTools = renderAgentContract(['read_file', 'edit_file'], { canExecuteCommands: false })
  check('contract warns when commands are unavailable',
    /unavailable/i.test(withTools), withTools)
  check('contract tells the model not to pretend it ran things',
    /cannot run|can not run/i.test(withTools) || /unavailable/i.test(withTools))

  const noTools = renderAgentContract([], {})
  check('a session with no tools says so plainly', /No tools are available/.test(noTools), noTools)
  check('a tool-less session forbids claiming action',
    /do not claim to have done so/i.test(noTools), noTools)

  const readOnly = renderAgentContract(['read_file', 'list_files'], { canWriteFiles: false })
  check('a read-only session does not suggest editing', !/targeted edit/.test(readOnly))
}

console.log('\n4. Identity composes consistently')
{
  const composed = composeIdentity({ toolNames: ['read_file'] })
  check('composition includes the identity', composed.includes(MODEL_IDENTITY.slice(0, 40)))
  check('composition includes the contract', composed.includes('CAPABILITIES'))
  check('principles are rendered into the identity',
    MODEL_PRINCIPLES.every((p) => renderModelIdentity().includes(p.text.slice(0, 40))))
  check('fingerprint is stable across calls',
    identityFingerprint() === identityFingerprint())
  check('fingerprint is versioned', typeof IDENTITY_VERSION === 'string' && IDENTITY_VERSION.length > 0)
}

console.log('\n5. A run that has not finished is never "trained"')
{
  const runDir = tempRunDir()

  // Planned / started
  const rec = beginRun({
    runDir, baseModel: 'test', method: 'lora',
    dataset: { dir: 'x', trainRecords: 5 }, datasetRecords: 5, hardware: null,
  })
  check('a started run records state "started"', rec.state === TRAINING_STATE.STARTED, rec.state)

  let v = verifyProvenance(runDir)
  check('a started run is NOT trained', v.trained === false)
  check('and it says why', /did not complete/.test(v.detail), v.detail)
}

console.log('\n6. A failed run is not trained, and keeps the reason')
{
  const runDir = tempRunDir()
  const rec = beginRun({
    runDir, baseModel: 'test', method: 'lora',
    dataset: { dir: 'x', trainRecords: 5 }, datasetRecords: 5, hardware: null,
  })
  failRun(runDir, rec, { error: 'CUDA out of memory', exitCode: 1 })

  const v = verifyProvenance(runDir)
  check('a failed run is not trained', v.trained === false)
  check('the failure reason is preserved', /CUDA out of memory/.test(v.detail), v.detail)
  check('the state is "failed"', v.state === TRAINING_STATE.FAILED, v.state)
}

console.log('\n7. An interrupted run is distinct from a failed one')
{
  const runDir = tempRunDir()
  const rec = beginRun({
    runDir, baseModel: 'test', method: 'lora',
    dataset: { dir: 'x', trainRecords: 5 }, datasetRecords: 5, hardware: null,
  })
  interruptRun(runDir, rec, 'terminated by signal SIGINT')

  const v = verifyProvenance(runDir)
  check('an interrupted run is not trained', v.trained === false)
  check('the state is "interrupted"', v.state === TRAINING_STATE.INTERRUPTED, v.state)
}

console.log('\n8. Exit code 0 alone does not mean trained')
{
  const runDir = tempRunDir()
  const rec = beginRun({
    runDir, baseModel: 'test', method: 'lora',
    dataset: { dir: 'x', trainRecords: 5 }, datasetRecords: 5, hardware: null,
  })

  // Claim completion pointing at an adapter directory that does not exist.
  const claimed = completeRun(runDir, rec, {
    adapterDir: join(runDir, 'does-not-exist'),
    exitCode: 0,
  })
  check('completion is refused without a real adapter',
    claimed.state === TRAINING_STATE.FAILED, claimed.state)

  const v = verifyProvenance(runDir)
  check('and it is not reported as trained', v.trained === false)
  check('the reason names the missing adapter', /no adapter|missing/.test(v.detail), v.detail)
}

console.log('\n9. A non-zero exit cannot be recorded as success')
{
  const runDir = tempRunDir()
  const adapterDir = join(runDir, 'adapter')
  mkdirSync(adapterDir, { recursive: true })
  writeFileSync(join(adapterDir, 'adapter_config.json'), '{}')
  writeFileSync(join(adapterDir, 'adapter_model.safetensors'), 'x')

  const rec = beginRun({
    runDir, baseModel: 'test', method: 'lora',
    dataset: { dir: 'x', trainRecords: 5 }, datasetRecords: 5, hardware: null,
  })

  // Even with a perfectly good adapter on disk, a non-zero exit is a failure.
  const claimed = completeRun(runDir, rec, { adapterDir, exitCode: 1 })
  check('a non-zero exit forces state "failed"', claimed.state === TRAINING_STATE.FAILED, claimed.state)
  check('verify agrees it is not trained', verifyProvenance(runDir).trained === false)
}

console.log('\n10. A real completion IS recognised as trained')
{
  const runDir = tempRunDir()
  const adapterDir = join(runDir, 'adapter')
  mkdirSync(adapterDir, { recursive: true })
  writeFileSync(join(adapterDir, 'adapter_config.json'), '{"r":8}')
  writeFileSync(join(adapterDir, 'adapter_model.safetensors'), 'weights')

  const rec = beginRun({
    runDir, baseModel: 'test', method: 'lora',
    dataset: { dir: 'x', trainRecords: 5 }, datasetRecords: 5, hardware: null,
  })
  const done = completeRun(runDir, rec, { adapterDir, exitCode: 0 })

  check('state is "completed"', done.state === TRAINING_STATE.COMPLETED, done.state)

  const v = verifyProvenance(runDir)
  check('a real completion verifies as trained', v.trained === true, v.detail)
  check('the adapter files are listed', v.files.length >= 2, String(v.files?.length))
  check('identity was recorded at training time',
    Boolean(v.record?.identity?.fingerprint), JSON.stringify(v.record?.identity))
}

console.log('\n11. Adapter usability is actually checked')
{
  const dir = mkdtempSync(join(tmpdir(), 'javelin-adapter-'))
  tempDirs.push(dir)

  check('an empty dir is not usable', looksLikeUsableAdapter(dir).ok === false)

  writeFileSync(join(dir, 'adapter_config.json'), '{}')
  check('config without weights is not usable', looksLikeUsableAdapter(dir).ok === false)

  writeFileSync(join(dir, 'adapter_model.safetensors'), 'w')
  check('config plus weights IS usable', looksLikeUsableAdapter(dir).ok === true)

  const dir2 = mkdtempSync(join(tmpdir(), 'javelin-adapter2-'))
  tempDirs.push(dir2)
  writeFileSync(join(dir2, 'trainer_state.json'), '{}')
  check('a stray log file is not an adapter', looksLikeUsableAdapter(dir2).ok === false)
}

console.log('\n12. A missing provenance record is honestly "unknown"')
{
  const runDir = tempRunDir()
  check('no record exists', !existsSync(join(runDir, 'provenance.json')))
  const v = verifyProvenance(runDir)
  check('missing record is not trained', v.trained === false)
  check('missing record says nothing was trained here', /nothing was trained/i.test(v.detail), v.detail)
}

// Clean up temp directories.
for (const dir of tempDirs) {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL IDENTITY + PROVENANCE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
