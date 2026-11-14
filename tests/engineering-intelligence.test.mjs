/**
 * Engineering intelligence: project index, dependency awareness, automatic
 * checkpointing, and evidence-based confidence.
 *
 * These are the guarantees this file exists to prove:
 *  1. The agent starts each run with a bounded project map (files, stack, layout,
 *     imports, reverse dependencies) instead of guessing at the codebase.
 *  2. A safety checkpoint is taken before any tool runs and the result exposes its
 *     baseline id, so a run is always revertible.
 *  3. A change is only reported VERIFIED when a real check passed after that change;
 *     otherwise it is LIKELY or UNVERIFIED, and the reason is explicit.
 *  4. Unresolved local imports introduced by a change are surfaced, not hidden.
 *  5. project_overview, find_references and verify_project have real behaviour.
 */

import { runAgent } from '../src/lib/agent.js'
import { VirtualWorkspace } from '../src/lib/virtualWorkspace.js'
import {
  buildProjectContext,
  buildWorkspaceIndex,
  detectVerificationCommands,
  relevantFiles,
  unresolvedImports,
} from '../src/engine/projectIndex.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const provider = { providerId: 'local', baseUrl: 'http://localhost:11434/v1', model: 'test' }

function scriptedCompletion(script, onGenerate) {
  let call = 0
  return async (request) => {
    onGenerate?.(request)
    const step = script[Math.min(call, script.length - 1)]
    call++
    return {
      content: step.content ?? '',
      toolCalls: step.toolCalls ?? [],
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
    }
  }
}

const eventsFor = () => {
  const events = []
  return { events, emit: (event) => events.push(event) }
}

const finishCall = (id, summary, verified = false) => ({
  id,
  name: 'finish',
  args: { summary, verified },
})

console.log('\n1. The project index understands structure, imports and reverse dependencies')
{
  const files = {
    'package.json': JSON.stringify({
      name: 'demo',
      main: 'src/main.js',
      scripts: { test: 'node test.mjs', build: 'vite build' },
      dependencies: { react: '^18.0.0' },
    }),
    'src/main.js': "import { add } from './math.js'\nimport React from 'react'\nconsole.log(add(1, 2))\n",
    'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n',
    'src/format.js': "import { add } from './math.js'\nexport const result = add(2, 3)\n",
  }
  const index = buildWorkspaceIndex(files)
  const mathImports = index.imports.get('src/main.js') ?? []
  check('a relative import resolves to a real file', mathImports.find((entry) => entry.specifier === './math.js')?.resolved === 'src/math.js')
  check('a package import is marked external', mathImports.find((entry) => entry.specifier === 'react')?.external === true)
  check('reverse dependencies list both importers',
    (index.dependents.get('src/math.js') ?? []).sort().join(',') === 'src/format.js,src/main.js',
    JSON.stringify(index.dependents.get('src/math.js')))
  check('the stack is detected from package.json', index.frameworks.includes('React'), index.frameworks.join(','))
  check('entry points include package.json main', index.entryPoints.includes('src/main.js'), index.entryPoints.join(','))
  check('verification commands are derived from real scripts',
    detectVerificationCommands(index).map((entry) => entry.command).join(',') === 'npm test,npm run build',
    JSON.stringify(detectVerificationCommands(index)))

  const context = buildProjectContext(index, 'Fix add in src/math.js')
  check('context starts from the indexed workspace', context.includes('PROJECT CONTEXT') && context.includes('4 files'))
  check('context names the relevant file', context.includes('src/math.js'))
  check('context shows who imports the relevant file', context.includes('imported by'))
  check('context never dumps file contents', !context.includes('return a + b'))
  check('relevant files are task-scoped', relevantFiles(index, 'fix add math').some((entry) => entry.path === 'src/math.js'))

  const broken = {
    ...files,
    'src/broken.js': "import { missing } from './does-not-exist.js'\nexport const value = missing\n",
  }
  const brokenIndex = buildWorkspaceIndex(broken)
  const warnings = unresolvedImports(brokenIndex, ['src/broken.js'])
  check('an unresolved relative import is reported with its line',
    warnings.length === 1 && warnings[0].line === 1 && warnings[0].specifier === './does-not-exist.js',
    JSON.stringify(warnings))
}

