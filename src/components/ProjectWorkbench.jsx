import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronsDownUp, ChevronsUpDown, Columns2, Copy, Eye, EyeOff, FilePlus2, Files, FolderOpen, FolderPlus, GitBranch, Minus, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RotateCcw, Save, Search, Settings, Sparkles, Square, Terminal, Trash2, WrapText, X } from 'lucide-react'
import FileTypeIcon from './FileTypeIcon.jsx'
import { Markdown } from './Markdown.jsx'

const EXPLORER_MIN_WIDTH = 180
const EXPLORER_MAX_WIDTH = 360
const EXPLORER_DEFAULT_WIDTH = 220
const EDITOR_FONT_MIN = 10
const EDITOR_FONT_MAX = 22
const EDITOR_FONT_DEFAULT = 13

const MonacoEditor = lazy(async () => {
  const module = await import('@monaco-editor/react')
  module.loader.config({ paths: { vs: `${import.meta.env.BASE_URL}monaco/vs` } })
  return { default: module.default }
})

const LANGUAGE_BY_EXTENSION = {
  bash: 'shell', bat: 'bat', c: 'cpp', cc: 'cpp', cfg: 'ini', cjs: 'javascript', cmd: 'bat',
  conf: 'ini', cpp: 'cpp', cs: 'csharp', cxx: 'cpp', dart: 'dart', diff: 'diff', env: 'ini',
  go: 'go', gql: 'graphql', graphql: 'graphql', h: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp',
  ini: 'ini', java: 'java', js: 'javascript', json: 'json', jsonc: 'json', jsx: 'javascript',
  kt: 'kotlin', kts: 'kotlin', less: 'less', lua: 'lua', luau: 'lua', md: 'markdown', mdx: 'markdown',
  mjs: 'javascript', php: 'php', proto: 'protobuf', ps1: 'powershell', py: 'python', pyw: 'python',
  r: 'r', rb: 'ruby', rs: 'rust', scala: 'scala', scss: 'scss', sh: 'shell', sol: 'solidity',
  sql: 'sql', svelte: 'html', swift: 'swift', toml: 'ini', ts: 'typescript', tsx: 'typescript',
  txt: 'plaintext', vb: 'vb', vue: 'html', xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'shell',
}

/** Javelin's editor palette: same greens as the IDE chrome, tuned for code contrast. */
const JAVELIN_EDITOR_THEME = {
  base: 'vs-dark',
  inherit: true,
  semanticHighlighting: true,
  rules: [
    { token: 'comment', foreground: '71806f', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c6e07a' },
    { token: 'keyword.control', foreground: 'c6e07a' },
    { token: 'string', foreground: 'a7d18d' },
    { token: 'string.escape', foreground: 'e0b97a' },
    { token: 'number', foreground: 'e0b97a' },
    { token: 'regexp', foreground: 'd7a3e0' },
    { token: 'type', foreground: '8fd0c0' },
    { token: 'type.identifier', foreground: '8fd0c0' },
    { token: 'constant', foreground: 'e0b97a' },
    { token: 'variable', foreground: 'e3ebe4' },
    { token: 'variable.predefined', foreground: '8fd0c0' },
    { token: 'function', foreground: 'cddba6' },
    { token: 'tag', foreground: 'c6e07a' },
    { token: 'attribute.name', foreground: '8fd0c0' },
    { token: 'attribute.value', foreground: 'a7d18d' },
    { token: 'delimiter', foreground: '9aa79b' },
    { token: 'operator', foreground: 'cbd6cc' },
    { token: 'key', foreground: '8fd0c0' },
  ],
  colors: {
    'editor.background': '#111412',
    'editor.foreground': '#dfe7e0',
    'editorLineNumber.foreground': '#4b574d',
    'editorLineNumber.activeForeground': '#b9c7bb',
    'editorCursor.foreground': '#d3ef74',
    'editor.selectionBackground': '#2f4028',
    'editor.inactiveSelectionBackground': '#26301f',
    'editor.lineHighlightBackground': '#161c17',
    'editorIndentGuide.background1': '#232b25',
    'editorIndentGuide.activeBackground1': '#3b4a3d',
    'editorBracketHighlight.foreground1': '#d3ef74',
    'editorBracketHighlight.foreground2': '#8fd0c0',
    'editorBracketHighlight.foreground3': '#e0b97a',
    'editorBracketPairGuide.activeBackground1': '#3b4a3d',
    'editorSuggestWidget.background': '#171d18',
    'editorSuggestWidget.border': '#2c352d',
    'editorSuggestWidget.selectedBackground': '#2b3727',
    'editorSuggestWidget.highlightForeground': '#d3ef74',
    'editorWidget.background': '#171d18',
    'editorWidget.border': '#2c352d',
    'editorHoverWidget.background': '#171d18',
    'editorHoverWidget.border': '#2c352d',
    'editorGutter.background': '#111412',
    'editorStickyScroll.background': '#131814',
    'editorStickyScrollHover.background': '#1b221c',
    'editorError.foreground': '#e07a7a',
    'editorWarning.foreground': '#e0b97a',
    'scrollbarSlider.background': '#2d382f80',
    'scrollbarSlider.hoverBackground': '#3b4a3d',
    'scrollbarSlider.activeBackground': '#4a5a4c',
  },
}

function defineJavelinTheme(monaco) {
  monaco.editor.defineTheme('javelin-dark', JAVELIN_EDITOR_THEME)
}

function makeTree(files, directories = []) {
  const root = { name: '', path: '', directories: new Map(), files: [] }
  for (const directoryPath of directories) {
    let node = root
    let currentPath = ''
    for (const part of directoryPath.split('/')) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      if (!node.directories.has(part)) {
        node.directories.set(part, { name: part, path: currentPath, directories: new Map(), files: [] })
      }
      node = node.directories.get(part)
    }
  }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      const currentPath = node.path ? `${node.path}/${part}` : part
      if (!node.directories.has(part)) {
        node.directories.set(part, { name: part, path: currentPath, directories: new Map(), files: [] })
      }
      node = node.directories.get(part)
    }
    node.files.push({ ...file, name: parts[parts.length - 1] })
  }
  return root
}

function duplicatePathFor(filePath, isTaken) {
  const slash = filePath.lastIndexOf('/')
  const directory = slash >= 0 ? filePath.slice(0, slash + 1) : ''
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  let attempt = 1
  let candidate = `${directory}${stem} copy${extension}`
  while (isTaken(candidate)) {
    attempt += 1
    candidate = `${directory}${stem} copy ${attempt}${extension}`
  }
  return candidate
}

