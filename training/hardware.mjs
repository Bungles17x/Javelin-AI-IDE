/**
 * Hardware profiler.
 * ==================
 *
 * Fine-tuning advice is worthless if it assumes the wrong hardware. The original
 * pipeline said "a GPU is required" and stopped — which is both unhelpful and, for
 * an AMD machine, actively misleading.
 *
 * This profiler reports what the machine actually has, then recommends a path that
 * will really work on it. The important distinction it encodes:
 *
 *   - **CUDA (NVIDIA)** — PyTorch/PEFT/TRL work out of the box.
 *   - **ROCm (AMD, Linux)** — works, but QLoRA needs Linux (`bitsandbytes`).
 *   - **AMD on Windows, 6000-series** — ROCm's Windows preview covers Radeon
 *     7000/9000 only. A 6000-series card is NOT supported. Pretending otherwise
 *     sends people down a multi-hour dead end.
 *   - **AMD on Windows, 7000/9000** — supported via AMD's ROCm PyTorch preview.
 *   - **No usable GPU** — CPU training of a small model is the honest fallback, and
 *     it genuinely works at ~1B parameters or below.
 *
 * So the profiler never says "you can't". It says *which* path fits.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Vendor classification used to pick a training path. */
export const GPU_VENDOR = {
  NVIDIA: 'nvidia',
  AMD: 'amd',
  INTEL: 'intel',
  APPLE: 'apple',
  NONE: 'none',
}

/**
 * Known AMD ROCm GPU families. Used to decide whether a card is likely to work
 * with ROCm at all, and on which OS.
 */
const AMD_FAMILIES = [
  {
    family: 'rdna4',
    match: /\b(rx\s*9\d{3}|rx\s*9070|9070)\b/i,
    rocmWindows: true,
    rocmLinux: true,
    note: 'Radeon 9000 series — ROCm supported on Windows and Linux.',
  },
  {
    family: 'rdna3',
    match: /\b(rx\s*7\d{3}|7900|7800|7700|7600)\b/i,
    rocmWindows: true,
    rocmLinux: true,
    note: 'Radeon 7000 series — ROCm supported on Windows and Linux.',
  },
  {
    family: 'rdna2',
    match: /\b(rx\s*6\d{3}|6900|6800|6700|6650|6600|6500)\b/i,
    rocmWindows: false,
    rocmLinux: true,
    note:
      'Radeon 6000 series (RDNA2). ROCm on Windows does NOT list these ' +
      '(the Windows preview covers 7000/9000 only). ROCm on Linux may work at ' +
      'your own risk; it is community-supported, not official.',
  },
  {
    family: 'rdna1',
    match: /\b(rx\s*5\d{3}|5700|5600)\b/i,
    rocmWindows: false,
    rocmLinux: false,
    note: 'Radeon 5000 series — no practical ROCm support.',
  },
]

/**
 * Profile the machine. Everything is best-effort: a probe failing must never throw,
 * because a profiler that crashes tells you less than one that reports "unknown".
 */
export function profileHardware({ gpuOverride = null, ramOverride = null } = {}) {
  const gpus = gpuOverride ?? detectGpus()
  const ramGb = ramOverride ?? detectRamGb()

  const primary = pickPrimaryGpu(gpus)
  const vendor = classifyVendor(primary)
  const vramGb = primary?.vramGb ?? 0

  const rocm = detectRocm()
  const wsl = detectWsl()

  const profile = {
    gpus,
    primaryGpu: primary,
    vendor,
    vramGb,
    ramGb,
    rocm,
    wsl,
    amdFamily: vendor === GPU_VENDOR.AMD ? classifyAmdFamily(primary?.name ?? '') : null,
  }

  profile.recommendation = recommend(profile)
  return profile
}

/**
 * Run a PowerShell command, trying several ways to locate the interpreter.
 * Spawning "powershell" fails with ENOENT in environments where it is not on the
 * child process PATH, which silently produced "no GPU detected".
 */
function runPowershell(command, timeout = 20_000) {
  const candidates = [
    'powershell.exe',
    'powershell',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'pwsh.exe',
    'pwsh',
  ]
  let last = { status: null, stdout: '', stderr: '', error: null }
  for (const exe of candidates) {
    const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    })
    if (!res.error && res.status === 0) {
      return res
    }
    if (!res.error) {
      // The interpreter ran but the command failed; do not keep trying others.
      return res
    }
    last = { ...res, error: res.error }
  }
  return last
}

