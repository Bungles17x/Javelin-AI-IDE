const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('javelinDesktop', Object.freeze({
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  createWorkspace: (name) => ipcRenderer.invoke('workspace:create', name),
  readFile: (relativePath) => ipcRenderer.invoke('workspace:read', relativePath),
  writeFile: (relativePath, content) => ipcRenderer.invoke('workspace:write', relativePath, content),
  createFolder: (relativePath) => ipcRenderer.invoke('workspace:create-folder', relativePath),
  deleteFile: (relativePath) => ipcRenderer.invoke('workspace:delete', relativePath),
  deleteFolder: (relativePath) => ipcRenderer.invoke('workspace:delete-folder', relativePath),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('workspace:rename', oldPath, newPath),
  getRuntimeStatus: () => ipcRenderer.invoke('runtime:status'),
  startOllama: () => ipcRenderer.invoke('runtime:start-ollama'),
  resetNetwork: () => ipcRenderer.invoke('network:reset'),
  cancelCommand: (id) => ipcRenderer.send('workspace:cancel-command', id),
  runCommand: async (id, command, onOutput) => {
    const receiveOutput = (_event, commandId, stream, text) => {
      if (commandId === id && typeof onOutput === 'function') onOutput({ stream, text })
    }
    ipcRenderer.on('workspace:command-output', receiveOutput)
    try {
      return await ipcRenderer.invoke('workspace:run-command', id, command)
    } finally {
      ipcRenderer.removeListener('workspace:command-output', receiveOutput)
    }
  },
  startDebug: (config) => ipcRenderer.invoke('debug:start', config),
  stopDebug: (id) => ipcRenderer.invoke('debug:stop', id),
  onDebugOutput: (callback) => {
    const listener = (_event, id, stream, text) => callback({ id, stream, text })
    ipcRenderer.on('debug:output', listener)
    return () => ipcRenderer.removeListener('debug:output', listener)
  },
  onDebugReady: (callback) => {
    const listener = (_event, id, wsUrl) => callback({ id, wsUrl })
    ipcRenderer.on('debug:ready', listener)
    return () => ipcRenderer.removeListener('debug:ready', listener)
  },
  onDebugExit: (callback) => {
    const listener = (_event, id, exitCode) => callback({ id, exitCode })
    ipcRenderer.on('debug:exit', listener)
    return () => ipcRenderer.removeListener('debug:exit', listener)
  },
}))