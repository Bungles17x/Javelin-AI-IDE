/**
 * Javelin Tokenizer
 * =================
 *
 * A subword tokenization system for Javelin's model.
 *
 * Implements a BPE-style tokenizer:
 * - Learns subword merges from training data
 * - Encodes text to token IDs
 * - Decodes token IDs back to text
 * - Handles special tokens
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'

export class Tokenizer {
  constructor(vocabSize = 50000) {
    this.vocabSize = vocabSize
    this.vocab = new Map()  // token -> id
    this.inverseVocab = new Map()  // id -> token
    this.merges = []  // List of merge operations
    this.specialTokens = {
      pad: '<pad>',
      unk: '<unk>',
      bos: '<bos>',
      eos: '<eos>',
    }
    this.specialTokenIds = {}

    this._initializeSpecialTokens()
  }

  _initializeSpecialTokens() {
    let id = 0
    for (const [key, token] of Object.entries(this.specialTokens)) {
      this.vocab.set(token, id)
      this.inverseVocab.set(id, token)
      this.specialTokenIds[key] = id
      id++
    }
  }

  /**
   * Train tokenizer on text corpus
   * @param {string[]} corpus - Array of text samples
   * @param {number} vocabSize - Target vocabulary size
   */
  train(corpus, vocabSize = this.vocabSize) {
    console.log('Training tokenizer...')
    console.log(`  Corpus size: ${corpus.length} documents`)

    // Initialize with individual characters
    const wordFreqs = new Map()
    for (const text of corpus) {
      const words = text.split(/\s+/)
      for (const word of words) {
        const chars = word.split('').join(' ')
        wordFreqs.set(chars, (wordFreqs.get(chars) || 0) + 1)
      }
    }

    // Initial vocab (special tokens + characters)
    const chars = new Set()
    for (const word of wordFreqs.keys()) {
      for (const char of word.split(' ')) {
        chars.add(char)
      }
    }

    for (const char of chars) {
      if (!this.vocab.has(char)) {
        const id = this.vocab.size
        this.vocab.set(char, id)
        this.inverseVocab.set(id, char)
      }
    }

    // BPE merge iterations
    let iterations = vocabSize - this.vocab.size
    console.log(`  Merging ${iterations} pairs...`)

    for (let i = 0; i < iterations; i++) {
      // Find most frequent pair
      const pair = this._findBestPair(wordFreqs)
      if (!pair) break

      // Add merge
      this.merges.push(pair)
      const newToken = pair[0] + pair[1]

      // Add to vocab
      if (!this.vocab.has(newToken)) {
        const id = this.vocab.size
        this.vocab.set(newToken, id)
        this.inverseVocab.set(id, newToken)
      }

      // Update word frequencies
      this._applyMerge(wordFreqs, pair, newToken)

      if (i % 1000 === 0) {
        console.log(`  Progress: ${i}/${iterations} merges`)
      }
    }

    console.log(`  Final vocab size: ${this.vocab.size}`)
  }

  _findBestPair(wordFreqs) {
    const pairFreqs = new Map()
    for (const [word, freq] of wordFreqs) {
      const symbols = word.split(' ')
      for (let i = 0; i < symbols.length - 1; i++) {
        const pair = `${symbols[i]} ${symbols[i + 1]}`
        pairFreqs.set(pair, (pairFreqs.get(pair) || 0) + freq)
      }
    }

    let bestPair = null
    let bestFreq = 0
    for (const [pair, freq] of pairFreqs) {
      if (freq > bestFreq) {
        bestFreq = freq
        bestPair = pair.split(' ')
      }
    }

    return bestPair
  }

  _applyMerge(wordFreqs, pair, newToken) {
    const pairStr = pair.join(' ')
    const newWordStr = pair.join('')

    for (const [word, freq] of wordFreqs) {
      const newWord = word.replace(new RegExp(pairStr.replace(/ /g, ' '), 'g'), newWordStr)
      if (newWord !== word) {
        wordFreqs.delete(word)
        wordFreqs.set(newWord, freq)
      }
    }
  }

  /**
   * Encode text to token IDs
   * @param {string} text - Input text
   * @returns {number[]} Token IDs
   */
  encode(text) {
    // Add BOS token
    const tokens = [this.specialTokenIds.bos]

    // Tokenize using learned merges
    const words = text.split(/\s+/)
    for (const word of words) {
      const wordTokens = this._tokenizeWord(word)
      tokens.push(...wordTokens)
    }

    // Add EOS token
    tokens.push(this.specialTokenIds.eos)

    return tokens
  }

  _tokenizeWord(word) {
    // Start with characters
    let symbols = word.split('')

    // Apply merges
    while (symbols.length > 1) {
      let merged = false
      for (const [a, b] of this.merges) {
        const mergeStr = a + b
        for (let i = 0; i < symbols.length - 1; i++) {
          if (symbols[i] === a && symbols[i + 1] === b) {
            symbols.splice(i, 2, mergeStr)
            merged = true
            break
          }
        }
        if (merged) break
      }
      if (!merged) break
    }

    // Convert to IDs
    const ids = []
    for (const symbol of symbols) {
      const id = this.vocab.get(symbol) ?? this.specialTokenIds.unk
      ids.push(id)
    }

    return ids
  }

  /**
   * Decode token IDs to text
   * @param {number[]} ids - Token IDs
   * @returns {string} Decoded text
   */
  decode(ids) {
    const tokens = []
    for (const id of ids) {
      const token = this.inverseVocab.get(id) ?? this.specialTokens.unk
      tokens.push(token)
    }

    // Join and clean up
    let text = tokens.join('')
    // Remove special tokens
    for (const token of Object.values(this.specialTokens)) {
      text = text.replace(new RegExp(token, 'g'), '')
    }

    return text
  }

  /**
   * Get vocabulary size
   */
  getVocabSize() {
    return this.vocab.size
  }

  /**
   * Save tokenizer to file
   * @param {string} path - File path
   */
  save(path) {
    if (typeof window === 'undefined') {
      const data = {
        vocabSize: this.vocabSize,
        vocab: Array.from(this.vocab.entries()),
        merges: this.merges,
        specialTokens: this.specialTokens,
        specialTokenIds: this.specialTokenIds,
      }
      writeFileSync(path, JSON.stringify(data), 'utf8')
    } else {
      console.warn('Cannot save tokenizer in browser environment')
    }
  }

  /**
   * Load tokenizer from file
   * @param {string} path - File path
   * @returns {Tokenizer} Loaded tokenizer
   */
  static load(path) {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const tokenizer = new Tokenizer(data.vocabSize)
    tokenizer.vocab = new Map(data.vocab)
    tokenizer.inverseVocab = new Map(
      Array.from(tokenizer.vocab.entries()).map(([k, v]) => [v, k])
    )
    tokenizer.merges = data.merges
    tokenizer.specialTokens = data.specialTokens
    tokenizer.specialTokenIds = data.specialTokenIds
    return tokenizer
  }
}