/** Detect GPUs via OS tooling. Windows-first, since that is the common case here. */
function detectGpus() {
  const gpus = []

  if (process.platform === 'win32') {
    // Node may not resolve the bare name "powershell" (it is not always on PATH
    // for a spawned process), so try shell candidates and then a full path.
    const res = runPowershell(
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress',
    )
    if (res.status === 0 && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout)
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
          gpus.push({
            name: entry.Name ?? 'unknown',
            // WMI's AdapterRAM is a signed 32-bit field and caps around 4GB, so it
            // is unreliable for modern cards. It is recorded but treated as a floor.
            reportedVramGb: entry.AdapterRAM ? Math.round(entry.AdapterRAM / 1024 ** 3) : null,
            driver: entry.DriverVersion ?? null,
          })
        }
      } catch {
        // fall through with an empty list
      }
    }
  } else {
    const res = spawnSync('lspci', [], { encoding: 'utf8', timeout: 10_000 })
    if (res.status === 0 && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        if (/vga|3d|display/i.test(line)) {
          gpus.push({ name: line.trim(), reportedVramGb: null, driver: null })
        }
      }
    }
  }

  // Enrich with known VRAM for cards whose OS-reported value is unreliable.
  for (const gpu of gpus) {
    gpu.vramGb = KNOWN_VRAM.find((k) => k.match.test(gpu.name))?.vramGb ?? gpu.reportedVramGb ?? null
    gpu.vramEstimated = Boolean(KNOWN_VRAM.find((k) => k.match.test(gpu.name)))
  }

  return gpus
}

/**
 * VRAM for common cards. WMI caps AdapterRAM at ~4GB, so a 10GB RX 6700 reports 4.
 * Knowing the real figure matters: it decides whether a 7B model fits at all.
 */
const KNOWN_VRAM = [
  // AMD RDNA2/3/4 consumer
  { match: /RX\s*6700\s*XT/i, vramGb: 12 },
  { match: /RX\s*6700/i, vramGb: 10 },
  { match: /RX\s*6800\s*XT/i, vramGb: 16 },
  { match: /RX\s*6800/i, vramGb: 16 },
  { match: /RX\s*6900/i, vramGb: 16 },
  { match: /RX\s*7600/i, vramGb: 8 },
  { match: /RX\s*7700/i, vramGb: 12 },
  { match: /RX\s*7800/i, vramGb: 16 },
  { match: /RX\s*7900\s*XTX/i, vramGb: 24 },
  { match: /RX\s*7900\s*XT/i, vramGb: 20 },
  { match: /RX\s*7900/i, vramGb: 24 },
  { match: /RX\s*9070/i, vramGb: 16 },
  // NVIDIA
  { match: /RTX\s*4090/i, vramGb: 24 },
  { match: /RTX\s*4080/i, vramGb: 16 },
  { match: /RTX\s*4060/i, vramGb: 8 },
  { match: /RTX\s*3090/i, vramGb: 24 },
  { match: /RTX\s*3080/i, vramGb: 10 },
  { match: /RTX\s*3070/i, vramGb: 8 },
  { match: /RTX\s*3060/i, vramGb: 12 },
]

/** Choose the GPU most likely to be used for compute. */
function pickPrimaryGpu(gpus) {
  if (!gpus.length) {
    return null
  }
  // Prefer a discrete AMD/NVIDIA card over an integrated Intel one.
  const discrete = gpus.find((g) => /radeon|nvidia|geforce|arc/i.test(g.name))
  return discrete ?? gpus[0]
}

function classifyVendor(gpu) {
  const name = gpu?.name ?? ''
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/i.test(name)) {
    return GPU_VENDOR.NVIDIA
  }
  if (/radeon|\bamd\b|gfx/i.test(name)) {
    return GPU_VENDOR.AMD
  }
  if (/intel|iris|uhd|arc/i.test(name)) {
    return GPU_VENDOR.INTEL
  }
  if (/apple|m1|m2|m3|m4/i.test(name)) {
    return GPU_VENDOR.APPLE
  }
  return GPU_VENDOR.NONE
}

function classifyAmdFamily(name) {
  for (const family of AMD_FAMILIES) {
    if (family.match.test(name)) {
      return family
    }
  }
  return null
}

function detectRamGb() {
  if (process.platform === 'win32') {
    const res = runPowershell('(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory')
    if (res.status === 0 && res.stdout) {
      const bytes = Number(res.stdout.trim())
      if (Number.isFinite(bytes) && bytes > 0) {
        return Math.round(bytes / 1024 ** 3)
      }
    }
  }
  return null
}

/** Is AMD's ROCm stack installed? */
function detectRocm() {
  if (process.platform === 'win32') {
    const winPath = 'C:\\Program Files\\AMD\\ROCm'
    return { installed: existsSync(winPath), path: existsSync(winPath) ? winPath : null }
  }
  const res = spawnSync('rocm-smi', ['--version'], { encoding: 'utf8', timeout: 8000 })
  return { installed: res.status === 0, path: null }
}