function IconButton({ title, disabled, onClick, children }) {
  return (
    <button className="workbench-icon-button" type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

function TreeBranch({ node, depth, expanded, onToggle, onSelect, onDelete, onContextMenu, activeFile }) {
  const directories = [...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name))
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <>
      {directories.map((directory) => {
        const isOpen = expanded.has(directory.path)
        return (
          <div key={directory.path}>
            <button
              className="project-tree-row project-tree-folder"
              type="button"
              style={{ '--tree-depth': depth }}
              onClick={() => onToggle(directory.path)}
              aria-expanded={isOpen}
            >
              <span className="tree-chevron">{isOpen ? '⌄' : '›'}</span>
              <span>{directory.name}</span>
            </button>
            {isOpen && (
              <TreeBranch node={directory} depth={depth + 1} expanded={expanded} onToggle={onToggle} onSelect={onSelect} onDelete={onDelete} onContextMenu={onContextMenu} activeFile={activeFile} />
            )}
          </div>
        )
      })}
      {files.map((file) => (
        <div key={file.path} className="project-tree-item">
          <button
            className={`project-tree-row project-tree-file ${activeFile === file.path ? 'is-active' : ''}`}
            type="button"
            style={{ '--tree-depth': depth }}
            onClick={() => onSelect(file.path)}
            onContextMenu={(event) => {
              event.preventDefault()
              onContextMenu(event, file.path)
            }}
            title={`${file.path} — right-click for file actions`}
          >
            <FileTypeIcon name={file.name} />
            <span>{file.name}</span>
          </button>
          <button
            className="tree-delete-button"
            type="button"
            title={`Delete ${file.path}`}
            aria-label={`Delete ${file.path}`}
            onClick={(event) => {
              event.stopPropagation()
              void onDelete(file.path)
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </>
  )
}

export function ProjectWorkbench({ project, projectFiles = [], projectDirectories = [], contents = {}, commandOutput = [], model, runtimeStatus, runtimeBusy, runtimeError, onOpenProject, onCreateWorkspace, onSaveFile, onRenameFile, onDeleteFile, onCreateFolder, onRunCommand, onStartOllama, onRefreshRuntime }) {
  const [activeFile, setActiveFile] = useState('')
  const [openFiles, setOpenFiles] = useState([])
  const [fileDrafts, setFileDrafts] = useState({})
  const [savedContents, setSavedContents] = useState({})
  const draft = fileDrafts[activeFile] ?? ''
  const savedContent = savedContents[activeFile] ?? ''
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleInput, setConsoleInput] = useState('')
  const [consoleBusy, setConsoleBusy] = useState(false)
  const [consoleLines, setConsoleLines] = useState([])
  const [createType, setCreateType] = useState('')
  const [createPath, setCreatePath] = useState('')
  const [error, setError] = useState('')
  const [activityView, setActivityView] = useState('explorer')
  const [explorerWidth, setExplorerWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('javelin.explorerWidth'))
      return Number.isFinite(stored) ? Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, stored)) : EXPLORER_DEFAULT_WIDTH
    } catch {
      return EXPLORER_DEFAULT_WIDTH
    }
  })
  const [explorerCollapsed, setExplorerCollapsed] = useState(() => {
    try { return localStorage.getItem('javelin.explorerCollapsed') === 'true' } catch { return false }
  })
  const [wordWrap, setWordWrap] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [secondaryFile, setSecondaryFile] = useState('')
  const [previewMarkdown, setPreviewMarkdown] = useState(false)
  const [fontSize, setFontSize] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('javelin.editorFontSize'))
      return Number.isFinite(stored)
        ? Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, stored))
        : EDITOR_FONT_DEFAULT
    } catch {
      return EDITOR_FONT_DEFAULT
    }
  })
  const [gitStatus, setGitStatus] = useState(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [recentFiles, setRecentFiles] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('javelin.recentFiles') || '[]')
      return Array.isArray(stored) ? stored.filter((path) => typeof path === 'string').slice(0, 8) : []
    } catch {
      return []
    }
  })
  const [contextMenu, setContextMenu] = useState(null)
  const [matchCase, setMatchCase] = useState(false)
  const [searchingContents, setSearchingContents] = useState(false)
  const [searchResults, setSearchResults] = useState([])
  const [commandHistory, setCommandHistory] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('javelin.commandHistory') || '[]')
      return Array.isArray(stored) ? stored.filter((entry) => typeof entry === 'string').slice(0, 40) : []
    } catch {
      return []
    }
  })
  const [historyIndex, setHistoryIndex] = useState(-1)
  const searchInputRef = useRef(null)
  const paletteInputRef = useRef(null)
  const editorRef = useRef(null)
  const secondaryEditorRef = useRef(null)
  const pendingRevealRef = useRef(null)
  const contextMenuRef = useRef(null)
  const consoleAbortRef = useRef(null)
  const historyDraftRef = useRef('')

  const filteredFiles = useMemo(() => {
    const query = search.trim().toLowerCase()
    return projectFiles.filter((file) => !query || file.path.toLowerCase().includes(query))
  }, [projectFiles, search])
  const tree = useMemo(() => makeTree(filteredFiles, projectDirectories), [filteredFiles, projectDirectories])
  const dirty = Boolean(activeFile) && draft !== savedContent
  const extension = activeFile.split('.').pop()?.toLowerCase()
  const language = LANGUAGE_BY_EXTENSION[extension] || 'plaintext'
  const secondaryExtension = secondaryFile.split('.').pop()?.toLowerCase()
  const secondaryLanguage = LANGUAGE_BY_EXTENSION[secondaryExtension] || 'plaintext'
  const secondaryDraft = fileDrafts[secondaryFile] ?? ''
  const secondarySaved = savedContents[secondaryFile] ?? ''
  const secondaryDirty = Boolean(secondaryFile) && secondaryDraft !== secondarySaved
  const splitOpen = Boolean(secondaryFile)
  const markdownActive = extension === 'md' || extension === 'mdx'
  const allDirectories = useMemo(() => [...new Set(projectDirectories)].sort(), [projectDirectories])

  function rememberRecent(path) {
    setRecentFiles((previous) => [path, ...previous.filter((entry) => entry !== path)].slice(0, 8))
  }

  function revealAt(line, column = 1) {
    const editor = editorRef.current
    if (!editor) {
      pendingRevealRef.current = { line, column }
      return
    }
    const model = editor.getModel()
    if (!model) return
    const targetLine = Math.max(1, Math.min(line, model.getLineCount()))
    const targetColumn = Math.max(1, Math.min(column, model.getLineMaxColumn(targetLine)))
    editor.setPosition({ lineNumber: targetLine, column: targetColumn })
    editor.revealLineInCenter(targetLine)
    editor.focus()
  }

  useEffect(() => {
    if (commandOutput.length) setConsoleOpen(true)
  }, [commandOutput.length])

  useEffect(() => {
    setCursor({ line: 1, column: 1 })
    const reveal = pendingRevealRef.current
    if (!reveal) return
    const timer = setTimeout(() => {
      pendingRevealRef.current = null
      revealAt(reveal.line, reveal.column)
    }, 70)
    return () => clearTimeout(timer)
  }, [activeFile])

  useEffect(() => {
    try { localStorage.setItem('javelin.recentFiles', JSON.stringify(recentFiles)) } catch { /* storage can be unavailable */ }
  }, [recentFiles])

  useEffect(() => {
    try { localStorage.setItem('javelin.explorerWidth', String(explorerWidth)) } catch { /* storage can be unavailable */ }
  }, [explorerWidth])

  useEffect(() => {
    try { localStorage.setItem('javelin.explorerCollapsed', String(explorerCollapsed)) } catch { /* storage can be unavailable */ }
  }, [explorerCollapsed])

  useEffect(() => {
    try { localStorage.setItem('javelin.editorFontSize', String(fontSize)) } catch { /* storage can be unavailable */ }
  }, [fontSize])

  useEffect(() => {
    try { localStorage.setItem('javelin.commandHistory', JSON.stringify(commandHistory)) } catch { /* storage can be unavailable */ }
  }, [commandHistory])

  useEffect(() => {
    setPreviewMarkdown(false)
  }, [activeFile])

  useEffect(() => {
    const handleExplorerShortcuts = (event) => {
      const command = event.ctrlKey || event.metaKey
      if (!command || event.altKey) return
      if (event.key.toLowerCase() === 'b' && !event.shiftKey) {
        event.preventDefault()
        setExplorerCollapsed((collapsed) => !collapsed)
        return
      }
      if (event.key.toLowerCase() === 'e' && event.shiftKey) {
        event.preventDefault()
        setExplorerCollapsed(false)
        setActivityView('explorer')
        setTimeout(() => searchInputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', handleExplorerShortcuts)
    return () => window.removeEventListener('keydown', handleExplorerShortcuts)
  }, [])

  // Show the top level of a newly opened project instead of a wall of closed folders.
  useEffect(() => {
    if (!project) return
    setExpanded((previous) => previous.size ? previous : new Set(allDirectories.filter((path) => !path.includes('/'))))
  }, [project?.root, allDirectories])

  // Search file contents, not just names. Debounced so typing stays responsive on
  // a large project, and capped so a common word cannot flood the panel.
  useEffect(() => {
    if (activityView !== 'search' || !search.trim()) {
      setSearchResults([])
      setSearchingContents(false)
      return undefined
    }
    setSearchingContents(true)
    const timer = setTimeout(() => {
      const needle = matchCase ? search : search.toLowerCase()
      const results = []
      for (const [path, content] of Object.entries(contents)) {
        if (typeof content !== 'string') continue
        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          const column = (matchCase ? line : line.toLowerCase()).indexOf(needle)
          if (column === -1) continue
          results.push({ path, line: index + 1, column: column + 1, text: line.trim().slice(0, 180) })
          if (results.length >= 200) break
        }
        if (results.length >= 200) break
      }
      setSearchResults(results)
      setSearchingContents(false)
    }, 140)
    return () => clearTimeout(timer)
  }, [activityView, search, matchCase, contents])

  useEffect(() => {
    if (!contextMenu) return undefined
    const close = (event) => {
      if (contextMenuRef.current?.contains(event.target)) return
      setContextMenu(null)
    }
    const closeOnBlur = () => setContextMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', closeOnBlur)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', closeOnBlur)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!activeFile || dirty || typeof contents[activeFile] !== 'string') return
    const next = contents[activeFile]
    setFileDrafts((previous) => ({ ...previous, [activeFile]: next }))
    setSavedContents((previous) => ({ ...previous, [activeFile]: next }))
  }, [activeFile, contents, dirty])

  useEffect(() => {
    const handleSaveShortcut = (event) => {
      const command = event.ctrlKey || event.metaKey
      if (command && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (activityView !== 'search') setSearch('')
        setActivityView('search')
        setTimeout(() => searchInputRef.current?.focus(), 0)
        return
      }
      if (command && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setPaletteQuery('>')
        setPaletteOpen(true)
        return
      }
      if (command && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setPaletteQuery('')
        setPaletteOpen(true)
        return
      }
      if (command && !event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openProject()
        return
      }
      if (command && event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveAll()
        return
      }
      if (command && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveFile()
        return
      }
      if (command && event.key.toLowerCase() === 'w' && activeFile) {
        event.preventDefault()
        closeFile(activeFile)
        return
      }
      if (command && event.key === 'Tab' && openFiles.length > 1) {
        event.preventDefault()
        const index = Math.max(0, openFiles.indexOf(activeFile))
        const step = event.shiftKey ? -1 : 1
        activateFile(openFiles[(index + step + openFiles.length) % openFiles.length])
        return
      }
      if (command && event.key === '\\') {
        event.preventDefault()
        if (secondaryFile) closeSplit()
        else void openInSplit()
        return
      }
      const editingField = event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')
      if (event.key === 'F2' && activeFile && !editingField) {
        event.preventDefault()
        void renameFileAt(activeFile)
        return
      }
      if (event.key === 'Escape') {
        setContextMenu(null)
        if (paletteOpen) setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', handleSaveShortcut)
    return () => window.removeEventListener('keydown', handleSaveShortcut)
  }, [paletteOpen, activeFile, openFiles, fileDrafts, savedContents, draft, dirty, busy, activityView, secondaryFile, project])

  useEffect(() => {
    if (paletteOpen) paletteInputRef.current?.focus()
  }, [paletteOpen])

  useEffect(() => {
    setPaletteIndex(0)
  }, [paletteQuery, paletteOpen])

  /** Keep one shared file activation path so tabs, the explorer and splits all
   *  swap rather than opening the same file in both panes. */
  function activateFile(path) {
    if (!path || path === activeFile) return
    if (secondaryFile === path) setSecondaryFile(activeFile || '')
    setActiveFile(path)
    rememberRecent(path)
  }

  const savePath = async (path) => {
    if (!path || busy) return
    const content = fileDrafts[path] ?? contents[path] ?? ''
    if (content === (savedContents[path] ?? '')) return
    setBusy(true)
    setError('')
    try {
      await onSaveFile(path, content)
      setSavedContents((previous) => ({ ...previous, [path]: content }))
    } catch (saveError) {
      setError(saveError.message || String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const saveFile = async () => savePath(activeFile)

  const selectFile = async (relativePath) => {
    if (relativePath === activeFile) return true
    setError('')
    if (openFiles.includes(relativePath)) {
      activateFile(relativePath)
      return true
    }
    if (typeof contents[relativePath] === 'string') {
      setOpenFiles((previous) => [...previous, relativePath])
      setFileDrafts((previous) => ({ ...previous, [relativePath]: contents[relativePath] }))
      setSavedContents((previous) => ({ ...previous, [relativePath]: contents[relativePath] }))
      activateFile(relativePath)
      return true
    }
    setBusy(true)
    try {
      const content = await window.javelinDesktop.readFile(relativePath)
      setOpenFiles((previous) => previous.includes(relativePath) ? previous : [...previous, relativePath])
      setFileDrafts((previous) => ({ ...previous, [relativePath]: content }))
      setSavedContents((previous) => ({ ...previous, [relativePath]: content }))
      activateFile(relativePath)
      return true
    } catch (readError) {
      pendingRevealRef.current = null
      setError(readError.message || String(readError))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** Open a second editor pane without disturbing the file in the primary pane. */
  async function openInSplit(targetPath) {
    if (!project) {
      setError('Open a project folder first.')
      return
    }
    if (!activeFile) {
      if (targetPath) await selectFile(targetPath)
      else setError('Open a file first, then open another one to the side.')
      return
    }
    let target = targetPath || activeFile
    if (target === activeFile) {
      target = openFiles.find((path) => path !== activeFile)
        ?? Object.keys(contents).find((path) => path !== activeFile)
      if (!target) {
        setError('Open a second file before splitting the editor.')
        return
      }
    }
    if (secondaryDirty && secondaryFile && target !== secondaryFile &&
      !window.confirm(`Discard unsaved changes in ${secondaryFile} and replace the split pane?`)) return
    const primary = activeFile
    const loaded = await selectFile(target)
    if (!loaded) return
    setActiveFile(primary)
    setSecondaryFile(target)
    rememberRecent(target)
    setTimeout(() => secondaryEditorRef.current?.focus?.(), 80)
  }

  function closeSplit() {
    if (secondaryDirty && !window.confirm(`Discard unsaved changes in ${secondaryFile}?`)) return
    setSecondaryFile('')
    requestAnimationFrame(() => editorRef.current?.focus?.())
  }

  const openFileAt = async (relativePath, line = 1, column = 1) => {
    pendingRevealRef.current = { line, column }
    if (relativePath === activeFile) {
      pendingRevealRef.current = null
      revealAt(line, column)
      return
    }
    await selectFile(relativePath)
  }

  const saveAll = async () => {
    if (busy) return
    const changed = openFiles.filter((path) => (fileDrafts[path] ?? '') !== (savedContents[path] ?? ''))
    if (!changed.length) return
    setBusy(true)
    setError('')
    try {
      for (const path of changed) await onSaveFile(path, fileDrafts[path] ?? '')
      setSavedContents((previous) => {
        const next = { ...previous }
        for (const path of changed) next[path] = fileDrafts[path] ?? ''
        return next
      })
    } catch (saveError) {
      setError(saveError.message || String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const closeAll = () => {
    const changed = openFiles.filter((path) => (fileDrafts[path] ?? '') !== (savedContents[path] ?? ''))
    if (changed.length && !window.confirm(`Close ${openFiles.length} file(s) and discard unsaved changes in ${changed.length}?`)) return
    setOpenFiles([])
    setActiveFile('')
    setSecondaryFile('')
    setPreviewMarkdown(false)
    setFileDrafts({})
    setSavedContents({})
  }

  const closeFile = (path) => {
    const isDirty = (fileDrafts[path] ?? '') !== (savedContents[path] ?? '')
    if (isDirty && !window.confirm(`Discard unsaved changes to ${path}?`)) return
    const index = openFiles.indexOf(path)
    const nextFiles = openFiles.filter((file) => file !== path)
    setOpenFiles(nextFiles)
    if (activeFile === path) setActiveFile(nextFiles[Math.min(index, nextFiles.length - 1)] ?? '')
    if (secondaryFile === path || activeFile === path) setSecondaryFile('')
    setFileDrafts((previous) => {
      const next = { ...previous }
      delete next[path]
      return next
    })
    setSavedContents((previous) => {
      const next = { ...previous }
      delete next[path]
      return next
    })
  }

  const renameFileAt = async (targetPath = activeFile) => {
    if (!targetPath || busy) return
    const newPath = window.prompt(`Rename or move ${targetPath} within the project`, targetPath)
    if (newPath == null) return
    const normalizedPath = newPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!normalizedPath || normalizedPath.split('/').some((part) => !part || part === '.' || part === '..')) {
      setError('Enter a project-relative name without . or .. path segments.')
      return
    }
    if (normalizedPath === targetPath) return
    if (projectFiles.some((file) => file.path === normalizedPath) || projectDirectories.includes(normalizedPath)) {
      setError(`A project entry already exists at ${normalizedPath}.`)
      return
    }

    setBusy(true)
    setError('')
    try {
      await onRenameFile(targetPath, normalizedPath)
      setOpenFiles((previous) => previous.map((path) => path === targetPath ? normalizedPath : path))
      setFileDrafts((previous) => {
        const next = { ...previous, [normalizedPath]: previous[targetPath] ?? '' }
        delete next[targetPath]
        return next
      })
      setSavedContents((previous) => {
        const next = { ...previous, [normalizedPath]: previous[targetPath] ?? '' }
        delete next[targetPath]
        return next
      })
      setActiveFile((current) => current === targetPath ? normalizedPath : current)
      setSecondaryFile((current) => current === targetPath ? normalizedPath : current)
      rememberRecent(normalizedPath)
    } catch (renameError) {
      setError(renameError.message || String(renameError))
    } finally {
      setBusy(false)
    }
  }

  const renameActiveFile = () => renameFileAt(activeFile)

  const duplicateFile = async (targetPath) => {
    if (!targetPath || busy) return
    const isTaken = (candidate) => projectFiles.some((file) => file.path === candidate) || allDirectories.includes(candidate)
    const newPath = duplicatePathFor(targetPath, isTaken)
    setBusy(true)
    setError('')
    try {
      const content = fileDrafts[targetPath] ?? contents[targetPath] ?? await window.javelinDesktop.readFile(targetPath)
      await onSaveFile(newPath, content)
      setOpenFiles((previous) => [...previous, newPath])
      setFileDrafts((previous) => ({ ...previous, [newPath]: content }))
      setSavedContents((previous) => ({ ...previous, [newPath]: content }))
      setActiveFile(newPath)
      rememberRecent(newPath)
    } catch (duplicateError) {
      setError(duplicateError.message || String(duplicateError))
    } finally {
      setBusy(false)
    }
  }

  const copyFilePath = async (targetPath) => {
    try {
      await navigator.clipboard.writeText(targetPath)
    } catch {
      setError('The clipboard is unavailable in this window.')
    }
  }

  const openContextMenu = (event, targetPath) => {
    setContextMenu({
      path: targetPath,
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 210),
    })
  }

  /** Delete any file in the project: from the explorer row, the context menu, or the toolbar. */
  const deleteFile = async (targetPath) => {
    if (!targetPath || busy) return
    const path = targetPath
    const hasUnsavedChanges = (fileDrafts[path] ?? '') !== (savedContents[path] ?? '')
    const confirmation = `Permanently delete ${path}${hasUnsavedChanges ? ' and discard its unsaved changes' : ''}?`
    if (!window.confirm(confirmation)) return
    const index = openFiles.indexOf(path)
    const nextFiles = openFiles.filter((file) => file !== path)
    setBusy(true)
    setError('')
    try {
      await onDeleteFile(path)
      setOpenFiles(nextFiles)
      if (activeFile === path) setActiveFile(nextFiles[Math.min(index, nextFiles.length - 1)] ?? '')
      if (secondaryFile === path || activeFile === path) setSecondaryFile('')
      setFileDrafts((previous) => {
        const next = { ...previous }
        delete next[path]
        return next
      })
      setSavedContents((previous) => {
        const next = { ...previous }
        delete next[path]
        return next
      })
    } catch (deleteError) {
      setError(deleteError.message || String(deleteError))
    } finally {
      setBusy(false)
    }
  }

  const deleteActiveFile = () => deleteFile(activeFile)

  const toggleDirectory = (path) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const beginCreate = (type) => {
    if (!project && type !== 'workspace') return
    setError('')
    setCreateType(type)
    setCreatePath('')
    setActivityView('explorer')
  }

  const createProjectEntry = async (event) => {
    event.preventDefault()
    const relativePath = createPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      setError('Enter a valid name without . or .. path segments.')
      return
    }
    if (createType === 'workspace') {
      if (relativePath.includes('/')) {
        setError('A workspace name must be a single folder name.')
        return
      }
      try {
        await onCreateWorkspace(relativePath)
        setCreateType('')
        setCreatePath('')
        setError('')
      } catch (createError) {
        setError(createError.message || String(createError))
      }
      return
    }
    if (!project) {
      setError('Open or create a workspace before adding files or folders.')
      return
    }
    if (projectFiles.some((file) => file.path === relativePath) || projectDirectories.includes(relativePath)) {
      setError(`A project entry already exists at ${relativePath}.`)
      return
    }
    try {
      if (createType === 'folder') {
        await onCreateFolder(relativePath)
        const parts = relativePath.split('/')
        let current = ''
        setExpanded((previous) => {
          const next = new Set(previous)
          for (const part of parts.slice(0, -1)) {
            current = current ? `${current}/${part}` : part
            next.add(current)
          }
          return next
        })
      } else {
        await onSaveFile(relativePath, '')
        setOpenFiles((previous) => previous.includes(relativePath) ? previous : [...previous, relativePath])
        setFileDrafts((previous) => ({ ...previous, [relativePath]: '' }))
        setSavedContents((previous) => ({ ...previous, [relativePath]: '' }))
        setActiveFile(relativePath)
      }
      setCreateType('')
      setCreatePath('')
      setError('')
    } catch (createError) {
      setError(createError.message || String(createError))
    }
  }

  const openProject = async () => {
    setError('')
    if (openFiles.some((path) => (fileDrafts[path] ?? '') !== (savedContents[path] ?? '')) &&
      !window.confirm('Discard unsaved changes in the open files?')) return
    try {
      const opened = await onOpenProject()
      if (!opened) return
      const firstTextFile = opened.files.find((file) => typeof opened.contents[file.path] === 'string')
      const initialTabs = firstTextFile ? [firstTextFile.path] : []
      const initialContents = firstTextFile ? { [firstTextFile.path]: opened.contents[firstTextFile.path] } : {}
      setOpenFiles(initialTabs)
      setFileDrafts(initialContents)
      setSavedContents(initialContents)
      setActiveFile(firstTextFile?.path ?? '')
      setSecondaryFile('')
      setPreviewMarkdown(false)
      const autoExpanded = new Set((opened.directories ?? []).filter((path) => !path.includes('/')))
      if (firstTextFile?.path) {
        const parts = firstTextFile.path.split('/')
        let current = ''
        for (const part of parts.slice(0, -1)) {
          current = current ? `${current}/${part}` : part
          autoExpanded.add(current)
        }
      }
      setExpanded(autoExpanded)
    } catch (openError) {
      setError(openError.message || String(openError))
    }
  }

  const runTerminalCommand = async (event) => {
    event.preventDefault()
    const command = consoleInput.trim()
    if (!command || !project || consoleBusy) return
    setConsoleInput('')
    setHistoryIndex(-1)
    setCommandHistory((previous) => [command, ...previous.filter((entry) => entry !== command)].slice(0, 40))
    setConsoleBusy(true)
    setConsoleLines((previous) => [...previous, { type: 'command', text: `> ${command}` }])
    const controller = new AbortController()
    consoleAbortRef.current = controller
    try {
      const result = await onRunCommand(command, controller.signal)
      if (controller.signal.aborted) {
        setConsoleLines((previous) => [...previous, { type: 'error', text: 'Command canceled.' }].slice(-50))
        return
      }
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
      setConsoleLines((previous) => [...previous, {
        type: result.exitCode === 0 ? 'success' : 'error',
        text: `${output || '(no output)'}\nexit code: ${result.exitCode}`,
      }].slice(-50))
    } catch (commandError) {
      setConsoleLines((previous) => [...previous, {
        type: 'error',
        text: controller.signal.aborted ? 'Command canceled.' : commandError.message || String(commandError),
      }].slice(-50))
    } finally {
      if (consoleAbortRef.current === controller) consoleAbortRef.current = null
      setConsoleBusy(false)
    }
  }

  const cancelConsoleCommand = () => consoleAbortRef.current?.abort()

  const handleConsoleHistory = (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (!commandHistory.length) return
    event.preventDefault()
    if (event.key === 'ArrowUp') {
      if (historyIndex === -1) historyDraftRef.current = consoleInput
      const next = Math.min(commandHistory.length - 1, historyIndex + 1)
      setHistoryIndex(next)
      setConsoleInput(commandHistory[next])
      return
    }
    const next = historyIndex - 1
    if (next < 0) {
      setHistoryIndex(-1)
      setConsoleInput(historyDraftRef.current)
    } else {
      setHistoryIndex(next)
      setConsoleInput(commandHistory[next])
    }
  }

  const revealFolder = (folderPath) => {
    setExplorerCollapsed(false)
    setActivityView('explorer')
    setSearch('')
    setExpanded((previous) => {
      const next = new Set(previous)
      let current = ''
      for (const part of folderPath.split('/')) {
        current = current ? `${current}/${part}` : part
        next.add(current)
      }
      return next
    })
  }

  const openActivityView = async (view) => {
    // File-name filtering and content search are different queries; do not carry
    // one into the other and leave the user staring at "No matching files".
    if (view !== activityView && (view === 'search' || activityView === 'search')) setSearch('')
    if (view === 'explorer' || view === 'search' || view === 'source') setExplorerCollapsed(false)
    setActivityView(view)
    if (view === 'search') searchInputRef.current?.focus()
    if (view === 'run') setConsoleOpen(true)
    if (view === 'assistant') window.dispatchEvent(new Event('javelin:focus-assistant'))
    if (view === 'settings') window.dispatchEvent(new Event('javelin:open-settings'))
    if (view === 'source' && project) {
      try {
        const status = await onRunCommand('git status --short')
        setGitStatus(status)
      } catch (statusError) {
        setGitStatus({ exitCode: 1, stdout: '', stderr: statusError.message || String(statusError) })
      }
    }
  }

  const commands = [
    { label: 'Open Project Folder', icon: FolderOpen, action: openProject },
    { label: 'New File', icon: FilePlus2, action: () => beginCreate('file') },
    { label: 'Save All Files', icon: Save, action: () => void saveAll() },
    { label: 'Close All Files', icon: X, action: closeAll },
    { label: 'Duplicate Active File', icon: Copy, action: () => void duplicateFile(activeFile) },
    { label: 'Rename Active File', icon: Pencil, action: () => void renameFileAt(activeFile) },
    { label: 'Search in Files', icon: Search, action: () => {
      setActivityView('search')
      setTimeout(() => searchInputRef.current?.focus(), 0)
    } },
    { label: 'Go to Line', icon: Search, action: () => {
      if (!activeFile) return
      const line = Number(window.prompt('Go to line number', String(cursor.line)))
      if (Number.isFinite(line) && line > 0) revealAt(line)
    } },
    { label: 'Open Active File to the Side', icon: Columns2, action: () => void openInSplit(activeFile) },
    { label: secondaryFile ? 'Close Split Editor' : 'Split Editor', icon: Columns2, action: () => secondaryFile ? closeSplit() : void openInSplit() },
    ...(markdownActive ? [{
      label: previewMarkdown ? 'Show Markdown Source' : 'Preview Markdown',
      icon: previewMarkdown ? EyeOff : Eye,
      action: () => setPreviewMarkdown((value) => !value),
    }] : []),
    { label: 'Toggle Word Wrap', icon: WrapText, action: () => setWordWrap((on) => !on) },
    { label: 'Increase Editor Font Size', icon: Plus, action: () => setFontSize((size) => Math.min(EDITOR_FONT_MAX, size + 1)) },
    { label: 'Decrease Editor Font Size', icon: Minus, action: () => setFontSize((size) => Math.max(EDITOR_FONT_MIN, size - 1)) },
    { label: 'Reset Editor Font Size', icon: RotateCcw, action: () => setFontSize(EDITOR_FONT_DEFAULT) },
    { label: 'Toggle Explorer Sidebar', icon: PanelLeftClose, action: () => setExplorerCollapsed((collapsed) => !collapsed) },
    { label: 'Expand All Folders', icon: ChevronsUpDown, action: () => setExpanded(new Set(allDirectories)) },
    { label: 'Collapse All Folders', icon: ChevronsDownUp, action: () => setExpanded(new Set()) },
    { label: 'Toggle Terminal Panel', icon: Terminal, action: () => setConsoleOpen((open) => !open) },
    { label: 'Clear Terminal Output', icon: Trash2, action: () => setConsoleLines([]) },
    { label: 'Focus Javelin Assistant', icon: Bot, action: () => window.dispatchEvent(new Event('javelin:focus-assistant')) },
    { label: 'Open Javelin Settings', icon: Settings, action: () => window.dispatchEvent(new Event('javelin:open-settings')) },
    { label: 'Run Project Tests', icon: Play, action: () => {
      setConsoleOpen(true)
      void onRunCommand('npm test').then((result) => setConsoleLines((previous) => [...previous, {
        type: result.exitCode === 0 ? 'success' : 'error',
        text: `${result.stdout || ''}${result.stderr || ''}\nexit code: ${result.exitCode}`,
      }].slice(-50))).catch((commandError) => setConsoleLines((previous) => [...previous, { type: 'error', text: commandError.message || String(commandError) }].slice(-50)))
    } },
  ]
  const normalizedPaletteQuery = paletteQuery.replace(/^>\s*/, '').toLowerCase()
  const showCommands = paletteQuery.startsWith('>')
  const matchingCommands = commands.filter((command) => command.label.toLowerCase().includes(normalizedPaletteQuery))
  const matchingFiles = filteredFiles.filter((file) => !normalizedPaletteQuery || file.path.toLowerCase().includes(normalizedPaletteQuery))
  const recentItems = normalizedPaletteQuery
    ? []
    : recentFiles.filter((path) => filteredFiles.some((file) => file.path === path)).slice(0, 5).map((path) => ({ label: path, type: 'recent', action: () => void selectFile(path) }))
  const recentPathSet = new Set(recentItems.map((item) => item.label))
  const paletteItems = showCommands
    ? matchingCommands.map((command) => ({ ...command, type: 'command' }))
    : [
      ...recentItems,
      ...matchingFiles.filter((file) => !recentPathSet.has(file.path)).slice(0, 12).map((file) => ({ label: file.path, type: 'file', action: () => void selectFile(file.path) })),
      ...matchingCommands.map((command) => ({ ...command, type: 'command' })),
    ]

  const startExplorerResize = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = explorerWidth
    const onMove = (moveEvent) => {
      setExplorerWidth(Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, startWidth + (moveEvent.clientX - startX))))
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('is-resizing')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    document.body.classList.add('is-resizing')
  }

  const editorOptions = {
    automaticLayout: true,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize,
    fontLigatures: true,
    lineHeight: Math.round(fontSize * 1.55),
    minimap: { enabled: false },
    padding: { top: 14 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    cursorBlinking: 'smooth',
    renderLineHighlight: 'all',
    roundedSelection: true,
    tabSize: 2,
    detectIndentation: true,
    wordWrap: wordWrap ? 'on' : 'off',
    // Autocomplete: word suggestions, snippets and trigger characters, so
    // typed prefixes produce completions without extra keystrokes.
    quickSuggestions: { other: true, comments: false, strings: false },
    quickSuggestionsDelay: 60,
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: 'on',
    tabCompletion: 'on',
    wordBasedSuggestions: 'currentDocument',
    suggest: { showWords: true, preview: true, insertMode: 'replace', snippetsPreventQuickSuggestions: false },
    snippetSuggestions: 'inline',
    parameterHints: { enabled: true },
    inlineSuggest: { enabled: true },
    // Colour coding beyond tokens: brackets get their own colours and guides.
    bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
    guides: { indentation: true, bracketPairs: true, highlightActiveIndentation: true, bracketPairsHorizontal: 'active' },
    occurrencesHighlight: 'singleFile',
    selectionHighlight: true,
    autoClosingBrackets: 'always',
    autoClosingQuotes: 'always',
    autoClosingOvertype: 'always',
    autoIndent: 'full',
    linkedEditing: true,
    multiCursorModifier: 'ctrlCmd',
    stickyScroll: { enabled: true, maxLineCount: 4 },
    breadcrumbs: { enabled: true, showSymbols: true },
    folding: true,
    showFoldingControls: 'mouseover',
    unicodeHighlight: { ambiguousCharacters: false },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  }

  return (
    <section
      className={`javelin-workbench${explorerCollapsed ? ' is-explorer-collapsed' : ''}`}
      aria-label="Project workbench"
      style={{ '--explorer-width': `${explorerWidth}px` }}
    >
      <header className="workbench-topbar">
        <div className="workbench-brand">
          <span className="javelin-mark">J</span>
          <span>Javelin <strong>IDE</strong></span>
        </div>
        <button className="command-center" type="button" title="Quick Open (Ctrl+P) · Commands (Ctrl+Shift+P)" onClick={() => {
          setPaletteQuery('')
          setPaletteOpen(true)
        }}>
          <Search size={13} />
          <span>{project?.name || 'Search files and commands'}</span>
          <kbd>Ctrl P</kbd>
        </button>
        <div className="workbench-project-name" title={project?.root || 'No project open'}>
          {project?.name || 'No project open'}
        </div>
        <div className={`runtime-indicator ${runtimeStatus?.ollama?.ok ? 'is-ready' : 'is-offline'}`} title={runtimeError || (runtimeStatus?.ollama?.ok ? `Ollama ready: ${(runtimeStatus.ollama.models ?? []).length} model(s)` : 'Ollama is not responding on port 11434')}>
          <span className="runtime-dot" />
          <span>{runtimeStatus?.ollama?.ok ? `Local · ${(runtimeStatus.ollama.models ?? []).length} models` : runtimeStatus ? 'Local offline' : 'Checking local'}</span>
        </div>
        {runtimeStatus && !runtimeStatus.ollama.ok && (
          <button className="runtime-recovery-button" type="button" disabled={runtimeBusy} onClick={onStartOllama} title="Start the local Ollama service">
            {runtimeBusy ? 'Starting…' : 'Start Ollama'}
          </button>
        )}
        <button
          className="workbench-panel-toggle"
          type="button"
          aria-label={explorerCollapsed ? 'Show explorer' : 'Hide explorer'}
          aria-expanded={!explorerCollapsed}
          title={explorerCollapsed ? 'Show explorer (Ctrl+B)' : 'Hide explorer (Ctrl+B)'}
          onClick={() => setExplorerCollapsed((collapsed) => !collapsed)}
        >
          {explorerCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
        <button className="workbench-open-button" type="button" onClick={openProject}>
          <FolderOpen size={15} />
          <span>{project ? 'Open project' : 'Open folder'}</span>
        </button>
      </header>

      <nav className="activity-rail" aria-label="IDE activity">
        <button className={activityView === 'explorer' ? 'is-active' : ''} title="Explorer (Ctrl+B)" aria-label="Explorer" onClick={() => void openActivityView('explorer')}><Files size={19} /></button>
        <button className={activityView === 'search' ? 'is-active' : ''} title="Search files" aria-label="Search files" onClick={() => void openActivityView('search')}><Search size={19} /></button>
        <button className={activityView === 'source' ? 'is-active' : ''} title="Source Control" aria-label="Source Control" disabled={!project} onClick={() => void openActivityView('source')}><GitBranch size={19} /></button>
        <button className={consoleOpen ? 'is-active' : ''} title="Run and terminal" aria-label="Run and terminal" onClick={() => void openActivityView('run')}><Play size={19} /></button>
        <button title="Javelin Assistant" aria-label="Javelin Assistant" onClick={() => void openActivityView('assistant')}><Sparkles size={19} /></button>
        <button className="activity-settings" title="Settings" aria-label="Settings" onClick={() => void openActivityView('settings')}><Settings size={19} /></button>
      </nav>

      <aside className="workbench-explorer">
        <div className="explorer-heading">
          <span>{activityView === 'source' ? 'SOURCE CONTROL' : activityView === 'search' ? 'SEARCH' : 'EXPLORER'}</span>
          <div className="explorer-actions">
            <IconButton title="Expand all folders" disabled={!allDirectories.length} onClick={() => setExpanded(new Set(allDirectories))}><ChevronsUpDown size={15} /></IconButton>
            <IconButton title="Collapse all folders" disabled={!expanded.size} onClick={() => setExpanded(new Set())}><ChevronsDownUp size={15} /></IconButton>
            <IconButton title="New workspace" onClick={() => beginCreate('workspace')}><FolderPlus size={15} /></IconButton>
            <IconButton title="New file" disabled={!project} onClick={() => beginCreate('file')}><FilePlus2 size={15} /></IconButton>
            <IconButton title="New folder" disabled={!project} onClick={() => beginCreate('folder')}><FolderPlus size={15} /></IconButton>
            <IconButton title="Open project folder" onClick={openProject}><FolderOpen size={15} /></IconButton>
          </div>
        </div>
        <label className="explorer-search">
          <Search size={14} />
          <input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={activityView === 'search' ? 'Search file contents…' : 'Filter files'} aria-label={activityView === 'search' ? 'Search file contents' : 'Filter project files'} />
          {activityView === 'search' && <button type="button" className={`search-case-button ${matchCase ? 'is-active' : ''}`} title="Match case" aria-pressed={matchCase} onClick={() => setMatchCase((on) => !on)}>Aa</button>}
          {search && <IconButton title="Clear search" onClick={() => setSearch('')}><X size={13} /></IconButton>}
        </label>
        <div className="project-tree" role="tree" aria-label="Project files">
          {activityView === 'source' ? (
            <div className="source-control-view">
              <div className="source-control-project">{project?.name}</div>
              <button type="button" onClick={() => void openActivityView('source')}>Refresh changes</button>
              <pre>{gitStatus ? (gitStatus.exitCode === 0 ? gitStatus.stdout || 'Working tree clean.' : gitStatus.stderr || 'Git status unavailable.') : 'Checking Git status…'}</pre>
            </div>
          ) : activityView === 'search' ? (
            <div className="content-search-results" role="list" aria-label="File content matches">
              {!search.trim() ? (
                <p className="tree-empty">Search the text of every indexed file. Results open at the matching line.</p>
              ) : searchingContents ? (
                <p className="tree-empty">Searching {projectFiles.length} files…</p>
              ) : searchResults.length ? (
                <>
                  <div className="search-results-summary">{searchResults.length === 200 ? 'First 200' : searchResults.length} match{searchResults.length === 1 ? '' : 'es'}</div>
                  {searchResults.map((match) => (
                    <button
                      className={`content-search-result ${activeFile === match.path ? 'is-active' : ''}`}
                      type="button"
                      role="listitem"
                      key={`${match.path}:${match.line}:${match.column}`}
                      onClick={() => void openFileAt(match.path, match.line, match.column)}
                      title={`${match.path}:${match.line}:${match.column}`}
                    >
                      <span className="content-search-file"><FileTypeIcon name={match.path} /> <span>{match.path}</span><small>:{match.line}</small></span>
                      <code>{match.text}</code>
                    </button>
                  ))}
                </>
              ) : (
                <p className="tree-empty">No matches for “{search}”.</p>
              )}
            </div>
          ) : project ? (
            <>
              <div className="project-root-label">{project.name}</div>
              {filteredFiles.length ? (
                <TreeBranch node={tree} depth={0} expanded={expanded} onToggle={toggleDirectory} onSelect={selectFile} onDelete={deleteFile} onContextMenu={openContextMenu} activeFile={activeFile} />
              ) : (
                <p className="tree-empty">No matching files</p>
              )}
            </>
          ) : (
            <div className="explorer-empty">
              <FolderOpen size={23} />
              <p>Open a folder to start working.</p>
              <button type="button" onClick={() => beginCreate('workspace')}>Create workspace</button>
              <button type="button" onClick={openProject}>Open folder</button>
            </div>
          )}
        </div>
        {createType && (
          <form className="explorer-create-form" onSubmit={createProjectEntry}>
            <label htmlFor="new-project-entry">New {createType}</label>
            <input
              id="new-project-entry"
              value={createPath}
              onChange={(event) => setCreatePath(event.target.value)}
              placeholder={createType === 'workspace' ? 'My Workspace' : createType === 'folder' ? 'src/new-folder' : 'src/new-file.lua'}
              autoFocus
            />
            <div>
              <button type="button" onClick={() => setCreateType('')}>Cancel</button>
              <button type="submit" disabled={!createPath.trim()}>Create</button>
            </div>
          </form>
        )}
        <div className="explorer-footer">{projectFiles.length} files indexed</div>
      </aside>

      {!explorerCollapsed && <div
        className="panel-resizer explorer-resizer"
        role="separator"
        aria-label="Resize project explorer"
        aria-orientation="vertical"
        aria-valuemin={EXPLORER_MIN_WIDTH}
        aria-valuemax={EXPLORER_MAX_WIDTH}
        aria-valuenow={explorerWidth}
        tabIndex={0}
        title="Drag to resize the explorer · double-click to reset"
        onPointerDown={startExplorerResize}
        onDoubleClick={() => setExplorerWidth(EXPLORER_DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            setExplorerWidth(Math.min(EXPLORER_MAX_WIDTH, explorerWidth + 16))
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setExplorerWidth(Math.max(EXPLORER_MIN_WIDTH, explorerWidth - 16))
          } else if (event.key === 'Home') {
            event.preventDefault()
            setExplorerWidth(EXPLORER_DEFAULT_WIDTH)
          }
        }}
      />}

      <main className={`workbench-editor-area${consoleOpen ? ' has-console' : ''}${splitOpen ? ' is-split' : ''}`}>
        <div className="editor-tabs">
          <div className="editor-tabs-list" role="tablist" aria-label="Open files">
            {openFiles.length ? openFiles.map((path) => (
              <div
                className={`editor-tab-wrap ${path === activeFile ? 'is-active' : ''}${path === secondaryFile ? ' is-secondary' : ''}`}
                key={path}
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  closeFile(path)
                }}
              >
                <button
                  className="editor-tab"
                  type="button"
                  role="tab"
                  aria-selected={path === activeFile}
                  title={path}
                  onClick={() => activateFile(path)}
                >
                  <FileTypeIcon name={path} />
                  <span>{path.split('/').pop()}</span>
                  {(fileDrafts[path] ?? '') !== (savedContents[path] ?? '') && <span className="editor-dirty-dot" aria-label="Unsaved changes" />}
                </button>
                <button className="editor-tab-close" type="button" title={`Close ${path}`} aria-label={`Close ${path}`} onClick={() => closeFile(path)}>
                  <X size={12} />
                </button>
              </div>
            )) : (
              <div className="editor-tab editor-tab-empty">Workspace</div>
            )}
          </div>
          <div className="editor-actions">
            {markdownActive && (
              <IconButton title={previewMarkdown ? 'Show Markdown source' : 'Preview Markdown'} onClick={() => setPreviewMarkdown((value) => !value)}>
                {previewMarkdown ? <EyeOff size={15} /> : <Eye size={15} />}
              </IconButton>
            )}
            <IconButton
              title={splitOpen ? 'Close split editor (Ctrl+\\)' : 'Split editor (Ctrl+\\)'}
              disabled={!activeFile}
              onClick={() => splitOpen ? closeSplit() : void openInSplit()}
            >
              <Columns2 size={15} />
            </IconButton>
            <IconButton title={wordWrap ? 'Turn word wrap off' : 'Turn word wrap on'} onClick={() => setWordWrap((on) => !on)}><WrapText size={15} /></IconButton>
            <IconButton title={consoleOpen ? 'Hide terminal' : 'Show terminal'} onClick={() => setConsoleOpen((open) => !open)}><Terminal size={15} /></IconButton>
            <IconButton title="Save file (Ctrl+S)" disabled={!dirty || busy} onClick={() => void saveFile()}><Save size={15} /></IconButton>
            <IconButton title="Rename or move active file" disabled={!activeFile || busy} onClick={() => void renameActiveFile()}><Pencil size={14} /></IconButton>
            <IconButton title="Delete active file" disabled={!activeFile || busy} onClick={() => void deleteActiveFile()}><Trash2 size={14} /></IconButton>
          </div>
        </div>
        {!splitOpen && (
          <nav className="editor-breadcrumbs" aria-label="Active file path">
            {activeFile ? activeFile.split('/').map((part, index, parts) => {
              const path = parts.slice(0, index + 1).join('/')
              const last = index === parts.length - 1
              return (
                <span className="editor-crumb-item" key={path}>
                  {index > 0 && <span className="editor-crumb-separator">/</span>}
                  {last ? (
                    <span className="editor-crumb is-file"><FileTypeIcon name={part} size={12} /> {part}</span>
                  ) : (
                    <button className="editor-crumb" type="button" title={`Show ${path} in Explorer`} onClick={() => revealFolder(path)}>{part}</button>
                  )}
                </span>
              )
            }) : <span className="editor-crumb-placeholder">No file open</span>}
          </nav>
        )}
        <div className={`editor-split${splitOpen ? ' is-split' : ''}`}>
          <section className="editor-pane is-primary">
            {splitOpen && (
              <div className="editor-pane-header">
                <span className="editor-pane-title">
                  <FileTypeIcon name={activeFile} size={12} />
                  <span>{activeFile}</span>
                  {dirty && <span className="editor-dirty-dot" aria-label="Unsaved changes" />}
                </span>
                <div className="editor-pane-actions">
                  <IconButton title="Save file (Ctrl+S)" disabled={!dirty || busy} onClick={() => void saveFile()}><Save size={14} /></IconButton>
                </div>
              </div>
            )}
        {activeFile ? (
          markdownActive && previewMarkdown ? (
            <div className="editor-markdown-preview">
              <Markdown>{draft}</Markdown>
            </div>
          ) : (
          <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
            <MonacoEditor
              height="100%"
              path={activeFile}
              language={language}
              value={draft}
              onChange={(value) => setFileDrafts((previous) => ({ ...previous, [activeFile]: value ?? '' }))}
              theme="javelin-dark"
              beforeMount={defineJavelinTheme}
              onMount={(editor) => {
                editorRef.current = editor
                editor.onDidChangeCursorPosition((event) => {
                  setCursor({ line: event.position.lineNumber, column: event.position.column })
                })
                const reveal = pendingRevealRef.current
                if (reveal) {
                  pendingRevealRef.current = null
                  revealAt(reveal.line, reveal.column)
                }
              }}
              options={editorOptions}
            />
          </Suspense>
          )
        ) : (
          <div className="editor-welcome">
            <span className="welcome-mark">J</span>
            <span className="welcome-kicker">JAVELIN IDE</span>
            <h1>{project ? 'Choose a file' : 'Your workspace, in Javelin'}</h1>
            <p>{project ? 'Select a file from the project explorer to open it here.' : 'Open a project folder to explore, edit and verify real files with Javelin.'}</p>
            <div className="welcome-actions">
              {!project && <button type="button" onClick={openProject}><FolderOpen size={15} /> Open project <kbd>Ctrl O</kbd></button>}
              <button type="button" onClick={() => { setPaletteQuery(''); setPaletteOpen(true) }}><Search size={15} /> Quick open <kbd>Ctrl P</kbd></button>
              {project && <button type="button" onClick={() => beginCreate('file')}><FilePlus2 size={15} /> New file</button>}
            </div>
            <div className="welcome-shortcuts">
              <span><kbd>Ctrl P</kbd> Quick open</span>
              <span><kbd>Ctrl ⇧ P</kbd> Commands</span>
              <span><kbd>Ctrl ⇧ F</kbd> Search in files</span>
              <span><kbd>Ctrl \</kbd> Split editor</span>
              <span><kbd>F2</kbd> Rename file</span>
            </div>
          </div>
        )}
          </section>
          {splitOpen && (
            <section className="editor-pane is-secondary">
              <div className="editor-pane-header">
                <span className="editor-pane-title">
                  <FileTypeIcon name={secondaryFile} size={12} />
                  <span>{secondaryFile}</span>
                  {secondaryDirty && <span className="editor-dirty-dot" aria-label="Unsaved changes" />}
                </span>
                <div className="editor-pane-actions">
                  <IconButton title="Save split file" disabled={!secondaryDirty || busy} onClick={() => void savePath(secondaryFile)}><Save size={14} /></IconButton>
                  <IconButton title="Close split editor (Ctrl+\\)" onClick={closeSplit}><X size={14} /></IconButton>
                </div>
              </div>
              <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
                <MonacoEditor
                  height="100%"
                  path={secondaryFile}
                  language={secondaryLanguage}
                  value={secondaryDraft}
                  onChange={(value) => setFileDrafts((previous) => ({ ...previous, [secondaryFile]: value ?? '' }))}
                  theme="javelin-dark"
                  beforeMount={defineJavelinTheme}
                  onMount={(editor) => { secondaryEditorRef.current = editor }}
                  options={editorOptions}
                />
              </Suspense>
            </section>
          )}
        </div>
        {consoleOpen && (
          <section className="workbench-console" aria-label="Build and terminal output">
            <header className="console-heading">
              <span>TERMINAL / OUTPUT</span>
              <IconButton title="Clear terminal output" onClick={() => setConsoleLines([])}><X size={14} /></IconButton>
            </header>
            <div className="console-scrollback" role="log" aria-live="polite">
              {commandOutput.map((entry, index) => <pre className={`console-line ${entry.type}`} key={`agent-${index}`}>{entry.text}</pre>)}
              {consoleLines.map((entry, index) => <pre className={`console-line ${entry.type}`} key={`manual-${index}`}>{entry.text}</pre>)}
              {!commandOutput.length && !consoleLines.length && <span className="console-placeholder">Command output appears here.</span>}
            </div>
            <form className="console-command-form" onSubmit={runTerminalCommand}>
              <span aria-hidden="true">&gt;</span>
              <input
                value={consoleInput}
                onChange={(event) => { setConsoleInput(event.target.value); setHistoryIndex(-1) }}
                onKeyDown={handleConsoleHistory}
                placeholder={project ? 'Run a command in the project folder' : 'Open a project folder first'}
                title="Use ↑ and ↓ to recall previous commands"
                aria-label="Project terminal command"
                disabled={!project || consoleBusy}
                autoComplete="off"
              />
              {consoleBusy ? (
                <button type="button" title="Cancel command" aria-label="Cancel command" onClick={cancelConsoleCommand}>
                  <Square size={13} />
                </button>
              ) : (
                <button type="submit" title="Run command" aria-label="Run command" disabled={!project || !consoleInput.trim()}>
                  <Play size={13} />
                </button>
              )}
            </form>
          </section>
        )}
        {error && <div className="workbench-error" role="alert">{error}</div>}
        <footer className="editor-statusbar">
          <span>{project?.root || 'JAVELIN DESKTOP'}</span>
          <div className="editor-status-tools">
            <span>{activeFile ? `Ln ${cursor.line}, Col ${cursor.column} · ${language}` : 'Ready'}{dirty ? ' · Unsaved' : ''}{splitOpen ? ' · split' : ''}</span>
            <span className="editor-font-controls" aria-label="Editor font size">
              <button type="button" title="Decrease editor font size" aria-label="Decrease editor font size" onClick={() => setFontSize((size) => Math.max(EDITOR_FONT_MIN, size - 1))}>−</button>
              <span>{fontSize}px</span>
              <button type="button" title="Increase editor font size" aria-label="Increase editor font size" onClick={() => setFontSize((size) => Math.min(EDITOR_FONT_MAX, size + 1))}>+</button>
            </span>
          </div>
        </footer>
      </main>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="file-context-menu"
          role="menu"
          aria-label={`Actions for ${contextMenu.path}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="file-context-heading" title={contextMenu.path}>{contextMenu.path}</div>
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void selectFile(contextMenu.path) }}><FolderOpen size={13} /> Open</button>
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void openInSplit(contextMenu.path) }}><Columns2 size={13} /> Open to the side</button>
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void renameFileAt(contextMenu.path) }}><Pencil size={13} /> Rename or move… <kbd>F2</kbd></button>
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void duplicateFile(contextMenu.path) }}><Copy size={13} /> Duplicate</button>
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void copyFilePath(contextMenu.path) }}><Files size={13} /> Copy relative path</button>
          <div className="file-context-separator" />
          <button className="is-danger" type="button" role="menuitem" onClick={() => { setContextMenu(null); void deleteFile(contextMenu.path) }}><Trash2 size={13} /> Delete</button>
        </div>
      )}
      {paletteOpen && (
        <div className="command-palette-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="command-palette" role="dialog" aria-modal="true" aria-label="Quick Open and commands" onClick={(event) => event.stopPropagation()}>
            <input
              ref={paletteInputRef}
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && paletteItems.length) {
                  event.preventDefault()
                  setPaletteIndex((index) => (index + 1) % paletteItems.length)
                  return
                }
                if (event.key === 'ArrowUp' && paletteItems.length) {
                  event.preventDefault()
                  setPaletteIndex((index) => (index - 1 + paletteItems.length) % paletteItems.length)
                  return
                }
                if (event.key === 'Enter' && paletteItems.length) {
                  event.preventDefault()
                  const item = paletteItems[Math.min(paletteIndex, paletteItems.length - 1)]
                  item.action()
                  setPaletteOpen(false)
                }
              }}
              placeholder="Type a file name, or > for commands"
              aria-label="Quick Open query"
            />
            <div className="command-palette-results">
              {paletteItems.map((item, index) => (
                <button
                  className={index === paletteIndex ? 'is-selected' : ''}
                  key={`${item.type}-${item.label}`}
                  type="button"
                  onMouseEnter={() => setPaletteIndex(index)}
                  onClick={() => {
                    item.action()
                    setPaletteOpen(false)
                  }}
                >
                  {item.icon ? <item.icon size={14} /> : <FileTypeIcon name={item.label} />}
                  <span>{item.label}</span>
                  <small>{item.type === 'command' ? 'Command' : item.type === 'recent' ? 'Recent' : 'File'}</small>
                </button>
              ))}
              {!paletteItems.length && <p>No matching files or commands</p>}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}