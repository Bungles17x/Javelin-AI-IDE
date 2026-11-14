import { FileText } from 'lucide-react'

// Brand colours per language, so a glance at the tree tells you what a file is
// without reading its name. Values are the common editor colour-scheme choices.
const TYPES = {
  bat: { label: 'BAT', fg: '#e8eef5', bg: '#4b5563' },
  c: { label: 'C', fg: '#ffffff', bg: '#5c6bc0' },
  cc: { label: 'C++', fg: '#ffffff', bg: '#00599c' },
  cjs: { label: 'JS', fg: '#1b1b10', bg: '#f7df1e' },
  cmd: { label: 'BAT', fg: '#e8eef5', bg: '#4b5563' },
  cpp: { label: 'C++', fg: '#ffffff', bg: '#00599c' },
  cs: { label: 'C#', fg: '#ffffff', bg: '#68217a' },
  css: { label: 'CSS', fg: '#ffffff', bg: '#264de4' },
  cxx: { label: 'C++', fg: '#ffffff', bg: '#00599c' },
  dart: { label: 'DART', fg: '#ffffff', bg: '#0175c2' },
  env: { label: 'ENV', fg: '#e5e7eb', bg: '#4b5563' },
  go: { label: 'GO', fg: '#04222b', bg: '#00add8' },
  h: { label: 'H', fg: '#a8c7f0', bg: '#1f3a5f' },
  hh: { label: 'H++', fg: '#a8c7f0', bg: '#1f3a5f' },
  hpp: { label: 'H++', fg: '#a8c7f0', bg: '#1f3a5f' },
  htm: { label: 'HTML', fg: '#ffffff', bg: '#e34f26' },
  html: { label: 'HTML', fg: '#ffffff', bg: '#e34f26' },
  hxx: { label: 'H++', fg: '#a8c7f0', bg: '#1f3a5f' },
  ipynb: { label: 'IPY', fg: '#ffffff', bg: '#f37626' },
  java: { label: 'J', fg: '#241505', bg: '#f89820' },
  js: { label: 'JS', fg: '#1b1b10', bg: '#f7df1e' },
  json: { label: '{}', fg: '#1b1b10', bg: '#cbcb41' },
  jsonc: { label: '{}', fg: '#1b1b10', bg: '#cbcb41' },
  jsx: { label: 'JSX', fg: '#0d1f26', bg: '#61dafb' },
  kt: { label: 'KT', fg: '#ffffff', bg: '#7f52ff' },
  kts: { label: 'KT', fg: '#ffffff', bg: '#7f52ff' },
  less: { label: 'LESS', fg: '#1a1014', bg: '#cd6799' },
  log: { label: 'TXT', fg: '#d6ddd7', bg: '#3a423c' },
  lua: { label: 'LUA', fg: '#ffffff', bg: '#2c2d72' },
  luau: { label: 'LUA', fg: '#ffffff', bg: '#2c2d72' },
  md: { label: 'MD', fg: '#cfe8f5', bg: '#3b4a52' },
  mdx: { label: 'MD', fg: '#cfe8f5', bg: '#3b4a52' },
  mjs: { label: 'JS', fg: '#1b1b10', bg: '#f7df1e' },
  php: { label: 'PHP', fg: '#ffffff', bg: '#777bb4' },
  ps1: { label: 'PS', fg: '#ffffff', bg: '#012456' },
  psm1: { label: 'PS', fg: '#ffffff', bg: '#012456' },
  py: { label: 'PY', fg: '#ffd43b', bg: '#3776ab' },
  pyi: { label: 'PY', fg: '#ffd43b', bg: '#3776ab' },
  pyw: { label: 'PY', fg: '#ffd43b', bg: '#3776ab' },
  r: { label: 'R', fg: '#ffffff', bg: '#276dc3' },
  rb: { label: 'RB', fg: '#ffffff', bg: '#cc342d' },
  rs: { label: 'RS', fg: '#ffffff', bg: '#b7410e' },
  sass: { label: 'SCSS', fg: '#1a1014', bg: '#cd6799' },
  scss: { label: 'SCSS', fg: '#1a1014', bg: '#cd6799' },
  sh: { label: 'SH', fg: '#0f1a0b', bg: '#4eaa25' },
  sql: { label: 'SQL', fg: '#241505', bg: '#e38c00' },
  svelte: { label: 'SVE', fg: '#ffffff', bg: '#ff3e00' },
  svg: { label: 'SVG', fg: '#241505', bg: '#ffb13b' },
  swift: { label: 'SW', fg: '#ffffff', bg: '#f05138' },
  toml: { label: 'TL', fg: '#ffffff', bg: '#9c4221' },
  ts: { label: 'TS', fg: '#ffffff', bg: '#3178c6' },
  tsx: { label: 'TSX', fg: '#ffffff', bg: '#3178c6' },
  txt: { label: 'TXT', fg: '#d6ddd7', bg: '#3a423c' },
  vue: { label: 'VUE', fg: '#0d1f16', bg: '#41b883' },
  xml: { label: 'XML', fg: '#241505', bg: '#ffb13b' },
  yaml: { label: 'YML', fg: '#ffffff', bg: '#cb171e' },
  yml: { label: 'YML', fg: '#ffffff', bg: '#cb171e' },
  zsh: { label: 'SH', fg: '#0f1a0b', bg: '#4eaa25' },
}

