/**
 * Javelin Inference Engine
 * ========================
 *
 * Handles text generation from the Javelin model.
 *
 * Features:
 * - Autoregressive generation
 * - Sampling strategies (greedy, top-k, top-p)
 * - Temperature control
 * - Streaming output
 * - Tool call detection and formatting
 */

export class InferenceEngine {
  constructor(model, tokenizer, config = {}) {
    this.model = model
    this.tokenizer = tokenizer
    this.config = {
      temperature: config.temperature ?? 0.7,
      topK: config.topK ?? 50,
      topP: config.topP ?? 0.9,
      maxTokens: config.maxTokens ?? 512,
      ...config,
    }
  }

  /**
   * Generate text from a prompt
   */
  async generate({
    prompt,
    maxTokens = this.config.maxTokens,
    temperature = this.config.temperature,
    topK = this.config.topK,
    topP = this.config.topP,
    onToken,
  }) {
    const inputIds = this.tokenizer.encode(prompt)
    let generatedIds = [...inputIds]
    let generatedText = ''
    const toolCalls = []

    for (let i = 0; i < maxTokens; i++) {
      const probs = this.model.getProbabilities(generatedIds)
      const nextTokenId = this.sample(probs, { temperature, topK, topP })
      generatedIds.push(nextTokenId)

      const tokenText = this.tokenizer.decode([nextTokenId])
      generatedText += tokenText

      if (onToken) {
        onToken(tokenText)
      }

      if (nextTokenId === this.tokenizer.specialTokenIds.eos) {
        break
      }
    }

    const cleanText = this.cleanOutput(generatedText)

    return {
      text: cleanText,
      tokens: generatedIds.slice(inputIds.length),
      toolCalls,
    }
  }

  sample(probs, { temperature, topK, topP }) {
    const scaledProbs = probs.map(p => Math.pow(p, 1 / temperature))
    const sum = scaledProbs.reduce((a, b) => a + b, 0)
    const normalized = scaledProbs.map(p => p / sum)

    let filtered = normalized
    if (topK > 0 && topK < normalized.length) {
      const sorted = normalized
        .map((p, i) => ({ p, i }))
        .sort((a, b) => b.p - a.p)
        .slice(0, topK)

      const newProbs = Array(normalized.length).fill(0)
      for (const { p, i } of sorted) {
        newProbs[i] = p
      }
      const newSum = newProbs.reduce((a, b) => a + b, 0)
      filtered = newProbs.map(p => p / newSum)
    }

    if (topP > 0 && topP < 1) {
      const sorted = filtered
        .map((p, i) => ({ p, i }))
        .sort((a, b) => b.p - a.p)

      let cumulative = 0
      const selected = []
      for (const { p, i } of sorted) {
        cumulative += p
        selected.push({ p, i })
        if (cumulative >= topP) break
      }

      const newProbs = Array(filtered.length).fill(0)
      for (const { p, i } of selected) {
        newProbs[i] = p
      }
      const newSum = newProbs.reduce((a, b) => a + b, 0)
      filtered = newProbs.map(p => p / newSum)
    }

    const r = Math.random()
    let cumulative = 0
    for (let i = 0; i < filtered.length; i++) {
      cumulative += filtered[i]
      if (r <= cumulative) {
        return i
      }
    }

    return filtered.indexOf(Math.max(...filtered))
  }

  cleanOutput(text) {
    let clean = text
    const specials = ['<pad>', '<unk>', '<bos>', '<eos>']
    for (const special of specials) {
      clean = clean.replace(new RegExp(special, 'g'), '')
    }
    return clean.trim()
  }

  async *generateStream(options) {
    const inputIds = this.tokenizer.encode(options.prompt)
    let generatedIds = [...inputIds]

    for (let i = 0; i < (options.maxTokens || this.config.maxTokens); i++) {
      const probs = this.model.getProbabilities(generatedIds)
      const nextTokenId = this.sample(probs, {
        temperature: options.temperature || this.config.temperature,
        topK: options.topK || this.config.topK,
        topP: options.topP || this.config.topP,
      })
      generatedIds.push(nextTokenId)

      const tokenText = this.tokenizer.decode([nextTokenId])

      yield {
        token: tokenText,
        text: this.cleanOutput(this.tokenizer.decode(generatedIds.slice(inputIds.length))),
        done: nextTokenId === this.tokenizer.specialTokenIds.eos,
      }

      if (nextTokenId === this.tokenizer.specialTokenIds.eos) {
        break
      }
    }
  }

  async chat({
    messages,
    maxTokens = this.config.maxTokens,
    temperature = this.config.temperature,
    onToken,
  }) {
    const prompt = this.formatMessages(messages)

    return this.generate({
      prompt,
      maxTokens,
      temperature,
      onToken,
    })
  }

  formatMessages(messages) {
    let prompt = ''
    for (const msg of messages) {
      const role = msg.role.toUpperCase()
      const content = msg.content || ''
      prompt += `[${role}]: ${content}\n`
    }
    prompt += '[ASSISTANT]:'
    return prompt
  }
}

export async function createInferenceEngine(modelPath, tokenizerPath, config = {}) {
  const { JavelinModel } = await import('./model.js')
  const { Tokenizer } = await import('./tokenizer.js')

  const model = await JavelinModel.load(modelPath)
  const tokenizer = Tokenizer.load(tokenizerPath)

  return new InferenceEngine(model, tokenizer, config)
}
