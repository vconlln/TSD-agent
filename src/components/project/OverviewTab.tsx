import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FileCode2,
  FileText,
  FolderOpen,
  Layers,
  Play,
  Sparkles,
  Timer,
  Trash2,
  Zap,
} from 'lucide-react'
import { cn, formatDuration, formatRelative } from '@/lib/utils'
import type { Project } from '../../../shared/types'
import { currentRun, elapsed, isRunActive, useSessionStore, type ProjectRuntime } from '@/stores/session'
import { Badge, Button, EmptyState, ProgressBar, StatusDot } from '@/components/ui'
import { MetricCard, SectionTitle } from '@/components/common/PageHeader'
import { PipelineTimeline } from '@/components/pipeline/PipelineTimeline'

function ProgressRing({ value, active, failed }: { value: number; active: boolean; failed: boolean }) {
  const size = 92
  const stroke = 7
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(1, Math.max(0, value / 100)))
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      {/* 单色仪表环：层次靠明度，不靠渐变或发光（gate 2a / 29） */}
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={failed ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-500 ease-out"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className="font-display text-[17px] font-semibold leading-none tabular">{Math.round(value)}%</div>
          <div className="mt-1 text-[11.5px] text-muted-foreground/70">进度</div>
        </div>
      </div>
    </div>
  )
}

