/**
 * Accept / revert — the corruption safety net.
 *
 * The claim these tests exist to prove: after a run, you can always get your
 * workspace back, *without* relying on the agent to have been sensible. The
 * checkpoint is taken automatically by the runtime before the first tool call, so
 * even a run that corrupts files or fails halfway is recoverable in one step.
 *
 *  1. A safety checkpoint is taken BEFORE any tool runs (not after, not by request).
 *  2. It is taken even under full autonomy, where the agent never asks permission.
 *  3. Reverting restores a file the run corrupted.
 *  4. Reverting un-deletes a file the run deleted.
 *  5. Reverting is idempotent — reverting twice is safe, not an error.
 *  6. The run result exposes the baseline id, so a UI can always offer the button.
 *  7. If a checkpoint cannot be taken, the run refuses to edit rather than
 *     proceeding unprotected.
 */

import { createJavelin, EngineRegistry, JavelinMemory } from '../src/core/index.js'
import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'
import { AUTONOMY } from '../src/core/tools.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const GOOD_CALC = 'export function add(a, b) {\n  return a + b\n}\n'
const GOOD_UTIL = 'export function noop() {\n  return null\n}\n'
const WORKSPACE = { 'calc.js': GOOD_CALC, 'util.js': GOOD_UTIL }

/** A deterministic engine replaying a script of turns. */
function makeEngine(script) {
  let pending = 0
  return {
    id: 'test-engine',
    label: 'Test engine',
    capabilities: ['tools', 'offline'],
    async probe() {
      return { ok: true }
    },
    async generate() {
      // The runtime may ask for an extra turn (e.g. before the first action), so the
      // script index only advances once a turn has actually carried tool calls.
      // Holding on the current step keeps a script from running dry mid-task.
      const index = Math.min(pending, script.length - 1)
      const step = script[index]
      const toolCalls = step.toolCalls ?? []
      if (toolCalls.length) {
        pending++
      }
      return {
        text: step.text ?? '',
        toolCalls,
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
        engineId: 'test-engine',
      }
    },
  }
}

function makeJavelin(script) {
  const registry = new EngineRegistry()
  registry.register(makeEngine(script))
  registry.assign('primary', 'test-engine')
  return createJavelin({ engines: registry, memory: new JavelinMemory() })
}

// Existing files need an explicit overwrite — write_file refuses to clobber by default.
// Script steps, shaped like the runtime's turns: { text, toolCalls }.
// (These are NOT bare tool calls — the engine replays whole turns.)
const write = (id, path, content) => ({
  text: `Writing ${path}.`,
  toolCalls: [{ id, name: 'write_file', args: { path, content, overwrite: true } }],
})
const del = (id, path) => ({
  text: `Deleting ${path}.`,
  toolCalls: [{ id, name: 'delete_file', args: { path } }],
})
const stop = (id, summary) => ({
  text: 'Done.',
  toolCalls: [{ id, name: 'finish', args: { summary, verified: true } }],
})
const cmd = (id, command) => ({
  text: `Running ${command}.`,
  toolCalls: [{ id, name: 'run_command', args: { command } }],
})

/**
 * A script that changes files, then verifies, then finishes.
 *
 * The verification step is not optional dressing: the runtime refuses an
 * unverified finish once files have changed, so a script that skips it never
 * reaches its `finish` turn — which is the policy working as intended.
 */
function changing(edit) {
  return [edit, cmd('verify', 'npm test'), stop('end', 'done')]
}

async function run(script, workspace, opts = {}) {
  const events = []
  const javelin = opts.javelin ?? makeJavelin(script)
  const result = await javelin.think({
    task: opts.task ?? 'change files',
    workspace,
    runCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    onEvent: (e) => events.push(e),
    requestApproval: opts.requestApproval ?? (async () => ({ approved: true })),
    autonomy: opts.autonomy ?? AUTONOMY.FULL,
  })
  return { result, events, workspace }
}

console.log('\n1. A safety checkpoint is taken BEFORE any tool runs')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  const { result, events } = await run(changing(write('a1', 'calc.js', 'CORRUPTED\n')), ws)
  const checkpointEvents = events.filter((e) => e.type === 'checkpoint')
  check('the runtime emitted a checkpoint event', checkpointEvents.length >= 1,
    String(checkpointEvents.length))
  check('the run exposes a baseline id', Boolean(result.baseline), String(result.baseline))
  // The baseline must be the FIRST checkpoint — taken before the edit, not after.
  check('the baseline is the first checkpoint recorded',
    result.checkpoints[0]?.id === result.baseline,
    `${result.checkpoints[0]?.id} vs ${result.baseline}`)
  check('its label identifies it as the start of the run',
    /start of run/i.test(result.checkpoints[0]?.label ?? ''),
    result.checkpoints[0]?.label)
}