// Exact names win over extensions: `package.json` is more useful as NPM than `{}`.
const NAMES = {
  'package.json': { label: 'NPM', fg: '#ffffff', bg: '#cb3837' },
  'package-lock.json': { label: 'NPM', fg: '#ffffff', bg: '#cb3837' },
  'pnpm-lock.yaml': { label: 'NPM', fg: '#ffffff', bg: '#cb3837' },
  'yarn.lock': { label: 'NPM', fg: '#ffffff', bg: '#cb3837' },
  'tsconfig.json': { label: 'TS', fg: '#ffffff', bg: '#3178c6' },
  'jsconfig.json': { label: 'JS', fg: '#1b1b10', bg: '#f7df1e' },
  '.gitignore': { label: 'GIT', fg: '#ffffff', bg: '#f05032' },
  '.gitattributes': { label: 'GIT', fg: '#ffffff', bg: '#f05032' },
  dockerfile: { label: 'DOCK', fg: '#ffffff', bg: '#2496ed' },
  makefile: { label: 'MK', fg: '#d6ddd7', bg: '#4b5563' },
  license: { label: 'LIC', fg: '#d6ddd7', bg: '#4b5563' },
}

/** The badge description for a path, or null when the type is unknown. */
export function fileTypeFor(nameOrPath) {
  const name = String(nameOrPath || '').split('/').pop().toLowerCase()
  if (!name) return null
  if (NAMES[name]) return NAMES[name]
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return TYPES[name.slice(dot + 1)] || null
}

/**
 * A compact language badge ("JS", "PY", "C++") in the language's brand colour.
 * Unknown types fall back to the generic file glyph so nothing looks broken.
 */
export default function FileTypeIcon({ name, size = 16 }) {
  const type = fileTypeFor(name)
  if (!type) return <FileText size={size} strokeWidth={1.6} />
  // Wider than tall for 3-4 letter labels; a 16px square cannot fit "HTML" legibly.
  const scale = type.label.length >= 4 ? 0.4 : type.label.length === 3 ? 0.45 : 0.5
  const width = type.label.length >= 3 ? size + 5 : size
  return (
    <span
      className="file-type-icon"
      aria-hidden="true"
      style={{
        '--ft-fg': type.fg,
        '--ft-bg': type.bg,
        width,
        height: size,
        fontSize: Math.max(6, Math.round(size * scale * 10) / 10),
      }}
    >
      {type.label}
    </span>
  )
}
