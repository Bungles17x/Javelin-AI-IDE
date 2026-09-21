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

for (const test of tests) {
  const entry = path.join(here, test)
  const outfile = path.join(outDir, test.replace(/\.mjs$/, '.bundle.mjs'))

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
    absWorkingDir: root,
  })

  console.log(`\n=== ${test} ===`)
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed++
  }
}

rmSync(outDir, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} test file(s) failed.\n`)
  process.exit(1)
}
console.log('\nAll test files passed.\n')
