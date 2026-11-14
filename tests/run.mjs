/**
 * Test runner.
 *
 * The agent modules under src/lib use extensionless imports (Vite resolves them,
 * bare Node does not). Rather than fight the resolver, we bundle each test with
 * the esbuild that already ships as a Vite dependency, then execute it.
 *
 * Run: npm test
 */

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = mkdtempSync(path.join(tmpdir(), 'javelin-tests-'))

const tests = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

if (!tests.length) {
  console.error('No test files found in tests/.')
  process.exit(1)
}

let failed = 0
const failedTests = []

for (const test of tests) {
  const entry = path.join(here, test)
  console.log(`\n=== ${test} ===`)
  let testFile = entry

  // Keep the CommonJS Electron helper native; bundling it into ESM breaks Node built-in requires.
  if (test !== 'desktop-text-files.test.mjs') {
    testFile = path.join(outDir, test.replace(/\.mjs$/, '.bundle.mjs'))
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: testFile,
      logLevel: 'silent',
      absWorkingDir: root,
      // Workerd provides this built-in module; the Node test bundle only needs
      // to leave the import intact (the SMTP test injects its own transport).
      external: ['cloudflare:sockets'],
    })
  }

  const result = spawnSync(process.execPath, [testFile], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed++
    failedTests.push(test)
    console.error(`\n>>> FAILED TEST: ${test} <<<\n`)
  }
}

rmSync(outDir, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} test file(s) failed: ${failedTests.join(', ')}\n`)
  process.exit(1)
}
console.log('\nAll test files passed.\n')
