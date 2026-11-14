/**
 * Javelin Model Architecture
 * ==========================
 *
 * A transformer-based neural network architecture for Javelin's independent model.
 *
 * This is a functional implementation that:
 * - Can be instantiated with configurable hyperparameters
 * - Can be trained on datasets
 * - Can perform inference on text
 * - Can save/load weights
 *
 * Note: This model is UNTRAINED by default. It requires training on substantial
 * data to become useful. The architecture is capable, but weights must be learned.
 */

import { defaultConfig } from './config.js'

/**
 * Multi-head attention mechanism
 */
class MultiHeadAttention {
  constructor(config) {
    this.config = config
    this.embedDim = config.embedDim
    this.numHeads = config.numHeads
    this.headDim = this.embedDim / this.numHeads

    // Initialize projection matrices (simplified - using linear layers)
    this.Wq = this.randomMatrix(this.embedDim, this.embedDim)
    this.Wk = this.randomMatrix(this.embedDim, this.embedDim)
    this.Wv = this.randomMatrix(this.embedDim, this.embedDim)
    this.Wo = this.randomMatrix(this.embedDim, this.embedDim)
  }

  randomMatrix(rows, cols) {
    const scale = Math.sqrt(2.0 / (rows + cols))
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => (Math.random() * 2 - 1) * scale)
    )
  }

  /**
   * Apply attention to input
   * @param {number[][]} x - Input tensor [seq_len, embed_dim]
   * @returns {number[][]} Output tensor [seq_len, embed_dim]
   */
  forward(x) {
    const seqLen = x.length

    // Project to Q, K, V
    const Q = this.matmul(x, this.Wq)
    const K = this.matmul(x, this.Wk)
    const V = this.matmul(x, this.Wv)

    // Reshape for multi-head
    const Q_heads = this.reshapeHeads(Q)
    const K_heads = this.reshapeHeads(K)
    const V_heads = this.reshapeHeads(V)

    // Scaled dot-product attention
    const attnOutput = this.scaledDotProductAttention(Q_heads, K_heads, V_heads)

    // Combine heads
    const combined = this.combineHeads(attnOutput)

    // Final projection
    return this.matmul(combined, this.Wo)
  }

  matmul(a, b) {
    const rows = a.length
    const cols = b[0].length
    const inner = b.length
    const result = Array.from({ length: rows }, () => Array(cols).fill(0))

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        for (let k = 0; k < inner; k++) {
          result[i][j] += a[i][k] * b[k][j]
        }
      }
    }
    return result
  }

  reshapeHeads(x) {
    // Simplified reshape for multi-head attention
    const seqLen = x.length
    const heads = this.numHeads
    const headDim = this.headDim
    const result = []

    for (let h = 0; h < heads; h++) {
      const head = []
      for (let i = 0; i < seqLen; i++) {
        const row = []
        for (let d = 0; d < headDim; d++) {
          row.push(x[i][h * headDim + d])
        }
        head.push(row)
      }
      result.push(head)
    }
    return result
  }

  combineHeads(x) {
    const heads = x.length
    const seqLen = x[0].length
    const headDim = x[0][0].length
    const result = []

    for (let i = 0; i < seqLen; i++) {
      const row = []
      for (let h = 0; h < heads; h++) {
        row.push(...x[h][i])
      }
      result.push(row)
    }
    return result
  }

  scaledDotProductAttention(Q, K, V) {
    const heads = Q.length
    const seqLen = Q[0].length
    const headDim = Q[0][0].length
    const result = []

    for (let h = 0; h < heads; h++) {
      const headResult = []
      for (let i = 0; i < seqLen; i++) {
        const attended = []
        for (let j = 0; j < seqLen; j++) {
          // Dot product
          let score = 0
          for (let d = 0; d < headDim; d++) {
            score += Q[h][i][d] * K[h][j][d]
          }
          // Scale
          score /= Math.sqrt(headDim)
          // Softmax (simplified)
          score = Math.exp(score)
          attended.push(score)
        }
        // Normalize
        const sum = attended.reduce((a, b) => a + b, 0)
        const normalized = attended.map(s => s / sum)
        // Weighted sum of V
        const output = Array(headDim).fill(0)
        for (let j = 0; j < seqLen; j++) {
          for (let d = 0; d < headDim; d++) {
            output[d] += normalized[j] * V[h][j][d]
          }
        }
        headResult.push(output)
      }
      result.push(headResult)
    }
    return result
  }
}

/**
 * Feed-forward network
 */
class FeedForward {
  constructor(config) {
    this.config = config
    this.embedDim = config.embedDim
    this.ffDim = config.ffDim

    this.W1 = this.randomMatrix(this.embedDim, this.ffDim)
    this.W2 = this.randomMatrix(this.ffDim, this.embedDim)
  }

