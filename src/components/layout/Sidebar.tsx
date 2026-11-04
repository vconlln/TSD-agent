import { NavLink, useNavigate, useParams } from 'react-router-dom'
import {
  LayoutDashboard,
  FolderKanban,
  Settings2,
  Palette,
  Plus,
  ChevronLeft,
  Cpu,
  Github,
} from 'lucide-react'
import { cn, formatRelative } from '@/lib/utils'
import { Monogram } from '@/components/common/Monogram'
import { useAppStore } from '@/stores/app'
import { useProjectsStore } from '@/stores/projects'
import { Badge, StatusDot, Tooltip } from '@/components/ui'
import { LogoLockup, LogoMark } from '@/components/common/Logo'

const NAV = [
  { to: '/', label: '工作台', icon: LayoutDashboard, end: true },
  { to: '/projects', label: '项目库', icon: FolderKanban, end: false },
  { to: '/settings', label: '设置', icon: Settings2, end: false },
]

export function Sidebar() {
  const navigate = useNavigate()
  const params = useParams()
  const collapsed = useAppStore((s) => s.appearance.sidebarCollapsed)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const setThemePanelOpen = useAppStore((s) => s.setThemePanelOpen)
  const health = useAppStore((s) => s.health)
  const projects = useProjectsStore((s) => s.projects)
  const recent = projects.slice(0, 8)

  return (
    <aside
      className={cn(
        // 侧栏宽度不做补间（gate 10a 禁止动 width）：直接切换，标签用透明度过渡
        'relative z-20 flex h-full shrink-0 flex-col border-r border-border bg-sidebar',
        collapsed ? 'w-[64px]' : 'w-[248px]',
      )}
    >
      <div className={cn('flex h-14 items-center px-3', collapsed ? 'justify-center' : 'justify-between')}>
        {collapsed ? <LogoMark size={24} /> : <LogoLockup />}
        {!collapsed && (
          <Tooltip content="收起侧栏" side="right">
            <button
              onClick={() => setAppearance({ sidebarCollapsed: true })}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              aria-label="收起侧栏"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>

      <nav className="space-y-0.5 px-2">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/[0.11] text-foreground'
                  : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                collapsed && 'justify-center px-0',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && !collapsed && (
                  <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground/80')} />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && item.to === '/projects' && projects.length > 0 && (
                  <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-2xs tabular text-muted-foreground">
                    {projects.length}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-5 flex items-center justify-between px-3 pb-2">
        {!collapsed ? (
          <span className="text-2xs font-semibold text-muted-foreground/50">最近项目</span>
        ) : (
          <span className="mx-auto h-px w-6 bg-border" />
        )}
        {!collapsed && (
          <Tooltip content="新建项目">
            <button
              onClick={() => navigate('/?new=1')}
              className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              aria-label="新建项目"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 scroll-area-thin">
        {recent.length === 0 ? (
          !collapsed && (
            <p className="px-2 py-3 text-sm leading-relaxed text-muted-foreground/60">
              还没有项目。创建第一个项目，让 Agent 接管解析、升级与差异生成。
            </p>
          )
        ) : (
          <div className="space-y-0.5">
            {recent.map((project) => {
              const active = params.id === project.id
              const tone =
                project.status === 'running'
                  ? 'running'
                  : project.status === 'ready'
                    ? 'success'
                    : project.status === 'failed'
                      ? 'danger'
                      : 'idle'
              return (
                <NavLink
                  key={project.id}
                  to={`/project/${project.id}`}
                  className={cn(
                    'group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors',
                    active ? 'bg-accent/80' : 'hover:bg-accent/50',
                    collapsed && 'justify-center',
                  )}
                  title={project.name}
                >
                  <Monogram name={project.name} size={22} />
                  {!collapsed && (
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground/90">{project.name}</span>
                        <StatusDot tone={tone} pulse={tone === 'running'} />
                      </span>
                      {/* 版本与时间分成两段各自截断，不再用中点串成一长条 */}
                      <span className="flex min-w-0 items-baseline gap-1.5 text-2xs text-muted-foreground/70">
                        <span className="font-display min-w-0 truncate tabular">
                          v{project.baseVersion} → v{project.targetVersion}
                        </span>
                        <span className="ml-auto shrink-0 whitespace-nowrap">{formatRelative(project.updatedAt)}</span>
                      </span>
                    </span>
                  )}
                </NavLink>
              )
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border/60 p-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <Tooltip content="外观" side="right">
              <button
                onClick={() => setThemePanelOpen(true)}
                className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Palette className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content="展开侧栏" side="right">
              <button
                onClick={() => setAppearance({ sidebarCollapsed: false })}
                className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4 rotate-180" />
              </button>
            </Tooltip>
          </div>
        ) : (
          <div className="rounded-xl border border-border/70 bg-card/50 p-2.5">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/10 text-primary">
                <Cpu className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground/90">
                  {health?.model || '未配置模型'}
                </p>
                <p className="flex items-center gap-1 text-xs text-muted-foreground/70">
                  <StatusDot tone={health?.engine === 'online' ? 'success' : 'warning'} />
                  {health?.engine === 'online' ? '在线推理' : '离线模式'}
                </p>
              </div>
              <Badge variant="outline" className="text-2xs">
                v{health?.version?.split('.')[0] ?? '1'}
              </Badge>
            </div>
            <div className="mt-2 flex items-center gap-1">
              <button
                onClick={() => setThemePanelOpen(true)}
                className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Palette className="h-3.5 w-3.5" /> 外观
              </button>
              <button
                onClick={() => window.tsd?.openExternal('https://github.com/vconlln/TSD-agent')}
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="GitHub"
              >
                <Github className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
