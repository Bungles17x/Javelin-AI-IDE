import { useState } from 'react'
import {
  Search, Play, Terminal, FileCode, FolderPlus, Save, CheckCircle2, XCircle, Loader2, AlertTriangle,
  RotateCcw, ChevronDown, ChevronRight, Clock, Check,
} from 'lucide-react'
import { Button } from './Button'
import { DiffView } from './DiffView'

const STEP_ICON = {
  list_files: Search,
  read_file: FileCode,
  search_code: Search,
  write_file: Save,
  create_folder: FolderPlus,
  edit_file: Save,
  create_checkpoint: Clock,
  run_command: Terminal,
  finish: CheckCircle2,
}

const PHASE_LABEL = {
  inspect: 'Inspecting',
  plan: 'Planning',
  act: 'Editing',
  verify: 'Verifying',
  recover: 'Recovering from failure',
  done: 'Done',
}

/** Live phase indicator shown while the agent is running. */
export function AgentPhase({ phase, status }) {
  if (!phase && !status) return null
  const phases = ['inspect', 'plan', 'act', 'verify']
  const activeIndex = phases.indexOf(phase)
  const active = phase !== 'done'
  return (
    <div className="agent-phase-panel" role="status" aria-live="polite">
      <div className="agent-phase-heading">
        {active ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
        <span className="font-medium">{PHASE_LABEL[phase] ?? 'Working'}</span>
        {status && <span className="truncate text-muted-foreground">{status}</span>}
      </div>
      {phase === 'recover' ? (
        <div className="agent-recovery-note"><AlertTriangle size={12} /> Adjusting after a failed step</div>
      ) : (
        <div className="agent-phase-track" aria-label={`Current phase: ${PHASE_LABEL[phase] ?? 'working'}`}>
          {phases.map((item, index) => (
            <div className={`agent-phase-segment ${index < activeIndex || phase === 'done' ? 'is-complete' : ''} ${index === activeIndex ? 'is-current' : ''}`} key={item}>
              <span>{index < activeIndex || phase === 'done' ? <Check size={10} /> : index + 1}</span>
              <small>{PHASE_LABEL[item]}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Collapsible list of every step the agent took, with pass/fail and diffs. */
export function AgentTimeline({ steps, onUndo }) {
  const [open, setOpen] = useState(true)
  if (!steps?.length) return null

  const failures = steps.filter((s) => s.ok === false).length

  return (
    <div className="glass-card overflow-hidden rounded-2xl border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="font-medium">
          Agent activity — {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>
        {failures > 0 && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            {failures} failed
          </span>
        )}
        {steps.some((step) => step.ok == null) && (
          <span className="ml-auto flex items-center gap-1 text-muted-foreground" role="status">
            <Loader2 className="h-3 w-3 animate-spin" />
            In progress
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t p-3" role="list" aria-label="Agent tool activity">
          {steps.map((step, i) => (
            <StepRow key={step.id ?? step.step ?? i} step={step} onUndo={onUndo} />
          ))}
        </div>
      )}
    </div>
  )
}

function StepRow({ step, onUndo }) {
  const [outputOpen, setOutputOpen] = useState(
    () => step.ok == null || step.ok === false || ['read_file', 'list_files', 'search_code'].includes(step.name),
  )
  const Icon = STEP_ICON[step.name] ?? Play
  const label = step.args?.path ?? step.args?.command ?? step.args?.query ?? step.args?.label ?? ''
  const pending = step.ok == null
  const outputLabel = step.name === 'run_command' ? 'Command output' : 'Tool output'

  return (
    <div className="agent-step flex items-start gap-2 text-xs" role="listitem" aria-label={`${step.name}: ${pending ? 'in progress' : step.ok ? 'completed' : 'failed'}`}>
      <span className="mt-0.5 w-4 shrink-0 text-right text-muted-foreground/60">{step.step}</span>
      {pending ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : step.ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="font-mono font-medium">{step.name}</span>
          {label && <span className="truncate font-mono text-muted-foreground">{label}</span>}
        </div>
        {step.output && (
          <details
            className="glass-inset mt-1 rounded-lg border"
            open={outputOpen}
            onToggle={(event) => setOutputOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer px-2 py-1 text-[10px] text-muted-foreground">{outputLabel}</summary>
            <pre className={`max-h-40 overflow-auto whitespace-pre-wrap border-t px-2 py-1 text-[10px] ${step.ok ? 'text-foreground' : 'bg-red-50/60 text-red-900 dark:bg-red-950/30 dark:text-red-200'}`}>
              {step.output}
            </pre>
          </details>
        )}
        {step.diff && (
          <div className="mt-1">
            <DiffView diff={step.diff} path={step.args?.path} defaultOpen={false} />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The plan as a live task checklist.
 *
 * This is the "what will it do" view: one row per planned step, ticked off in order
 * as real work succeeds, so progress is visible rather than inferred.
 */
export function TaskList({ steps }) {
  if (!steps?.length) return null
  const activeIndex = steps.findIndex((s) => !s.done)
  return (
    <div className="glass-card rounded-2xl px-3 py-2 text-xs">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Tasks</div>
      <ul className="space-y-1">
        {steps.map((step, i) => {
          const isDone = Boolean(step.done)
          const isActive = !isDone && i === activeIndex
          return (
            <li
              key={i}
              className={[
                'flex items-start gap-2',
                isDone ? 'text-muted-foreground line-through' : '',
                isActive ? 'font-medium' : '',
              ].join(' ')}
            >
              <span className={isDone ? 'text-green-400' : 'text-muted-foreground'}>
                {isDone ? '✓' : isActive ? '▸' : '○'}
              </span>
              <span>
                {i + 1}. {step.text}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Restore-to-checkpoint control. */
export function CheckpointBar({ checkpoints, onRestore }) {
  if (!checkpoints?.length) return null
  return (
    <div className="glass-card flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2 text-xs">
      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-medium">Checkpoints:</span>
      {checkpoints.map((cp) => (
        <Button
          key={cp.id}
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={() => onRestore(cp.id)}
          title={`Restore workspace to "${cp.label}"`}
        >
          <RotateCcw className="h-3 w-3" />
          {cp.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * The keep-or-undo decision after a run that changed files.
 *
 * Revert is always offered, because the runtime takes its own checkpoint before
 * the run — it does not depend on the agent having remembered to make one.
 */
export function RunControls({ fileCount, status, summary, code, onAccept, onRevert, onRevertMessage }) {
  // Reverting a message is meaningful even when nothing changed, so the bar renders
  // whenever there is either a change to decide on or a message to undo.
  if (!fileCount && !onRevertMessage) return null
  const rough = status && status !== 'done'
  return (
    <div className={`run-decision-panel ${rough ? 'is-incomplete' : 'is-complete'}`}>
      <div className="run-decision-copy">
        <strong>{fileCount ? `This run changed ${fileCount} item(s).` : status === 'aborted' ? 'Run stopped.' : status === 'failed' ? 'Run could not finish.' : 'Run finished.'}</strong>
        {code && (
          <code
            className="rounded border px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
            title="Error code — look it up in docs/ERROR-CODES.md"
          >
            {code}
          </code>
        )}
        {summary && <span>{summary}</span>}
      </div>
      <div className="flex items-center gap-2">
        {fileCount ? (
          <>
            <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={onAccept}>
              <Check className="h-3 w-3" />
              Accept all
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px] text-red-400"
              onClick={onRevert}
              title="Undo every change this run made, back to how the workspace was before it started"
            >
              <RotateCcw className="h-3 w-3" />
              Revert all
            </Button>
          </>
        ) : null}
        {onRevertMessage && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px] text-red-400"
            onClick={onRevertMessage}
            title="Discard your last message and everything after it, and restore the files to before it ran"
          >
            <RotateCcw className="h-3 w-3" />
            Revert my last message
          </Button>
        )}
      </div>
      {rough && (
        <span className="text-muted-foreground">
          {status === 'aborted' ? 'Run was stopped part-way' : 'Run failed'} — reverting is recommended.
        </span>
      )}
    </div>
  )
}
