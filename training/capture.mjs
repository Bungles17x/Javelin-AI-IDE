/**
 * Capture — record real Javelin runs as training data.
 * ====================================================
 *
 *   npm run capture --task "fix the bug in calc.js" --workspace ./sandbox
 *   npm run capture --tasks tasks.jsonl            # batch: one task per line
 *
 * Why this is the honest foundation for "my own model":
 * a fine-tune is only as good as the traces it learns from, and traces are only
 * trustworthy if they record what actually happened. This runs Javelin for real
 * against a real workspace, records the full trajectory (every tool call, every
 * failure, every repair), and writes it in JDF — the same format the exporter and
 * the trainer consume.
 *
 * It does NOT train. It gathers evidence. Run `npm run train:dataset --traces traces/`
 * afterwards to turn these runs into training examples.
 *
 * Requires a working engine (a local or cloud OpenAI-compatible model). If none is
 * reachable, it says so and exits — it never fabricates a trace.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJavelin } from '../src/core/index.js'
import { identityFingerprint } from '../src/core/identity.js'
import { trajectoryFromRun, trajectoryToJsonl } from '../src/core/trace.js'
import { NodeWorkspace } from './workspace-node.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function parseArgs(argv) {
  const args = {
    task: null,
    tasks: null,
    workspace: null,
    out: 'traces',
    maxSteps: 24,
    autonomy: 'full',
    // --auto records through the runtime's own capture sink instead of writing the
    // trajectory here. Same output, but it exercises the path the app uses.
    auto: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--task') args.task = argv[++i]
    else if (a === '--tasks') args.tasks = argv[++i]
    else if (a === '--workspace') args.workspace = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--max-steps') args.maxSteps = Number(argv[++i])
    else if (a === '--autonomy') args.autonomy = argv[++i]
    else if (a === '--auto') args.auto = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Javelin trace capture

  --task <text>        A single task to run and record
  --tasks <file>       A .jsonl file with one {"task": "..."} per line (batch)
  --workspace <dir>    Directory to run against (default: a temp sandbox)
  --out <dir>          Where to write traces (default: traces/)
  --autonomy <level>   ask | auto-edit | full  (default: full — capture needs it to act)
  --max-steps <n>      Step budget per task (default: 24)

Captures real runs as JDF trajectories. It does not train anything.
`)
}

/** Load tasks from a --tasks file (one JSON object per line, or raw text lines). */
function loadTasks(path) {
  const text = readFileSync(path, 'utf8')
  const tasks = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj?.task) tasks.push(obj.task)
    } catch {
      // Not JSON — treat the line itself as the task text.
      tasks.push(trimmed)
    }
  }
  return tasks
}

/**
 * Build the engine from environment. We reuse the same provider layer the app uses,
 * so capturing works against whatever model the user actually runs.
 */
