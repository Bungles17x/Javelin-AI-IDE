/**
 * Hardware profiler tests.
 *
 * The profiler's whole job is to give advice that matches the machine. The failure
 * mode it exists to prevent is telling an AMD user "a GPU is required" — which is
 * both wrong and useless. These tests pin that behaviour down across the hardware
 * configurations that actually exist in the wild.
 *
 * Uses simulated profiles so the logic is tested for machines we do not have.
 */

import {
  profileHardware, recommendMethod, recommendBaseModel, GPU_VENDOR,
} from '../training/hardware.mjs'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Build a simulated machine profile. */
function sim({ gpu, ramGb = 32, wsl = false, rocm = false }) {
  return profileHardware({
    gpuOverride: gpu
      ? [{ name: gpu, reportedVramGb: 4, driver: 'test', vramGb: undefined, vramEstimated: false }]
      : [],
    ramOverride: ramGb,
  })
}

/** The profiler enriches VRAM from a known-cards table; re-run with that applied. */
function simWithVram({ gpu, ramGb = 32 }) {
  const p = profileHardware({ gpuOverride: null, ramOverride: ramGb })
  // Override detection with a simulated card, then let enrichment run.
  const simulated = structuredClone(p)
  simulated.primaryGpu = { name: gpu, reportedVramGb: 4 }
  simulated.gpus = [simulated.primaryGpu]
  simulated.ramGb = ramGb
  return simulated
}

console.log('\n1. AMD 6000-series on Windows is told the truth')
{
  const p = sim({ gpu: 'AMD Radeon RX 6700' })
  check('vendor detected as AMD', p.vendor === GPU_VENDOR.AMD, p.vendor)
  check('RDNA2 family recognised', p.amdFamily?.family === 'rdna2', JSON.stringify(p.amdFamily?.family))

  const paths = p.recommendation.paths
  const winPath = paths.find((x) => x.id === 'rocm-windows')
  check('Windows ROCm is marked NOT viable for this card', winPath && winPath.works === false,
    JSON.stringify(winPath?.works))
  check('the reason names the 7000/9000 limitation', /7000/.test(winPath?.detail ?? ''),
    winPath?.detail)

  const linuxPath = paths.find((x) => x.id === 'rocm-linux')
  check('Linux ROCm is offered as viable', linuxPath?.works === true, JSON.stringify(linuxPath?.works))

  check('a best path is still recommended', Boolean(p.recommendation.best))
  check('the summary names the GPU', /RX 6700/.test(p.recommendation.summary), p.recommendation.summary)
}

console.log('\n2. AMD 7000-series on Windows is told it can work')
{
  const p = sim({ gpu: 'AMD Radeon RX 7900 XT' })
  check('RDNA3 family recognised', p.amdFamily?.family === 'rdna3', JSON.stringify(p.amdFamily?.family))
  const winPath = p.recommendation.paths.find((x) => x.id === 'rocm-windows')
  check('Windows ROCm is marked viable', winPath?.works === true, JSON.stringify(winPath?.works))
  check('the guidance warns QLoRA is Linux-only', /bitsandbytes|QLoRA/.test(winPath?.detail ?? ''),
    winPath?.detail)
}

console.log('\n3. NVIDIA is offered the standard CUDA path')
{
  const p = sim({ gpu: 'NVIDIA GeForce RTX 4090' })
  check('vendor detected as NVIDIA', p.vendor === GPU_VENDOR.NVIDIA, p.vendor)
  const cuda = p.recommendation.paths.find((x) => x.id === 'cuda')
  check('CUDA path is viable', cuda?.works === true)
  check('CUDA is the recommended path', p.recommendation.best?.id === 'cuda',
    p.recommendation.best?.id)
}

