import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Minus, Square, X, Palette, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { LogoMark } from '@/components/common/Logo'
import { Tooltip } from '@/components/ui/overlays'
import { StatusDot } from '@/components/ui/core'

export function TitleBar({ title, subtitle }: { title?: string; subtitle?: string }) {
  const navigate = useNavigate()
  const [maximized, setMaximized] = useState(false)
  const setThemePanelOpen = useAppStore((s) => s.setThemePanelOpen)
  const backend = useAppStore((s) => s.backend)
  const health = useAppStore((s) => s.health)
  const platform = window.tsd?.platform ?? 'web'
  const isMac = platform === 'darwin'
  const hasNativeControls = isMac
  const online = backend.state === 'online' || backend.state === 'external'

  useEffect(() => {
    const bridge = window.tsd
    if (!bridge?.onMaximizeChange) return
    return bridge.onMaximizeChange(setMaximized)
  }, [])

  const stateLabel =
    backend.state === 'online'
      ? '后端在线'
      : backend.state === 'external'
        ? '外部后端'
        : backend.state === 'starting'
          ? '后端启动中'
          : backend.state === 'error'
            ? '后端异常'
            : '后端离线'

  return (
    <header
      className={cn(
        'drag-region relative z-30 flex h-10 shrink-0 select-none items-center gap-3 border-b border-border/60 bg-[hsl(var(--background)/0.55)] pl-3 pr-2 backdrop-blur-xl',
        isMac && 'pl-[78px]',
      )}
    >
      <div className="flex items-center gap-2">
        <LogoMark size={18} className="opacity-95" />
        <div className="flex items-center gap-1 no-drag">
          <button
            onClick={() => navigate(-1)}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            aria-label="后退"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => navigate(1)}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            aria-label="前进"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="h-4 w-px bg-border/70" />

      <div className="flex min-w-0 items-center gap-2 text-[12px]">
        {title ? <span className="truncate font-medium text-foreground/90">{title}</span> : null}
        {subtitle ? (
          <>
            <span className="text-muted-foreground/40">/</span>
            <span className="truncate text-muted-foreground">{subtitle}</span>
          </>
        ) : null}
      </div>

      <div className="flex-1" />

      <div className="no-drag flex items-center gap-1.5">
        <Tooltip
          content={
            <div className="space-y-1">
              <div className="font-medium">{stateLabel}</div>
              <div className="text-muted-foreground">{backend.url || '等待后端地址…'}</div>
              {health?.model ? <div className="text-muted-foreground">模型 · {health.model}</div> : null}
            </div>
          }
        >
          <div className="flex h-6 items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2 text-[10.5px] text-muted-foreground">
            <StatusDot tone={online ? 'success' : backend.state === 'starting' ? 'running' : 'danger'} pulse={backend.state === 'starting'} />
            <span className="hidden sm:inline">{stateLabel}</span>
          </div>
        </Tooltip>

        <Tooltip content="外观与布局">
          <button
            onClick={() => setThemePanelOpen(true)}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="外观设置"
          >
            <Palette className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      {!hasNativeControls && (
        <div className="no-drag ml-1 flex items-center gap-0.5">
          <button
            onClick={() => window.tsd?.minimize()}
            className="grid h-7 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="最小化"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => window.tsd?.toggleMaximize()}
            className="grid h-7 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="最大化"
          >
            {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
          </button>
          <button
            onClick={() => window.tsd?.close()}
            className="grid h-7 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            aria-label="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </header>
  )
}