async function buildEngine() {
  const { providerEngine, CAPABILITY, EngineRegistry } = await import('../src/core/engines.js')
  const { getProvider } = await import('../src/lib/providers.js')

  const providerId = process.env.JAVELIN_PROVIDER || 'local'
  const provider = getProvider(providerId)
  const baseUrl = process.env.JAVELIN_BASE_URL || provider.baseUrl
  const model = process.env.JAVELIN_MODEL || provider.defaultModel

  const engine = providerEngine(
    { ...provider, baseUrl, apiKey: process.env.JAVELIN_API_KEY },
    {
      id: 'capture-engine',
      label: provider.label,
      model,
      capabilities: [CAPABILITY.TOOLS, CAPABILITY.STRONG_REASONING],
    },
  )

  const registry = new EngineRegistry()
  registry.register(engine)
  registry.assign('primary', engine.id)

  const health = await engine.probe()
  return { registry, engine, health, provider, model }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('\n=== Javelin trace capture ===\n')

  const tasks = []
  if (args.task) tasks.push(args.task)
  if (args.tasks) tasks.push(...loadTasks(resolve(root, args.tasks)))
  if (tasks.length === 0) {
    console.error('  ERROR: nothing to capture. Pass --task "..." or --tasks <file>.')
    console.error('  Run with --help for usage.\n')
    process.exit(1)
  }

  // ---- Workspace ----------------------------------------------------------
  const sandbox = args.workspace ? resolve(root, args.workspace) : join(root, 'traces', '_sandbox')
  if (!existsSync(sandbox)) {
    mkdirSync(sandbox, { recursive: true })
    // Give capture something real to look at when no workspace was provided.
    writeFileSync(
      join(sandbox, 'README.md'),
      '# Capture sandbox\nA small workspace for recording Javelin runs.\n',
      'utf8',
    )
  }
  console.log(`  workspace : ${sandbox}`)
  console.log(`  tasks     : ${tasks.length}`)

  // ---- Engine -------------------------------------------------------------
  const { registry, health, provider, model } = await buildEngine()
  console.log(`  provider  : ${provider.label} (${model})`)
  if (!health?.ok) {
    console.error('\n  ERROR: no working engine is reachable.')
    console.error(`    ${health?.detail ?? 'probe failed'}`)
    console.error('\n  Start your model first, then retry. Capturing without an engine')
    console.error('  would produce fake traces, so this stops here.\n')
    process.exit(1)
  }

  const outDir = resolve(root, args.out)
  mkdirSync(outDir, { recursive: true })

  const javelin = createJavelin({ engines: registry })
  let captured = 0
  let useful = 0

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    console.log(`\n[${i + 1}/${tasks.length}] ${task}`)

    const events = []
    const workspace = new NodeWorkspace(sandbox)
    const plan = { value: null }

    let result
    try {
      result = await javelin.think({
        task,
        workspace,
        runCommand: workspace.runCommand,
        onEvent: (evt) => {
          events.push(evt)
          if (evt.type === 'plan') plan.value = evt.plan
          if (evt.type === 'tool_call') process.stdout.write('.')
          if (evt.type === 'verification_required') process.stdout.write('!')
        },
        // Capture needs Javelin to actually act, or there is nothing to learn from.
        autonomy: args.autonomy,
        maxSteps: args.maxSteps,
        // --auto: let the runtime's own sink write the trajectory (the app's path).
        autoCapture: args.auto,
        captureDir: outDir,
      })
    } catch (err) {
      console.log(`\n  run failed: ${err.message}`)
      continue
    }
    console.log('')

    const record = trajectoryFromRun(
      {
        task,
        steps: result.steps,
        hypotheses: result.hypotheses,
        verified: result.verified,
        status: result.status,
        events,
        plan: plan.value,
        filesTouched: result.filesTouched,
      },
      {
        model,
        provider: provider.id,
        timestamp: new Date().toISOString(),
        workspaceSignature: basename(sandbox),
        identityFingerprint: identityFingerprint(),
        toolSchemas: javelin.tools.schemas(),
      },
    )

    let file
    if (args.auto) {
      // The runtime's own sink already wrote this run; we only count it.
      file = '(written by auto-capture)'
    } else {
      file = join(outDir, `capture-${Date.now()}-${i + 1}.jsonl`)
      writeFileSync(file, trajectoryToJsonl(record) + '\n', 'utf8')
    }
    captured++

    const acted = result.steps.length > 0
    const verified = Boolean(result.verified)
    if (acted) useful++
    console.log(`  status    : ${result.status}${verified ? ' (verified)' : ''}`)
    console.log(`  steps     : ${result.steps.length}`)
    console.log(`  wrote     : ${file}`)
    if (!acted) {
      console.log('  note      : no tool action was taken — the exporter will skip this trace.')
    }
  }

  // ---- Honest summary -----------------------------------------------------
  console.log('\n=== Capture complete ===\n')
  console.log(`  traces written : ${captured}`)
  console.log(`  with actions   : ${useful}`)
  console.log(`  output dir     : ${args.out}`)
  if (useful === 0) {
    console.log('\n  WARNING: none of these runs acted. Training on them would teach nothing.')
    console.log('  Check that the engine is capable of tool calls, and that the tasks')
    console.log('  actually require file changes.')
  }
  console.log('\n  Next: turn traces into a dataset:')
  console.log(`    npm run train:dataset --traces ${args.out} --out datasets/javelin-real`)
  console.log('')
}

main()
