import { useState } from 'react'
import { ChevronDown, ChevronRight, FileCode, Plus, Minus } from 'lucide-react'
import { Button } from './Button'

/**
 * Render a line-level diff produced by computeDiff().
 * Collapses long runs of unchanged context so the interesting lines stay visible.
 */
export function DiffView({ diff, path, defaultOpen = true, expanded = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(expanded)

  if (!diff) return null
  const lines = showAll ? diff.lines : collapseContext(diff.lines)

  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 truncate font-mono font-medium">{path}</span>
        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <Plus className="h-3 w-3" />
          {diff.added}
        </span>
        <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
          <Minus className="h-3 w-3" />
          {diff.removed}
        </span>
      </button>

      {open && (
        <div className="max-h-80 overflow-auto border-t font-mono text-xs">
          {lines.map((line, i) =>
            line.type === 'gap' ? (
              <button
                key={i}
                className="w-full bg-muted/40 px-3 py-1 text-left text-[10px] text-muted-foreground hover:bg-muted"
                onClick={() => setShowAll(true)}
              >
                ⋯ {line.count} unchanged lines — show all
              </button>
            ) : (
              <div
                key={i}
                className={`flex whitespace-pre px-2 leading-5 ${line.type === 'add'
                    ? 'bg-emerald-50 dark:bg-emerald-950/40'
                    : line.type === 'remove'
                      ? 'bg-red-50 dark:bg-red-950/40'
                      : ''
                  }`}
              >
                <span className="w-8 shrink-0 select-none text-right text-muted-foreground/60">
                  {line.aLine ?? ''}
                </span>
                <span className="w-8 shrink-0 select-none text-right text-muted-foreground/60">
                  {line.bLine ?? ''}
                </span>
                <span data-gutter className={`w-4 shrink-0 text-center ${gutterClass(line.type)}`}>
                  {gutterMark(line.type)}
                </span>
                <span className="flex-1 pr-3">{line.text}</span>
              </div>
),
          )}
          {!showAll && diff.lines.length > lines.length && (
            <div className="border-t bg-muted/20 px-3 py-1">
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setShowAll(true)}>
                Expand full diff
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function gutterMark(type) {
  if (type === 'add') return '+'
  if (type === 'remove') return '-'
  return ' '
}

function gutterClass(type) {
  if (type === 'add') return 'text-emerald-600 dark:text-emerald-400'
  if (type === 'remove') return 'text-red-600 dark:text-red-400'
  return ''
}

/** Replace long context runs with a single summary row. */
function collapseContext(lines, padding = 3) {
  const out = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== 'context') {
      out.push(lines[i])
      i++
      continue
    }
    let j = i
    while (j < lines.length && lines[j].type === 'context') j++
    const run = j - i
    if (run > padding * 2 + 1) {
      out.push(...lines.slice(i, i + padding))
      out.push({ type: 'gap', count: run - padding * 2 })
      out.push(...lines.slice(j - padding, j))
    } else {
      out.push(...lines.slice(i, j))
    }
    i = j
  }
  return out
}
