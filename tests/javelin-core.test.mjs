/**
 * Javelin Core — integration tests.
 *
 * Proves the *system* works, using a scripted engine so the tests are
 * deterministic and need no model installed. This is the evidence that Javelin's
 * reasoning lifecycle, memory, tool policy and self-correction are real.
 */

import {
  createJavelin,
  EngineRegistry,
  JavelinMemory,
  PHASE,
  buildProjectIndex,
} from '../src/core/index.js'
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

const WORKSPACE = {
  'calc.js': 'export function add(a, b) {\n  return a - b\n}\n',
  'util.js': 'export function noop() {\n  return null\n}\n',
}

/** A deterministic engine that replays a script of turns. */
function makeEngine(script) {
  let call = 0
  return {
    id: 'test-engine',
    label: 'Test engine',
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
        engineId: 'test-engine',
      }
    },
  }
}

function makeJavelin(script, opts = {}) {
  const registry = new EngineRegistry()
  registry.register(makeEngine(script))
  registry.assign('primary', 'test-engine')
  return createJavelin({ engines: registry, ...opts })
}

/** Shorthand builders keep the test scripts readable. */
const read = (id, path) => ({ id, name: 'read_file', args: { path } })
const edit = (id, path, oldString, newString) => ({
  id,
  name: 'edit_file',
  args: { path, old_string: oldString, new_string: newString },
})
const run = (id, command) => ({ id, name: 'run_command', args: { command } })
const finish = (id, summary, verified) => ({ id, name: 'finish', args: { summary, verified } })
const remember = (id, fact) => ({ id, name: 'remember', args: { fact } })

const okCommand = async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })
const alwaysApprove = async () => ({ approved: true })

console.log('\n1. Project indexing (memory grounding)')
{
  const index = buildProjectIndex(WORKSPACE)
  check('indexes all files', index.files.size === 2, String(index.files.size))
  check('detects the language', index.languages.get('javascript') === 2)
  check('extracts symbols', index.symbols.has('add'), [...index.symbols.keys()].join(','))
  check('exposes the phase constants', typeof PHASE.UNDERSTAND === 'string' && PHASE.REPAIR === 'repair')
}

