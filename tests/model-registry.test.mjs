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

  const openaiShape = salvageToolCallFromText(
    '```json\n{"function": {"name": "edit_file", "arguments": {"path": "a.js", "old_string": "old", "new_string": "new"}}}\n```',
  )
  check('the OpenAI {function:{name}} shape is recovered', openaiShape?.name === 'edit_file', JSON.stringify(openaiShape))

  const doubled = salvageToolCallFromText('{{"name": "read_file", "arguments": {"path": "a.js"}}}')
  check('a doubled-brace JSON call is recovered', doubled?.name === 'read_file', JSON.stringify(doubled))

  const xml = salvageToolCallFromText(
    '<function name="write_file" arguments=\'{"path":"hello.html","content":"<h1>hi</h1>"}\'/>',
  )
  check('a Qwen XML function call is recovered', xml?.name === 'write_file', JSON.stringify(xml))
  check('its XML arguments are parsed', xml?.args?.path === 'hello.html', JSON.stringify(xml?.args))

  const prose = salvageToolCallFromText('I think you should look at the file yourself.')
  check('plain prose yields no invented tool call', prose === null, JSON.stringify(prose))

  const empty = salvageToolCallFromText('')
  check('empty text yields nothing', empty === null)

  const noisyResponse = [
    'Create a new file `Game.js` inside the `src/chess` folder.',
    'javascriptCopy',
    '```',
    'class Game {',
    '  constructor() { this.board = []; }',
    '}',
    '```',
    'Run the project tests:',
    'jsonCopy',
    '```',
    '{"name":"run_command","arguments":{"command":"npm test"}}',
    '```',
    'Repeat the command:',
    'jsonCopy',
    '```',
    '{"name":"run_command","arguments":{"command":"npm test"}}',
    '```',
  ].join('\n')
  const recovered = salvageToolCallFromText(noisyResponse)
  check('the explicit file action is recovered before the command',
    recovered?.name === 'write_file' && recovered.args.path === 'src/chess/Game.js',
    JSON.stringify(recovered))

  const { salvageToolCallsFromText } = await import('../src/lib/providers.js')
  const deduplicated = salvageToolCallsFromText(noisyResponse)
  check('an explicitly described new file is recovered from its code block',
    deduplicated[0]?.name === 'write_file' &&
      deduplicated[0]?.args.path === 'src/chess/Game.js' &&
      deduplicated[0]?.args.content.includes('class Game'),
    JSON.stringify(deduplicated[0]))
  check('repeated copies of the file and command are only executed once', deduplicated.length === 2, String(deduplicated.length))
  const unknown = salvageToolCallFromText('{"name":"delete_project","arguments":{"path":"."}}')
  check('unregistered tool names are not executed', unknown === null)
  const legacyFileCall = salvageToolCallFromText(
    '{"name":"create_file","arguments":{"path":"src/new.js","content":"export {}"}}',
  )
  check('legacy create_file JSON is normalized to the registered write_file tool',
    legacyFileCall?.name === 'write_file' &&
      legacyFileCall.args.path === 'src/new.js' &&
      legacyFileCall.args.content === 'export {}',
    JSON.stringify(legacyFileCall))
  const camelCaseFileCall = salvageToolCallFromText(
    '{"name":"createFile","arguments":{"path":"src/camel.js","content":"export {}"}}',
  )
  check('camelCase file tool JSON is recovered as a supported file write',
    camelCaseFileCall?.name === 'write_file' &&
      camelCaseFileCall.args.path === 'src/camel.js',
    JSON.stringify(camelCaseFileCall))

  const responseBody = `data: ${JSON.stringify({
    choices: [{ delta: { content: noisyResponse }, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`
  const { readStream } = await import('../src/lib/providers.js')
  const streamed = await readStream(new Response(responseBody, {
    headers: { 'Content-Type': 'text/event-stream' },
  }))
  check('the SSE parser returns the recovered command as a real tool call',
    streamed.toolCalls[1]?.name === 'run_command' && streamed.toolCalls[1]?.args.command === 'npm test',
    JSON.stringify(streamed.toolCalls))
  check('the serialized tool call is not left as assistant prose', streamed.content === '')

  const narratedFile = [
    'Plan:',
    '1. Write the initial code for the game logic in `flappy_bird/game.js`.',
    '```javascript',
    '// flappy_bird/game.js',
    'export function startGame() {}',
    '```',
  ].join('\n')
  const narratedCalls = salvageToolCallsFromText(narratedFile)
  check('a direct write instruction with a matching path comment becomes a file action',
    narratedCalls.length === 1 &&
      narratedCalls[0].name === 'write_file' &&
      narratedCalls[0].args.path === 'flappy_bird/game.js' &&
      narratedCalls[0].args.content.includes('startGame'),
    JSON.stringify(narratedCalls))
  const ambiguousFence = salvageToolCallsFromText([
    'Here is an example of a game loop:',
    '```javascript',
    '// flappy_bird/game.js',
    'export function startGame() {}',
    '```',
  ].join('\n'))
  check('a code sample without an explicit write instruction does not create a file',
    ambiguousFence.length === 0, JSON.stringify(ambiguousFence))

  const narratedScript = [
    'First, we need to create a Python script for the game. Let us call it `guess_the_number.py`.',
    'pythonCopy',
    '```',
    '# guess_the_number.py',
    'def play_game():',
    '    return "ready"',
    '```',
    'Now, create an HTML file to load this script.',
    'htmlCopy',
    '```',
    '<!-- flappy_bird/index.html -->',
    '<!doctype html>',
    '<script src="game.js"></script>',
    '```',
    'If another script needs to import it, use this example.',
    '```python',
    '# main.py',
    'from guess_the_number import play_game',
    '```',
  ].join('\n')
  const recoveredScripts = salvageToolCallsFromText(narratedScript)
  check('explicit file-creation narration recovers multiple source files',
    recoveredScripts.length === 2 &&
      recoveredScripts[0].args.path === 'guess_the_number.py' &&
      recoveredScripts[1].args.path === 'flappy_bird/index.html',
    JSON.stringify(recoveredScripts))
  check('an import example is not mistaken for another file creation',
    !recoveredScripts.some((call) => call.args.path === 'main.py'))
  const unsafeHeader = salvageToolCallsFromText([
    'Create a Python script for the game.',
    '```python',
    '# ../outside.py',
    'print("unsafe")',
    '```',
  ].join('\n'))
  check('narrated paths cannot escape the workspace',
    unsafeHeader.length === 0, JSON.stringify(unsafeHeader))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
