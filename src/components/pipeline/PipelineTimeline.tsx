import { motion } from 'framer-motion'
import {
  Check,
  CircleDashed,
  Globe2,
  FileText,
  Download,
  BrainCircuit,
  FilePenLine,
  Code2,
  GitCompareArrows,
  X,
  Loader2,
  SkipForward,
} from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import type { Run, RunStep } from '../../../shared/types'
import { ProgressBar } from '@/components/ui'

const STEP_ICONS: Record<string, typeof Globe2> = {
  fetch: Globe2,
  parse: FileText,
  plan: FileText,
  download: Download,
  analyze: BrainCircuit,
  update: FilePenLine,
  code: Code2,
  diff: GitCompareArrows,
  verify: Check,
  finalize: Check,
}

function StepStatusIcon({ status }: { status: RunStep['status'] }) {
  if (status === 'done')
    return (
      <span className="grid h-6 w-6 place-items-center rounded-full bg-[hsl(var(--success)/0.14)] text-[hsl(var(--success))]">
        <Check className="h-3.5 w-3.5" />
      </span>
    )
  if (status === 'running')
    return (
      <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </span>
    )
  if (status === 'failed')
    return (
      <span className="grid h-6 w-6 place-items-center rounded-full bg-destructive/15 text-destructive">
        <X className="h-3.5 w-3.5" />
      </span>
    )
  if (status === 'skipped')
    return (
      <span className="grid h-6 w-6 place-items-center rounded-full bg-muted text-muted-foreground">
        <SkipForward className="h-3 w-3" />
      </span>
    )
  return (
    <span className="grid h-6 w-6 place-items-center rounded-full border border-border bg-muted/30 text-muted-foreground/50">
      <CircleDashed className="h-3.5 w-3.5" />
    </span>
  )
}

export function PipelineTimeline({ run, className }: { run?: Run; className?: string }) {
  const steps = run?.steps ?? []
  if (!steps.length) {
    return (
      <div className={cn('rounded-xl border border-dashed border-border/70 px-4 py-8 text-center', className)}>
        <p className="text-[13px] text-muted-foreground">尚未开始升级。填写升级方案后点击「开始升级」。</p>
      </div>
    )
  }

  return (
    <ol className={cn('relative space-y-0.5', className)}>
      <div className="absolute bottom-3 left-[11px] top-3 w-px bg-border/70" aria-hidden />
      {steps.map((step, idx) => {
        const Icon = STEP_ICONS[step.key] ?? FileText
        const duration = step.startedAt ? (step.finishedAt ?? Date.now()) - step.startedAt : 0
        const active = step.status === 'running'
        return (
          <motion.li
            key={step.key}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(idx * 0.03, 0.24), duration: 0.25 }}
            className="relative flex gap-3 rounded-lg px-1 py-1.5"
          >
            <div className="relative z-10 shrink-0">
              <StepStatusIcon status={step.status} />
            </div>
            <div className={cn('min-w-0 flex-1 rounded-lg px-2 py-0.5', active && 'bg-primary/[0.045]')}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Icon className={cn('h-3 w-3', active ? 'text-primary' : 'text-muted-foreground/60')} />
                <span className={cn('text-[12.5px] font-medium', step.status === 'pending' ? 'text-muted-foreground/60' : 'text-foreground/90')}>
                  {step.title}
                </span>
                {step.metrics
                  ? Object.entries(step.metrics)
                      .slice(0, 3)
                      .map(([k, v]) => (
                        <span key={k} className="rounded bg-muted/60 px-1.5 py-0.5 text-[11.5px] tabular text-muted-foreground">
                          {k} {v}
                        </span>
                      ))
                  : null}
                <span className="ml-auto shrink-0 text-[12px] tabular text-muted-foreground/50">
                  {step.startedAt && step.status !== 'pending' ? formatDuration(duration) : ''}
                </span>
              </div>
              {step.detail ? (
                <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground/80">{step.detail}</p>
              ) : null}
              {active && step.progress !== undefined ? (
                <ProgressBar value={step.progress} indeterminate={step.progress <= 0} className="mt-1.5 h-1" />
              ) : null}
            </div>
          </motion.li>
        )
      })}
    </ol>
  )
}
