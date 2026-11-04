import { useEffect, useMemo, useState } from 'react'
import { FolderKanban, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectsStore } from '@/stores/projects'
import { ProjectCard } from '@/components/project/ProjectCard'
import { NewProjectForm } from '@/components/project/NewProjectForm'
import { Button, Dialog, DialogContent, EmptyState, Input, Segmented } from '@/components/ui'
import { PageHeader, MetricCard } from '@/components/common/PageHeader'

type Filter = 'all' | 'running' | 'ready' | 'failed'

export function ProjectsPage() {
  const projects = useProjectsStore((s) => s.projects)
  const load = useProjectsStore((s) => s.load)
  const remove = useProjectsStore((s) => s.remove)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (filter !== 'all' && p.status !== filter) return false
      if (query) {
        const q = query.toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          (p.sourceUrl ?? '').toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [projects, filter, query])

  const totals = useMemo(() => {
    const files = projects.reduce((n, p) => n + (p.stats?.filesChanged ?? 0), 0)
    const added = projects.reduce((n, p) => n + (p.stats?.added ?? 0), 0)
    const removed = projects.reduce((n, p) => n + (p.stats?.removed ?? 0), 0)
    return { files, added, removed }
  }, [projects])

  return (
    <div className="h-full overflow-y-auto scroll-area-thin">
      <div className="mx-auto w-full max-w-[1180px] px-6 pb-14 pt-7">
        <PageHeader
          eyebrow="项目库"
          title="全部升级项目"
          description="每个项目包含原始方案、升级方案、代码快照与完整差异记录。"
          actions={
            <Button variant="primary" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> 新建项目
            </Button>
          }
        />

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <MetricCard label="项目数" value={projects.length} hint={`就绪 ${projects.filter((p) => p.status === 'ready').length}`} icon={<FolderKanban className="h-4 w-4" />} />
          <MetricCard label="累计变更文件" value={totals.files} hint="所有项目合计" />
          <MetricCard
            label="代码行变更"
            value={
              <span className="flex items-baseline gap-2">
                <span className="text-[hsl(var(--diff-add))]">+{totals.added}</span>
                <span className="text-[hsl(var(--diff-del))]">-{totals.removed}</span>
              </span>
            }
            hint="新增 / 删除"
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索项目名称、来源…"
              className="h-8 w-64 pl-8 text-sm"
            />
          </div>
          <Segmented<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: '全部', count: projects.length },
              { value: 'running', label: '执行中', count: projects.filter((p) => p.status === 'running').length },
              { value: 'ready', label: '已就绪', count: projects.filter((p) => p.status === 'ready').length },
              { value: 'failed', label: '失败', count: projects.filter((p) => p.status === 'failed').length },
            ]}
          />
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground/60">
            <SlidersHorizontal className="h-3 w-3" /> {filtered.length} 个结果
          </span>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onDelete={async (id) => {
                await remove(id)
                toast.success('项目已删除')
              }}
            />
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-dashed border-border/80 bg-card/25">
            <EmptyState
              icon={<FolderKanban className="h-5 w-5" />}
              title={query ? '没有匹配的项目' : '项目库为空'}
              description={query ? '换个关键词试试。' : '创建第一个项目，Agent 会接管后续全部流程。'}
              action={
                !query ? (
                  <Button size="sm" variant="primary" className="gap-1.5" onClick={() => setOpen(true)}>
                    <Plus className="h-3.5 w-3.5" /> 新建项目
                  </Button>
                ) : null
              }
            />
          </div>
        ) : null}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="新建升级项目"
          description="填写项目信息与升级方案，创建后立即执行。"
          className="w-[min(94vw,620px)]"
        >
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4 scroll-area-thin">
            <NewProjectForm compact onCreated={() => setOpen(false)} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
