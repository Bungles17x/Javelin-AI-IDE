/**
 * Javelin Model Training Script
 * =============================
 *
 * Command-line script to train a Javelin model from scratch or fine-tune
 * an existing model.
 *
 * Usage:
 *   node local-model/train.js --train data/dataset.jsonl --model models/javelin-base
 *   node local-model/train.js --finetune models/javelin-base --data data/dataset.jsonl
 */

import { JavelinModel } from './model.js'
import { SimpleTokenizer } from './tokenizer.js'
import { TrainingPipeline } from './training.js'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function parseArgs() {
  const args = process.argv.slice(2)
  const options = {
    action: null,
    dataset: null,
    model: null,
    output: 'models/javelin-trained',
    epochs: 10,
    batchSize: 16,
    learningRate: 0.001,
    config: 'default',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--train' || arg === '--finetune') {
      options.action = arg.replace('--', '')
    } else if (arg === '--dataset') {
      options.dataset = args[++i]
    } else if (arg === '--model') {
      options.model = args[++i]
    } else if (arg === '--output') {
      options.output = args[++i]
    } else if (arg === '--epochs') {
      options.epochs = parseInt(args[++i])
    } else if (arg === '--batch-size') {
      options.batchSize = parseInt(args[++i])
    } else if (arg === '--learning-rate') {
      options.learningRate = parseFloat(args[++i])
    } else if (arg === '--config') {
      options.config = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return options
}

function printHelp() {
  console.log(`
Javelin Model Training

  Train a new model:
    node local-model/train.js --train --dataset data.jsonl --output models/javelin

  Fine-tune existing model:
    node local-model/train.js --finetune --model models/javelin --dataset data.jsonl

  Options:
    --dataset <path>      Training dataset (JSONL format)
    --model <path>        Base model for fine-tuning
    --output <path>       Output model path (default: models/javelin-trained)
    --epochs <n>          Number of training epochs (default: 10)
    --batch-size <n>      Batch size (default: 16)
    --learning-rate <n>   Learning rate (default: 0.001)
    --config <name>       Model config: small, default, large (default: default)

  Note: This is a CPU-based implementation. For production training with GPU,
  use the Python training infrastructure in training/finetune/
`)
}

async function main() {
  const options = parseArgs()

  if (!options.action) {
    console.error('Error: Specify --train or --finetune')
    printHelp()
    process.exit(1)
  }

  if (!options.dataset) {
    console.error('Error: --dataset is required')
    printHelp()
    process.exit(1)
  }

  if (!existsSync(options.dataset)) {
    console.error(`Error: Dataset not found: ${options.dataset}`)
    process.exit(1)
  }

  console.log('\n=== Javelin Model Training ===\n')

  // Create models directory
  mkdirSync('models', { recursive: true })

  let model
  let tokenizer

  if (options.action === 'train') {
    console.log('Creating new model...')
    const { getConfig } = await import('./config.js')
    const config = getConfig(options.config)

    // Use smaller config for CPU training
    if (options.config === 'default') {
      console.log('Using tiny configuration for CPU training...')
      config.vocabSize = 1000
      config.embedDim = 64
      config.numHeads = 2
      config.ffDim = 256
      config.numLayers = 1
      config.maxSeqLen = 256
    }

    model = new JavelinModel(config)
    tokenizer = new SimpleTokenizer()

    // Train tokenizer on dataset
    console.log('Training tokenizer...')
    const corpus = loadCorpus(options.dataset)
    tokenizer.train(corpus)

    // Save tokenizer
    tokenizer.save('models/tokenizer.json')
    console.log('Tokenizer saved to models/tokenizer.json')

  } else if (options.action === 'finetune') {
    if (!options.model) {
      console.error('Error: --model is required for fine-tuning')
      process.exit(1)
    }

    if (!existsSync(options.model)) {
      console.error(`Error: Model not found: ${options.model}`)
      process.exit(1)
    }

    console.log('Loading model for fine-tuning...')
    model = await JavelinModel.load(options.model)
    tokenizer = SimpleTokenizer.load('models/tokenizer.json')
  }

  // Create training pipeline
  const { getConfig } = await import('./config.js')
  const config = {
    ...getConfig(options.config),
    epochs: options.epochs,
    batchSize: options.batchSize,
    learningRate: options.learningRate,
  }

  const pipeline = new TrainingPipeline({
    model,
    tokenizer,
    config,
  })

  // Train
  await pipeline.train(options.dataset, {
    epochs: options.epochs,
    batchSize: options.batchSize,
    learningRate: options.learningRate,
  })

  // Save final model
  console.log('\nSaving final model...')
  await model.save(options.output)
  console.log(`Model saved to ${options.output}`)

  console.log('\n=== Training Complete ===')
  console.log('\nTo use this model with Javelin Core:')
  console.log('  1. Update src/lib/providers.js to use the local model')
  console.log('  2. Start Javelin: npm run dev')
  console.log('  3. Select "Javelin (local)" in settings')
}

function loadCorpus(datasetPath) {
  const text = readFileSync(datasetPath, 'utf8')
  const lines = text.split('\n').filter(line => line.trim())

  const corpus = []
  for (const line of lines) {
    try {
      const example = JSON.parse(line)
      const content = example.prompt + ' ' + (example.completion || example.response || '')
      corpus.push(content)
    } catch {
      // Skip invalid lines
    }
  }

  return corpus
}

main().catch(error => {
  console.error('Training failed:', error)
  process.exit(1)
})