export function OverviewTab({
  project,
  runtime,
  onStart,
}: {
  project: Project
  runtime?: ProjectRuntime
  onStart: () => void
}) {
  const cancel = useSessionStore((s) => s.cancelRun)
  const run = currentRun(runtime)
  const active = isRunActive(run)
  const failed = run?.status === 'failed'
  const doneSteps = run?.steps.filter((s) => s.status === 'done').length ?? 0
  const totalSteps = run?.steps.length ?? 0
  const progress = run?.status === 'done' ? 100 : totalSteps ? (doneSteps / totalSteps) * 100 : 0
  const currentStep = run?.steps.find((s) => s.status === 'running')
  const planSections = runtime?.diff?.plan.sections.filter((s) => s.status !== 'unchanged').length ?? 0
  const files = runtime?.diff?.files ?? []

  const artifacts = useMemo(
    () =>
      [
        { label: '原始方案', path: runtime?.documents?.plan.path, exists: runtime?.documents?.plan.exists, icon: FileText },
        { label: '升级方案', path: runtime?.documents?.update.path, exists: runtime?.documents?.update.exists, icon: Sparkles },
        { label: '原始代码', path: project.sourceDir, exists: !!project.sourceDir, icon: FolderOpen },
        { label: '升级后代码', path: project.targetDir, exists: !!project.targetDir, icon: Layers },
      ].filter((a) => a.path),
    [runtime?.documents, project.sourceDir, project.targetDir],
  )

  return (
    <div className="h-full overflow-y-auto pr-1 scroll-area-thin">
      <div className="space-y-3">
        <div className="panel grain-border relative overflow-hidden p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <ProgressRing value={progress} active={active} failed={!!failed} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[14.5px] font-semibold tracking-tight">
                  {active
                    ? currentStep?.title
                      ? `正在执行：${currentStep.title}`
                      : '正在准备升级…'
                    : failed
                      ? '执行失败，请查看日志'
                      : run?.status === 'done'
                        ? '升级已完成，可查看差异'
                        : project.status === 'ready'
                          ? '项目已就绪'
                          : '尚未执行升级'}
                </h2>
                {run ? (
                  <Badge variant={failed ? 'danger' : active ? 'default' : 'success'} className="gap-1">
                    <StatusDot tone={failed ? 'danger' : active ? 'running' : 'success'} pulse={active} />
                    {run.kind === 'chat' ? '对话修改' : '升级流程'}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 max-w-2xl text-[12.5px] leading-relaxed text-muted-foreground">
                {run?.summary ||
                  currentStep?.detail ||
                  'Agent 将依次解析方案网页、下载基础代码、生成 UPDATE.md、升级代码并计算差异。'}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground/75">
                <span className="flex items-center gap-1">
                  <Timer className="h-3 w-3" /> {run ? formatDuration(elapsed(run)) : '—'}
                </span>
                <span className="flex items-center gap-1">
                  <Layers className="h-3 w-3" /> {doneSteps}/{totalSteps || '—'} 步骤
                </span>
                <span className="flex items-center gap-1">
                  <Zap className="h-3 w-3" /> {run?.model || '默认模型'}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" /> {formatRelative(project.updatedAt)}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" variant={active ? 'secondary' : 'primary'} className="gap-1.5" onClick={active ? () => void cancel(project.id) : onStart}>
                  {active ? (
                    '停止执行'
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" /> {run ? '重新执行升级' : '开始升级'}
                    </>
                  )}
                </Button>
                <Link to={`?tab=diff`}>
                  <Button size="sm" variant="outline" className="gap-1.5">
                    查看差异 <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
                <Link to={`?tab=chat`}>
                  <Button size="sm" variant="ghost" className="gap-1.5">
                    与 Agent 对话
                  </Button>
                </Link>
              </div>
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-2 sm:w-56">
              {[
                { label: '变更文件', value: runtime?.diff?.stats.filesChanged ?? 0 },
                { label: '方案变更段', value: planSections },
                { label: '新增行', value: runtime?.diff?.stats.added ?? 0, tone: 'add' },
                { label: '删除行', value: runtime?.diff?.stats.removed ?? 0, tone: 'del' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border/60 bg-background/25 px-2 py-1.5">
                  <div className="text-[11.5px] text-muted-foreground/60">{s.label}</div>
                  <div
                    className={cn(
                      'stat-num mt-0.5 text-[16px] font-semibold leading-none',
                      s.tone === 'add' ? 'text-[hsl(var(--diff-add))]' : s.tone === 'del' ? 'text-[hsl(var(--diff-del))]' : 'text-foreground',
                    )}
                  >
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {active ? (
            <div className="mt-3">
              <ProgressBar value={progress} indeterminate={!totalSteps} />
            </div>
          ) : null}
        </div>

        {run?.error ? (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium text-destructive">执行失败</p>
              <p className="mt-0.5 break-words text-[12.5px] leading-relaxed text-muted-foreground">{run.error}</p>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="panel min-w-0 p-3.5">
            <SectionTitle hint="Agent 执行步骤" action={active ? <Badge variant="default" className="gap-1"><StatusDot tone="running" pulse />进行中</Badge> : null}>
              升级流水线
            </SectionTitle>
            <div className="mt-2.5">
              <PipelineTimeline run={run} />
            </div>
          </div>

          <div className="min-w-0 space-y-3">
            <div className="panel min-w-0 p-3.5">
              <SectionTitle hint="本次升级需求">需求与产物</SectionTitle>
              <div className="mt-2.5 space-y-2">
                <div className="rounded-lg border border-border/50 bg-background/25 p-2.5">
                  <p className="line-clamp-4 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/80">
                    {run?.prompt || project.description || '尚未提交升级需求'}
                  </p>
                </div>
                <div className="space-y-1">
                  {artifacts.map((artifact) => (
                    <button
                      key={artifact.label}
                      onClick={() => artifact.path && void window.tsd?.openPath(artifact.path)}
                      className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/60"
                    >
                      <artifact.icon className={cn('h-3.5 w-3.5 shrink-0', artifact.exists ? 'text-primary/80' : 'text-muted-foreground/40')} />
                      <span className="shrink-0 text-[12px] text-muted-foreground">{artifact.label}</span>
                      <span className="truncate font-mono text-[12px] text-muted-foreground/60">{artifact.path}</span>
                      <FolderOpen className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/70" />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="panel min-w-0 p-3.5">
              <SectionTitle hint="最近 5 次">运行历史</SectionTitle>
              <div className="mt-2 space-y-1">
                {(runtime?.runs ?? []).slice(0, 5).map((r) => (
                  <div key={r.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px]">
                    <StatusDot tone={r.status === 'failed' ? 'danger' : r.status === 'running' ? 'running' : 'success'} />
                    <span className="truncate text-muted-foreground">
                      {r.kind === 'chat' ? '对话修改' : '升级执行'} · {formatRelative(r.startedAt)}
                    </span>
                    <span className="ml-auto shrink-0 tabular text-muted-foreground/60">{formatDuration(elapsed(r))}</span>
                  </div>
                ))}
                {!runtime?.runs.length ? (
                  <p className="px-1.5 py-2 text-[12px] text-muted-foreground/60">还没有运行记录</p>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <MetricCard label="方案章节" value={runtime?.documents?.update.exists ? runtime?.diff?.plan.sections.length ?? 0 : 0} hint="升级方案中的章节数" icon={<FileText className="h-3.5 w-3.5" />} />
          <MetricCard label="变更文件" value={files.length} hint={`新增 ${files.filter((f) => f.status === 'added').length} · 删除 ${files.filter((f) => f.status === 'deleted').length}`} icon={<FileCode2 className="h-3.5 w-3.5" />} />
          <MetricCard label="代码新增" value={`+${runtime?.diff?.stats.added ?? 0}`} tone="add" hint="本次升级新增行数" icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
          <MetricCard label="代码删除" value={`-${runtime?.diff?.stats.removed ?? 0}`} tone="del" hint="本次升级删除行数" icon={<Trash2 className="h-3.5 w-3.5" />} />
        </div>

        {!run ? (
          <div className="panel">
            <EmptyState
              icon={<Sparkles className="h-5 w-5" />}
              title="准备就绪"
              description="填写升级方案后点击「开始升级」，Agent 会自动完成方案解析、代码下载、方案升级与差异生成。"
              action={
                <Button size="sm" variant="primary" className="gap-1.5" onClick={onStart}>
                  <Play className="h-3.5 w-3.5" /> 开始升级
                </Button>
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
