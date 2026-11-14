import { createDesktopCommandRunner } from '../src/lib/desktopCommand.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n1. AbortSignal stays inside the renderer')
{
  const controller = new AbortController()
  let receivedArgs
  const api = {
    cancelCommand: () => {},
    runCommand: (...args) => {
      receivedArgs = args
      return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '' })
    },
  }
  const onOutput = () => {}
  const result = await createDesktopCommandRunner(api)('npm test', controller.signal, onOutput)
  check('desktop bridge receives id, command, and callback only',
    receivedArgs.length === 3 && typeof receivedArgs[0] === 'string' &&
      receivedArgs[1] === 'npm test' && receivedArgs[2] === onOutput)
  check('command result is preserved', result.exitCode === 0 && result.stdout === 'ok')
}

console.log('\n2. Cancellation is forwarded by command id')
{
  const controller = new AbortController()
  let commandId
  let canceledId
  let complete
  const api = {
    cancelCommand: (id) => { canceledId = id },
    runCommand: (id) => {
      commandId = id
      return new Promise((resolve) => { complete = resolve })
    },
  }
  const pending = createDesktopCommandRunner(api)('npm test', controller.signal)
  controller.abort()
  check('abort targets the matching command', Boolean(commandId) && canceledId === commandId)
  complete({ exitCode: 1, stdout: '', stderr: 'terminated' })
  await pending
}

console.log('\n3. An already-aborted task never starts a shell command')
{
  const controller = new AbortController()
  controller.abort()
  let started = false
  const api = {
    cancelCommand: () => {},
    runCommand: () => { started = true },
  }
  let abortError = false
  try {
    await createDesktopCommandRunner(api)('npm test', controller.signal)
  } catch (error) {
    abortError = error.name === 'AbortError'
  }
  check('pre-aborted command rejects as an abort', abortError)
  check('pre-aborted command is not launched', !started)
}

console.log(`\n${failures === 0 ? 'ALL DESKTOP COMMAND CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