  randomMatrix(rows, cols) {
    const scale = Math.sqrt(2.0 / (rows + cols))
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => (Math.random() * 2 - 1) * scale)
    )
  }

  forward(x) {
    const seqLen = x.length
    const result = []

    for (let i = 0; i < seqLen; i++) {
      // First linear
      const hidden = this.linear(x[i], this.W1)
      // ReLU activation
      const activated = hidden.map(v => Math.max(0, v))
      // Second linear
      const output = this.linear(activated, this.W2)
      result.push(output)
    }
    return result
  }

  linear(x, W) {
    const cols = W[0].length
    const result = Array(cols).fill(0)
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < x.length; i++) {
        result[j] += x[i] * W[i][j]
      }
    }
    return result
  }
}

/**
 * Layer normalization
 */
class LayerNorm {
  constructor(dim) {
    this.dim = dim
    this.gamma = Array(dim).fill(1)
    this.beta = Array(dim).fill(0)
  }

  forward(x) {
    const seqLen = x.length
    const result = []

    for (let i = 0; i < seqLen; i++) {
      const mean = x[i].reduce((a, b) => a + b, 0) / this.dim
      const variance = x[i].reduce((a, b) => a + (b - mean) ** 2, 0) / this.dim
      const std = Math.sqrt(variance + 1e-6)

      const normalized = x[i].map(v => (v - mean) / std)
      const output = normalized.map((v, j) => v * this.gamma[j] + this.beta[j])
      result.push(output)
    }
    return result
  }
}

/**
 * Transformer encoder layer
 */
class TransformerEncoderLayer {
  constructor(config) {
    this.config = config
    this.attention = new MultiHeadAttention(config)
    this.norm1 = new LayerNorm(config.embedDim)
    this.ff = new FeedForward(config)
    this.norm2 = new LayerNorm(config.embedDim)
  }

  forward(x) {
    // Self-attention with residual connection
    const attnOutput = this.attention.forward(x)
    const attnNorm = this.addNorm(x, attnOutput, this.norm1)

    // Feed-forward with residual connection
    const ffOutput = this.ff.forward(attnNorm)
    const ffNorm = this.addNorm(attnNorm, ffOutput, this.norm2)

    return ffNorm
  }

  addNorm(x, output, norm) {
    const seqLen = x.length
    const added = []
    for (let i = 0; i < seqLen; i++) {
      added.push(x[i].map((v, j) => v + output[i][j]))
    }
    return norm.forward(added)
  }
}

/**
 * Main Javelin Model
 */
export class JavelinModel {
  constructor(config = defaultConfig) {
    this.config = config
    this.vocabSize = config.vocabSize
    this.embedDim = config.embedDim
    this.maxSeqLen = config.maxSeqLen

    // Token and position embeddings
    this.tokenEmbeddings = this.randomMatrix(this.vocabSize, this.embedDim)
    this.positionEmbeddings = this.randomMatrix(this.maxSeqLen, this.embedDim)

    // Transformer layers
    this.layers = Array.from({ length: config.numLayers }, () =>
      new TransformerEncoderLayer(config)
    )

    // Output layer
    this.lmHead = this.randomMatrix(this.embedDim, this.vocabSize)
  }

