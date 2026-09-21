import { useState } from 'react'
import {
  Brain, GitBranch, Lightbulb, ShieldCheck, Database, Activity, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle2, XCircle, Loader2, Wrench, Ban,
} from 'lucide-react'
import { Button } from './Button'
import { DiffView } from './DiffView'

const PHASE_ORDER = ['understand', 'plan', 'act', 'verify', 'repair', 'conclude']

const PHASE_TEXT = {
  understand: 'Understanding',
  plan: 'Planning',
  act: 'Acting',
  verify: 'Verifying',
  repair: 'Repairing',
  conclude: 'Concluding',
}

/** The reasoning lifecycle strip — shows where Javelin is in its own loop. */
export function PhaseRail({ phase, busy }) {
  const activeIndex = PHASE_ORDER.indexOf(phase)
  return (
    <div className="flex items-center gap-1 overflow-x-auto rounded-lg border bg-card/60 px-3 py-2">
      <Brain className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />
      {PHASE_ORDER.map((p, i) => {
        const isActive = busy && i === activeIndex
        const isDone = busy && i < activeIndex
        return (
          <div key={p} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span className="text-muted-foreground/40">→</span>}
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] ${isActive
                  ? 'bg-primary text-primary-foreground'
                  : isDone
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground/50'
                }`}
            >
              {PHASE_TEXT[p]}
            </span>
          </div>
        )
      })}
      {busy && <Loader2 className="ml-1 h-3 w-3 shrink-0 animate-spin text-primary" />}
    </div>
  )
}

/** The standing plan Javelin is following. */
export function PlanCard({ plan }) {
  if (!plan) return null
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        <GitBranch className="h-3.5 w-3.5 text-primary" />
        Javelin&apos;s plan
      </p>
      <pre className="whitespace-pre-wrap font-sans text-xs text-muted-foreground">{plan}</pre>
    </div>
  )
}

/** Hypotheses Javelin formed while diagnosing failures. */
export function HypothesisList({ hypotheses }) {
  if (!hypotheses?.length) return null
  return (
    <div className="rounded-lg border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-100">
        <Lightbulb className="h-3.5 w-3.5" />
        Diagnoses
      </p>
      <ul className="space-y-1 text-xs text-amber-900 dark:text-amber-100">
        {hypotheses.map((h, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="opacity-60">•</span>
            <span>{h}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const STEP_ICON = {
  list_files: Activity,
  read_file: Activity,
  search_code: Activity,
  write_file: Wrench,
  edit_file: Wrench,
  run_command: Activity,
  create_checkpoint: Database,
  remember: Database,
  repeat_blocked: Ban,
  verification_required: AlertTriangle,
  tool_refused: Ban,
}

/** Collapsible log of everything Javelin tried, including blocked repeats. */
export function JavelinSteps({ steps }) {
  const [open, setOpen] = useState(true)
  if (!steps?.length) return null

  const failed = steps.filter((s) => s.ok === false).length
  const blocked = steps.filter((s) => s.name === 'repeat_blocked').length

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="font-medium">
          Javelin activity — {steps.length} action{steps.length === 1 ? '' : 's'}
        </span>
        {blocked > 0 && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <Ban className="h-3 w-3" />
            {blocked} repeat{blocked === 1 ? '' : 's'} blocked
          </span>
        )}
        {failed > 0 && (
          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
            <XCircle className="h-3 w-3" />
            {failed} failed
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t p-3">
          {steps.map((step, i) => (
            <JavelinStepRow key={i} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}

function JavelinStepRow({ step }) {
  const Icon = STEP_ICON[step.name] ?? Activity
  const label = step.args?.path ?? step.args?.command ?? step.args?.query ?? step.args?.fact ?? step.args?.note ?? ''

  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 w-4 shrink-0 text-right text-muted-foreground/60">{step.step}</span>
      {step.ok === true ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : step.ok === false ? (
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
      ) : (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="font-mono font-medium">{step.name}</span>
          {label && <span className="truncate font-mono text-muted-foreground">{label}</span>}
        </div>
        {step.ok === false && step.output && (
          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded border bg-red-50/60 px-2 py-1 text-[10px] text-red-900 dark:bg-red-950/30 dark:text-red-200">
            {step.output}
          </pre>
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

/** What the run produced, stated honestly. */
export function JavelinResult({ result }) {
  if (!result) return null
  const tone =
    result.status === 'done'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100'
      : result.status === 'aborted'
        ? 'bg-muted'
        : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100'

  return (
    <div className={`rounded-lg border p-3 text-xs ${tone}`}>
      <p className="flex items-center gap-1.5 font-medium">
        {result.status === 'done' ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <XCircle className="h-3.5 w-3.5" />
        )}
        {result.status === 'done' ? 'Completed' : result.status === 'aborted' ? 'Stopped' : 'Could not complete'}
        {result.verified && (
          <span className="ml-1 flex items-center gap-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] text-white">
            <ShieldCheck className="h-2.5 w-2.5" />
            verified
          </span>
        )}
      </p>
      <p className="mt-1 opacity-90">{result.summary}</p>
      {result.hypotheses?.length > 0 && (
        <p className="mt-1 opacity-75">{result.hypotheses.length} diagnosis(es) were made while repairing.</p>
      )}
    </div>
  )
}

/** Engine health + what Javelin has learned. This makes the system legible. */
export function JavelinDiagnostics({ diagnostics, learnings, onRefresh }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="overflow-hidden rounded-lg border bg-card/60">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent"
        onClick={() => {
          setOpen((o) => !o)
          if (!open) onRefresh?.()
        }}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Brain className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium">Javelin system</span>
        {diagnostics && (
          <span className="text-muted-foreground">
            {diagnostics.engines?.length ?? 0} engine(s) · {diagnostics.memory?.facts ?? 0} learned fact(s)
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t p-3 text-xs">
          <div>
            <p className="mb-1 font-medium text-muted-foreground">Inference engines</p>
            <ul className="space-y-1">
              {(diagnostics?.engines ?? []).map((e) => {
                const health = diagnostics.health?.[e.id]
                return (
                  <li key={e.id} className="flex items-center gap-2">
                    {health?.ok ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <XCircle className="h-3 w-3 text-red-600 dark:text-red-400" />
                    )}
                    <span className="font-mono">{e.label}</span>
                    <span className="text-muted-foreground">
                      {health?.ok ? 'reachable' : health?.detail || 'unavailable'}
                    </span>
                  </li>
                )
              })}
              {!diagnostics?.engines?.length && (
                <li className="text-muted-foreground">No engine probed yet.</li>
              )}
            </ul>
          </div>

          <div>
            <p className="mb-1 font-medium text-muted-foreground">Memory</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>{diagnostics?.memory?.episodes ?? 0} recorded action(s)</li>
              <li>{diagnostics?.memory?.facts ?? 0} durable learning(s)</li>
              <li>
                {diagnostics?.memory?.deadActions ?? 0} action(s) marked as failing — these will not
                be repeated
              </li>
            </ul>
          </div>

          {learnings?.strong?.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-muted-foreground">Learned about this project</p>
              <ul className="space-y-1">
                {learnings.strong.slice(0, 6).map((f) => (
                  <li key={f.id} className="flex gap-1.5">
                    <span className="text-muted-foreground/60">•</span>
                    <span>{f.fact}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {learnings?.blocked?.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-muted-foreground">Known-dead actions</p>
              <ul className="space-y-1 font-mono text-[10px] text-muted-foreground">
                {learnings.blocked.slice(0, 5).map((b) => (
                  <li key={b} className="truncate">• {b}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
