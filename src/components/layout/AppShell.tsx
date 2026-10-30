import { useEffect } from 'react'
import { Outlet, useLocation, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Toaster } from 'sonner'
import { AlertTriangle, Loader2, RefreshCw, ServerOff } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'
import { ThemePanel } from './ThemePanel'
import { useBackend } from '@/hooks/useBackend'
import { useAppStore } from '@/stores/app'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui'

function BackendGate() {
  const ready = useAppStore((s) => s.apiReady)
  const backend = useAppStore((s) => s.backend)
  const { retry } = useBackend()
  const starting = backend.state === 'starting'
  if (ready) return null
  const failing = backend.state === 'offline' || backend.state === 'error'

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-[hsl(var(--background)/0.86)] backdrop-blur-md">
      <div className="w-[min(92vw,460px)] rounded-2xl border border-border bg-card/90 p-6 text-center shadow-float">
        {starting ? (
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]">
            {failing ? <ServerOff className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
          </div>
        )}
        <h2 className="text-[15px] font-semibold tracking-tight">
          {starting ? '正在启动本地 Agent 引擎…' : failing ? '无法连接后端服务' : '等待后端就绪'}
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
          {starting
            ? '首次启动需要初始化 Python 运行时与工作目录，通常几秒内完成。'
            : backend.message || '请确认 Python 后端已启动，或在设置中切换为外部后端地址。'}
        </p>
        {backend.logTail?.length ? (
          <pre className="mt-3 max-h-28 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-2 text-left font-mono text-[10.5px] leading-relaxed text-muted-foreground scroll-area-thin">
            {backend.logTail.slice(-6).join('\n')}
          </pre>
        ) : null}
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button size="sm" variant="primary" className="gap-1.5" onClick={() => void retry()}>
            <RefreshCw className="h-3.5 w-3.5" /> 重试连接
          </Button>
          <Button size="sm" variant="outline" onClick={() => (window.location.hash = '#/settings')}>
            打开设置
          </Button>
        </div>
        {backend.url ? (
          <p className="mt-4 font-mono text-[10.5px] text-muted-foreground/60">{backend.url}</p>
        ) : null}
      </div>
    </div>
  )
}

export function AppShell() {
  const location = useLocation()
  const params = useParams()
  const mode = useAppStore((s) => s.appearance.mode)
  const projects = useProjectsStore((s) => s.projects)
  const loadProjects = useProjectsStore((s) => s.load)
  const apiReady = useAppStore((s) => s.apiReady)

  useEffect(() => {
    if (apiReady) void loadProjects()
  }, [apiReady, loadProjects])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        const store = useAppStore.getState()
        store.setThemePanelOpen(!store.themePanelOpen)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const activeProject = location.pathname.startsWith('/project/')
    ? projects.find((p) => p.id === params.id)
    : undefined

  const title = location.pathname.startsWith('/project/')
    ? activeProject?.name || '项目'
    : location.pathname.startsWith('/settings')
      ? '设置'
      : location.pathname.startsWith('/projects')
        ? '项目库'
        : '工作台'
  const subtitle = location.pathname.startsWith('/project/')
    ? activeProject
      ? `v${activeProject.baseVersion} → v${activeProject.targetVersion}`
      : undefined
    : undefined

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <div className="app-backdrop">
        <div className="grid-layer" />
        <div className="noise-layer" />
      </div>

      <div className="relative z-10 flex h-full w-full flex-col">
        <TitleBar title={title} subtitle={subtitle} />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="relative min-w-0 flex-1 overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                className="h-full"
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>

      <ThemePanel />
      <BackendGate />
      <Toaster
        theme={mode}
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast:
              'border border-border bg-popover/95 text-foreground backdrop-blur-xl shadow-float rounded-xl text-[12.5px]',
            description: 'text-muted-foreground text-[11.5px]',
            actionButton: 'bg-primary text-primary-foreground',
          },
        }}
      />
    </div>
  )
}
