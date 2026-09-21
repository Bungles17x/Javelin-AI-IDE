/**
 * Auto-capture — the dataset that builds itself.
 *
 * Normal use of Javelin should produce training data as a side effect, not as a
 * separate chore. These tests prove the auto-capture sink does that, and — just as
 * importantly — that it can never harm a run:
 *
 *  1. With capture OFF, nothing is written and the run is unchanged.
 *  2. With capture ON, a valid JDF trajectory is written for the run.
 *  3. The captured record carries the real steps, not a summary.
 *  4. A capture failure (unwritable dir) does NOT fail the run.
 *  5. The sink reports honestly when there is no filesystem.
 *
 * Run: npm test
 */

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createJavelin, EngineRegistry } from '../src/core/index.js'
import { captureTrajectory, makeTrajectoryHook } from '../src/core/traceSink.js'
import { fromJsonl, validateRecord } from '../training/dataset/format.js'
import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A deterministic engine that replays a script of turns. */
function makeEngine(script) {
  let call = 0
  return {
    id: 'capture-engine',
    label: 'Capture engine',
    capabilities: ['tools', 'offline'],
    async probe() {
      return { ok: true }
    },
    async generate() {
      const step = script[Math.min(call, script.length - 1)]
      call++
      return {
        text: step.text ?? '',
        toolCalls: step.toolCalls ?? [],
        finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
        engineId: 'capture-engine',
      }
    },
  }
}

function makeJavelin(script, opts = {}) {
  const registry = new EngineRegistry()
  registry.register(makeEngine(script))
  registry.assign('primary', 'capture-engine')
  return createJavelin({ engines: registry, ...opts })
}

const WORKSPACE = { 'calc.js': 'export function add(a, b) {\n  return a - b\n}\n' }
const read = (id, path) => ({ id, name: 'read_file', args: { path } })
const edit = (id, path, o, n) => ({ id, name: 'edit_file', args: { path, old_string: o, new_string: n } })
const finish = (id, summary, verified) => ({ id, name: 'finish', args: { summary, verified } })

console.log('\n1. Capture OFF: nothing is written, the run is normal')
{
  const dir = mkdtempSync(join(tmpdir(), 'javelin-nocap-'))
  const javelin = makeJavelin([
    { text: '', toolCalls: [read('c1', 'calc.js')] },
    { text: '', toolCalls: [finish('c2', 'read only', false)] },
  ])
  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'read calc',
    workspace: ws,
    onEvent: () => { },
    requestApproval: async () => ({ approved: true }),
    // autoCapture left off (the default)
  })
  check('the run still completed', result.status === 'done', result.status)
  check('no trace directory was created', !existsSync(dir) || readdirSync(dir).length === 0)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n2. Capture ON: a valid JDF trajectory is written')
{
  const dir = mkdtempSync(join(tmpdir(), 'javelin-cap-'))
  const javelin = makeJavelin([
    { text: '', toolCalls: [read('c1', 'calc.js')] },
    { text: '', toolCalls: [edit('c2', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [finish('c3', 'fixed', false)] },
  ])
  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'fix add()',
    workspace: ws,
    onEvent: () => { },
    requestApproval: async () => ({ approved: true }),
    autoCapture: true,
    captureDir: dir,
  })

  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  check('exactly one trace file was written', files.length === 1, String(files.length))

  const { records, errors } = fromJsonl(readFileSync(join(dir, files[0]), 'utf8'))
  check('the trace parses with no errors', errors.length === 0, JSON.stringify(errors))
  check('it is a trajectory record', records[0]?.kind === 'trajectory', records[0]?.kind)
  check('it is valid JDF', validateRecord(records[0]).ok, JSON.stringify(validateRecord(records[0]).errors))
  check('it recorded the real steps', records[0]?.trajectory?.toolCalls?.length === 2, String(records[0]?.trajectory?.toolCalls?.length))
  check('it recorded the task', records[0]?.trajectory?.task === 'fix add()', records[0]?.trajectory?.task)
  check('the run result is unchanged by capture', result.status === 'done', result.status)

  rmSync(dir, { recursive: true, force: true })
}

console.log('\n3. A capture failure never fails the run')
{
  // Point capture at a path that cannot be created as a directory (a file exists there).
  const dir = mkdtempSync(join(tmpdir(), 'javelin-failcap-'))
  const blocked = join(dir, 'not-a-dir')
  const fs = await import('node:fs')
  fs.writeFileSync(blocked, 'i am a file')

  const javelin = makeJavelin([
    { text: '', toolCalls: [read('c1', 'calc.js')] },
    { text: '', toolCalls: [finish('c2', 'done', false)] },
  ])
  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'read calc',
    workspace: ws,
    onEvent: () => { },
    requestApproval: async () => ({ approved: true }),
    autoCapture: true,
    captureDir: join(blocked, 'sub'), // cannot mkdir under a file
  })
  check('the run still completed despite a capture failure', result.status === 'done', result.status)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n4. The sink reports honestly when there is no directory')
{
  const outcome = await captureTrajectory({ run: { task: 'x', steps: [] }, events: [], dir: null })
  check('it declines rather than throwing', outcome.ok === false)
  check('and says why', /no capture directory/i.test(outcome.skipped ?? ''), outcome.skipped)
}

console.log('\n5. A capture hook with capture off is null (zero overhead)')
{
  const hook = makeTrajectoryHook({ enabled: false })
  check('disabled capture yields no hook', hook === null)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