/** Is WSL available? On Windows this is the most realistic AMD ROCm route. */
function detectWsl() {
  if (process.platform !== 'win32') {
    return { available: false, distros: [] }
  }
  const res = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf8', timeout: 10_000 })
  if (res.status !== 0) {
    return { available: false, distros: [], detail: 'WSL is not installed.' }
  }
  const distros = (res.stdout || '')
    .split('\n')
    .map((l) => l.replace(/\0/g, '').trim())
    .filter(Boolean)
  return { available: true, distros }
}

/**
 * Recommend a path. This is the part that must not lie: an unsupported card gets
 * told it is unsupported, and handed the routes that do work.
 */
function recommend(profile) {
  const { vendor, vramGb, ramGb, amdFamily, wsl } = profile
  const paths = []

  if (vendor === GPU_VENDOR.NVIDIA) {
    const fits7b = vramGb >= 8
    paths.push({
      id: 'cuda',
      name: 'CUDA + QLoRA (via WSL2 if needed)',
      works: true,
      detail: fits7b
        ? `NVIDIA GPU with ${vramGb}GB VRAM. Standard PyTorch path works.`
        : `NVIDIA GPU with only ${vramGb}GB. Use QLoRA and a 1B–3B base model.`,
      steps: [
        'Install Python 3.10+ and the CUDA build of PyTorch.',
        'pip install transformers peft trl datasets bitsandbytes accelerate',
        'npm run train:prepare --dataset datasets/<name>',
        'python training/finetune/train.py',
      ],
    })
  }

  if (vendor === GPU_VENDOR.AMD) {
    const family = amdFamily?.family ?? 'unknown'

    if (family === 'rdna3' || family === 'rdna4') {
      paths.push({
        id: 'rocm-windows',
        name: 'ROCm on Windows (officially supported)',
        works: true,
        detail:
          `${amdFamily.note} Caveat: bitsandbytes 4-bit (QLoRA) is Linux-only, so on ` +
          `Windows you get LoRA rather than QLoRA — which needs more VRAM for the same model.`,
        steps: [
          'Install the AMD ROCm PyTorch preview for Windows (7000/9000 series).',
          'pip install the ROCm PyTorch wheel, then transformers/peft/trl.',
          'Choose a base model that fits VRAM without 4-bit quantization.',
          'npm run train:prepare --dataset datasets/<name> --method lora',
        ],
      })
    }

    if (family === 'rdna2' || family === 'rdna1' || family === 'unknown') {
      paths.push({
        id: 'rocm-windows',
        name: 'ROCm on Windows — NOT supported for this card',
        works: false,
        detail:
          (amdFamily?.note ?? 'Unrecognised AMD GPU.') +
          ' AMD\'s ROCm Windows preview covers Radeon 7000/9000 only.',
        steps: [],
      })
    }

    paths.push({
      id: 'rocm-linux',
      name: 'ROCm on Linux (WSL2 or native)',
      works: family !== 'rdna1',
      detail:
        family === 'rdna1'
          ? 'Radeon 5000 series has no practical ROCm support.'
          : 'ROCm on Linux supports RDNA2 in many builds. This is the route most likely ' +
          'to give you a working GPU fine-tune, and enables QLoRA (bitsandbytes is Linux-only).',
      steps: [
        wsl.available
          ? 'WSL2 is installed — use it.'
          : 'Enable WSL2:  wsl --install -d Ubuntu',
        'In the Linux environment, install ROCm for your card and the ROCm PyTorch wheel.',
        'pip install transformers peft trl datasets bitsandbytes accelerate',
        'npm run train:prepare --dataset datasets/<name> --method qlora',
        'python training/finetune/train.py',
      ],
    })

    paths.push({
      id: 'directml',
      name: 'DirectML (CPU-class speed, GPU memory)',
      works: true,
      detail:
        'torch-directml runs on AMD GPUs on Windows without ROCm, but training support is ' +
        'limited and slow. Best treated as an experiment, not a route to a good adapter.',
      steps: ['pip install torch-directml', 'Expect substantially slower training than ROCm.'],
    })
  }

  // Always include the CPU path: it is slow but it genuinely works, and for a small
  // model on 32GB of RAM it is a real answer rather than a consolation prize.
  const canCpuTrain1b = (ramGb ?? 0) >= 16
  paths.push({
    id: 'cpu',
    name: 'CPU-only training of a small model',
    works: canCpuTrain1b,
    detail: canCpuTrain1b
      ? `No supported GPU path needed. With ${ramGb}GB of RAM, LoRA fine-tuning of a ` +
      `~0.5B–1.5B model on a small dataset is practical (hours, not minutes). ` +
      `It will not produce a strong coder, but it proves the whole pipeline end to end ` +
      `and produces a real adapter.`
      : 'Insufficient RAM for CPU training. 16GB+ recommended.',
    steps: [
      'Install Python 3.10+ (CPU PyTorch — no GPU setup needed).',
      'pip install torch --index-url https://download.pytorch.org/whl/cpu',
      'pip install transformers peft trl datasets accelerate',
      'npm run train:prepare --dataset datasets/<name> --method lora --model Qwen/Qwen2.5-Coder-0.5B-Instruct',
      'python training/finetune/train.py',
    ],
  })

  paths.push({
    id: 'rented',
    name: 'Rent a CUDA GPU',
    works: true,
    detail:
      'The most cost-effective route to a good adapter. A single A100 or 4090 for a few ' +
      'hours costs a few dollars and removes every driver problem above.',
    steps: [
      'Push datasets/ to your storage of choice.',
      'Run this repo on a rented CUDA instance (Colab, RunPod, Lambda).',
      'Same commands — the pipeline is hardware-independent.',
    ],
  })

  // Rank: working GPU paths first, then CPU, then rented.
  const order = ['cuda', 'rocm-windows', 'rocm-linux', 'directml', 'cpu', 'rented']
  paths.sort((a, b) => {
    const ai = order.indexOf(a.id)
    const bi = order.indexOf(b.id)
    if (a.works !== b.works) {
      return a.works ? -1 : 1
    }
    return ai - bi
  })

  const viable = paths.filter((p) => p.works)
  const best = viable[0] ?? null

  return {
    paths,
    /** The recommended path, or null if nothing works (which should not happen). */
    best,
    summary: buildSummary(profile, best),
  }
}

