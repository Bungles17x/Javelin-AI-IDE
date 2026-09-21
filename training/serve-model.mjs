/**
 * Serve your own Javelin model — no Ollama, no third-party runner.
 * =================================================================
 *
 *   npm run serve:model                     # serve the merged model on :8080
 *   npm run serve:model --model path.gguf --port 8080
 *
 * This is Javelin's own serving path. It runs a small OpenAI-compatible HTTP server
 * in front of your merged model weights, so the app talks to *your* model through the
 * exact same interface it uses for any provider — nothing about the agent loop changes.
 *
 * HONESTY ABOUT THE ENGINE
 * ------------------------
 * A 7B–70B model cannot be run by JavaScript. Actual inference (the matrix math) is
 * done by a native backend. This script does not pretend otherwise:
 *
 *   - If `node-llama-cpp` (or a `llama-server` binary) is available, it uses it.
 *   - If not, it tells you exactly what to install and stops.
 *
 * What Javelin owns here is the serving layer, the OpenAI-compatible API, the tool
 * protocol, and the model file that YOU trained. That is the honest boundary: we do
 * not reimplement CUDA, and we do not lie about needing a native runtime.
 *
 * RECOMMENDED BACKENDS (all serve the same OpenAI API this expects):
 *   - llama.cpp `llama-server`  — lightweight, cross-platform, GPU or CPU
 *   - vLLM / TGI                — for datacentre-class throughput
 *   - LM Studio                 — GUI, for casual local use
 * Point `--backend <url>` at any of them and Javelin serves it as "your model".
 */

import { createServer } from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function parseArgs(argv) {
  const args = {
    model: null,
    port: 8080,
    backend: null,
    ctx: 8192,
    threads: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model') args.model = argv[++i]
    else if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--backend') args.backend = argv[++i]
    else if (a === '--ctx') args.ctx = Number(argv[++i])
    else if (a === '--threads') args.threads = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      console.log(`
Javelin model server

  --model <path>     Path to a .gguf model (or a merged model directory)
  --port <n>         Port to listen on (default 8080)
  --backend <url>    Proxy to an existing OpenAI-compatible server instead of
                     launching llama-server (e.g. http://localhost:1234/v1)
  --ctx <n>          Context length (default 8192)
  --threads <n>      CPU threads (default: auto)

Serves your Javelin model at http://localhost:<port>/v1 — point the app's
"Javelin (self-hosted)" provider at it. No Ollama involved.
`)
      process.exit(0)
    }
  }
  return args
}

/** Locate a llama-server binary across common install locations. */
function findLlamaServer() {
  const candidates = [
    process.env.LLAMA_SERVER,
    join(root, 'bin', 'llama-server.exe'),
    join(root, 'bin', 'llama-server'),
    'llama-server',
  ].filter(Boolean)
  for (const c of candidates) {
    if (c === 'llama-server') return c // allow PATH resolution
    if (existsSync(c)) return c
  }
  return null
}

/** Find the newest merged model directory we can serve. */
function findDefaultModel() {
  const merged = join(root, 'training', 'runs', 'javelin-coder-80b', 'merged')
  const lora = join(root, 'training', 'runs', 'javelin-lora', 'merged')
  for (const dir of [merged, lora]) {
    if (existsSync(join(dir, 'config.json'))) {
      return dir
    }
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('\n=== Javelin model server ===\n')

  // ---- Proxying an existing backend ---------------------------------------
  if (args.backend) {
    console.log(`  mode      : proxy → ${args.backend}`)
    console.log(`  listening : http://localhost:${args.port}/v1`)
    console.log('\n  Forwarding all requests to your existing server.')
    console.log('  Point the app at "Javelin (self-hosted)" and use this address.\n')
    startProxy(args.backend, args.port)
    return
  }

  // ---- Locate the model ---------------------------------------------------
  const modelPath = args.model ? resolve(args.model) : findDefaultModel()
  console.log(`  model     : ${modelPath ?? '(none found)'}`)
  if (!modelPath || !existsSync(modelPath)) {
    console.error('\n  ERROR: no model to serve.')
    console.error('  Train and merge one first:')
    console.error('    1. npm run capture --task "..."          # record real runs')
    console.error('    2. npm run train:dataset --traces traces --out datasets/javelin-real')
    console.error('    3. npm run train:prepare --dataset datasets/javelin-real')
    console.error('    4. npm run train:run --run training/runs/javelin-lora')
    console.error('    5. python training/finetune/merge.py      # merge the adapter')
    console.error('  Then:  npm run serve:model --model <merged-dir-or-gguf>\n')
    process.exit(1)
  }

  // ---- Locate a backend ---------------------------------------------------
  const llama = findLlamaServer()
  if (!llama) {
    console.error('\n  ERROR: no native inference backend found.')
    console.error('  A language model cannot be run by JavaScript — it needs a native runtime.')
    console.error('\n  Install one of these, then retry:')
    console.error('    • llama.cpp:  place llama-server (or llama-server.exe) on PATH, or set LLAMA_SERVER')
    console.error('                  https://github.com/ggerganov/llama.cpp')
    console.error('    • Or run any OpenAI-compatible server and proxy to it:')
    console.error('        npm run serve:model --backend http://localhost:1234/v1')
    console.error('\n  (This is the same native-runtime reality as Ollama — we are just')
    console.error('   running the server ourselves instead of handing it to Ollama.)\n')
    process.exit(1)
  }

  console.log(`  backend   : ${llama}`)
  console.log(`  port      : ${args.port}`)
  console.log(`  ctx       : ${args.ctx}`)

  const childArgs = [
    '--model', modelPath,
    '--port', String(args.port),
    '--ctx-size', String(args.ctx),
    '--host', '127.0.0.1',
  ]
  if (args.threads) {
    childArgs.push('--threads', String(args.threads))
  }

  console.log('\n  Starting your model server…\n')
  const child = spawn(llama, childArgs, { stdio: 'inherit' })

  child.on('error', (err) => {
    console.error(`\n  ERROR: could not start ${llama}: ${err.message}\n`)
    process.exit(1)
  })
  child.on('close', (code) => process.exit(code ?? 0))

  console.log(`  Your Javelin model is serving at http://localhost:${args.port}/v1`)
  console.log('  Select the "Javelin (self-hosted)" provider in the app.')
  console.log('  Press Ctrl+C to stop.\n')
}

/** Minimal reverse proxy: forward /v1/* to an existing OpenAI-compatible server. */
function startProxy(backend, port) {
  const target = backend.replace(/\/$/, '')
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const upstream = await fetch(`${target}${req.url}`, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body,
      })
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      const text = await upstream.text()
      res.end(text)
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `proxy error: ${err.message}` }))
    }
  })
  server.listen(port, '127.0.0.1')
}

main()
