import { useMemo, useState } from 'react'
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  FileText,
  FolderTree,
  Pencil,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  XCircle,
} from 'lucide-react'
import type { AgentTraceEntry, Project } from '../../../shared/types'
import { useSessionStore } from '@/stores/session'
import { cn, formatClock, formatDuration } from '@/lib/utils'
import { Badge, Button, EmptyState, Segmented } from '@/components/ui'

const TOOL_ICONS: Record<string, typeof FileText> = {
  read_file: FileText,
  write_file: Pencil,
  edit_file: Pencil,
  delete_file: CircleSlash,
  grep: Search,
  list_files: FolderTree,
  run_command: Terminal,
  run_tests: Play,
  finish: CheckCircle2,
}

function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : ''
  switch (tool) {
    case 'read_file':
      return path + (args.start_line ? ` : ${String(args.start_line)}-${String(args.end_line ?? '')}` : '')
    case 'edit_file': {
      const oldLines = typeof args.old_string === 'string' ? args.old_string.split('\n').length : 0
      const newLines = typeof args.new_string === 'string' ? args.new_string.split('\n').length : 0
      return `${path}  (${oldLines} 行 → ${newLines} 行)`
    }
    case 'write_file':
      return path
    case 'delete_file':
      return path
    case 'grep':
      return `/${String(args.pattern ?? '')}/` + (args.include ? `  ${String(args.include)}` : '')
    case 'list_files':
      return String(args.pattern ?? '**/*')
    case 'run_command':
      return String(args.command ?? '')
    case 'run_tests':
      return '自动探测测试命令'
    case 'finish':
      return String(args.summary ?? '').slice(0, 80)
    default: {
      const keys = Object.keys(args)
      return keys.length ? keys.map((key) => `${key}=${String(args[key]).slice(0, 40)}`).join(' ') : ''
    }
  }
}

function EntryRow({ entry }: { entry: AgentTraceEntry }) {
  const [open, setOpen] = useState(false)

  if (entry.kind === 'thought') {
    return (
      <div className="flex gap-2.5 px-1 py-1">
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-3 w-3" />
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap pt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          {entry.text}
        </p>
        <span className="shrink-0 pt-1 font-mono text-[11.5px] text-muted-foreground/40">{formatClock(entry.ts)}</span>
      </div>
    )
  }

  if (entry.kind === 'verify') {
    return (
      <div
        className={cn(
          'rounded-lg border px-2.5 py-2',
          entry.ok
            ? 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.06)]'
            : 'border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.06)]',
        )}
      >
        <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
          {entry.ok ? (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--success))]" />
          ) : (
            <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          )}
          <span className="text-[12.5px] font-medium">验证 {entry.ok ? '通过' : '未通过'}</span>
          <span className="truncate font-mono text-[12px] text-muted-foreground">{entry.command}</span>
          {entry.exitCode !== undefined ? (
            <Badge variant={entry.ok ? 'success' : 'danger'} className="ml-auto shrink-0 text-[11.5px]">
              exit {entry.exitCode}
            </Badge>
          ) : null}
        </button>
        {open && entry.output ? (
          <pre className="mt-1.5 max-h-56 overflow-auto rounded-md border border-border/50 bg-background/50 p-2 font-mono text-[12px] leading-relaxed text-muted-foreground scroll-area-thin">
            {entry.output}
          </pre>
        ) : null}
      </div>
    )
  }

  const Icon = TOOL_ICONS[entry.tool] ?? Terminal
  const summary = summarizeArgs(entry.tool, entry.args)
  return (
    <div className={cn('rounded-lg border border-border/60 bg-background/25', !entry.ok && 'border-destructive/30')}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronDown className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
        <Icon className={cn('h-3.5 w-3.5 shrink-0', entry.ok ? 'text-primary/80' : 'text-destructive')} />
        <span className="shrink-0 font-mono text-[12px] text-foreground/90">{entry.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{summary}</span>
        <span className="shrink-0 tabular text-[11.5px] text-muted-foreground/60">{formatDuration(entry.durationMs)}</span>
        {entry.ok ? null : (
          <Badge variant="danger" className="shrink-0 text-[11.5px]">
            失败
          </Badge>
        )}
      </button>
      {open ? (
        <pre className="max-h-64 overflow-auto border-t border-border/50 bg-[hsl(var(--surface-1)/0.6)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-muted-foreground scroll-area-thin">
          {entry.observation || entry.preview || '（无输出）'}
        </pre>
      ) : null}
    </div>
  )
}

export function AgentTab({ project }: { project: Project }) {
  const runtime = useSessionStore((s) => s.runtimes[project.id])
  const trace = useMemo(() => runtime?.trace ?? [], [runtime?.trace])
  const [filter, setFilter] = useState<'all' | 'tool' | 'verify'>('all')

  const stats = useMemo(() => {
    const tools = trace.filter((entry) => entry.kind === 'tool')
    const verifies = trace.filter((entry) => entry.kind === 'verify')
    return {
      tools: tools.length,
      failed: tools.filter((entry) => entry.kind === 'tool' && !entry.ok).length,
      verifies: verifies.length,
      verified: verifies.length > 0 && verifies.every((entry) => entry.kind === 'verify' && entry.ok),
      thoughts: trace.filter((entry) => entry.kind === 'thought').length,
    }
  }, [trace])

  const visible = trace.filter((entry) => {
    if (filter === 'all') return true
    if (filter === 'tool') return entry.kind === 'tool'
    return entry.kind === 'verify'
  })

  if (trace.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<Bot className="h-5 w-5" />}
          title="还没有 Agent 轨迹"
          description="执行一次升级后，这里会显示模型的思考、每一次工具调用（读了哪个文件、改了哪里、跑了什么命令）以及验证结果。"
          className="max-w-lg"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/40 px-3 py-2">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-[12.5px] font-medium">Agent 轨迹</span>
        <Badge variant="muted" className="gap-1">
          <Terminal className="h-2.5 w-2.5" /> {stats.tools} 次工具调用
        </Badge>
        {stats.failed > 0 ? (
          <Badge variant="warning" className="gap-1">
            <XCircle className="h-2.5 w-2.5" /> {stats.failed} 次失败
          </Badge>
        ) : null}
        {stats.verifies > 0 ? (
          <Badge variant={stats.verified ? 'success' : 'danger'} className="gap-1">
            <ShieldCheck className="h-2.5 w-2.5" /> {stats.verified ? '验证通过' : '验证未通过'}
          </Badge>
        ) : null}
        <Badge variant="outline" className="gap-1">
          <Sparkles className="h-2.5 w-2.5" /> {stats.thoughts} 段思考
        </Badge>
        <div className="ml-auto">
          <Segmented<'all' | 'tool' | 'verify'>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: '全部', count: trace.length },
              { value: 'tool', label: '工具', count: stats.tools },
              { value: 'verify', label: '验证', count: stats.verifies },
            ]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-xl border border-border/70 bg-card/30 p-2 scroll-area-thin">
        {visible.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
        {visible.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] text-muted-foreground">当前筛选下没有内容</p>
        ) : null}
      </div>

      <p className="shrink-0 px-1 text-[11.5px] text-muted-foreground/60">
        Agent 模式在「设置 → Agent 模式」里开关与调参；关闭命令执行后只会改代码、不跑验证。
      </p>
    </div>
  )
}
