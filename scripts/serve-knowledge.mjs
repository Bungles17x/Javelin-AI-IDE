/**
 * Serve the trained Javelin models on http://127.0.0.1:8787/v1.
 *
 * llama.cpp is roughly an order of magnitude faster than the PyTorch path on CPU
 * (measured 18.2 vs 2.7 tokens/s), so it is used whenever the binaries and GGUF
 * files are present. The Python server stays as the fallback and as the way to run
 * an adapter that has not been converted yet.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { resolve } from 'node:path'

const root = process.cwd()
const llamaCpu = resolve(root, 'tools/llama/llama-server.exe')
const llamaVulkan = resolve(root, 'tools/llama-vulkan/llama-server.exe')
const modelDir = resolve(root, 'training/knowledge/gguf')
const python = resolve(root, '.venv/Scripts/python.exe')

/**
 * Use the GPU when the Vulkan build is present and a device answers. The CPU
 * build remains the fallback, so a missing/old driver cannot stop the model from
 * running — it just runs slower.
 */
function detectVulkanDevice() {
  if (process.env.JAVELIN_GPU === '0' || !existsSync(llamaVulkan)) return null
  try {
    const probe = spawnSync(llamaVulkan, ['--list-devices'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
    const line = output.split(/\r?\n/).find((entry) => /Vulkan\d+:/.test(entry))
    return line ? line.trim() : null
  } catch {
    return null
  }
}

const vulkanDevice = detectVulkanDevice()
const useGpu = Boolean(vulkanDevice)
const llamaServer = useGpu ? llamaVulkan : llamaCpu

const canUseLlama = existsSync(llamaServer) && existsSync(modelDir)
// One thread per physical core. Hyper-threads contend for the same vector units and
// raise CPU use without raising tokens/s, so the old cpus-4 value oversubscribed.
const threads = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))

const [file, args] = canUseLlama
  ? [
      llamaServer,
      [
        '--models-dir', modelDir,
        // Keep one model resident: otherwise every model you try stays loaded and the
        // server grows to 13 GB. Switching reloads from disk instead of holding all four.
        '--models-max', '1',
        '--host', '127.0.0.1',
        '--port', '8787',
        // A real project's system prompt, project map, tool results and transcript
        // do not fit in 8K tokens. 32K fits the 7B plus quantised KV on the 10 GB card.
        '-c', '32768',
        '-t', String(threads),
        // Offload every layer when a Vulkan device is available; on CPU this is a
        // no-op. The router keeps one model resident, so a 7B fits in the 10 GB card.
        ...(useGpu ? ['-ngl', '99'] : []),
        // Quantised cache halves KV memory. Vulkan Flash Attention is not supported by
        // this build, so f16 does not make it faster; q8 keeps more VRAM free.
        '-ctk', 'q8_0',
        '-ctv', 'q8_0',
        '--jinja',
      ],
    ]
  : [python, ['training/knowledge/serve.py', ...process.argv.slice(2)]]

console.log(canUseLlama
  ? useGpu
    ? `Serving Javelin models with llama.cpp on GPU: ${vulkanDevice} (also uses ${threads} CPU threads).`
    : `Serving Javelin models with llama.cpp on CPU (${threads} threads; no Vulkan device detected).`
  : 'Serving with the Python runtime (llama.cpp binaries or GGUF files not found).')

const MODEL_PORT = 8787

/**
 * llama.cpp's router indexes the models directory at startup, but the OpenAI
 * /v1/models registry can omit newly added GGUFs until it is reloaded. Without
 * this, a model that is visible in the logs answers "model not found" on its
 * first request. Reload once the server is listening, then report what it serves.
 */
async function warmModelRegistry() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      const res = await fetch(`http://127.0.0.1:${MODEL_PORT}/models?reload=1`)
      if (!res.ok) continue
      const data = await res.json()
      const ids = (data?.data ?? []).map((model) => model.id)
      if (ids.length) {
        console.log(`Model registry ready: ${ids.join(', ')}`)
        return
      }
    } catch {
      // Server is still starting; try again.
    }
  }
  console.warn('The model server started but its registry did not answer; check the log above.')
}

const child = spawn(file, args, { cwd: root, stdio: 'inherit' })

child.on('error', (error) => {
  console.error(`Could not start the model server: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 0))

if (canUseLlama) void warmModelRegistry()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
