import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const targetName = process.argv[2]
if (!['dist', 'public'].includes(targetName)) {
  console.error('Usage: node scripts/prepare-monaco.mjs <dist|public>')
  process.exit(1)
}

const source = join(root, 'node_modules', 'monaco-editor', 'min', 'vs')
const target = join(root, targetName, 'monaco', 'vs')
rmSync(target, { recursive: true, force: true })
mkdirSync(dirname(target), { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`Copied local Monaco runtime to ${target}`)