console.log('\n2. A baseline checkpoint is taken before the first tool call')
{
  const workspace = new VirtualWorkspace({ 'src/old.js': 'export const old = true\n' })
  const generate = scriptedCompletion([
    { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'src/created.js', content: 'export const value = 1\n' } }] },
    { toolCalls: [finishCall('f1', 'Created src/created.js', true)] },
  ])
  const { events, emit } = eventsFor()
  const result = await runAgent({
    task: 'Create src/created.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })

  check('the result exposes a baseline id', typeof result.baseline === 'string' && result.baseline.length > 0, String(result.baseline))
  check('the baseline is the first checkpoint', result.checkpoints[0]?.id === result.baseline)
  check('the baseline is labelled as the start of the run', /start of run/i.test(result.checkpoints[0]?.label ?? ''))
  check('a checkpoint event was emitted before the edit',
    events.findIndex((event) => event.type === 'checkpoint') < events.findIndex((event) => event.type === 'tool_call'))
  workspace.restore(result.baseline)
  check('reverting the baseline removes the created file', !workspace.exists('src/created.js'))

  check('a claimed verification without a passing check is downgraded', result.confidence === 'likely' && result.verified === false)
  check('the downgrade is explained in the result', result.notes.some((note) => /No passing/.test(note)))
  check('a verification-required event is emitted',
    events.some((event) => event.type === 'verification_required'))
}

console.log('\n3. A passing verify_project run makes the result VERIFIED')
{
  const workspace = new VirtualWorkspace({
    'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node test.mjs' } }),
  })
  const commands = []
  const generate = scriptedCompletion([
    { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'src/created.js', content: 'export const value = 1\n' } }] },
    { toolCalls: [{ id: 'v1', name: 'verify_project', args: {} }] },
    { toolCalls: [finishCall('f1', 'Created the file and ran the tests', true)] },
  ])
  const { events, emit } = eventsFor()
  const result = await runAgent({
    task: 'Create src/created.js and verify it',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
    runCommand: async (command) => {
      commands.push(command)
      return { exitCode: 0, stdout: 'all tests passed', stderr: '' }
    },
  })

  check('verify_project ran the detected test command', commands.join(',') === 'npm test', commands.join(','))
  check('a passing check is recorded as verification', result.verification.passed === true)
  check('the result is VERIFIED', result.confidence === 'verified' && result.verified === true, `${result.confidence} / ${result.verified}`)
  check('the command output is evidence', result.verification.checks.some((entry) => entry.command === 'npm test' && entry.ok))
  check('the run ends cleanly', result.status === 'done')
  check('no fabricated check is reported', result.verification.checks.every((entry) => entry.command === 'npm test'))
  check('the UI receives a command-finished event', events.some((event) => event.type === 'command_finished' && event.exitCode === 0))
}

console.log('\n4. A failing check is reported honestly, never as verified')
{
  const workspace = new VirtualWorkspace({
    'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node test.mjs' } }),
  })
  const generate = scriptedCompletion([
    { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'src/created.js', content: 'export const value = 1\n' } }] },
    { toolCalls: [{ id: 'v1', name: 'verify_project', args: { checks: ['test'] } }] },
    { toolCalls: [finishCall('f1', 'Implemented it', true)] },
  ])
  const result = await runAgent({
    task: 'Create src/created.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit: () => {}, requestApproval: async () => ({ approved: true }) },
    runCommand: async () => ({ exitCode: 1, stdout: '', stderr: '1 test failed' }),
  })

  check('the failing check is recorded', result.verification.checks.some((entry) => entry.command === 'npm test' && entry.ok === false))
  check('verification did not pass', result.verification.passed === false)
  check('the result is not VERIFIED', result.confidence === 'likely' && result.verified === false, `${result.confidence} / ${result.verified}`)
  check('the failure is surfaced in a note', result.notes.some((note) => /No passing/.test(note)))
}