console.log('\n2. Full lifecycle: understand → plan → act → verify → finish')
{
  const events = []
  const javelin = makeJavelin([
    { text: 'Looking at the project.', toolCalls: [read('c1', 'calc.js')] },
    { text: 'Plan:\n1. Fix the operator in calc.js\n2. Verify it runs', toolCalls: [] },
    { text: 'Applying the fix.', toolCalls: [edit('c2', 'calc.js', 'return a - b', 'return a + b')] },
    { text: 'Now verifying.', toolCalls: [run('c3', 'npm test')] },
    { text: 'Done.', toolCalls: [finish('c4', 'Fixed calc.js', true)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'Fix the bug in calc.js',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })

  check('run completed', result.status === 'done', result.status)
  check('the file was actually corrected', ws.read('calc.js').includes('return a + b'))
  check('plan was captured and surfaced', events.some((e) => e.type === 'plan'), 'no plan event')
  check('phase events were emitted', events.filter((e) => e.type === 'phase').length >= 4)
  check('verification was recognised', result.verified === true)
  check('summary names the touched file', result.summary.includes('calc.js'), result.summary)
}

console.log('\n3. Self-correction: a failed action is never repeated')
{
  const events = []
  const javelin = makeJavelin([
    { text: 'Trying an edit.', toolCalls: [edit('c1', 'calc.js', 'NOT PRESENT', 'x')] },
    { text: 'Trying again.', toolCalls: [edit('c2', 'calc.js', 'NOT PRESENT', 'x')] },
    { text: 'Different approach.', toolCalls: [edit('c3', 'calc.js', 'return a - b', 'return a + b')] },
    { text: 'Verify.', toolCalls: [run('c4', 'npm test')] },
    { text: '', toolCalls: [finish('c5', 'Fixed', true)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  await javelin.think({
    task: 'Fix calc.js',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })

  const blocked = events.filter((e) => e.type === 'repeat_blocked')
  check('the repeated failed action was blocked', blocked.length === 1, `got ${blocked.length}`)
  check('the block reason explains why', Boolean(blocked[0]?.note.includes('already tried')))
  check('the working fix still applied', ws.read('calc.js').includes('return a + b'))
}

console.log('\n4. Verification is enforced (no false "done")')
{
  const events = []
  const javelin = makeJavelin([
    { text: 'Plan:\n1. Edit calc.js\n2. Ship it', toolCalls: [] },
    { text: '', toolCalls: [edit('c1', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [finish('c2', 'Done', true)] },
    { text: '', toolCalls: [run('c3', 'npm test')] },
    { text: '', toolCalls: [finish('c4', 'Fixed and verified', true)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'Fix calc.js',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })

  const demanded = events.filter((e) => e.type === 'verification_required')
  check('an unverified finish was refused', demanded.length >= 1, `got ${demanded.length}`)
  check('the run still completed after complying', result.status === 'done', result.status)
}

console.log('\n5. Safety: destructive commands are refused outright')
{
  const events = []
  const javelin = makeJavelin([
    { text: '', toolCalls: [run('c1', 'rm -rf /')] },
    { text: '', toolCalls: [finish('c2', 'could not proceed', false)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  await javelin.think({
    task: 'delete everything',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })

  const refused = events.filter((e) => e.type === 'tool_refused')
  check('rm -rf / was refused outright', refused.length === 1, `got ${refused.length}`)
}

console.log('\n6. A denied edit is not applied and not retried')
{
  const events = []
  const javelin = makeJavelin([
    { text: '', toolCalls: [edit('c1', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [edit('c2', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [finish('c3', 'user denied', false)] },
  ])

  let approvals = 0
  const ws = new VirtualWorkspace(WORKSPACE)
  await javelin.think({
    task: 'change calc',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: async () => {
      approvals++
      return { approved: false }
    },
  })

  check('approval was requested', approvals >= 1, String(approvals))
  check('the denied edit was not applied', ws.read('calc.js').includes('return a - b'))
  check('the denied retry was blocked as a repeat', events.some((e) => e.type === 'repeat_blocked'))
}

console.log('\n7. Memory persists and grounds later runs')
{
  const javelin = makeJavelin([
    { text: '', toolCalls: [remember('c1', 'Tests live in the tests/ directory')] },
    { text: '', toolCalls: [finish('c2', 'noted', false)] },
  ])

  const ws = new VirtualWorkspace(WORKSPACE)
  await javelin.think({
    task: 'learn about the project',
    workspace: ws,
    onEvent: () => {},
    requestApproval: alwaysApprove,
  })

  const learnings = javelin.learnings()
  check(
    'the fact was stored in semantic memory',
    learnings.strong.some((f) => f.fact.includes('tests/')),
    JSON.stringify(learnings.strong),
  )

  const restored = JavelinMemory.restore(javelin.memory.snapshot())
  check('memory survives serialisation', restored.semantic.strong().length >= 1)
  check('memory block grounds a future task', Boolean(restored.contextFor('where are the tests')))
}

console.log('\n8. Stop / abort')
{
  const javelin = makeJavelin([{ text: 'thinking', toolCalls: [] }])
  const ws = new VirtualWorkspace(WORKSPACE)
  const controller = new AbortController()
  controller.abort()
  const result = await javelin.think({
    task: 'anything',
    workspace: ws,
    signal: controller.signal,
    onEvent: () => {},
    requestApproval: alwaysApprove,
  })
  check('an aborted run reports aborted', result.status === 'aborted', result.status)
}

console.log('\n9. Engine registry degrades gracefully')
{
  const registry = new EngineRegistry()
  registry.register({
    id: 'dead',
    label: 'Unreachable engine',
    capabilities: [],
    async probe() {
      return { ok: false, detail: 'connection refused' }
    },
    async generate() {
      throw new Error('should not be called')
    },
  })
  registry.register(makeEngine([{ text: '', toolCalls: [finish('c1', 'used the fallback', false)] }]))
  registry.assign('primary', 'dead')

  const javelin = createJavelin({ engines: registry })
  const diag = await javelin.diagnose()
  check('the dead engine is reported unhealthy', diag.health.dead.ok === false)

  const ws = new VirtualWorkspace(WORKSPACE)
  const result = await javelin.think({
    task: 'do something',
    workspace: ws,
    onEvent: () => {},
    requestApproval: alwaysApprove,
  })
  check('Javelin falls back to a healthy engine', result.status === 'done', result.status)
}

console.log('\n9. A model that only narrates cannot fake completion')
{
  const ws = new VirtualWorkspace(WORKSPACE)
  // The model describes what it WOULD do but never calls a tool and never finishes.
  const javelin = makeJavelin([
    { text: 'I will now update calc.js to fix the operator.', toolCalls: [] },
    { text: 'The fix has been applied to calc.js.', toolCalls: [] },
    { text: 'Done.', toolCalls: [] },
  ])
  const events = []
  const result = await javelin.think({
    task: 'fix calc.js',
    workspace: ws,
    runCommand: okCommand,
    onEvent: (e) => events.push(e),
    requestApproval: alwaysApprove,
  })
  check('no file was actually changed', ws.read('calc.js').includes('return a - b'))
  check('the run did NOT report unqualified success without acting',
    result.steps.length === 0, `steps=${result.steps.length}`)
}

console.log(`\n${failures === 0 ? 'ALL JAVELIN CORE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
