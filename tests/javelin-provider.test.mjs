/**
 * Javelin-model provider tests.
 *
 * Verifies the extension selects local Ollama providers, rejects remote requests,
 * and reports useful runtime/model failures. Uses compiled extension output.
 */

import { PROVIDERS, getProvider, DEFAULT_PROVIDER, streamCompletion, probeProviderModel, isLocalOllamaEndpoint, salvageToolCallFromText, salvageToolCallsFromText } from '../vscode-extension/out/providers.js'
import { canonicalizeToolCall } from '../vscode-extension/out/core/tools.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. The Javelin model is a registered provider')
{
  check('provider exists', Boolean(PROVIDERS.javelin), Object.keys(PROVIDERS).join(','))
  check('id is "javelin"', PROVIDERS.javelin.id === 'javelin')
  check('flagged as a Javelin model', PROVIDERS.javelin.isJavelinModel === true)
  check('labelled clearly', /javelin/i.test(PROVIDERS.javelin.label), PROVIDERS.javelin.label)
  check('it is presented as self-hosted, not an external runner', /self-hosted/i.test(PROVIDERS.javelin.label), PROVIDERS.javelin.label)

  const p = getProvider('javelin')
  check('getProvider resolves it (no fallback)', p.id === 'javelin', p.id)
  check('it does not require an API key', p.requiresKey === false)
  check('it points at the local Ollama endpoint', p.baseUrl === 'http://127.0.0.1:11434/v1', p.baseUrl)
  check('it has a default model name', Boolean(p.defaultModel), p.defaultModel)
  check('its default model is the installed Javelin model', p.defaultModel === 'javelin-coder:latest', p.defaultModel)
  check('its help explains local Ollama hosting', /ollama/i.test(p.help), p.help)
}

console.log('\n1a. Common directory tool names map to the registered folder tool')
{
  for (const name of ['create_directory', 'make_directory', 'mkdir']) {
    check(`${name} is recognized as create_folder`, canonicalizeToolCall({ name }).name === 'create_folder')
  }
  check('create_file is recognized as write_file',
    canonicalizeToolCall({ name: 'create_file' }).name === 'write_file')
  check('camelCase createFile is recognized as write_file',
    canonicalizeToolCall({ name: 'createFile' }).name === 'write_file')
  check('hyphenated new-file is recognized as write_file',
    canonicalizeToolCall({ name: 'new-file' }).name === 'write_file')
}

console.log('\n2. Existing providers are unchanged')
{
  const before = ['local', 'groq', 'custom']
  for (const id of before) {
    check(`${id} still registered`, Boolean(PROVIDERS[id]))
  }
  check('Javelin is the default provider', DEFAULT_PROVIDER === 'javelin', DEFAULT_PROVIDER)
  check('groq still requires a key', PROVIDERS.groq.requiresKey === true)
  check('custom still has no preset models', PROVIDERS.custom.models.length === 0)
  check('local is not flagged as a Javelin model', !PROVIDERS.local.isJavelinModel)
  check('local provider documents automatic Ollama startup', /starts Ollama when needed/i.test(PROVIDERS.local.help))
  check('local provider no longer recommends building a toy model', !/build your own|model:local/i.test(PROVIDERS.local.help))
}

console.log('\n3. An unknown provider still falls back safely')
{
  const p = getProvider('does-not-exist')
  check('unknown id falls back to the default', p.id === DEFAULT_PROVIDER, p.id)
}

console.log('\n4. Only self-hosted providers are offered')
{
  const order = ['javelin', 'local']
  check('every ordered id exists in the registry', order.every((id) => Boolean(PROVIDERS[id])))
  check('only local providers are offered', order.every((id) => ['javelin', 'local'].includes(id)))
  check('Javelin is first', order[0] === 'javelin')
}

console.log('\n5. The manifest exposes it as a selectable option')
{
  const { readFileSync, existsSync } = await import('node:fs')
  const { join, dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  // The test runner bundles into a temp directory, so a path relative to this file
  // would resolve against the temp location. Walk up from cwd instead, and fall
  // back to the source tree so the check works in both layouts.
  const candidates = [
    resolve(process.cwd(), 'vscode-extension', 'package.json'),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'vscode-extension', 'package.json'),
  ]
  const manifestPath = candidates.find((p) => existsSync(p))
  check('manifest was located', Boolean(manifestPath), candidates.join(' | '))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const enumValues = manifest.contributes.configuration.properties['javelin.provider'].enum
  check('manifest enum includes "javelin"', enumValues.includes('javelin'), enumValues.join(','))
  check('enum and enumDescriptions have equal length',
    enumValues.length ===
    manifest.contributes.configuration.properties['javelin.provider'].enumDescriptions.length)
  check('every enum value is a real provider',
    enumValues.every((id) => Boolean(PROVIDERS[id])), enumValues.join(','))
  check('settings only offer self-hosted providers',
    enumValues.length === 2 && enumValues.every((id) => ['javelin', 'local'].includes(id)), enumValues.join(','))
  check('model setting accepts custom model ids',
    !Object.hasOwn(manifest.contributes.configuration.properties['javelin.model'], 'enum'))
  check('default model matches the Javelin provider',
    manifest.contributes.configuration.properties['javelin.model'].default === PROVIDERS.javelin.defaultModel)
}

