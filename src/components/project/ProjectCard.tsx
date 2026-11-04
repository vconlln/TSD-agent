import { Link } from 'react-router-dom'
import { ArrowRight, Clock, FileCode2, FolderGit2, MoreHorizontal, Trash2 } from 'lucide-react'
import { formatRelative } from '@/lib/utils'
import { Monogram } from '@/components/common/Monogram'
import type { Project } from '../../../shared/types'
import { Badge, Button, StatusDot } from '@/components/ui'
import { DropdownContent, DropdownItem, DropdownMenu, DropdownMenuTrigger } from '@/components/ui/overlays'

function statusBadge(project: Project) {
  switch (project.status) {
    case 'running':
      return <Badge variant="default" className="gap-1"><StatusDot tone="running" pulse />升级中</Badge>
    case 'ready':
      return <Badge variant="success">已就绪</Badge>
    case 'failed':
      return <Badge variant="danger">失败</Badge>
    default:
      return <Badge variant="muted">草稿</Badge>
  }
}

export function ProjectCard({ project, onDelete }: { project: Project; onDelete?: (id: string) => void }) {
  return (
    <div className="group panel panel-hover relative min-w-0 overflow-hidden p-3.5">
      <div className="flex items-start gap-2.5">
        <Monogram name={project.name} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Link to={`/project/${project.id}`} className="truncate text-base font-semibold tracking-tight hover:text-primary">
              {project.name}
            </Link>
            {statusBadge(project)}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground/70">
            <FolderGit2 className="h-3 w-3" />
            <span className="truncate">{project.sourceUrl || '本地目录'}</span>
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="grid h-6 w-6 place-items-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownContent>
            <DropdownItem onSelect={() => window.tsd?.revealPath(project.workspace)}>打开工作目录</DropdownItem>
            <DropdownItem
              onSelect={() => {
                void navigator.clipboard.writeText(project.workspace)
              }}
            >
              复制路径
            </DropdownItem>
            <DropdownItem danger onSelect={() => onDelete?.(project.id)}>
              <Trash2 className="h-3.5 w-3.5" /> 删除项目
            </DropdownItem>
          </DropdownContent>
        </DropdownMenu>
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <Badge variant="outline" className="font-mono">v{project.baseVersion}</Badge>
        <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
        <Badge variant="gradient" className="font-mono">v{project.targetVersion}</Badge>
      </div>

      {project.stats ? (
        <div className="mt-2.5 flex items-center gap-3 text-xs tabular text-muted-foreground/70">
          <span className="flex items-center gap-1">
            <FileCode2 className="h-3 w-3" /> {project.stats.filesChanged ?? project.stats.files ?? 0} 个文件
          </span>
          <span className="text-[hsl(var(--diff-add))]">+{project.stats.added ?? 0}</span>
          <span className="text-[hsl(var(--diff-del))]">-{project.stats.removed ?? 0}</span>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2.5">
        <span className="flex items-center gap-1 text-xs text-muted-foreground/60">
          <Clock className="h-3 w-3" /> {formatRelative(project.updatedAt)}
        </span>
        <Link to={`/project/${project.id}`}>
          <Button size="xs" variant="ghost" className="gap-1 text-muted-foreground group-hover:text-foreground">
            打开 <ArrowRight className="h-2.5 w-2.5" />
          </Button>
        </Link>
      </div>
    </div>
  )
}
