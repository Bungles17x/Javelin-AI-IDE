/**
 * Build a .vsix from the extension folder.
 *
 * vsce exits 0 but writes nothing in this environment, so the package is assembled
 * directly. Two details matter and both are easy to get wrong:
 *
 *  1. OPC/ZIP entries MUST use forward slashes. PowerShell's ZipFile helper writes
 *     backslashes, which VS Code cannot resolve — the extension then installs but
 *     does not load.
 *  2. [Content_Types].xml and extension.vsixmanifest must sit at the archive ROOT,
 *     with the extension's own files under extension/.
 *
 * Usage: node build-vsix.mjs
 */
import { createWriteStream, readdirSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const extDir = join(here, 'vscode-extension')
const outFile = join(extDir, 'javelin-fixed.vsix')

const pkg = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8'))

// ---- Collect the files that belong in the package -------------------------------
// Compiled output plus the metadata the marketplace expects. Sources and tests are
// deliberately excluded — .vscodeignore is honoured by mirroring its intent here.
const include = ['package.json', 'README.md', 'LICENSE', 'icon.png', 'out']

function walk(absDir, base) {
  const entries = []
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name)
    const rel = relative(base, abs).split(sep).join('/')
    if (statSync(abs).isDirectory()) {
      entries.push(...walk(abs, base))
    } else {
      entries.push({ abs, rel })
    }
  }
  return entries
}

const files = []
for (const item of include) {
  const abs = join(extDir, item)
  if (!existsSync(abs)) continue
  if (statSync(abs).isDirectory()) {
    for (const f of walk(abs, extDir)) files.push({ ...f, zipPath: `extension/${f.rel}` })
  } else {
    files.push({ abs, rel: item, zipPath: `extension/${item}` })
  }
}

// ---- The two root manifests ----------------------------------------------------
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="map" ContentType="application/json"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
`

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher || 'javelin'}"/>
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Tags>ai,coding-agent,llm,ollama</Tags>
    <Categories>Machine Learning,Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines?.vscode || '^1.85.0'}"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`

// ---- Minimal ZIP writer (store/deflate), forward slashes only -------------------
const entries = [
  { zipPath: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
  { zipPath: 'extension.vsixmanifest', data: Buffer.from(manifest, 'utf8') },
  ...files.map((f) => ({ zipPath: f.zipPath, data: readFileSync(f.abs) })),
]

const chunks = []
const central = []
let offset = 0

// CRC32 table
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

for (const e of entries) {
  const nameBuf = Buffer.from(e.zipPath, 'utf8') // forward slashes by construction
  const compressed = deflateRawSync(e.data)
  const useDeflate = compressed.length < e.data.length
  const body = useDeflate ? compressed : e.data
  const method = useDeflate ? 8 : 0
  const crc = crc32(e.data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6) // UTF-8 names
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(e.data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)

  chunks.push(local, nameBuf, body)

  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt16LE(20, 4)
  cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(0x0800, 8)
  cd.writeUInt16LE(method, 10)
  cd.writeUInt16LE(0, 12)
  cd.writeUInt16LE(0, 14)
  cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(body.length, 20)
  cd.writeUInt32LE(e.data.length, 24)
  cd.writeUInt16LE(nameBuf.length, 28)
  cd.writeUInt16LE(0, 30)
  cd.writeUInt16LE(0, 32)
  cd.writeUInt16LE(0, 34)
  cd.writeUInt16LE(0, 36)
  cd.writeUInt32LE(0, 38)
  cd.writeUInt32LE(offset, 42)
  central.push(cd, nameBuf)

  offset += local.length + nameBuf.length + body.length
}

const centralBuf = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(0, 4)
end.writeUInt16LE(0, 6)
end.writeUInt16LE(entries.length, 8)
end.writeUInt16LE(entries.length, 10)
end.writeUInt32LE(centralBuf.length, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

const fs = await import('node:fs')
fs.writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]))

console.log('wrote', outFile)
console.log('entries:', entries.length)
console.log('has core/tools.js:', entries.some((e) => e.zipPath === 'extension/out/core/tools.js'))
console.log('all paths forward-slash:', entries.every((e) => !e.zipPath.includes('\\')))