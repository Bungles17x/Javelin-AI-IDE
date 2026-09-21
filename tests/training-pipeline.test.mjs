/**
 * Training pipeline — integration tests.
 *
 * Proves the pipeline works with Javelin's REAL runtime, not mocks:
 * the recorder observes actual Core event streams, the exporter turns them into
 * valid training examples, and the format guarantees hold.
 */

import { EngineRegistry } from '../src/core/engines.js'
import { runJavelin } from '../src/core/runtime.js'
import { JavelinMemory } from '../src/core/memory.js'
import { createStandardToolset } from '../src/core/tools.js'
import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'

import { createTraceRecorder } from '../training/dataset/recorder.js'
import { exportTrajectory, exportDataset } from '../training/dataset/exporter.js'
import { buildSeedDataset, SEED_SYSTEM_PROMPT } from '../training/dataset/seeds.js'
import {
  validateDataset, validateRecord, dedupe, split, toJsonl, fromJsonl, SOURCE, SKILL,
} from '../training/dataset/format.js'

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
function scriptedEngine(steps) {
  let call = 0
  return {
    id: 'test-engine',
    label: 'Test engine',
    capabilities: ['tools', 'offline'],
    async probe() {
      return { ok: true }
    },
    async generate() {
      const step = steps[Math.min(call, steps.length - 1)]
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

const WORKSPACE = { 'calc.js': 'export function add(a, b) {\n  return a - b\n}\n' }

const read = (id, path) => ({ id, name: 'read_file', args: { path } })
const edit = (id, path, oldS, newS) => ({ id, name: 'edit_file', args: { path, old_string: oldS, new_string: newS } })
const run = (id, command) => ({ id, name: 'run_command', args: { command } })
const finish = (id, summary, verified) => ({ id, name: 'finish', args: { summary, verified } })

/** Run a scripted Javelin run and capture it. */
async function captureRun(script, opts = {}) {
  const registry = new EngineRegistry()
  registry.register(scriptedEngine(script))
  registry.assign('primary', 'test-engine')

  const recorder = createTraceRecorder({ task: opts.task ?? 'Fix the bug in calc.js' })
  const ws = new VirtualWorkspace(opts.files ?? WORKSPACE)
  const tools = createStandardToolset()

  const result = await runJavelin({
    task: opts.task ?? 'Fix the bug in calc.js',
    workspace: ws,
    engines: registry,
    signal: new AbortController().signal,
    memory: new JavelinMemory(),
    tools,
    runCommand: async () => ({ exitCode: 0, stdout: 'PASS', stderr: '' }),
    onEvent: recorder.observe,
    requestApproval: async () => ({ approved: true }),
  })

  const trajectory = recorder.finish({
    status: result.status,
    summary: result.summary,
    verified: result.verified,
    filesTouched: result.filesTouched,
  })

  return { result, trajectory, recorder, tools }
}

console.log('\n1. Recorder observes a real Javelin run')
{
  // A realistic sequence: understand first (inspect), then state the plan, then act.
  const { trajectory, recorder } = await captureRun([
    { text: 'Looking at the project.', toolCalls: [read('c1', 'calc.js')] },
    { text: 'Plan:\n1. Fix the operator in calc.js\n2. Verify it runs', toolCalls: [] },
    { text: '', toolCalls: [edit('c2', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [run('c3', 'npm test')] },
    { text: '', toolCalls: [finish('c4', 'Fixed', true)] },
  ])

  check('recorder captured events', recorder.eventCount > 0, String(recorder.eventCount))
  check('trajectory is valid JDF', validateRecord(trajectory).ok, JSON.stringify(validateRecord(trajectory).errors))
  check('trajectory kind is correct', trajectory.kind === 'trajectory')
  check('source is runtime-trace', trajectory.source === SOURCE.RUNTIME_TRACE)
  check('plan was captured', Boolean(trajectory.trajectory.plan))
  check('task was captured', trajectory.trajectory.task.includes('calc.js'))
  // `finish` ends the run before a tool_call event is emitted, and the plan turn
  // makes no tool call. So three real actions are recorded here.
  check('tool calls recorded', trajectory.trajectory.toolCalls.length === 3,
    String(trajectory.trajectory.toolCalls.length))
}

console.log('\n2. Exporter produces training examples from a real run')
{
  const { trajectory, tools } = await captureRun([
    { text: 'Inspecting the relevant file.', toolCalls: [read('c1', 'calc.js')] },
    { text: 'Plan:\n1. Fix calc.js\n2. Verify', toolCalls: [] },
    { text: '', toolCalls: [edit('c2', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [run('c3', 'npm test')] },
    { text: '', toolCalls: [finish('c4', 'Fixed', true)] },
  ])

  const examples = exportTrajectory(trajectory, {
    systemPrompt: SEED_SYSTEM_PROMPT,
    toolSchemas: tools.schemas(),
  })

  check('examples were produced', examples.length > 0, String(examples.length))
  check('all examples are valid JDF', examples.every((e) => validateRecord(e).ok),
    JSON.stringify(examples.flatMap((e) => validateRecord(e).errors)))

  const skills = new Set(examples.map((e) => e.skill))
  check('taught tool selection', skills.has(SKILL.TOOL_SELECTION), [...skills].join(','))
  check('taught edit precision', skills.has(SKILL.EDIT_PRECISION))
  check('taught verification', skills.has(SKILL.VERIFICATION))

  const editExample = examples.find((e) => e.skill === SKILL.EDIT_PRECISION)
  // Find the edit call specifically — the context also contains the earlier read.
  const targetMsg = editExample.messages.find((m) =>
    m.tool_calls?.some((tc) => tc.function.name === 'edit_file'))
  const editArgs = JSON.parse(targetMsg.tool_calls[0].function.arguments)
  check('edit target carries the exact snippet', editArgs.old_string === 'return a - b',
    JSON.stringify(editArgs))
  check('edit target carries the replacement', editArgs.new_string === 'return a + b')
  check('edit target arguments are a JSON string',
    typeof targetMsg.tool_calls[0].function.arguments === 'string')
  check('example includes the action consequence', editExample.messages.some((m) => m.role === 'tool'))
  check('context precedes the target (read comes first)',
    editExample.messages.findIndex((m) => m.tool_calls?.[0]?.function.name === 'read_file') <
      editExample.messages.findIndex((m) => m.tool_calls?.[0]?.function.name === 'edit_file'))
}

console.log('\n3. Repair lessons are extracted from failed → successful transitions')
{
  const { trajectory } = await captureRun([
    { text: 'Plan:\n1. Edit calc.js', toolCalls: [edit('c1', 'calc.js', 'NOT PRESENT', 'x')] },
    // The runtime blocks the repeat; then the model diagnoses and reads the file.
    {
      text: 'Diagnosis: the snippet was guessed. The cause is a stale assumption about the file contents.',
      toolCalls: [read('c2', 'calc.js')]
    },
    { text: '', toolCalls: [edit('c3', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [run('c4', 'npm test')] },
    { text: '', toolCalls: [finish('c5', 'Fixed', true)] },
  ])

  const examples = exportTrajectory(trajectory, { systemPrompt: SEED_SYSTEM_PROMPT })
  const repair = examples.find((e) => e.skill === SKILL.REPAIR)
  check('a repair example was derived from the trace', Boolean(repair))
  check('repair was derived despite no hypothesis event',
    (trajectory.trajectory.hypotheses ?? []).length === 0 && Boolean(repair),
    'runtime only emits hypotheses for failed verifications')
  if (repair) {
    // The failed action must be visible to the model, so it can learn NOT to
    // repeat it — this is the entire point of a repair example.
    check('repair example shows the failure in context', repair.messages.some(
      (m) => m.role === 'tool' && /not found/i.test(m.content ?? '')))
    check('repair lesson instructs a different approach', repair.messages.some(
      (m) => m.role === 'system' && /materially different approach/i.test(m.content ?? '')))
    check('repair target is a successful different action',
      repair.messages.some((m) => m.tool_calls && m.tool_calls[0].function.name === 'read_file'))
  }
}

console.log('\n4. Only successful edits become targets (never train on failures)')
{
  const { trajectory } = await captureRun([
    { text: 'Plan:\n1. Try an edit', toolCalls: [edit('c1', 'calc.js', 'BOGUS', 'x')] },
    { text: '', toolCalls: [finish('c2', 'gave up', false)] },
  ])

  const examples = exportTrajectory(trajectory, {})
  const editTargets = examples.filter((e) => e.skill === SKILL.EDIT_PRECISION)
  check('no edit example from a failed edit', editTargets.length === 0, String(editTargets.length))
  check('no verification example was invented', !examples.some((e) => e.skill === SKILL.VERIFICATION && e.outcome.status === 'success' && !e.tags?.includes('verify-passed')))
}

console.log('\n5. Repeat-block lessons come from the runtime refusal')
{
  const { trajectory } = await captureRun([
    { text: 'Plan:\n1. Edit', toolCalls: [edit('c1', 'calc.js', 'BOGUS', 'x')] },
    // The model retries the identical failing call — the runtime must block it.
    { text: '', toolCalls: [edit('c2', 'calc.js', 'BOGUS', 'x')] },
    { text: '', toolCalls: [read('c3', 'calc.js')] },
    { text: '', toolCalls: [finish('c4', 'recovered', false)] },
  ])

  const examples = exportTrajectory(trajectory, { systemPrompt: SEED_SYSTEM_PROMPT })
  const honesty = examples.filter((e) => e.tags?.includes('no-repeat'))
  check('a no-repeat lesson was produced from the runtime refusal', honesty.length > 0,
    JSON.stringify(examples.map((e) => e.tags)))
  check('trajectory tagged repeat-blocked',
    trajectory.tags.includes('repeat-blocked') || trajectory.outcome.blockedRepeats > 0,
    JSON.stringify(trajectory.tags))
}

console.log('\n6. Format guarantees')
{
  const good = buildSeedDataset()
  const stats = validateDataset(good)
  check('seed dataset is valid', stats.ok, JSON.stringify(stats.errors.slice(0, 3)))
  check('every seed is labelled synthetic', good.every((r) => r.source === SOURCE.SYNTHETIC))

  // A tool result without a matching call must be rejected.
  const broken = {
    id: 'x',
    version: '1.0.0',
    kind: 'sft',
    source: SOURCE.SYNTHETIC,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'missing', name: 'read_file', content: 'x' },
    ],
  }
  const res = validateRecord(broken)
  check('dangling tool_call_id is rejected', !res.ok && res.errors.some((e) => /unknown tool_call_id/.test(e)),
    JSON.stringify(res.errors))

  // Non-string tool arguments must be rejected — OpenAI format requires a string.
  // Built via a variable so the nested braces above cannot be mangled by tooling.
  const objectArgs = JSON.parse('{"not":"a string"}')
  const badToolCall = {
    id: 'c',
    type: 'function',
    function: { name: 'n', arguments: objectArgs },
  }
  const badArgs = {
    id: 'y',
    version: '1.0.0',
    kind: 'sft',
    source: SOURCE.SYNTHETIC,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [badToolCall] },
    ],
  }
  check('object tool arguments are rejected', !validateRecord(badArgs).ok)

  // Round-trip through JSONL.
  const jsonl = toJsonl(good)
  const back = fromJsonl(jsonl)
  check('JSONL round-trips cleanly', back.errors.length === 0 && back.records.length === good.length,
    JSON.stringify(back.errors))

  // Dedupe and deterministic split.
  const withDupes = [...good, ...good]
  check('dedupe removes repeats', dedupe(withDupes).length === good.length)

  const s1 = split(good, { seed: 42 })
  const s2 = split(good, { seed: 42 })
  check('split is deterministic for a given seed',
    s1.train.length === s2.train.length && s1.train[0]?.id === s2.train[0]?.id)
}

console.log('\n7. Full pipeline: capture → export → validate')
{
  // Two runs of different quality, as would accumulate in practice.
  const good = await captureRun([
    { text: 'Plan:\n1. Read\n2. Edit\n3. Verify', toolCalls: [read('c1', 'calc.js')] },
    { text: '', toolCalls: [edit('c2', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [run('c3', 'npm test')] },
    { text: '', toolCalls: [finish('c4', 'Fixed and verified', true)] },
  ], { task: 'Fix the addition bug' })

  const messy = await captureRun([
    { text: 'Plan:\n1. Edit', toolCalls: [edit('d1', 'calc.js', 'WRONG', 'x')] },
    { text: 'Diagnosis: the cause is that I guessed the snippet.', toolCalls: [read('d2', 'calc.js')] },
    { text: '', toolCalls: [edit('d3', 'calc.js', 'return a - b', 'return a + b')] },
    { text: '', toolCalls: [run('d4', 'npm test')] },
    { text: '', toolCalls: [finish('d5', 'Recovered and fixed', true)] },
  ], { task: 'Fix the addition bug, recovering from mistakes' })

  const examples = exportDataset([good.trajectory, messy.trajectory], {
    systemPrompt: SEED_SYSTEM_PROMPT,
  })

  check('pipeline produced examples from both runs', examples.length >= 6, String(examples.length))

  const merged = dedupe([...examples, ...buildSeedDataset()])
  const validation = validateDataset(merged)
  check('merged dataset validates', validation.ok, JSON.stringify(validation.errors.slice(0, 3)))
  check('dataset mixes real and synthetic sources',
    validation.stats.bySource['runtime-trace'] > 0 && validation.stats.bySource.synthetic > 0,
    JSON.stringify(validation.stats.bySource))

  const { train, validation: val } = split(merged, { validationFraction: 0.2, seed: 7 })
  check('split produces both partitions', train.length > 0 && val.length > 0,
    `train=${train.length} val=${val.length}`)
  check('no record appears in both partitions',
    !train.some((t) => val.some((v) => v.id === t.id)))
}

console.log(`\n${failures === 0 ? 'ALL TRAINING PIPELINE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