function buildSummary(profile, best) {
  const gpuName = profile.primaryGpu?.name ?? 'no GPU detected'
  const vram = profile.vramGb ? `${profile.vramGb}GB VRAM` : 'VRAM unknown'
  const ram = profile.ramGb ? `${profile.ramGb}GB RAM` : 'RAM unknown'
  const head = `${gpuName} (${vram}), ${ram}.`
  if (!best) {
    return `${head} No viable training path was found.`
  }
  return `${head} Recommended: ${best.name}.`
}

/**
 * Decide which fine-tune method is realistic for a profile.
 * On AMD/Windows there is no bitsandbytes, so QLoRA is unavailable — claiming
 * otherwise is how people waste an afternoon.
 */
export function recommendMethod(profile, requested = null) {
  if (requested && requested !== 'auto') {
    if (requested === 'qlora' && !profile.canQlora) {
      return {
        method: 'lora',
        downgraded: true,
        reason:
          'QLoRA requires bitsandbytes, which is Linux-only. Falling back to LoRA ' +
          '(higher VRAM, same adapter quality).',
      }
    }
    return { method: requested, downgraded: false, reason: 'explicitly requested' }
  }

  if (profile.canQlora) {
    return { method: 'qlora', downgraded: false, reason: 'bitsandbytes is available on this platform' }
  }
  return {
    method: 'lora',
    downgraded: false,
    reason:
      profile.vendor === GPU_VENDOR.AMD && process.platform === 'win32'
        ? 'AMD on Windows: QLoRA is unavailable (bitsandbytes is Linux-only), using LoRA.'
        : 'QLoRA unavailable on this platform; using LoRA.',
  }
}

/**
 * Pick a base model that actually fits the hardware.
 * A 7B model will not fit 10GB with LoRA; suggesting one wastes a large download.
 */
export function recommendBaseModel(profile) {
  const vram = profile.vramGb ?? 0
  const isCpu = !profile.recommendation?.best || profile.recommendation.best.id === 'cpu'

  if (isCpu) {
    return {
      model: 'Qwen/Qwen2.5-Coder-0.5B-Instruct',
      sizeGb: 1,
      reason:
        'CPU training: a 0.5B model is the largest that trains in a reasonable time. ' +
        'It proves the pipeline and produces a real adapter.',
    }
  }
  if (vram >= 24) {
    return { model: 'Qwen/Qwen2.5-Coder-7B-Instruct', sizeGb: 15, reason: 'Enough VRAM for a 7B LoRA.' }
  }
  if (vram >= 16) {
    return { model: 'Qwen/Qwen2.5-Coder-7B-Instruct', sizeGb: 15, reason: '7B LoRA fits comfortably at 16GB.' }
  }
  if (vram >= 10) {
    return {
      model: 'Qwen/Qwen2.5-Coder-3B-Instruct',
      sizeGb: 6,
      reason: 'A 3B base fits 10GB with LoRA; a 7B would need QLoRA, which AMD/Windows lacks.',
    }
  }
  if (vram >= 8) {
    return { model: 'Qwen/Qwen2.5-Coder-1.5B-Instruct', sizeGb: 3, reason: '1.5B fits 8GB with LoRA.' }
  }
  return {
    model: 'Qwen/Qwen2.5-Coder-0.5B-Instruct',
    sizeGb: 1,
    reason: 'Limited VRAM: the smallest coder model keeps training feasible.',
  }
}