console.log('\n5. Unresolved imports introduced by a change are surfaced')
{
  const workspace = new VirtualWorkspace({ 'package.json': JSON.stringify({ name: 'demo' }) })
  const generate = scriptedCompletion([
    {
      toolCalls: [{
        id: 'w1',
        name: 'write_file',
        args: { path: 'src/broken.js', content: "import { value } from './missing.js'\nexport const result = value\n" },
      }],
    },
    { toolCalls: [finishCall('f1', 'Added the module', false)] },
  ])
  const { events, emit } = eventsFor()
  const result = await runAgent({
    task: 'Create src/broken.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  check('the unresolved import is in the result', result.verification.warnings.some((warning) => warning.specifier === './missing.js'))
  check('the user is warned during the run', events.some((event) => event.type === 'reminder' && event.text.includes('./missing.js')))
  check('the note explains the unresolved import', result.notes.some((note) => note.includes('./missing.js')))
  check('an unreviewed change is not VERIFIED', result.confidence === 'likely')
}

console.log('\n5b. Invented local APIs and undeclared packages are caught statically')
{
  const workspace = new VirtualWorkspace({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { react: '^18.0.0' } }),
    'src/lib.js': 'export function add(a, b) {\n  return a + b\n}\n',
  })
  const generate = scriptedCompletion([
    {
      toolCalls: [{
        id: 'w1',
        name: 'write_file',
        args: {
          path: 'src/uses.js',
          content: "import { subtract } from './lib.js'\nimport axios from 'axios'\nexport const value = subtract(1, 2)\n",
        },
      }],
    },
    { toolCalls: [finishCall('f1', 'Added src/uses.js', false)] },
  ])
  const { events, emit } = eventsFor()
  const result = await runAgent({
    task: 'Create src/uses.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  const messages = result.verification.warnings.map((warning) => warning.message).join('\n')
  check('a function the target does not export is reported', messages.includes('does not export it'), messages)
  check('an undeclared package import is reported', messages.includes('not declared in package.json'), messages)
  check('the API warning is shown during the run', events.some((event) => event.type === 'reminder' && event.text.includes('API check')))
  check('a change with warnings is not VERIFIED', result.confidence === 'likely')
}

console.log('\n6. project_overview and find_references answer from the real index')
{
  const workspace = new VirtualWorkspace({
    'package.json': JSON.stringify({ name: 'demo', main: 'src/main.js', dependencies: { react: '^18.0.0' } }),
    'src/main.js': "import { add } from './math.js'\nconsole.log(add(1, 2))\n",
    'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n',
    'src/format.js': "import { add } from './math.js'\nexport const total = add(4, 5)\n",
  })
  const outputs = []
  const { events, emit } = eventsFor()
  const result = await runAgent({
    task: 'Explain how this project is organized',
    workspace,
    provider,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
    generate: scriptedCompletion([
      { toolCalls: [{ id: 'o1', name: 'project_overview', args: {} }] },
      { toolCalls: [{ id: 'r1', name: 'find_references', args: { name: 'add' } }] },
      { toolCalls: [finishCall('f1', 'Explained the project')] },
    ], (request) => {
      for (const message of request.messages) {
        if (message.role === 'tool') outputs.push(String(message.content))
      }
    }),
  })

  const overview = outputs.find((output) => output.includes('Project:')) ?? ''
  const references = outputs.find((output) => output.includes('add:')) ?? ''
  check('overview reports the real project size', overview.includes('4 files'), overview.slice(0, 120))
  check('overview reports the layout', overview.includes('src/'))
  check('overview names the detected stack', overview.includes('React'))
  check('references include the definition line', references.includes('src/math.js:1'), references.slice(0, 160))
  check('references include the importing files', references.includes('src/main.js') && references.includes('src/format.js'))
  check('the informational run completes', result.status === 'done', result.status)
}

console.log('\n6b. A context-overflow error is trimmed and retried, not fatal')
{
  let calls = 0
  const { events, emit } = eventsFor()
  const generate = async () => {
    calls += 1
    if (calls === 1) throw new Error('request (10182 tokens) exceeds the available context size (8192 tokens)')
    return { content: '', toolCalls: [finishCall('f1', 'Answered')], finishReason: 'stop' }
  }
  const result = await runAgent({
    task: 'Say hello',
    workspace: new VirtualWorkspace(),
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit, requestApproval: async () => ({ approved: true }) },
  })
  check('the request was retried after the context error', calls === 2, String(calls))
  check('the retry used a smaller transcript budget', result.metrics.contextTrims === 1, JSON.stringify(result.metrics))
  check('the user is told why the request was retried', events.some((event) => event.type === 'status' && /context/i.test(event.text)))
  check('the run does not fail on context overflow', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n7. autoVerify runs the project checks before accepting finish')
{
  const workspace = new VirtualWorkspace({
    'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node test.mjs' } }),
  })
  const commands = []
  const generate = scriptedCompletion([
    { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'src/created.js', content: 'export const value = 1\n' } }] },
    { toolCalls: [finishCall('f1', 'Created src/created.js', true)] },
  ])
  const result = await runAgent({
    task: 'Create src/created.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    autonomy: 'full',
    autoVerify: true,
    events: { emit: () => {}, requestApproval: async () => ({ approved: true }) },
    runCommand: async (command) => {
      commands.push(command)
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
  })
  check('autoVerify ran the project test command without an explicit tool call', commands.join(',') === 'npm test', commands.join(','))
  check('the automatically verified run is VERIFIED', result.confidence === 'verified')
  check('finish was accepted only after the check passed', result.status === 'done')
}