console.log('\n2. It is taken even under full autonomy, where nothing is approved')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  let approvals = 0
  const { result } = await run(changing(write('b1', 'calc.js', 'CORRUPTED\n')), ws, {
    task: 'corrupt a file',
    requestApproval: async () => {
      approvals++
      return { approved: true }
    },
    autonomy: AUTONOMY.FULL,
  })
  check('no approval was requested under full autonomy', approvals === 0, String(approvals))
  check('a baseline still exists to revert to', Boolean(result.baseline))
  // And it is genuinely the pre-corruption content, not the post-run state.
  check('the baseline predates the corruption',
    result.checkpoints[0].fileCount === 2,
    String(result.checkpoints[0].fileCount))
}

console.log('\n3. Reverting restores a file the run corrupted')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  const { result } = await run(changing(write('c1', 'calc.js', 'totally broken')), ws)
  check('the file was corrupted by the run', ws.read('calc.js') === 'totally broken')

  const changed = ws.restore(result.baseline)
  check('revert restored the original content', ws.read('calc.js') === GOOD_CALC, ws.read('calc.js'))
  check('revert reported the file it changed', changed.includes('calc.js'), changed.join(','))
}

console.log('\n4. Reverting un-deletes a file the run deleted')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  const { result } = await run(changing(del('d1', 'util.js')), ws)
  check('the file was deleted by the run', !ws.exists('util.js'))

  ws.restore(result.baseline)
  check('revert brought the deleted file back', ws.exists('util.js'))
  check('and its content is intact', ws.read('util.js') === GOOD_UTIL, ws.read('util.js'))
}

console.log('\n5. Reverting twice is safe (idempotent)')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  const { result } = await run(changing(write('e1', 'calc.js', 'broken\n')), ws)
  ws.restore(result.baseline)
  const second = ws.restore(result.baseline)
  check('a second revert does not throw', true)
  check('a second revert reports nothing left to change', second.length === 0, second.join(','))
  check('the content is still correct', ws.read('calc.js') === GOOD_CALC)
}

console.log('\n6. A failed run is still revertible (the case that matters most)')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  // The engine throws: a mid-run crash after it already corrupted a file.
  const registry = new EngineRegistry()
  let call = 0
  registry.register({
    id: 'test-engine',
    label: 'Test engine',
    capabilities: ['tools', 'offline'],
    async probe() {
      return { ok: true }
    },
    async generate() {
      call++
      if (call === 1) {
        return {
          text: '',
          toolCalls: [write('f1', 'calc.js', 'half-written garbage').toolCalls[0]],
          finishReason: 'tool_calls',
          engineId: 'test-engine',
        }
      }
      throw new Error('engine exploded mid-run')
    },
  })
  registry.assign('primary', 'test-engine')

  const javelin = createJavelin({ engines: registry, memory: new JavelinMemory() })
  const result = await javelin.think({
    task: 'corrupt then crash',
    workspace: ws,
    runCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    onEvent: () => { },
    requestApproval: async () => ({ approved: true }),
    autonomy: AUTONOMY.FULL,
  })

  check('the run is reported as failed', result.status === 'failed', result.status)
  check('the file really was corrupted before the crash',
    ws.read('calc.js') === 'half-written garbage', ws.read('calc.js'))
  check('a baseline was still taken despite the crash', Boolean(result.baseline))

  ws.restore(result.baseline)
  check('reverting recovers the corrupted file', ws.read('calc.js') === GOOD_CALC, ws.read('calc.js'))
}

console.log('\n7. If no checkpoint can be taken, the run refuses to edit')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  // A workspace that cannot snapshot must not be edited — no unprotected runs.
  ws.snapshot = () => {
    throw new Error('cannot write snapshots')
  }
  const { result } = await run(changing(write('g1', 'calc.js', 'should never be written')), ws, {
    task: 'try to edit an unprotected workspace',
    autonomy: AUTONOMY.FULL,
  })

  check('the run failed rather than proceeding', result.status === 'failed', result.status)
  check('the reason is stated honestly',
    /checkpoint/i.test(result.summary), result.summary)
  check('no file was modified', ws.read('calc.js') === GOOD_CALC, ws.read('calc.js'))
  check('no baseline is claimed', result.baseline === null, String(result.baseline))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)