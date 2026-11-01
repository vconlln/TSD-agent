import { useState } from 'react'
import {
  ChevronDown,
  CircleAlert,
  FileText,
  FolderTree,
  ListChecks,
  PencilLine,
  Search,
  Wrench,
} from 'lucide-react'
import type { ChatToolCall } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { CodeBlock } from '@/components/common/CodeBlock'

const ICONS: Record<string, typeof Wrench> = {
  list_files: FolderTree,
  read_file: FileText,
  grep: Search,
  propose_edit: PencilLine,
  update_plan: ListChecks,
}

function hintOf(call: ChatToolCall): string {
  const args = call.args || {}
  if (call.tool === 'propose_edit') return String(args.path || '')
  if (call.tool === 'read_file') return String(args.path || '')
  if (call.tool === 'grep') return String(args.pattern || '')
  if (call.tool === 'list_files') return String(args.path || '.')
  if (call.tool === 'update_plan') return '任务清单'
  return call.preview || ''
}

/** 一行工具调用：图标 + 工具名 + 关键参数 + 状态，点开看返回内容。 */
export function ToolStrip({ calls }: { calls: ChatToolCall[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  if (calls.length === 0) return null

  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {calls.map((call) => {
        const Icon = ICONS[call.tool] || Wrench
        const open = openId === call.id
        return (
          <div key={call.id} className="min-w-0">
            <button
              onClick={() => setOpenId(open ? null : call.id)}
              className={cn(
                'flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                call.ok
                  ? 'border-border/70 bg-card/60 text-muted-foreground hover:text-foreground'
                  : 'border-destructive/40 bg-destructive/[0.06] text-destructive',
              )}
            >
              {call.ok ? <Icon className="h-3 w-3 shrink-0" /> : <CircleAlert className="h-3 w-3 shrink-0" />}
              <span className="shrink-0 font-medium">{call.tool}</span>
              {hintOf(call) ? (
                <span className="truncate font-mono text-[10.5px] text-muted-foreground/70">{hintOf(call)}</span>
              ) : null}
              {call.durationMs ? (
                <span className="tabular shrink-0 text-[10px] text-muted-foreground/50">{call.durationMs}ms</span>
              ) : null}
              {call.observation ? (
                <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', !open && '-rotate-90')} />
              ) : null}
            </button>
            {open && call.observation ? (
              <div className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-border/60 bg-[hsl(var(--surface-1)/0.6)] scroll-area-thin">
                <CodeBlock code={call.observation} lang="text" dense showHeader={false} />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** 模型自己维护的任务清单 */
export function PlanBlock({ steps }: { steps: Array<{ title: string; status: string }> }) {
  if (!steps.length) return null
  return (
    <div className="mb-3 rounded-xl border border-border/60 bg-[hsl(var(--surface-1)/0.5)] px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
        <ListChecks className="h-3.5 w-3.5 text-primary/80" /> 任务清单
      </div>
      <ul className="space-y-1">
        {steps.map((step, index) => (
          <li key={index} className="flex items-start gap-2 text-[12px]">
            <span
              className={cn(
                'mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border text-[9px]',
                step.status === 'done'
                  ? 'border-[hsl(var(--success))]/60 bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]'
                  : step.status === 'in_progress'
                    ? 'border-primary/60 bg-primary/15 text-primary'
                    : 'border-border text-muted-foreground/50',
              )}
            >
              {step.status === 'done' ? '✓' : step.status === 'in_progress' ? '•' : ''}
            </span>
            <span className={cn('min-w-0', step.status === 'done' && 'text-muted-foreground line-through')}>
              {step.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