/**
 * Create a simple word-level tokenizer for quick start
 */
export class SimpleTokenizer {
  constructor() {
    this.vocab = new Map()
    this.inverseVocab = new Map()
    this.nextId = 0
    this._addSpecialTokens()
  }

  _addSpecialTokens() {
    const specials = ['<pad>', '<unk>', '<bos>', '<eos>']
    for (const token of specials) {
      this.vocab.set(token, this.nextId)
      this.inverseVocab.set(this.nextId, token)
      this.nextId++
    }
  }

  train(corpus) {
    console.log('Training simple word-level tokenizer...')
    const words = new Set()
    for (const text of corpus) {
      const tokens = text.toLowerCase().split(/\s+/)
      for (const token of tokens) {
        if (token) words.add(token)
      }
    }

    for (const word of words) {
      if (!this.vocab.has(word)) {
        this.vocab.set(word, this.nextId)
        this.inverseVocab.set(this.nextId, word)
        this.nextId++
      }
    }

    console.log(`  Vocab size: ${this.vocab.size}`)
  }

  encode(text) {
    const tokens = [this.vocab.get('<bos>')]
    const words = text.toLowerCase().split(/\s+/)
    for (const word of words) {
      const id = this.vocab.get(word) ?? this.vocab.get('<unk>')
      tokens.push(id)
    }
    tokens.push(this.vocab.get('<eos>'))
    return tokens
  }

  decode(ids) {
    const words = []
    for (const id of ids) {
      const word = this.inverseVocab.get(id)
      if (word && !word.startsWith('<')) {
        words.push(word)
      }
    }
    return words.join(' ')
  }

  getVocabSize() {
    return this.vocab.size
  }

  save(path) {
    if (typeof window === 'undefined') {
      const data = {
        vocab: Array.from(this.vocab.entries()),
        nextId: this.nextId,
      }
      writeFileSync(path, JSON.stringify(data), 'utf8')
    } else {
      console.warn('Cannot save tokenizer in browser environment')
    }
  }

  static load(path) {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const tokenizer = new SimpleTokenizer()
    tokenizer.vocab = new Map(data.vocab)
    tokenizer.inverseVocab = new Map(
      Array.from(tokenizer.vocab.entries()).map(([k, v]) => [v, k])
    )
    tokenizer.nextId = data.nextId
    return tokenizer
  }
}
