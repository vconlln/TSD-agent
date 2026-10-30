import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowUpRight,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  GitCompareArrows,
  LayoutDashboard,
  MessageSquare,
  MoreHorizontal,
  Play,
  RotateCw,
  Trash2,
  FolderOpen,
  Download,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn, copyText, formatRelative } from '@/lib/utils'
import type { Project } from '../../shared/types'
import { useProjectsStore } from '@/stores/projects'
import { useSessionStore, currentRun, isRunActive } from '@/stores/session'
import { Badge, Button, Skeleton, StatusDot, Tooltip } from '@/components/ui'
import { DropdownContent, DropdownItem, DropdownMenu, DropdownMenuTrigger } from '@/components/ui/overlays'
import { AgentDock } from '@/components/project/AgentDock'
import { StartRunDialog } from '@/components/project/StartRunDialog'
import { OverviewTab } from '@/components/project/OverviewTab'
import { PlanTab } from '@/components/project/PlanTab'
import { CodeTab } from '@/components/project/CodeTab'
import { DiffTab } from '@/components/project/DiffTab'
import { ChatPanel } from '@/components/chat/ChatPanel'

type Tab = 'overview' | 'plan' | 'code' | 'diff' | 'chat'

const TABS: Array<{ id: Tab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'plan', label: '方案', icon: FileText },
  { id: 'code', label: '代码', icon: Code2 },
  { id: 'diff', label: '差异', icon: GitCompareArrows },
  { id: 'chat', label: '对话', icon: MessageSquare },
]

function projectStatus(project: Project) {
  switch (project.status) {
    case 'running':
      return { label: '升级中', variant: 'default' as const, tone: 'running' as const }
    case 'ready':
      return { label: '已就绪', variant: 'success' as const, tone: 'success' as const }
    case 'failed':
      return { label: '执行失败', variant: 'danger' as const, tone: 'danger' as const }
    default:
      return { label: '草稿', variant: 'muted' as const, tone: 'idle' as const }
  }
}

