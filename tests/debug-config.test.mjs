import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDebugConfigurations,
  debugRunCommand,
  defaultLaunchJson,
  fileUrlForPath,
  isDebuggableFile,
  relativePathFromUrl,
} from '../src/lib/debugConfig.js'

test('auto-detects package.json main and conventional entry files', () => {
  const contents = {
    'package.json': JSON.stringify({ main: 'src/server.js' }),
    'src/server.js': '',
    'src/index.js': '',
    'index.js': '',
  }
  const configs = buildDebugConfigurations(contents)
  assert.deepEqual(configs.map((config) => config.program), ['src/server.js', 'src/index.js', 'index.js'])
  assert.equal(configs[0].type, 'node')
  assert.equal(configs[0].request, 'launch')
})

test('prioritizes the active JavaScript file as a debug target', () => {
  const contents = {
    'src/index.js': '',
    'src/worker.js': '',
  }
  const configs = buildDebugConfigurations(contents, { activeFile: 'src/worker.js' })
  assert.equal(configs[0].program, 'src/worker.js')
  assert.match(configs[0].name, /worker/)
})

test('reads .vscode/launch.json and resolves workspace variables', () => {
  const contents = {
    '.vscode/launch.json': `{
      // JSONC comments are accepted, like VS Code.
      "version": "0.2.0",
      "configurations": [{
        "type": "node",
        "request": "launch",
        "name": "API server",
        "program": "\${workspaceFolder}/src/server.js",
        "args": ["--port", "3000"],
        "cwd": "\${workspaceFolder}",
        "env": {"NODE_ENV": "development"},
        "runtimeArgs": ["--enable-source-maps"],
      }]
    }`,
    'src/server.js': '',
  }
  const configs = buildDebugConfigurations(contents)
  const launch = configs.find((config) => config.name === 'API server')
  assert.ok(launch)
  assert.equal(launch.program, 'src/server.js')
  assert.deepEqual(launch.args, ['--port', '3000'])
  assert.deepEqual(launch.runtimeArgs, ['--enable-source-maps'])
  assert.deepEqual(launch.env, { NODE_ENV: 'development' })
  assert.equal(launch.source, 'launch.json')
})

test('ignores non-Node and attach configurations', () => {
  const contents = {
    '.vscode/launch.json': JSON.stringify({
      configurations: [
        { type: 'chrome', request: 'launch', name: 'Browser', program: 'src/index.js' },
        { type: 'node', request: 'attach', name: 'Attach', program: 'src/index.js' },
        { type: 'node', request: 'launch', name: 'Valid', program: 'src/index.js' },
      ],
    }),
    'src/index.js': '',
  }
  const configs = buildDebugConfigurations(contents)
  assert.ok(configs.some((config) => config.name === 'Valid'))
  assert.ok(!configs.some((config) => config.name === 'Browser'))
  assert.ok(!configs.some((config) => config.name === 'Attach'))
})

test('only JavaScript Node files are debuggable', () => {
  assert.equal(isDebuggableFile('src/index.js'), true)
  assert.equal(isDebuggableFile('src/index.mjs'), true)
  assert.equal(isDebuggableFile('src/index.cjs'), true)
  assert.equal(isDebuggableFile('src/index.ts'), false)
  assert.equal(isDebuggableFile('src/index.jsx'), false)
  assert.equal(isDebuggableFile('server.py'), false)
})

test('file URLs map Windows and POSIX workspace paths', () => {
  assert.equal(fileUrlForPath('C:\\work\\project', 'src/a b.js'), 'file:///C:/work/project/src/a%20b.js')
  assert.equal(relativePathFromUrl('file:///C:/work/project/src/a%20b.js', 'C:\\work\\project'), 'src/a b.js')
  assert.equal(fileUrlForPath('/home/me/project', 'src/index.js'), 'file:///home/me/project/src/index.js')
  assert.equal(relativePathFromUrl('file:///home/me/project/src/index.js', '/home/me/project'), 'src/index.js')
})

test('run command and default launch JSON are usable', () => {
  const config = { program: 'src/index.js', args: ['--flag'], runtimeArgs: ['--enable-source-maps'] }
  assert.equal(debugRunCommand(config), 'node --enable-source-maps src/index.js --flag')
  const parsed = JSON.parse(defaultLaunchJson())
  assert.equal(parsed.version, '0.2.0')
  assert.equal(parsed.configurations[0].program, '${workspaceFolder}/src/index.js')
})
