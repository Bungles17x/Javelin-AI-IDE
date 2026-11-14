/**
 * Javelin Model Configuration
 * ============================
 *
 * Default hyperparameters for the Javelin model architecture.
 *
 * These can be adjusted based on:
 * - Available hardware (GPU VRAM, RAM)
 * - Training data size
 * - Desired inference speed
 * - Target model quality
 */

export const defaultConfig = {
  // Model architecture
  vocabSize: 50000,           // Vocabulary size
  embedDim: 512,              // Embedding dimension
  numHeads: 8,                // Number of attention heads
  ffDim: 2048,                // Feed-forward dimension
  numLayers: 6,               // Number of transformer layers
  maxSeqLen: 2048,            // Maximum sequence length

  // Training hyperparameters
  learningRate: 0.001,        // Learning rate
  batchSize: 32,              // Batch size
  epochs: 10,                 // Number of training epochs
  warmupSteps: 1000,          // Learning rate warmup steps
  weightDecay: 0.01,          // Weight decay (L2 regularization)
  dropout: 0.1,               // Dropout rate

  // Inference parameters
  temperature: 0.7,          // Sampling temperature
  topK: 50,                   // Top-k sampling
  topP: 0.9,                  // Nucleus sampling threshold
  maxTokens: 512,             // Maximum tokens to generate
}

/**
 * Small model configuration for faster training/inference
 */
export const smallConfig = {
  ...defaultConfig,
  embedDim: 256,
  numHeads: 4,
  ffDim: 1024,
  numLayers: 4,
  maxSeqLen: 1024,
  batchSize: 16,
}

/**
 * Large model configuration for better quality
 */
export const largeConfig = {
  ...defaultConfig,
  embedDim: 768,
  numHeads: 12,
  ffDim: 3072,
  numLayers: 12,
  maxSeqLen: 4096,
  batchSize: 64,
}

/**
 * Get configuration by name
 */
export function getConfig(name = 'default') {
  switch (name) {
    case 'small':
      return smallConfig
    case 'large':
      return largeConfig
    default:
      return defaultConfig
  }
}
