/**
 * Runtime tests for the VS Code agent loop (vscode-extension/src/agent.ts).
 *
 * The loop is compiled with esbuild against a stub `vscode` module and driven by a
 * fake local Ollama SSE stream, so the real loop code — not a copy of it — runs:
 * path canonicalisation, transcript pairing, repeat blocking, verified writes and
 * bounded retries.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`) }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const here = path.dirname(fileURLToPath(import.meta.url))

/** The runner executes the bundle from a temp dir, so find the repo by its source. */
function findProjectRoot(start) {
  let current = start
  for (;;) {
    if (existsSync(path.join(current, 'vscode-extension/src/agent.ts'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}
const root = findProjectRoot(process.cwd()) ?? findProjectRoot(path.resolve(here, '..'))
if (!root) throw new Error('Could not locate the project root for the extension agent test.')

const workDir = mkdtempSync(path.join(tmpdir(), 'javelin-ext-agent-'))
const PROJECT_ROOT = 'C:/project'

const stubPath = path.join(workDir, 'vscode-stub.mjs')
writeFileSync(stubPath, `
export const workspace = {
  workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(PROJECT_ROOT)}, scheme: 'file', path: '/' } }],
};
export const window = { createTerminal: () => ({ dispose() {} }) };
export class EventEmitter { constructor() { this.event = () => {}; } fire() {} }
export class Position {}
export class Range {}
export class Uri { static joinPath(base, ...parts) { return { fsPath: [base.fsPath ?? base, ...parts].join('/') }; } }
export const FileType = { File: 1, Directory: 2 };
export const commands = { executeCommand: async () => undefined };
`)

const agentEntry = path.join(root, 'vscode-extension/src/agent.ts')
const agentBundle = path.join(workDir, 'agent.mjs')
// This test is itself bundled by tests/run.mjs, so the esbuild JS API cannot be
// imported here. Drive the esbuild binary instead, aliasing `vscode` to the stub.
const built = spawnSync(process.execPath, [
  path.join(root, 'node_modules/esbuild/bin/esbuild'),
  agentEntry,
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--log-level=warning',
  `--alias:vscode=${stubPath}`,
  `--outfile=${agentBundle}`,
], { cwd: root, encoding: 'utf8' })
if (built.status !== 0) {
  console.error(built.stderr || built.stdout)
  throw new Error('Could not bundle vscode-extension/src/agent.ts for the test.')
}
const { runAgent } = await import(pathToFileURL(agentBundle).href)

/** Build one fake Ollama SSE response for a scripted model turn. */
function sseResponse(turn) {
  const deltas = []
  if (turn.content) deltas.push({ delta: { content: turn.content } })
  const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
    index,
    id: call.id,
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
  }))
  if (toolCalls.length) deltas.push({ delta: { tool_calls: toolCalls } })
  deltas.push({ delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' })
  const body = `${deltas.map((delta) => `data: ${JSON.stringify({ choices: [delta] })}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch
let script = []
let requests = []
const scriptedFetch = async (_url, init) => {
  requests.push(JSON.parse(init.body))
  if (!script.length) throw new Error('fetch failed')
  return sseResponse(script.shift())
}
globalThis.fetch = scriptedFetch

function inMemoryWorkspace(files = {}) {
  const map = new Map(Object.entries(files))
  const folders = new Set()
  return {
    map,
    folders,
    async createFolder(dir) {
      const existed = folders.has(dir) || map.has(dir)
      folders.add(dir)
      return { path: dir, created: !existed }
    },
    async rename(oldPath, newPath) {
      if (!map.has(oldPath)) throw new Error(`Source file not found: ${oldPath}.`)
      if (map.has(newPath)) throw new Error(`Destination already exists: ${newPath}.`)
      const content = map.get(oldPath)
      map.delete(oldPath)
      map.set(newPath, content)
      return { path: newPath, before: content, after: content, diff: { lines: [], added: 0, removed: 0 }, action: 'edit' }
    },
    async append(path, content) {
      const before = map.get(path) ?? ''
      map.set(path, before + content)
      return { path, before, after: before + content, diff: { lines: [], added: 0, removed: 0 }, action: 'edit' }
    },
    async copy(sourcePath, destPath) {
      if (!map.has(sourcePath)) throw new Error(`Source file not found: ${sourcePath}.`)
      if (map.has(destPath)) throw new Error(`Destination already exists: ${destPath}.`)
      const content = map.get(sourcePath)
      map.set(destPath, content)
      return { path: destPath, before: '', after: content, diff: { lines: [], added: 0, removed: 0 }, action: 'write' }
    },
    async list(dir = '') {
      const prefix = dir ? `${dir}/` : ''
      return [...map.keys()].filter((file) => file.startsWith(prefix)).sort()
    },
    async read(file) {
      if (!map.has(file)) throw new Error(`File not found: ${file}`)
      return map.get(file)
    },
    async search() { return '' },
    async preview() { return { diff: null } },
    async write(file, content, overwrite = false) {
      if (map.has(file) && !overwrite) throw new Error(`File "${file}" already exists.`)
      const before = map.get(file) ?? ''
      map.set(file, content)
      return { path: file, before, after: content, diff: { lines: [], added: 0, removed: 0 }, action: 'write' }
    },
    async edit(file, oldString, newString) {
      if (!map.has(file)) throw new Error(`File not found: ${file}`)
      const before = map.get(file)
      const index = before.indexOf(oldString)
      if (index === -1) throw new Error(`old_string not found in ${file}.`)
      const after = before.slice(0, index) + newString + before.slice(index + oldString.length)
      map.set(file, after)
      return { path: file, before, after, diff: { lines: [], added: 0, removed: 0 }, action: 'edit' }
    },
    async delete(file) {
      const before = map.get(file)
      if (before == null) throw new Error(`File not found: ${file}`)
      map.delete(file)
      return { path: file, before, after: '', diff: { lines: [], added: 0, removed: 0 }, action: 'delete' }
    },
    async snapshot(label) { return { id: `cp_${map.size}`, label, timestamp: Date.now(), fileCount: map.size } },
  }
}

function harness() {
  const state = { results: [], reminders: [], toolCalls: [], phases: [] }
  const callbacks = {
    onPhase: (phase) => state.phases.push(phase),
    onStatus: () => { },
    onAssistantText: () => { },
    onAssistantDelta: () => { },
    onToolCall: (call) => state.toolCalls.push(call),
    onToolResult: (result) => state.results.push(result),
    onCheckpoint: () => { },
    onCommand: () => { },
    onReminder: (text) => state.reminders.push(text),
    requestApproval: async () => ({ approved: true, remember: false }),
  }
  return { state, callbacks }
}

async function run(task, workspace, turns) {
  script = [...turns]
  requests = []
  const { state, callbacks } = harness()
  const result = await runAgent({
    task,
    workspace,
    provider: { providerId: 'javelin', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    signal: new AbortController().signal,
    callbacks,
  })
  return { result, state, requests }
}

function transcriptProblems(messages) {
  const problems = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue
    const ids = message.tool_calls.map((call) => call.id)
    if (new Set(ids).size !== ids.length) problems.push(`duplicate ids: ${ids.join(', ')}`)
    const answered = []
    let next = index + 1
    while (messages[next]?.role === 'tool') { answered.push(messages[next].tool_call_id); next++ }
    for (const id of ids) if (!answered.includes(id)) problems.push(`no result for ${id}`)
    for (const id of answered) if (!ids.includes(id)) problems.push(`orphan result ${id}`)
    if (messages[next]?.role === 'system') problems.push('system message interrupts tool results')
  }
  return problems
}

console.log('\n1. A multi-step edit survives changing path spellings')
{
  const workspace = inMemoryWorkspace()
  const { result, state } = await run('Create and update src/main.js', workspace, [
    { toolCalls: [{ id: 'e1', name: 'write_file', args: { path: 'src\\main.js', content: 'export const n = 1\n' } }] },
    { toolCalls: [{ id: 'e2', name: 'read_file', args: { path: './src/main.js' } }] },
    { toolCalls: [{ id: 'e3', name: 'edit_file', args: { path: 'C:/project/src/main.js', old_string: 'n = 1', new_string: 'n = 2' } }] },
    { toolCalls: [{ id: 'e4', name: 'finish', args: { summary: 'Updated n', verified: false } }] },
  ])

  check('no tool failed on a path mismatch',
    !state.results.some((entry) => !entry.ok), JSON.stringify(state.results))
  check('the edit landed in the canonical path',
    workspace.map.get('src/main.js')?.includes('n = 2'), JSON.stringify([...workspace.map.keys()]))
  check('no duplicate file was created for the same file',
    workspace.map.size === 1, JSON.stringify([...workspace.map.keys()]))
  check('the run finished', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n2. Every tool call reaches the model with a result')
{
  const workspace = inMemoryWorkspace({ 'src/app.js': 'const value = 1\n' })
  const { result, state, requests } = await run('Change the value in src/app.js', workspace, [
    {
      toolCalls: [
        { id: 'dup', name: 'read_file', args: { path: './src/app.js' } },
        { id: 'dup', name: 'edit_file', args: { path: 'src/app.js', old_string: 'NOPE', new_string: 'x' } },
      ],
    },
    { toolCalls: [{ id: 'dup', name: 'edit_file', args: { path: 'src/app.js', old_string: 'NOPE', new_string: 'x' } }] },
    { toolCalls: [{ id: 'dup', name: 'edit_file', args: { path: 'src/app.js', old_string: 'const value = 1', new_string: 'const value = 5' } }] },
    { toolCalls: [{ id: 'dup', name: 'finish', args: { summary: 'Updated value', verified: false } }] },
  ])

  const problems = requests.flatMap((request) => transcriptProblems(request.messages))
  check('no transcript sent to the model had a broken tool pairing', problems.length === 0, problems.join(' | '))
  const twoCallTurn = requests.flatMap((r) => r.messages).find((m) => Array.isArray(m.tool_calls) && m.tool_calls.length === 2)
  check('a reused call id was made unique per call',
    Boolean(twoCallTurn) && new Set(twoCallTurn.tool_calls.map((call) => call.id)).size === 2,
    JSON.stringify(twoCallTurn?.tool_calls?.map((call) => call.id)))
  check('the repeated failed call was blocked, not executed',
    state.reminders.some((note) => note.includes('edit_file:src/app.js')))
  check('the run still completed', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n3. A failed step can be retried once the workspace changes')
{
  const workspace = inMemoryWorkspace({ 'src/main.js': 'const a = 1\n' })
  const { result, state } = await run('Fix src/main.js', workspace, [
    { toolCalls: [{ id: 'f1', name: 'edit_file', args: { path: 'src/main.js', old_string: 'MISSING', new_string: 'x' } }] },
    { toolCalls: [{ id: 'f2', name: 'write_file', args: { path: 'src/other.js', content: 'export {}\n' } }] },
    { toolCalls: [{ id: 'f3', name: 'edit_file', args: { path: 'src/main.js', old_string: 'MISSING', new_string: 'x' } }] },
    { toolCalls: [{ id: 'f4', name: 'finish', args: { summary: 'Added other.js', verified: false } }] },
  ])

  const second = state.results.find((entry) => entry.id === 'f3')
  check('the identical retry is executed after progress', second?.output.includes('old_string not found'), JSON.stringify(second))
  check('the retry is not swallowed as a blocked repeat', !second?.output.includes('BLOCKED'), JSON.stringify(second))
  check('the run reaches its finish', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n4. A write is verified against disk')
{
  const workspace = inMemoryWorkspace()
  // Reports success for every write but persists nothing.
  workspace.write = async (file, content) => ({
    path: file, before: '', after: content, diff: { lines: [], added: 0, removed: 0 }, action: 'write',
  })

  const { result, state } = await run('Create src/ghost.js', workspace, [
    { toolCalls: [{ id: 'g1', name: 'write_file', args: { path: 'src/ghost.js', content: 'export const g = 1\n' } }] },
    { toolCalls: [{ id: 'g2', name: 'finish', args: { summary: 'Created the file', verified: false } }] },
    { toolCalls: [{ id: 'g3', name: 'finish', args: { summary: 'Created the file', verified: false } }] },
    { toolCalls: [{ id: 'g4', name: 'finish', args: { summary: 'Created the file', verified: false } }] },
  ])

  const ghost = state.results.find((entry) => entry.id === 'g1')
  check('the dropped write is reported as a failure', ghost?.ok === false && ghost.output.includes('VERIFICATION FAILED'), JSON.stringify(ghost))
  check('the missing file is named', ghost?.output.includes('does not exist'), JSON.stringify(ghost))
  check('finish is refused because nothing changed',
    state.results.some((entry) => entry.id === 'g2' && !entry.ok && entry.output.includes('no file or folder change has succeeded')),
    JSON.stringify(state.results.map((entry) => `${entry.id}:${entry.ok}`)))
  check('the run never claims success', result.status === 'failed', `${result.status}: ${result.summary}`)
  check('no file was invented', !workspace.map.has('src/ghost.js'))
}

console.log('\n5. Transient model failures are retried a bounded number of times')
{
  const workspace = inMemoryWorkspace()
  // Two transport failures, then a successful finish turn.
  let attempts = 0
  const failuresBefore = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    attempts += 1
    if (attempts < 3) {
      failuresBefore.push(attempts)
      throw new Error('fetch failed')
    }
    return sseResponse({ toolCalls: [{ id: 'retry-finish', name: 'finish', args: { summary: 'Recovered', verified: false } }] })
  }
  requests = []
  const { state, callbacks } = harness()
  const result = await runAgent({
    task: 'Say hello',
    workspace,
    provider: { providerId: 'javelin', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    signal: new AbortController().signal,
    callbacks,
  })
  check('two transient failures were retried', attempts === 3, String(attempts))
  check('the loop recovered', result.status === 'done', `${result.status}: ${result.summary}`)
  check('the retry was surfaced', state.phases.length > 0)
}

console.log('\n6. The agent can create folders, rename and copy files')
{
  // Section 5 installed its own fetch stub; restore the scripted one.
  globalThis.fetch = scriptedFetch
  const workspace = inMemoryWorkspace({ 'src/old.js': 'export const v = 1\n' })
  const { result, state } = await run('Reorganise src', workspace, [
    { toolCalls: [{ id: 't1', name: 'create_folder', args: { path: 'src/lib' } }] },
    { toolCalls: [{ id: 't2', name: 'copy_file', args: { source_path: 'src/old.js', dest_path: 'src/lib/copy.js' } }] },
    { toolCalls: [{ id: 't3', name: 'rename_file', args: { old_path: 'src/old.js', new_path: 'src/lib/new.js' } }] },
    { toolCalls: [{ id: 't4', name: 'finish', args: { summary: 'Reorganised src', verified: false } }] },
  ])

  check('create_folder ran', workspace.folders.has('src/lib'), JSON.stringify([...workspace.folders]))
  check('copy_file produced the copied content', workspace.map.get('src/lib/copy.js') === 'export const v = 1\n')
  check('rename_file moved the file',
    workspace.map.has('src/lib/new.js') && !workspace.map.has('src/old.js'),
    JSON.stringify([...workspace.map.keys()]))
  check('no tool call failed', !state.results.some((entry) => !entry.ok),
    JSON.stringify(state.results.filter((entry) => !entry.ok)))
  check('the run finished', result.status === 'done', `${result.status}: ${result.summary}`)
  check('a clean run carries no error code', result.code === null, String(result.code))
}

console.log('\n7. Failed runs carry a stable error code')
{
  const repeated = await run('Fix the project', inMemoryWorkspace(), [
    { content: 'I will change it.' },
    { content: 'I will change it.' },
    { content: 'I will change it.' },
  ])
  check('identical responses report ER.0203', repeated.result.code === 'ER.0203',
    `${repeated.result.code}: ${repeated.result.summary}`)

  const silent = await run('Fix the project', inMemoryWorkspace(), [
    { content: 'One.' }, { content: 'Two.' }, { content: 'Three.' },
  ])
  check('no tool action reports ER.0202', silent.result.code === 'ER.0202',
    `${silent.result.code}: ${silent.result.summary}`)

  const stalled = await run('Fix the project', inMemoryWorkspace(),
    Array.from({ length: 20 }, (_, index) => ({
      toolCalls: [{ id: `s${index}`, name: 'list_files', args: { path: `dir${index}` } }],
    })))
  check('a stall reports ER.0205', stalled.result.code === 'ER.0205',
    `${stalled.result.code}: ${stalled.result.summary}`)

  const limited = await run('Fix the project', inMemoryWorkspace(),
    Array.from({ length: 50 }, (_, index) => ({
      toolCalls: [{ id: `w${index}`, name: 'write_file', args: { path: `f${index}.js`, content: `export const n = ${index}\n` } }],
    })))
  check('the step limit reports ER.0201', limited.result.code === 'ER.0201',
    `${limited.result.code}: ${limited.result.summary}`)

  script = []
  const abortedController = new AbortController()
  abortedController.abort()
  const { callbacks } = harness()
  const aborted = await runAgent({
    task: 'Fix the project',
    workspace: inMemoryWorkspace(),
    provider: { providerId: 'javelin', baseUrl: 'http://localhost:11434/v1', model: 'test' },
    signal: abortedController.signal,
    callbacks,
  })
  check('a user stop reports ER.0301', aborted.code === 'ER.0301', String(aborted.code))
}

console.log('\n8. A large file can be built in chunks')
{
  globalThis.fetch = scriptedFetch
  const workspace = inMemoryWorkspace()
  const { result } = await run('Build a module in chunks', workspace, [
    { toolCalls: [{ id: 'a1', name: 'write_file', args: { path: 'big.js', content: 'export const a = 1\n' } }] },
    { toolCalls: [{ id: 'a2', name: 'append_file', args: { path: 'big.js', content: 'export const b = 2\n' } }] },
    { toolCalls: [{ id: 'a3', name: 'append_file', args: { path: 'big.js', content: 'export const c = 3\n' } }] },
    { toolCalls: [{ id: 'a4', name: 'finish', args: { summary: 'Built big.js', verified: false } }] },
  ])
  check('append_file extended the file instead of replacing it',
    workspace.map.get('big.js') === 'export const a = 1\nexport const b = 2\nexport const c = 3\n',
    JSON.stringify(workspace.map.get('big.js')))
  check('the chunked build finished', result.status === 'done', `${result.status}: ${result.summary}`)
}

console.log('\n9. A completed run ends on the model summary instead of failing')
{
  globalThis.fetch = scriptedFetch
  const workspace = inMemoryWorkspace()
  const { result } = await run('Create a.js', workspace, [
    { toolCalls: [{ id: 'p1', name: 'write_file', args: { path: 'a.js', content: 'export const a = 1\n' } }] },
    { content: 'Created a.js.' },
    { content: 'Created a.js.' },
  ])
  check('the run reports success', result.status === 'done', `${result.status}: ${result.summary}`)
  check('the summary is the model own report', result.summary.includes('Created a.js'), result.summary)
  check('no error code is attached', result.code === null, String(result.code))
}

globalThis.fetch = realFetch
rmSync(workDir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL EXTENSION-AGENT CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
