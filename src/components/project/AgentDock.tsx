import { useState } from 'react'
import { PanelRightClose, PanelRightOpen, Play, Sparkles, Timer, Zap } from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import type { Project } from '../../../shared/types'
import { useSessionStore, currentRun, isRunActive, elapsed } from '@/stores/session'
import { Badge, Button, ProgressBar, StatusDot, Tooltip } from '@/components/ui'
import { PipelineTimeline } from '@/components/pipeline/PipelineTimeline'
import { RunConsole } from '@/components/agent/RunConsole'

export function AgentDock({
  project,
  onStart,
  className,
}: {
  project: Project
  onStart: () => void
  className?: string
}) {
  const [collapsed, setCollapsed] = useState(false)
  const runtime = useSessionStore((s) => s.runtimes[project.id])
  const cancel = useSessionStore((s) => s.cancelRun)
  const run = currentRun(runtime)
  const active = isRunActive(run)
  const doneSteps = run?.steps.filter((s) => s.status === 'done').length ?? 0
  const totalSteps = run?.steps.length ?? 0
  const progress = totalSteps ? (doneSteps / totalSteps) * 100 : 0

  if (collapsed) {
    return (
      <div className={cn('flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border/60 bg-[hsl(var(--sidebar)/0.5)] py-3', className)}>
        <Tooltip content="展开 Agent 面板" side="left">
          <button
            onClick={() => setCollapsed(false)}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        </Tooltip>
        <div className="h-px w-5 bg-border" />
        <div className="flex flex-col items-center gap-1 writing-vertical">
          <span className="text-[10px] tracking-[0.2em] text-muted-foreground/50 [writing-mode:vertical-rl]">AGENT</span>
        </div>
        {active ? (
          <span className="mt-auto mb-2 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        ) : null}
      </div>
    )
  }

  return (
    <div className={cn('flex w-[320px] shrink-0 flex-col border-l border-border/60 bg-[hsl(var(--sidebar)/0.42)] backdrop-blur-xl', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-accent-grad text-primary-foreground">
          <Sparkles className="h-3 w-3" />
        </span>
        <span className="text-[12px] font-medium">Agent 控制台</span>
        {active ? (
          <Badge variant="default" className="gap-1">
            <StatusDot tone="running" pulse /> 运行中
          </Badge>
        ) : run ? (
          <Badge variant={run.status === 'failed' ? 'danger' : 'muted'}>
            {run.status === 'failed' ? '失败' : run.status === 'cancelled' ? '已取消' : '已完成'}
          </Badge>
        ) : null}
        <Tooltip content="收起面板" side="left">
          <button
            onClick={() => setCollapsed(true)}
            className="ml-auto grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="shrink-0 space-y-2 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Timer className="h-3 w-3" /> {run ? formatDuration(elapsed(run)) : '—'}
          </span>
          <span className="tabular">
            {doneSteps}/{totalSteps || '—'} 步骤
          </span>
        </div>
        <ProgressBar value={progress} indeterminate={active && !totalSteps} tone={run?.status === 'failed' ? 'danger' : 'primary'} />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={active ? 'secondary' : 'primary'}
            className="h-7 flex-1 gap-1.5 text-[11.5px]"
            onClick={active ? () => void cancel(project.id) : onStart}
          >
            {active ? (
              <>停止执行</>
            ) : (
              <>
                <Play className="h-3 w-3" /> {run ? '重新执行' : '开始升级'}
              </>
            )}
          </Button>
          <Tooltip content="查看用量">
            <div className="flex h-7 items-center gap-1 rounded-md border border-border/70 px-1.5 text-[10px] tabular text-muted-foreground">
              <Zap className="h-2.5 w-2.5" />
              {run?.usage?.outputTokens ? `${Math.round(run.usage.outputTokens / 1000)}k` : '—'}
            </div>
          </Tooltip>
        </div>
        {run?.model ? <p className="truncate text-[10px] text-muted-foreground/50">模型 · {run.model}</p> : null}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2 scroll-area-thin">
        <div className="rounded-lg border border-border/50 bg-card/30 p-1.5">
          <PipelineTimeline run={run} />
        </div>
      </div>

      <RunConsole
        run={run}
        logs={runtime?.logs ?? []}
        compact
        onCancel={() => void cancel(project.id)}
        className="m-2 mt-0 h-[190px] shrink-0 rounded-lg"
      />
    </div>
  )
}
