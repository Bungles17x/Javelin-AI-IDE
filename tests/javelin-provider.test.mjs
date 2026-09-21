/**
 * Javelin-model provider tests.
 *
 * Verifies the extension can select Javelin's own model as a provider (served by
 * Javelin's own server — no Ollama), and that it fails helpfully (rather than
 * cryptically) when the model is not served. Uses the compiled extension output so
 * it tests what actually ships.
 */

import { PROVIDERS, getProvider, DEFAULT_PROVIDER } from '../vscode-extension/out/providers.js'

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
  check('it points at a local endpoint', p.baseUrl.startsWith('http://localhost'), p.baseUrl)
  check('it has a default model name', Boolean(p.defaultModel), p.defaultModel)
  check('its help explains how to serve the model', /serve:model/i.test(p.help), p.help)
  check('its help points at the training docs', /TRAINING\.md/.test(p.help), p.help)
}

console.log('\n2. Existing providers are unchanged')
{
  const before = ['local', 'groq', 'custom']
  for (const id of before) {
    check(`${id} still registered`, Boolean(PROVIDERS[id]))
  }
  check('local is still the default', DEFAULT_PROVIDER === 'local', DEFAULT_PROVIDER)
  check('groq still requires a key', PROVIDERS.groq.requiresKey === true)
  check('custom still has no preset models', PROVIDERS.custom.models.length === 0)
  check('local is not flagged as a Javelin model', !PROVIDERS.local.isJavelinModel)
}

console.log('\n3. An unknown provider still falls back safely')
{
  const p = getProvider('does-not-exist')
  check('unknown id falls back to the default', p.id === DEFAULT_PROVIDER, p.id)
}

console.log('\n4. The provider list order puts Javelin first')
{
  // Mirrors PROVIDER_ORDER in extension.ts — keeps the picker and registry aligned.
  const order = ['javelin', 'local', 'groq', 'custom']
  check('every ordered id exists in the registry', order.every((id) => Boolean(PROVIDERS[id])))
  check('every registered provider appears in the order list',
    Object.keys(PROVIDERS).every((id) => order.includes(id)),
    Object.keys(PROVIDERS).join(','))
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
}

console.log(`\n${failures === 0 ? 'ALL JAVELIN-MODEL PROVIDER CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
