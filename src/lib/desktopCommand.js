function createAbortError() {
  const error = new Error('Command canceled.')
  error.name = 'AbortError'
  return error
}

/**
 * Adapt an in-renderer AbortSignal to the serializable desktop IPC command API.
 * AbortSignal itself must not cross Electron's contextBridge.
 */
export function createDesktopCommandRunner(desktopApi) {
  return (command, signal, onOutput) => {
    if (signal?.aborted) return Promise.reject(createAbortError())

    const id = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const cancel = () => desktopApi.cancelCommand(id)
    signal?.addEventListener('abort', cancel, { once: true })

    let result
    try {
      result = desktopApi.runCommand(id, command, onOutput)
    } catch (error) {
      signal?.removeEventListener('abort', cancel)
      return Promise.reject(error)
    }

    return Promise.resolve(result).finally(() => {
      signal?.removeEventListener('abort', cancel)
    })
  }
}
