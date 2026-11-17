/**
 * Minimal Chrome DevTools Protocol client for Node's built-in inspector.
 *
 * It deliberately implements only the surface the workbench uses: breakpoints,
 * pause/resume, stepping, call frames, console output and expression evaluation.
 * The renderer owns the socket; the desktop main process owns the child process.
 */

import { fileUrlForPath } from './debugConfig.js'

export class NodeInspectorClient {
  constructor(url, handlers = {}) {
    this.url = url
    this.handlers = handlers
    this.socket = null
    this.nextId = 0
    this.pending = new Map()
    this.breakpointIds = new Map()
    this.closed = false
  }

  connect() {
    if (typeof WebSocket === 'undefined') {
      return Promise.reject(new Error('The WebSocket API is unavailable in this window.'))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = new WebSocket(this.url)
      this.socket = socket
      socket.onopen = () => {
        settled = true
        resolve(this)
      }
      socket.onerror = () => {
        if (!settled) {
          settled = true
          reject(new Error('Could not connect to the Node inspector.'))
        }
      }
      socket.onclose = () => {
        this.closed = true
        this.failPending(new Error('The debug session ended.'))
        this.handlers.onClose?.()
      }
      socket.onmessage = (event) => this.receive(event.data)
    })
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('The debug session is not connected.'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  receive(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'Inspector error'))
      else pending.resolve(message.result)
      return
    }
    const params = message.params ?? {}
    switch (message.method) {
      case 'Debugger.paused':
        this.handlers.onPaused?.(params)
        break
      case 'Debugger.resumed':
        this.handlers.onResumed?.()
        break
      case 'Runtime.consoleAPICalled':
        this.handlers.onConsole?.(params)
        break
      case 'Runtime.exceptionThrown':
        this.handlers.onException?.(params)
        break
      case 'Debugger.scriptParsed':
        this.handlers.onScriptParsed?.(params)
        break
      case 'Inspector.detached':
        this.handlers.onClose?.(params.reason ?? 'Inspector detached.')
        break
      default:
        break
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  async enable() {
    await this.send('Runtime.enable')
    await this.send('Debugger.enable')
    // --inspect-brk holds the process until a client asks it to run. Sending this
    // after Debugger.enable means the initial pause event is not lost.
    this.send('Runtime.runIfWaitingForDebugger').catch(() => {})
  }

  async setBreakpoints(breakpoints = [], root = '') {
    for (const id of this.breakpointIds.values()) {
      await this.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {})
    }
    this.breakpointIds.clear()
    for (const breakpoint of breakpoints) {
      const url = fileUrlForPath(root, breakpoint.path)
      if (!url) continue
      try {
        const result = await this.send('Debugger.setBreakpointByUrl', {
          url,
          lineNumber: Math.max(0, Number(breakpoint.line) - 1),
          columnNumber: 0,
        })
        if (result?.breakpointId) this.breakpointIds.set(breakpoint.id, result.breakpointId)
      } catch {
        // A breakpoint in a file that will never load must not stop the session.
      }
    }
  }

  async setBreakpoint(breakpoint, root) {
    const url = fileUrlForPath(root, breakpoint.path)
    if (!url) return null
    try {
      const result = await this.send('Debugger.setBreakpointByUrl', {
        url,
        lineNumber: Math.max(0, Number(breakpoint.line) - 1),
        columnNumber: 0,
      })
      if (result?.breakpointId) this.breakpointIds.set(breakpoint.id, result.breakpointId)
      return result?.breakpointId ?? null
    } catch {
      return null
    }
  }

  async removeBreakpoint(id) {
    const breakpointId = this.breakpointIds.get(id)
    if (!breakpointId) return
    this.breakpointIds.delete(id)
    await this.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {})
  }

  resume() {
    return this.send('Debugger.resume')
  }

  pause() {
    return this.send('Debugger.pause')
  }

  stepOver() {
    return this.send('Debugger.stepOver')
  }

  stepInto() {
    return this.send('Debugger.stepInto')
  }

  stepOut() {
    return this.send('Debugger.stepOut')
  }

  async evaluate(expression, callFrameId = '') {
    const params = {
      expression,
      generatePreview: true,
      returnByValue: true,
      awaitPromise: true,
    }
    const result = await this.send(
      callFrameId ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate',
      callFrameId ? { ...params, callFrameId } : params,
    )
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'Evaluation failed')
    }
    const value = result?.result
    if (!value) return ''
    if ('value' in value) return typeof value.value === 'string' ? value.value : JSON.stringify(value.value)
    return value.description ?? value.type ?? ''
  }

  close() {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      // Already closed.
    }
    this.failPending(new Error('The debug session ended.'))
  }
}
