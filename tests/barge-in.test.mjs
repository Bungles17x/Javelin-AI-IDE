import { bargeThreshold, shouldInterrupt, createBargeIn, ATTACK_FLOOR, HEADROOM } from '../src/lib/bargeIn.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. The threshold rises above the assistant\'s own voice')
check('silence uses the attack floor', bargeThreshold(0) === ATTACK_FLOOR)
check('an echo floor raises the bar', bargeThreshold(0.01) === 0.01 * HEADROOM)
check('the floor wins over a quiet echo', bargeThreshold(0.001) === ATTACK_FLOOR)
check('the assistant voice alone does not trigger', shouldInterrupt(0.02, 0.02) === false)
check('a voice above the echo triggers', shouldInterrupt(0.09, 0.02) === true)
check('a quiet room still needs real speech', shouldInterrupt(0.015, 0) === false)
check('a loud bang in a silent room can trigger', shouldInterrupt(0.05, 0) === true)
check('a missing baseline is treated as silence', bargeThreshold() === ATTACK_FLOOR)

console.log('\n2. Without WebAudio it declines instead of pretending')
const noAudio = createBargeIn({ getStream: async () => ({}) })
check('start reports failure when there is no AudioContext', (await noAudio.start()) === false)
check('it does not claim to be running', noAudio.running === false)
check('stop is safe after a failed start', (() => { noAudio.stop(); return true })())

const noStream = createBargeIn({ getStream: async () => null })
check('a stream that never arrives is handled', (await noStream.start()) === false)

console.log('\n3. A sustained voice fires the interruption exactly once')
// Minimal WebAudio stand-in: the analyser is always loud.
class FakeAnalyser {
  constructor() { this.fftSize = 1024 }
  getFloatTimeDomainData(array) { array.fill(0.5) }
}
class FakeAudioContext {
  createMediaStreamSource() { return { connect() {} } }
  createAnalyser() { return new FakeAnalyser() }
  close() { this.closed = true }
}
globalThis.window = { AudioContext: FakeAudioContext }

let interrupts = 0
const monitor = createBargeIn({
  getStream: async () => ({ getAudioTracks: () => [{ readyState: 'live' }] }),
  onInterrupt: () => { interrupts += 1 },
  calibrationMs: 0,
  frameMs: 10,
  framesNeeded: 2,
})
check('the monitor starts', (await monitor.start()) === true)
await new Promise((resolve) => setTimeout(resolve, 120))
check('a loud sustained sound interrupts once', interrupts === 1, String(interrupts))
check('the monitor stops itself afterwards', monitor.running === false)

let quietInterrupts = 0
class QuietAnalyser extends FakeAnalyser { getFloatTimeDomainData(array) { array.fill(0) } }
globalThis.window = { AudioContext: class extends FakeAudioContext { createAnalyser() { return new QuietAnalyser() } } }
const quiet = createBargeIn({
  getStream: async () => ({ getAudioTracks: () => [] }),
  onInterrupt: () => { quietInterrupts += 1 },
  calibrationMs: 0,
  frameMs: 10,
  framesNeeded: 2,
})
await quiet.start()
await new Promise((resolve) => setTimeout(resolve, 120))
check('silence never interrupts', quietInterrupts === 0)
quiet.stop()
check('an explicit stop leaves it idle', quiet.running === false)

let stoppedInterrupts = 0
globalThis.window = { AudioContext: FakeAudioContext }
const cancelled = createBargeIn({
  getStream: async () => ({}),
  onInterrupt: () => { stoppedInterrupts += 1 },
  calibrationMs: 0,
  frameMs: 10,
  framesNeeded: 1,
})
await cancelled.start()
cancelled.stop()
await new Promise((resolve) => setTimeout(resolve, 80))
check('no interruption fires after stop', stoppedInterrupts === 0)

console.log(`\n${failures === 0 ? 'ALL BARGE-IN CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exitCode = failures === 0 ? 0 : 1
