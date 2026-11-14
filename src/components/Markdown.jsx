import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check } from 'lucide-react'

function CodeBlock({ className, children }) {
  const [copied, setCopied] = useState(false)
  const language = /language-(\w+)/.exec(className || '')?.[1] ?? ''
  const code = String(children).replace(/\n$/, '')

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="group relative my-3 overflow-hidden rounded-xl border border-white/15 bg-slate-950/90 text-slate-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_30px_-22px_rgba(0,0,0,0.9)] backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5 text-xs text-slate-400">
        <span className="font-mono">{language || 'code'}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-slate-800 hover:text-slate-100 transition-colors"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-sm leading-relaxed">
        <code className={className}>{code}</code>
      </pre>
    </div>
  )
}

const components = {
  code({ inline, className, children, ...props }) {
    // react-markdown v9: block code arrives wrapped in <pre>; inline has no newline & no language class.
    const isBlock = className?.includes('language-') || String(children).includes('\n')
    if (!inline && isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>
    }
    return (
      <code
        className="glass-inset rounded-md px-1.5 py-0.5 font-mono text-[0.875em] text-foreground"
        {...props}
      >
        {children}
      </code>
    )
  },
  pre({ children }) {
    // CodeBlock renders its own <pre>; avoid nesting.
    return <>{children}</>
  },
  a({ children, ...props }) {
    return (
      <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...props}>
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return <th className="border border-border bg-muted px-2 py-1 text-left font-semibold">{children}</th>
  },
  td({ children }) {
    return <td className="border border-border px-2 py-1">{children}</td>
  },
}

export function Markdown({ children }) {
  return (
    <div className="prose-javelin text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_hr]:my-4">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
