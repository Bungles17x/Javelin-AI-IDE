/**
 * Browser-compatible stub for local-model
 * 
 * In the browser (web build), the local model is not used.
 * The web interface communicates with the local model running
 * in the Electron main process or a Node.js backend.
 */

export function createLocalModelEngine() {
  return {
    id: 'javelin-browser',
    label: 'Javelin (browser - needs backend)',
    capabilities: [],
    async probe() {
      return {
        ok: false,
        detail: 'Local model not available in browser. Use the desktop IDE or run the backend server.',
      }
    },
    async generate() {
      return {
        text: '[ERROR: Local model not available in browser environment. Please use the desktop IDE for full functionality.]',
        toolCalls: [],
        finishReason: 'stop',
        engineId: 'javelin-browser',
      }
    },
  }
}

export async function hasLocalModel() {
  return false
}

export async function getModelInfo() {
  return {
    exists: false,
    trained: false,
    message: 'Local model not available in browser',
  }
}
