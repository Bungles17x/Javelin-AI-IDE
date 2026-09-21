/**
 * Capture pipeline — from a real run to training data.
 *
 * This is the foundation of "my own model": a fine-tune is only honest if the
 * training examples came from runs that actually happened. These tests prove the
 * chain works and, just as importantly, that it never fabricates data.
 *
 * Run: npm test
 */

import { trajectoryFromRun, trajectoryToJsonl } from '../src/core/trace.js'
import { exportTrajectory } from '../training/dataset/exporter.js'
import { validateRecord, fromJsonl, SOURCE } from '../training/dataset/format.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const SYSTEM = 'You are Javelin.'
const TOOLS = [{ type: 'function', function: { name: 'read_file', description: 'Read a file' }}]

console.log('\n1. A real run becomes a valid JDF trajectory')
{
  const run = {
    task: 'Fix add() in calc.js',
    status: 'done',
    verified: true,
    steps: [
      { id: 'c1', name: 'read_file', args: { path: 'calc.js' }, ok: true, output: 'return a - b' },
      { id: 'c2', name: 'edit_file', args: { path: 'calc.js', old_string: 'return a - b', new_string: 'return a + b' }, ok: true, output: 'Edited' },
      { id: 'c3', name: 'run_command', args: { command: 'npm test' }, ok: true, output: 'pass' },
    ],
    hypotheses: [],
    filesTouched: ['calc.js'],
    events: [{ type: 'plan', plan: '1. read 2. fix 3. verify' }],
  }
  const rec = trajectoryFromRun(run, { systemPrompt: SYSTEM, toolSchemas: TOOLS, model: 'test', timestamp: '2026-01-01T00:00:00Z' })

  check('kind is trajectory', rec.kind === 'trajectory', rec.kind)
  check('source is runtime-trace', rec.source === SOURCE.RUNTIME_TRACE, rec.source)
  check('it is valid JDF', validateRecord(rec).ok, JSON.stringify(validateRecord(rec).errors))
  check('the tool calls are recorded', rec.trajectory.toolCalls.length === 3, String(rec.trajectory.toolCalls.length))
  check('their results are recorded', rec.trajectory.toolResults.length === 3)
  check('the task is recorded', rec.trajectory.task === 'Fix add() in calc.js')
  check('the plan is captured', rec.trajectory.plan === '1. read 2. fix 3. verify')
  check('outcome is labelled verified', rec.outcome.verified === true)
}

console.log('\n2. Honesty: an unverified run is not labelled verified')
{
  const rec = trajectoryFromRun(
    { task: 'x', status: 'done', verified: false, steps: [{ id: 'c1', name: 'read_file', args: {}, ok: true, output: '' }] },
    {},
  )
  check('verified stays false when the run did not verify', rec.outcome.verified === false)
}

console.log('\n3. A run that did nothing is recorded but teaches nothing')
{
  const rec = trajectoryFromRun(
    { task: 'do nothing', status: 'failed', verified: false, steps: [], hypotheses: [], events: [] },
    { systemPrompt: SYSTEM },
  )
  check('the empty run is still recorded (audit trail)', rec.kind === 'trajectory')
  check('it is tagged no-action', rec.tags.includes('no-action'))
  const examples = exportTrajectory(rec, { systemPrompt: SYSTEM, toolSchemas: TOOLS })
  check('but it exports zero training examples', examples.length === 0, String(examples.length))
}

console.log('\n4. A failure -> successful-different-action run exports a repair example')
{
  const run = {
    task: 'Fix the parser',
    status: 'done',
    verified: true,
    steps: [
      { id: 'c1', name: 'edit_file', args: { path: 'p.js', old_string: 'OLD', new_string: 'X' }, ok: false, output: 'old_string not found' },
      { id: 'c2', name: 'read_file', args: { path: 'p.js' }, ok: true, output: 'const OLDER = 1' },
      { id: 'c3', name: 'edit_file', args: { path: 'p.js', old_string: 'const OLDER = 1', new_string: 'const OLDER = 2' }, ok: true, output: 'Edited' },
    ],
    hypotheses: ['the snippet did not match; re-read the file'],
    events: [],
  }
  const rec = trajectoryFromRun(run, { systemPrompt: SYSTEM, toolSchemas: TOOLS })
  const examples = exportTrajectory(rec, { systemPrompt: SYSTEM, toolSchemas: TOOLS })

  const repairs = examples.filter((e) => e.skill === 'repair')
  check('a repair example was exported', repairs.length >= 1, String(repairs.length))
  check('the repair target is the successful action',
    repairs[0]?.messages.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.function?.name === 'edit_file'))
  check('the repair carries the diagnosis',
    repairs.some((e) => e.messages.some((m) => (m.content ?? '').includes('diagnosed cause'))))
}

console.log('\n5. A failed repair is never exported as a correct target')
{
  const run = {
    task: 'bad task',
    status: 'failed',
    verified: false,
    steps: [
      { id: 'c1', name: 'edit_file', args: { path: 'p.js', old_string: 'A', new_string: 'B' }, ok: false, output: 'not found' },
      { id: 'c2', name: 'edit_file', args: { path: 'p.js', old_string: 'A', new_string: 'B' }, ok: false, output: 'not found again' },
    ],
    hypotheses: [],
    events: [],
  }
  const rec = trajectoryFromRun(run, { systemPrompt: SYSTEM, toolSchemas: TOOLS })
  const examples = exportTrajectory(rec, { systemPrompt: SYSTEM, toolSchemas: TOOLS })
  const repairs = examples.filter((e) => e.skill === 'repair')
  check('no repair example from an unrepaired failure', repairs.length === 0, String(repairs.length))
  const edits = examples.filter((e) => e.skill === 'edit-precision')
  check('no edit example from failed edits', edits.length === 0, String(edits.length))
}

console.log('\n6. The trajectory round-trips through JSONL')
{
  const rec = trajectoryFromRun(
    { task: 'x', status: 'done', verified: true, steps: [{ id: 'c1', name: 'read_file', args: { path: 'a' }, ok: true, output: 'y' }], events: [] },
    {},
  )
  const line = trajectoryToJsonl(rec)
  check('it serialises to exactly one line', line.split('\n').length === 1)
  const { records, errors } = fromJsonl(line + '\n')
  check('it parses back with no errors', errors.length === 0, JSON.stringify(errors))
  check('the round-tripped record matches', records[0]?.id === rec.id)
  check('the round-tripped record is valid', validateRecord(records[0]).ok)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
