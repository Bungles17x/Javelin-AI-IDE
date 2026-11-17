import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { NodeInspectorClient } from '../src/lib/nodeInspector.js'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

test('the inspector client can enable, pause, evaluate and resume', {
  skip: typeof WebSocket === 'undefined' ? 'This Node version has no global WebSocket.' : false,
  timeout: 15000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'javelin-inspector-'))
  const fixture = path.join(directory, 'fixture.js')
  await writeFile(fixture, 'const answer = 1 + 2\nconsole.log(answer)\n', 'utf8')
  const port = await freePort()
  const child = spawn(process.execPath, [`--inspect-brk=127.0.0.1:${port}`, fixture], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let client
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`Inspector did not start: ${output}`)), 8000)
      child.stderr.on('data', (chunk) => {
        output += chunk.toString('utf8')
        const match = output.match(/Debugger listening on (ws:\/\/[^\s]+)/)
        if (!match) return
        clearTimeout(timer)
        resolve(match[1])
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    const pauses = []
    const waiters = []
    client = new NodeInspectorClient(wsUrl, {
      onPaused: (params) => {
        const waiter = waiters.shift()
        if (waiter) waiter(params)
        else pauses.push(params)
      },
    })
    const nextPause = () => pauses.length
      ? Promise.resolve(pauses.shift())
      : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No pause event arrived.')), 5000)
        waiters.push((params) => { clearTimeout(timer); resolve(params) })
      })
    await client.connect()
    await client.enable()
    const pause = await nextPause()
    assert.ok(pause.callFrames.length >= 1)
    const value = await client.evaluate('1 + 2', pause.callFrames[0].callFrameId)
    assert.equal(value, '3')
    const breakpointId = await client.setBreakpoint({ id: 'fixture-line-2', path: 'fixture.js', line: 2 }, directory)
    assert.ok(breakpointId)
    await client.resume()
    const breakpointPause = await nextPause()
    assert.equal(breakpointPause.callFrames[0].location.lineNumber, 1)
    await client.resume()
  } finally {
    client?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))])
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
