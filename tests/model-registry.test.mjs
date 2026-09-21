/**
 * Model catalog — honesty tests.
 *
 * "Javelin Coder 80B" is a *declared* model. This suite exists to make sure the
 * codebase can never present a declared model as a built one, and specifically that:
 *
 *  1. The catalog lists Javelin Coder 80B and reports it as NOT trained/served.
 *  2. A manifest that *claims* trained/served is not believed on its say-so — the
 *     filesystem is the arbiter.
 *  3. A manifest becomes `trained` only once a verified adapter actually exists.
 *  4. The requirements are sane (80B needs real datacentre VRAM, not a consumer GPU).
 *
 * Run: npm test
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getManifest, resolveStatus, listModels } from '../training/model-registry.mjs'
import { beginRun, completeRun, verifyProvenance } from '../training/provenance.mjs'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. Javelin Coder 80B is declared')
{
  const m = getManifest('javelin-coder-80b')
  check('the manifest exists', Boolean(m))
  check('it has the product display name', m?.displayName === 'Javelin Coder 80B', m?.displayName)
  check('it names a real open base model', typeof m?.base?.model === 'string' && m.base.model.length > 0, m?.base?.model)
  check('the base is flagged approximate (80B is a class, not a literal size)', m?.base?.approximate === true)
}

console.log('\n2. Javelin Coder 80B is NOT reported as built')
{
  const m = getManifest('javelin-coder-80b')
  const s = resolveStatus(m)
  check('it is declared', s.declared === true)
  check('it is NOT trained', s.trained === false, `trained=${s.trained}`)
  check('it is NOT served', s.served === false, `served=${s.served}`)
  check('the detail says it is not built', /not (built|complete)|no adapter|did not complete|nothing was trained/i.test(s.detail), s.detail)
}

console.log('\n3. Hardware requirements are realistic for an 80B model')
{
  const m = getManifest('javelin-coder-80b')
  check('training needs datacentre-class VRAM (>= 80GB)', (m?.requirements?.trainVramGb ?? 0) >= 80, String(m?.requirements?.trainVramGb))
  check('the "local" path is marked not viable', m?.paths?.local?.viable === false)
  check('the "cpu" path is marked not viable', m?.paths?.cpu?.viable === false)
  check('a rented-GPU path is offered instead', m?.paths?.rented?.viable === true)
}

console.log('\n4. A manifest cannot fake being trained')
{
  // Point a manifest at a directory with no adapter and claim trained: true.
  const dir = mkdtempSync(join(tmpdir(), 'javelin-fake-'))
  const fake = {
    id: 'fake-claims',
    displayName: 'Fake Claims Model',
    output: { dir, mergedDir: join(dir, 'merged') },
    status: { declared: true, trained: true, served: true }, // a lie in the manifest
  }
  const s = resolveStatus(fake)
  check('the registry ignores the manifest\'s own trained flag', s.trained === false, `trained=${s.trained}`)
  check('and its served flag', s.served === false, `served=${s.served}`)
  check('it reports the real reason', /no provenance|did not complete|nothing was trained/i.test(s.detail), s.detail)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n5. The catalog lists at least the 80B model with a status')
{
  const models = listModels()
  check('the catalog is non-empty', models.length >= 1, String(models.length))
  const entry = models.find((m) => m.id === 'javelin-coder-80b')
  check('the 80B model is in the catalog', Boolean(entry))
  check('every catalog entry carries a resolved status', models.every((m) => m.statusResolved && typeof m.statusResolved.trained === 'boolean'))
  check('no catalog entry is falsely claimed as trained', models.every((m) => m.statusResolved.trained === false))
}

console.log('\n6. A real adapter would flip the status to trained')
{
  // Prove the mechanism works: write a completed provenance record + a real adapter,
  // and confirm the registry then believes it. This shows the "not built" verdict for
  // the 80B model is a fact about the filesystem, not a hardcoded refusal.
  const dir = mkdtempSync(join(tmpdir(), 'javelin-real-'))
  const adapterDir = join(dir, 'adapter')
  mkdirSync(adapterDir, { recursive: true })
  writeFileSync(join(adapterDir, 'adapter_config.json'), '{}')
  writeFileSync(join(adapterDir, 'adapter_model.safetensors'), 'weights')

  const rec = beginRun({
    runDir: dir, baseModel: 'test', method: 'lora',
    dataset: { dir: 'x', trainRecords: 100 }, datasetRecords: 100, hardware: null,
  })
  completeRun(dir, rec, { adapterDir, exitCode: 0 })

  const v = verifyProvenance(dir)
  check('the completed run is verified', v.trained === true)

  const fake = { id: 'now-real', output: { dir, mergedDir: join(dir, 'merged') }, status: {} }
  const s = resolveStatus(fake)
  check('the registry now reports it trained', s.trained === true, s.detail)
  check('but still not served (not merged)', s.served === false)
  check('and says merge is the remaining step', /merge/i.test(s.detail), s.detail)

  rmSync(dir, { recursive: true, force: true })
}

console.log('\n7. Local models that describe a tool call in text still work')
{
  // qwen2.5-coder via Ollama often emits a fenced JSON block instead of populating
  // delta.tool_calls. The salvage path must recover it, or the agent never acts.
  const { salvageToolCallFromText } = await import('../src/lib/providers.js')

  const fenced = salvageToolCallFromText('```json\n{"name": "list_files", "arguments": {"path": "."}}\n```')
  check('a fenced JSON tool call is recovered', fenced?.name === 'list_files', JSON.stringify(fenced))
  check('its arguments are parsed', fenced?.args?.path === '.', JSON.stringify(fenced?.args))

  const tagged = salvageToolCallFromText('<tool_call>\n{"name": "read_file", "arguments": {"path": "a.js"}}\n</tool_call>')
  check('a <tool_call> block is recovered', tagged?.name === 'read_file', JSON.stringify(tagged))

  const openaiShape = salvageToolCallFromText('```json\n{"function": {"name": "edit_file", "arguments": {"path": "a.js"}}}\n```')
  check('the OpenAI {function:{name}} shape is recovered', openaiShape?.name === 'edit_file', JSON.stringify(openaiShape))

  const prose = salvageToolCallFromText('I think you should look at the file yourself.')
  check('plain prose yields no invented tool call', prose === null, JSON.stringify(prose))

  const empty = salvageToolCallFromText('')
  check('empty text yields nothing', empty === null)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