console.log('\n4. CPU-only machines get a real path, not a dead end')
{
  const p = sim({ gpu: null, ramGb: 32 })
  check('vendor detected as none', p.vendor === GPU_VENDOR.NONE, p.vendor)
  const cpu = p.recommendation.paths.find((x) => x.id === 'cpu')
  check('a CPU path is offered', Boolean(cpu))
  check('the CPU path is viable with 32GB RAM', cpu?.works === true, cpu?.detail)
  check('some path is always recommended', Boolean(p.recommendation.best),
    p.recommendation.best?.name)
}

console.log('\n5. Low RAM is handled honestly')
{
  const p = sim({ gpu: null, ramGb: 4 })
  const cpu = p.recommendation.paths.find((x) => x.id === 'cpu')
  check('CPU path marked not viable with 4GB RAM', cpu?.works === false, JSON.stringify(cpu?.works))
}

console.log('\n6. Method selection never asks for QLoRA where it cannot work')
{
  const amd = sim({ gpu: 'AMD Radeon RX 6700' })
  const requested = recommendMethod(amd, 'qlora')
  check('an explicit QLoRA request is downgraded on AMD/Windows',
    requested.method === 'lora' && requested.downgraded === true,
    JSON.stringify(requested))
  check('the downgrade explains why', /bitsandbytes|Linux/i.test(requested.reason), requested.reason)

  const auto = recommendMethod(amd, 'auto')
  check('auto does not choose QLoRA here', auto.method === 'lora', auto.method)
}

console.log('\n7. Base model is sized to the hardware')
{
  const big = simWithVram({ gpu: 'NVIDIA GeForce RTX 4090' })
  big.vramGb = 24
  check('24GB gets a 7B model', /7B/.test(recommendBaseModel(big).model), recommendBaseModel(big).model)

  const mid = simWithVram({ gpu: 'AMD Radeon RX 6700' })
  mid.vramGb = 10
  const midChoice = recommendBaseModel(mid)
  check('10GB gets a 3B model (7B would need QLoRA)', /3B/.test(midChoice.model), midChoice.model)
  check('the 10GB choice explains itself', /QLoRA/.test(midChoice.reason), midChoice.reason)

  const cpuProfile = sim({ gpu: null })
  const cpuChoice = recommendBaseModel(cpuProfile)
  check('CPU gets a small model', /0\.5B/.test(cpuChoice.model), cpuChoice.model)
}

console.log('\n8. Every profile yields a usable decision')
{
  const machines = [
    { gpu: 'AMD Radeon RX 6700', ramGb: 32 },
    { gpu: 'AMD Radeon RX 7900 XTX', ramGb: 64 },
    { gpu: 'NVIDIA GeForce RTX 3060', ramGb: 16 },
    { gpu: 'NVIDIA GeForce RTX 4090', ramGb: 128 },
    { gpu: 'Intel Arc A770', ramGb: 32 },
    { gpu: null, ramGb: 8 },
  ]
  for (const m of machines) {
    const p = sim(m)
    const base = recommendBaseModel(p)
    const method = recommendMethod(p, 'auto')
    const ok =
      p.recommendation.paths.length > 0 &&
      Boolean(base.model) &&
      Boolean(method.method) &&
      p.recommendation.paths.some((x) => x.works)
    check(`${m.gpu ?? 'CPU only'} (${m.ramGb}GB) → ${base.model} / ${method.method}`, ok,
      JSON.stringify({ paths: p.recommendation.paths.length, base: base.model }))
  }
}

console.log('\n9. The original failure cannot recur')
{
  // The old behaviour: "A GPU is required" regardless of what was present.
  const amd = sim({ gpu: 'AMD Radeon RX 6700' })
  const allText = JSON.stringify(amd.recommendation)
  check('AMD advice never claims no GPU exists', !/no GPU detected/i.test(allText))
  check('AMD advice offers at least two routes', amd.recommendation.paths.filter((p) => p.works).length >= 2,
    String(amd.recommendation.paths.filter((p) => p.works).length))
}

console.log(`\n${failures === 0 ? 'ALL HARDWARE PROFILER CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
