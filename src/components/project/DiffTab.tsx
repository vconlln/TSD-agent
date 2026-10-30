import { useMemo } from 'react'
import { AlignLeft, Columns2, GitCompareArrows, RefreshCw, Sparkles } from 'lucide-react'
import type { Project } from '../../../shared/types'
import { useSessionStore, type ProjectRuntime } from '@/stores/session'
import { Button, EmptyState, Segmented, Skeleton, Switch, Tooltip, Badge } from '@/components/ui'
import { FileDiffList } from '@/components/diff/FileDiffCard'
import { summarizeDiff } from '@/lib/diff'
import { useAppStore } from '@/stores/app'

export function DiffTab({
  project,
  runtime,
  onOpenFile,
}: {
  project: Project
  runtime?: ProjectRuntime
  onOpenFile?: (path: string) => void
}) {
  const appearance = useAppStore((s) => s.appearance)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const loadDiff = useSessionStore((s) => s.loadDiff)
  const diff = runtime?.diff
  const files = useMemo(() => diff?.files ?? [], [diff])
  const summary = useMemo(() => summarizeDiff(files), [files])
  const changedPlan = diff?.plan.sections.filter((s) => s.status !== 'unchanged') ?? []

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/40 px-3 py-2">
        <GitCompareArrows className="h-4 w-4 text-primary" />
        <span className="text-[12px] font-medium">代码差异</span>
        <Badge variant="muted">{summary.changed} 个文件</Badge>
        <span className="tabular text-[11px] text-[hsl(var(--diff-add))]">+{summary.added}</span>
        <span className="tabular text-[11px] text-[hsl(var(--diff-del))]">-{summary.removed}</span>
        <div className="flex items-center gap-1 rounded-md bg-background/40 px-1.5 py-1">
          <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-muted">
            <span className="h-full bg-[hsl(var(--diff-add))]" style={{ width: `${summary.added + summary.removed ? (summary.added / (summary.added + summary.removed)) * 100 : 0}%` }} />
            <span className="h-full flex-1 bg-[hsl(var(--diff-del))]" />
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
            <span>语法高亮</span>
            <Switch
              checked={appearance.diffHighlight}
              onCheckedChange={(diffHighlight) => setAppearance({ diffHighlight })}
            />
          </div>
          <Segmented<'unified' | 'split'>
            size="sm"
            value={appearance.diffLayout}
            onChange={(diffLayout) => setAppearance({ diffLayout })}
            options={[
              { value: 'unified', label: '单列', icon: <AlignLeft className="h-3 w-3" /> },
              { value: 'split', label: '并排', icon: <Columns2 className="h-3 w-3" /> },
            ]}
          />
          <Tooltip content="重新计算差异">
            <Button size="icon-sm" variant="ghost" onClick={() => void loadDiff(project.id, true)}>
              <RefreshCw className={runtime?.diffLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            </Button>
          </Tooltip>
        </div>
      </div>

      {changedPlan.length ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/[0.045] px-2.5 py-1.5">
          <Sparkles className="h-3 w-3 text-primary" />
          <span className="text-[11px] text-muted-foreground">方案变更 {changedPlan.length} 段：</span>
          {changedPlan.slice(0, 6).map((s) => (
            <span key={s.key} className="rounded bg-background/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {s.heading}
            </span>
          ))}
          {changedPlan.length > 6 ? <span className="text-[10px] text-muted-foreground">…</span> : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 scroll-area-thin">
        {runtime?.diffLoading && !files.length ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full rounded-xl" />
            ))}
          </div>
        ) : files.length ? (
          <FileDiffList files={files} projectId={project.id} onOpenFile={onOpenFile} />
        ) : (
          <div className="h-full min-h-[320px] rounded-xl border border-dashed border-border/80 bg-card/25">
            <EmptyState
              icon={<GitCompareArrows className="h-5 w-5" />}
              title="暂无代码差异"
              description="执行一次升级后，这里会展示原版与升级版代码的逐文件差异，并支持单列 / 并排与语法高亮。"
            />
          </div>
        )}
      </div>
    </div>
  )
}
