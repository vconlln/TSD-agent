import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Copy, Square, Terminal, Trash2 } from 'lucide-react'
import { cn, copyText, formatClock, formatDuration } from '@/lib/utils'
import type { Run } from '../../../shared/types'
import type { LogLine } from '@/stores/session'
import { Badge, Button, Spinner, StatusDot, Tooltip } from '@/components/ui'

const LEVEL_CLS: Record<string, string> = {
  debug: 'text-muted-foreground/55',
  info: 'text-foreground/80',
  success: 'text-[hsl(var(--success))]',
  warn: 'text-[hsl(var(--warning))]',
  error: 'text-[hsl(var(--destructive))]',
}

export function RunConsole({
  run,
  logs,
  onCancel,
  onClear,
  className,
  compact = false,
}: {
  run?: Run
  logs: LogLine[]
  onCancel?: () => void
  onClear?: () => void
  className?: string
  compact?: boolean
}) {
  const [autoScroll, setAutoScroll] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const active = run?.status === 'running' || run?.status === 'queued'

  useEffect(() => {
    if (!autoScroll) return
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length, autoScroll])

  const elapsedMs = run ? (run.finishedAt ?? Date.now()) - run.startedAt : 0
  const visible = useMemo(() => (compact ? logs.slice(-60) : logs), [logs, compact])

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-1)/0.6)]', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
        <Terminal className="h-3.5 w-3.5 text-muted-foreground/70" />
        <span className="text-[11.5px] font-medium text-foreground/85">Agent 日志</span>
        {run ? (
          <Badge
            variant={run.status === 'running' ? 'default' : run.status === 'failed' ? 'danger' : run.status === 'cancelled' ? 'warning' : 'success'}
            className="gap-1"
          >
            {active ? <Spinner size={9} /> : <StatusDot tone={run.status === 'failed' ? 'danger' : 'success'} />}
            {run.status === 'running' ? '执行中' : run.status === 'done' ? '已完成' : run.status === 'failed' ? '失败' : run.status === 'queued' ? '排队中' : '已取消'}
          </Badge>
        ) : null}
        {run ? <span className="tabular text-[10.5px] text-muted-foreground/60">{formatDuration(elapsedMs)}</span> : null}
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip content={autoScroll ? '已开启自动滚动' : '开启自动滚动'}>
            <button
              onClick={() => setAutoScroll((v) => !v)}
              className={cn(
                'grid h-6 w-6 place-items-center rounded transition-colors hover:bg-accent',
                autoScroll ? 'text-primary' : 'text-muted-foreground/60',
              )}
            >
              <ArrowDownToLine className="h-3 w-3" />
            </button>
          </Tooltip>
          <Tooltip content="复制全部日志">
            <button
              onClick={() => void copyText(logs.map((l) => `[${formatClock(l.ts)}] ${l.level.toUpperCase()} ${l.message}`).join('\n'))}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
            </button>
          </Tooltip>
          {onClear ? (
            <Tooltip content="清空日志">
              <button
                onClick={onClear}
                className="grid h-6 w-6 place-items-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </Tooltip>
          ) : null}
          {active && onCancel ? (
            <Button size="xs" variant="ghost" className="gap-1 text-destructive hover:bg-destructive/10" onClick={onCancel}>
              <Square className="h-2.5 w-2.5" /> 停止
            </Button>
          ) : null}
        </div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2 font-mono text-[11px] leading-[1.75] scroll-area-thin">
        {visible.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-muted-foreground/50">等待 Agent 输出…</p>
        ) : (
          visible.map((line) => (
            <div key={line.id} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground/35">{formatClock(line.ts)}</span>
              {line.step ? <span className="shrink-0 text-primary/60">{line.step}</span> : null}
              <span className={cn('min-w-0 whitespace-pre-wrap break-words', LEVEL_CLS[line.level] ?? LEVEL_CLS.info)}>
                {line.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