console.log('\n6. External AI providers cannot receive requests')
{
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    throw new Error('External requests must not be sent')
  }
  try {
    let rejected = false
    try {
      await streamCompletion({
      providerId: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'Hello' }],
      })
    } catch (error) {
      rejected = /self-hosted/i.test(error.message)
    }
    check('cloud completion is rejected', rejected)
    check('no external fetch was attempted', !fetchCalled)

    const probe = await probeProviderModel({
      providerId: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test-key',
    })
    check('cloud model probing is rejected', !probe.ok && /self-hosted/i.test(probe.detail))
    check('cloud probing performs no fetch', !fetchCalled)
  } catch (error) {
    check('external providers are blocked', false, error.message)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n7. Local model probing and endpoint validation')
{
  const originalFetch = globalThis.fetch
  const recovered = salvageToolCallFromText([
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
  ].join('\n'))
  check('the VS Code provider recovers JSON tool calls embedded in prose',
    recovered?.name === 'run_command' && recovered.args.command === 'npm test',
    JSON.stringify(recovered))
  const fileActions = salvageToolCallsFromText([
    'Create a new file `Game.js` inside the `src/chess` folder.',
    'javascriptCopy',
    '```',
    '// src/chess/Game.js',
    'export default class Game {}',
    '```',
  ].join('\n'))
  check('the VS Code provider recovers an explicitly named file and code block',
    fileActions[0]?.name === 'write_file' &&
      fileActions[0]?.args.path === 'src/chess/Game.js' &&
      fileActions[0]?.args.content.includes('class Game'),
    JSON.stringify(fileActions))
  const narratedFile = salvageToolCallsFromText([
    'Plan:',
    '1. Write the initial code for the game logic in `flappy_bird/game.js`.',
    '```javascript',
    '// flappy_bird/game.js',
    'export function startGame() {}',
    '```',
  ].join('\n'))
  check('VS Code recovers the user-reported write phrasing as a file action',
    narratedFile.length === 1 &&
      narratedFile[0].name === 'write_file' &&
      narratedFile[0].args.path === 'flappy_bird/game.js' &&
      narratedFile[0].args.content.includes('startGame'),
    JSON.stringify(narratedFile))
  const narratedScripts = salvageToolCallsFromText([
    'First, create a Python script for the game. Let us call it `guess_the_number.py`.',
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
    '```',
    'For an optional import example, use:',
    '```python',
    '# main.py',
    'from guess_the_number import play_game',
    '```',
  ].join('\n'))
  check('VS Code recovers multi-file creation narration without importing examples',
    narratedScripts.length === 2 &&
      narratedScripts[0].args.path === 'guess_the_number.py' &&
      narratedScripts[1].args.path === 'flappy_bird/index.html',
    JSON.stringify(narratedScripts))
  check('VS Code rejects narrated paths outside the workspace',
    salvageToolCallsFromText([
      'Create a Python script for the game.',
      '```python',
      '# ../outside.py',
      'print("unsafe")',
      '```',
    ].join('\n')).length === 0)
  check('VS Code recovers folder creation calls from embedded JSON',
    salvageToolCallsFromText('{"name":"create_folder","arguments":{"path":"src/new-module"}}')[0]?.name === 'create_folder')
  const legacyFileCall = salvageToolCallsFromText(
    '{"name":"create_file","arguments":{"path":"src/new.js","content":"export {}"}}',
  )[0]
  check('VS Code normalizes legacy create_file JSON into a supported file write',
    legacyFileCall?.name === 'write_file' &&
      legacyFileCall.args.path === 'src/new.js' &&
      legacyFileCall.args.content === 'export {}',
    JSON.stringify(legacyFileCall))
  const camelCaseFileCall = salvageToolCallsFromText(
    '{"name":"createFile","arguments":{"path":"src/camel.js","content":"export {}"}}',
  )[0]
  check('VS Code salvages camelCase file tools into supported writes',
    camelCaseFileCall?.name === 'write_file' && camelCaseFileCall.args.path === 'src/camel.js',
    JSON.stringify(camelCaseFileCall))
  check('local Ollama endpoint is accepted', isLocalOllamaEndpoint('http://localhost:11434/v1'))
  check('remote endpoints are rejected', !isLocalOllamaEndpoint('https://api.openai.com/v1'))
  check('other local ports are rejected', !isLocalOllamaEndpoint('http://127.0.0.1:8080/v1'))
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'llama3.1:8b' }] }))
  try {
    const result = await probeProviderModel({
      providerId: 'local',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
    })
    check('missing local model is reported clearly', !result.ok && /available:/i.test(result.detail || ''), result.detail)
    check('the message names the requested model', !result.ok && /qwen2\.5-coder:7b/i.test(result.detail || ''), result.detail)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log(`\n${failures === 0 ? 'ALL PROVIDER CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
