const path = require('node:path')

const TEXT_EXTENSIONS = new Set([
  '.bat', '.c', '.cc', '.cfg', '.cmd', '.conf', '.cpp', '.cs', '.css', '.env', '.go', '.h', '.hpp',
  '.html', '.ini', '.java', '.js', '.jsx', '.json', '.jsonl', '.lock', '.log', '.lua', '.luau',
  '.md', '.mdx', '.mjs', '.cjs', '.php', '.ps1', '.py', '.rb', '.rs', '.scss', '.sh', '.sql',
  '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.properties', '.rbxlx', '.rbxmx',
])

function supportsTextFile(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return !extension || TEXT_EXTENSIONS.has(extension)
}

module.exports = { supportsTextFile }