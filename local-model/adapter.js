/**
 * Javelin Local Model Adapter
 * ============================
 *
 * Adapts the local Javelin model to work with Javelin Core's engine system.
 *
 * This adapter allows Javelin Core to use the locally-trained model as its
 * inference engine, making Javelin completely independent of external providers.
 */

import { InferenceEngine, createInferenceEngine } from './inference.js'

/**
 * Create a Javelin Core engine from the local model
 */
export async function createLocalModelEngine(options = {}) {
  const {
    modelPath = 'models/javelin-trained.json',
    tokenizerPath = 'models/tokenizer.json',
    config = {},
  } = options

  // Check if model exists
  let modelExists = false
  const isNode = typeof window === 'undefined'

  if (isNode) {
    try {
      const fs = await import('fs')
      modelExists = fs.existsSync(modelPath)
    } catch {
      modelExists = false
    }
  } else {
    // Browser: try to fetch the model
    try {
      const response = await fetch(modelPath)
      modelExists = response.ok
    } catch {
      modelExists = false
    }
  }

  if (!modelExists) {
    console.warn(`Local model not found at ${modelPath}`)
    console.warn('Javelin will run in untrained mode.')
    console.warn('Train a model first: node local-model/train.js')
  }

  try {
    const engine = await createInferenceEngine(modelPath, tokenizerPath, config)
    return {
      id: 'javelin-local',
      label: 'Javelin (local, independent)',
      capabilities: ['tools', 'offline'],
      async probe() {
        return {
          ok: modelExists,
          detail: modelExists
            ? 'Local model loaded successfully'
            : 'No trained model found',
        }
      },
      async generate(req) {
        const messages = req.messages.map(m => ({
          role: m.role,
          content: m.content,
        }))

        const result = await engine.chat({
          messages,
          maxTokens: 2048,
          temperature: req.temperature || 0.7,
          onToken: req.onToken,
        })

        // Extract tool calls if present
        const toolCalls = extractToolCalls(result.text)

        return {
          text: result.text,
          toolCalls,
          finishReason: 'stop',
          engineId: 'javelin-local',
        }
      },
    }
  } catch (error) {
    console.error('Failed to load local model:', error.message)
    return createUntrainedEngine()
  }
}

/**
 * Create an untrained fallback engine
 */
function createUntrainedEngine() {
  return {
    id: 'javelin-untrained',
    label: 'Javelin (untrained - needs training)',
    capabilities: ['offline'],
    async probe() {
      return {
        ok: false,
        detail: 'No trained model available. Train a model first.',
      }
    },
    async generate(req) {
      return {
        text: '[ERROR: Javelin model is not trained. Please train the model first using the training pipeline.]',
        toolCalls: [],
        finishReason: 'stop',
        engineId: 'javelin-untrained',
      }
    },
  }
}

/**
 * Extract tool calls from generated text
 */
function extractToolCalls(text) {
  const toolCalls = []

  // Pattern for tool calls in various formats
  const patterns = [
    /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g,
    /{[\s\S]*?"tool"[\s\S]*?}/g,
    /{[\s\S]*?"name"[\s\S]*?}/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1])
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: parsed.name || parsed.tool || 'unknown',
          args: parsed.arguments || parsed.parameters || {},
        })
      } catch {
        // Invalid JSON, skip
      }
    }
  }

  return toolCalls
}

/**
 * Check if a local model is available
 */
export async function hasLocalModel(modelPath = 'models/javelin-trained.json') {
  if (existsSync) {
    return existsSync(modelPath)
  } else {
    try {
      const response = await fetch(modelPath)
      return response.ok
    } catch {
      return false
    }
  }
}

/**
 * Get model information
 */
export async function getModelInfo(modelPath = 'models/javelin-trained.json') {
  let exists = false
  if (existsSync) {
    exists = existsSync(modelPath)
  } else {
    try {
      const response = await fetch(modelPath)
      exists = response.ok
    } catch {
      exists = false
    }
  }

  if (!exists) {
    return {
      exists: false,
      trained: false,
      message: 'No trained model found',
    }
  }

  try {
    let data
    if (typeof window === 'undefined') {
      const fs = await import('fs')
      data = JSON.parse(fs.readFileSync(modelPath, 'utf8'))
    } else {
      const response = await fetch(modelPath)
      data = await response.json()
    }

    return {
      exists: true,
      trained: true,
      config: data.config,
      message: 'Trained model loaded',
    }
  } catch (error) {
    return {
      exists: true,
      trained: false,
      message: 'Model file exists but is invalid',
    }
  }
}