console.log('\n8. A failed automatic check is fed back and the run can recover')
{
  const workspace = new VirtualWorkspace({
    'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node test.mjs' } }),
  })
  let testRuns = 0
  const generate = scriptedCompletion([
    { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'src/created.js', content: 'export const value = 1\n' } }] },
    { toolCalls: [finishCall('f1', 'Created src/created.js', true)] },
    { toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'src/created.js', content: 'export const value = 2\n', overwrite: true } }] },
    { toolCalls: [finishCall('f2', 'Fixed and verified src/created.js', true)] },
  ])
  const result = await runAgent({
    task: 'Create and verify src/created.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    autonomy: 'full',
    autoVerify: true,
    events: { emit: () => {}, requestApproval: async () => ({ approved: true }) },
    runCommand: async () => {
      testRuns += 1
      return testRuns === 1
        ? { exitCode: 1, stdout: '', stderr: 'expected 2, got 1' }
        : { exitCode: 0, stdout: 'ok', stderr: '' }
    },
  })
  check('the first finish was not accepted while the check failed', testRuns >= 2, String(testRuns))
  check('the model fixed the file after the failure', workspace.read('src/created.js').includes('value = 2'))
  check('the recovered run is VERIFIED', result.confidence === 'verified', `${result.confidence}: ${result.summary}`)
  check('the failed check remains in the evidence', result.verification.checks.some((entry) => entry.ok === false))
}

console.log('\n9. The engine contract demands evidence and confidence labels')
{
  let system = ''
  const workspace = new VirtualWorkspace({ 'src/app.js': 'export const value = 1\n' })
  const generate = scriptedCompletion([
    { content: 'It exports one value.', toolCalls: [] },
  ], (request) => {
    system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
  })
  await runAgent({
    task: 'Explain src/app.js',
    workspace,
    provider,
    generate,
    signal: new AbortController().signal,
    events: { emit: () => {}, requestApproval: async () => ({ approved: true }) },
  })
  check('the prompt requires evidence over guesses', /EVIDENCE, NOT GUESSES/.test(system) && /path:line/.test(system))
  check('the prompt defines all three confidence labels',
    /VERIFIED/.test(system) && /LIKELY/.test(system) && /UNVERIFIED/.test(system))
  check('the prompt forbids invented APIs and test results', /invent a file, function, API/.test(system))
  check('the project map is injected into the request', /PROJECT CONTEXT/.test(system) && /src\/app.js/.test(system))
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