export function ProjectPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'overview'
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === id))
  const upsert = useProjectsStore((s) => s.upsert)
  const remove = useProjectsStore((s) => s.remove)
  const runtime = useSessionStore((s) => s.runtimes[id])
  const hydrate = useSessionStore((s) => s.hydrate)
  const diff = runtime?.diff
  const [dialogOpen, setDialogOpen] = useState(false)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!id) return
    void hydrate(id)
  }, [id, hydrate])

  useEffect(() => {
    if (project || !id) return
    let cancelled = false
    api
      .getProject(id)
      .then((p) => {
        if (!cancelled) upsert(p)
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [id, project, upsert])

  const run = currentRun(runtime)
  const active = isRunActive(run)
  const counts = useMemo(
    () => ({
      plan: diff ? diff.plan.sections.filter((s) => s.status !== 'unchanged').length : 0,
      files: diff?.stats.filesChanged ?? 0,
      chat: runtime?.chat.length ?? 0,
    }),
    [diff, runtime?.chat.length],
  )

  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params)
    p.set('tab', next)
    setParams(p, { replace: true })
  }

  if (missing) {
    return (
      <div className="grid h-full place-items-center">
        <div className="text-center">
          <p className="text-[14px] font-medium">项目不存在或已被删除</p>
          <p className="mt-1 text-[12px] text-muted-foreground">它可能位于另一个工作目录，或后端工作区被重置。</p>
          <Button size="sm" variant="secondary" className="mt-4" onClick={() => navigate('/')}>
            返回工作台
          </Button>
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-8 w-full" />
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const status = projectStatus(project)

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border/60 bg-[hsl(var(--background)/0.35)] px-5 pt-4 backdrop-blur-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-[19px] font-semibold tracking-tight">{project.name}</h1>
                <Badge variant={status.variant} className="gap-1">
                  {active ? <StatusDot tone="running" pulse /> : <StatusDot tone={status.tone} />}
                  {status.label}
                </Badge>
                <div className="flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                  <span>v{project.baseVersion}</span>
                  <ArrowUpRight className="h-2.5 w-2.5 text-primary" />
                  <span className="text-primary">v{project.targetVersion}</span>
                </div>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/75">
                {project.sourceUrl ? (
                  <button
                    onClick={() => window.tsd?.openExternal(project.sourceUrl!)}
                    className="flex max-w-[420px] items-center gap-1 truncate hover:text-primary"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate font-mono">{project.sourceUrl}</span>
                  </button>
                ) : null}
                <Tooltip content={project.workspace}>
                  <button
                    onClick={() => {
                      void copyText(project.workspace).then(() => toast.success('已复制工作目录'))
                    }}
                    className="flex items-center gap-1 hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" /> 工作目录
                  </button>
                </Tooltip>
                <span>更新于 {formatRelative(project.updatedAt)}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant={active ? 'secondary' : 'primary'}
                className="gap-1.5"
                onClick={() => (active ? undefined : setDialogOpen(true))}
                disabled={active}
                loading={active}
              >
                {active ? (
                  <>执行中…</>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" /> {run ? '重新执行' : '开始升级'}
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  void window.tsd?.openPath(project.targetDir || project.workspace)
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" /> 打开目录
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  void useSessionStore.getState().loadDiff(project.id, true)
                  toast.success('已刷新差异')
                }}
              >
                <RotateCw className={cn('h-3.5 w-3.5', runtime?.diffLoading && 'animate-spin')} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownContent>
                  <DropdownItem onSelect={() => window.tsd?.revealPath(project.workspace)}>
                    <FolderOpen className="h-3.5 w-3.5" /> 在文件管理器中显示
                  </DropdownItem>
                  <DropdownItem
                    onSelect={async () => {
                      try {
                        const res = await api.exportBundle(project.id)
                        toast.success(`已导出到 ${res.path}`)
                      } catch (err) {
                        toast.error((err as Error).message || '导出失败')
                      }
                    }}
                  >
                    <Download className="h-3.5 w-3.5" /> 导出结果
                  </DropdownItem>
                  <DropdownItem
                    onSelect={() => {
                      void copyText(project.workspace).then(() => toast.success('已复制工作目录'))
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> 复制工作目录
                  </DropdownItem>
                  <DropdownItem
                    danger
                    onSelect={async () => {
                      await remove(project.id)
                      toast.success('项目已删除')
                      navigate('/projects')
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> 删除项目
                  </DropdownItem>
                </DropdownContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-0.5">
            {TABS.map((item) => {
              const selected = tab === item.id
              const count = item.id === 'plan' ? counts.plan : item.id === 'diff' ? counts.files : item.id === 'chat' ? counts.chat : 0
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={cn(
                    'relative flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium transition-colors',
                    selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/85',
                  )}
                >
                  <item.icon className={cn('h-3.5 w-3.5', selected ? 'text-primary' : 'text-muted-foreground/70')} />
                  {item.label}
                  {count > 0 ? (
                    <span className="rounded bg-muted px-1 text-[10px] tabular text-muted-foreground">{count}</span>
                  ) : null}
                  {selected ? (
                    <motion.span
                      layoutId="project-tab-indicator"
                      className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent-grad"
                      transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                    />
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
              className="h-full min-h-0"
            >
              {tab === 'overview' ? (
                <OverviewTab project={project} runtime={runtime} onStart={() => setDialogOpen(true)} />
              ) : tab === 'plan' ? (
                <PlanTab project={project} runtime={runtime} onStart={() => setDialogOpen(true)} />
              ) : tab === 'code' ? (
                <CodeTab project={project} runtime={runtime} />
              ) : tab === 'diff' ? (
                <DiffTab project={project} runtime={runtime} onOpenFile={(path) => {
                  const p = new URLSearchParams(params)
                  p.set('tab', 'code')
                  p.set('side', 'target')
                  p.set('path', path)
                  setParams(p, { replace: true })
                }} />
              ) : (
                <ChatPanel projectId={project.id} className="h-full" />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <AgentDock project={project} onStart={() => setDialogOpen(true)} className="hidden xl:flex" />
      <StartRunDialog project={project} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