  randomMatrix(rows, cols) {
    const scale = Math.sqrt(2.0 / (rows + cols))
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => (Math.random() * 2 - 1) * scale)
    )
  }

  /**
   * Forward pass through the model
   * @param {number[]} inputIds - Token IDs [seq_len]
   * @returns {number[][]} Logits [seq_len, vocab_size]
   */
  forward(inputIds) {
    const seqLen = inputIds.length

    // Embed tokens and positions
    let x = inputIds.map((tokenId, pos) => {
      const tokenEmb = this.tokenEmbeddings[tokenId] || Array(this.embedDim).fill(0)
      const posEmb = this.positionEmbeddings[pos] || Array(this.embedDim).fill(0)
      return tokenEmb.map((v, i) => v + posEmb[i])
    })

    // Pass through transformer layers
    for (const layer of this.layers) {
      x = layer.forward(x)
    }

    // Project to vocabulary
    const logits = x.map(seq => this.linear(seq, this.lmHead))
    return logits
  }

  linear(x, W) {
    const rows = W.length
    const result = Array(rows).fill(0)
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < x.length; j++) {
        result[i] += W[i][j] * x[j]
      }
    }
    return result
  }

  /**
   * Get next token probabilities
   * @param {number[]} inputIds - Token IDs
   * @returns {number[]} Probability distribution over vocabulary
   */
  getProbabilities(inputIds) {
    const logits = this.forward(inputIds)
    const lastLogits = logits[logits.length - 1]

    // Softmax
    const maxLogit = Math.max(...lastLogits)
    const expLogits = lastLogits.map(l => Math.exp(l - maxLogit))
    const sumExp = expLogits.reduce((a, b) => a + b, 0)
    return expLogits.map(e => e / sumExp)
  }

  /**
   * Serialize model weights
   * @returns {object} Serialized weights
   */
  serialize() {
    // Convert nested arrays to flat arrays for more efficient serialization
    const flatten = (arr) => arr.flat(Infinity)

    return {
      config: this.config,
      tokenEmbeddings: flatten(this.tokenEmbeddings),
      positionEmbeddings: flatten(this.positionEmbeddings),
      lmHead: flatten(this.lmHead),
      layers: this.layers.map(layer => ({
        attention: {
          Wq: flatten(layer.attention.Wq),
          Wk: flatten(layer.attention.Wk),
          Wv: flatten(layer.attention.Wv),
          Wo: flatten(layer.attention.Wo),
        },
        ff: {
          W1: flatten(layer.ff.W1),
          W2: flatten(layer.ff.W2),
        },
        norm1: {
          gamma: layer.norm1.gamma,
          beta: layer.norm1.beta,
        },
        norm2: {
          gamma: layer.norm2.gamma,
          beta: layer.norm2.beta,
        },
      })),
    }
  }

  /**
   * Deserialize model weights
   * @param {object} data - Serialized weights
   * @returns {JavelinModel} Loaded model
   */
  static deserialize(data) {
    const model = new JavelinModel(data.config)

    // Helper to reshape flat arrays back to matrices
    const reshape = (flat, rows, cols) => {
      const result = []
      for (let i = 0; i < rows; i++) {
        result.push(flat.slice(i * cols, (i + 1) * cols))
      }
      return result
    }

    // Reshape embeddings
    model.tokenEmbeddings = reshape(
      data.tokenEmbeddings,
      model.vocabSize,
      model.embedDim
    )
    model.positionEmbeddings = reshape(
      data.positionEmbeddings,
      model.maxSeqLen,
      model.embedDim
    )
    model.lmHead = reshape(
      data.lmHead,
      model.embedDim,
      model.vocabSize
    )

    // Reshape layer weights
    model.layers = data.layers.map(layerData => {
      const layer = new TransformerEncoderLayer(model.config)

      layer.attention.Wq = reshape(
        layerData.attention.Wq,
        model.embedDim,
        model.embedDim
      )
      layer.attention.Wk = reshape(
        layerData.attention.Wk,
        model.embedDim,
        model.embedDim
      )
      layer.attention.Wv = reshape(
        layerData.attention.Wv,
        model.embedDim,
        model.embedDim
      )
      layer.attention.Wo = reshape(
        layerData.attention.Wo,
        model.embedDim,
        model.embedDim
      )

      layer.ff.W1 = reshape(
        layerData.ff.W1,
        model.embedDim,
        model.config.ffDim
      )
      layer.ff.W2 = reshape(
        layerData.ff.W2,
        model.config.ffDim,
        model.embedDim
      )

      layer.norm1.gamma = layerData.norm1.gamma
      layer.norm1.beta = layerData.norm1.beta
      layer.norm2.gamma = layerData.norm2.gamma
      layer.norm2.beta = layerData.norm2.beta

      return layer
    })

    return model
  }

  /**
   * Save model to file
   * @param {string} path - File path
   */
  async save(path) {
    // Only save in Node.js environment
    if (typeof window === 'undefined') {
      const fs = await import('fs')
      const data = this.serialize()

      try {
        const json = JSON.stringify(data)
        fs.writeFileSync(path, json, 'utf8')
      } catch (error) {
        // If string is too long, save as separate files
        console.warn('Model too large for single JSON, saving as binary...')
        await this.saveBinary(path, data)
      }
    } else {
      console.warn('Cannot save model in browser environment')
    }
  }

  /**
   * Save model as binary-like format
   */
  async saveBinary(path, data) {
    const fs = await import('fs')
    const buffer = Buffer.from(JSON.stringify(data), 'utf8')
    fs.writeFileSync(path.replace('.json', '.bin'), buffer)
  }

  /**
   * Load model from file
   * @param {string} path - File path
   * @returns {JavelinModel} Loaded model
   */
  static async load(path) {
    if (typeof window === 'undefined') {
      // Node.js environment
      const fs = await import('fs')

      // Try JSON first
      try {
        const data = JSON.parse(fs.readFileSync(path, 'utf8'))
        return JavelinModel.deserialize(data)
      } catch {
        // Try binary format
        const binPath = path.replace('.json', '.bin')
        if (fs.existsSync(binPath)) {
          const buffer = fs.readFileSync(binPath)
          const data = JSON.parse(buffer.toString('utf8'))
          return JavelinModel.deserialize(data)
        }
        throw new Error('Could not load model from ' + path)
      }
    } else {
      // Browser environment - fetch the model
      try {
        const response = await fetch(path)
        const data = await response.json()
        return JavelinModel.deserialize(data)
      } catch (error) {
        throw new Error('Could not load model from ' + path + ': ' + error.message)
      }
    }
  }
}
