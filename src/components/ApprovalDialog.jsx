import { useEffect, useState } from 'react'
import { ShieldAlert, ShieldCheck, Terminal, FileEdit, FilePlus } from 'lucide-react'
import { Button } from './Button'
import { DiffView } from './DiffView'

const ICONS = {
  write_file: FilePlus,
  edit_file: FileEdit,
  run_command: Terminal,
}

/**
 * Modal gate shown before the agent performs a risky action.
 *
 * For file edits we show the actual diff *before* anything is applied, so approving
 * is an informed decision rather than a blind yes. "Always allow this run" remembers
 * the decision for the current session only.
 */
export function ApprovalDialog({ request, onDecide }) {
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    setRemember(false)
  }, [request?.id])

  // Escape always dismisses the dialog, so a modal can never trap the app.
  useEffect(() => {
    if (!request) return undefined
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDecide({ approved: false, remember: false })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [request, onDecide])

  if (!request) return null

  const Icon = ICONS[request.name] ?? ShieldAlert
  const isCommand = request.name === 'run_command'

  return (
    <div
      className="glass-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
    >
      <div className="glass-dialog w-full max-w-2xl rounded-3xl border p-5 text-card-foreground">
        <div className="mb-3 flex items-start gap-3">
          <div className="glass-chip mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="approval-title" className="text-base font-semibold">
              {isCommand ? 'Run this command?' : 'Apply this change?'}
            </h2>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              {describe(request)}
            </p>
          </div>
        </div>

        {isCommand ? (
          <pre className="mb-4 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs">
            $ {request.args?.command}
          </pre>
        ) : request.diff ? (
          <div className="mb-4">
            <DiffView diff={request.diff} path={request.args?.path ?? request.path} expanded />
          </div>
        ) : (
          <pre className="mb-4 max-h-72 overflow-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs">
            {request.args?.content ?? request.args?.new_string ?? ''}
          </pre>
        )}

        <label className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Always allow {isCommand ? 'commands' : 'file changes'} for the rest of this run
        </label>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onDecide({ approved: false, remember })}>
            Deny
          </Button>
          <Button onClick={() => onDecide({ approved: true, remember })}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            Approve
          </Button>
        </div>
      </div>
    </div>
  )
}

function describe(request) {
  switch (request.name) {
    case 'run_command':
      return 'The agent wants to execute a shell command.'
    case 'write_file':
      return `Write ${request.args?.path ?? 'file'}`
    case 'create_project':
      return `Create a ${request.args?.template ?? 'starter'} project${request.args?.path ? ` in ${request.args.path}` : ''}`
    case 'edit_file':
      return `Edit ${request.args?.path ?? 'file'}`
    default:
      return request.name
  }
}
