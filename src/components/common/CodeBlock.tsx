import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn, copyText } from '@/lib/utils'
import { highlightToHtml } from '@/lib/highlight'
import { useAppStore } from '@/stores/app'
import { langOf } from '@/lib/language'
import { Tooltip } from '@/components/ui/overlays'

export function CodeBlock({
  code,
  lang,
  filename,
  className,
  dense = false,
  showLineNumbers = false,
  maxHeight,
  actions,
  wrap: wrapProp,
  showHeader,
}: {
  code: string
  lang?: string
  filename?: string
  className?: string
  dense?: boolean
  showLineNumbers?: boolean
  maxHeight?: number | string
  actions?: React.ReactNode
  wrap?: boolean
  showHeader?: boolean
}) {
  const mode = useAppStore((s) => s.appearance.mode)
  const wrapSetting = useAppStore((s) => s.appearance.codeWrap)
  const wrap = wrapProp ?? wrapSetting
  const highlight = useAppStore((s) => s.appearance.diffHighlight)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)

  const resolvedLang = lang || (filename ? langOf(filename).shiki : 'text')

  useEffect(() => {
    mounted.current = true
    if (!highlight || code.length > 400_000) {
      setHtml(null)
      return
    }
    let cancelled = false
    void highlightToHtml(code, resolvedLang, mode === 'dark').then((result) => {
      if (!cancelled && mounted.current) setHtml(result)
    })
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [code, resolvedLang, mode, highlight])

  const lineCount = code.split('\n').length
  const gutter = showLineNumbers && !wrap

  const onCopy = async () => {
    if (await copyText(code)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }

  return (
    <div
      className={cn(
        'group/code relative overflow-hidden rounded-lg border border-border/80 bg-[hsl(var(--surface-1)/0.85)]',
        className,
      )}
    >
      {(filename || actions || showHeader) && (
        <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-card/50 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            {filename ? (
              <span className="truncate font-mono text-xs text-muted-foreground">{filename}</span>
            ) : (
              <span className="font-mono text-xs text-muted-foreground/60">{resolvedLang}</span>
            )}
          </div>
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/code:opacity-100">
            {actions}
            <Tooltip content={copied ? '已复制' : '复制代码'}>
              <button
                onClick={onCopy}
                className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {copied ? <Check className="h-3 w-3 text-[hsl(var(--success))]" /> : <Copy className="h-3 w-3" />}
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      <div className="relative flex overflow-auto scroll-area-thin" style={{ maxHeight }}>
        {gutter ? (
          <div
            className={cn(
              'code-scroll shrink-0 select-none border-r border-border/60 bg-muted/20 px-2 text-right text-muted-foreground/40',
              dense ? 'py-2.5' : 'py-3',
            )}
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        ) : null}
        {html ? (
          <div
            className={cn('code-scroll min-w-0 flex-1 [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0', wrap && 'whitespace-pre-wrap break-words')}
            style={{ padding: dense ? '10px 12px' : '12px 14px' }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre
            className={cn(
              'code-scroll min-w-0 flex-1 text-foreground/85',
              wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
            )}
            style={{ padding: dense ? '10px 12px' : '12px 14px' }}
          >
            {code}
          </pre>
        )}
      </div>
    </div>
  )
}
