import { motion, AnimatePresence } from 'framer-motion'
import { Monitor, Moon, RotateCcw, Sun, X, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { THEMES, useAppStore, type Density, type Effects, type Mode } from '@/stores/app'
import { Button, Segmented, Separator, Badge } from '@/components/ui'
import { Switch, Slider } from '@/components/ui/overlays'

function OptionRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground/90">{label}</p>
        {hint ? <p className="text-[12px] text-muted-foreground/70">{hint}</p> : null}
      </div>
      {children}
    </div>
  )
}

export function ThemePanel() {
  const navigate = useNavigate()
  const open = useAppStore((s) => s.themePanelOpen)
  const setOpen = useAppStore((s) => s.setThemePanelOpen)
  const appearance = useAppStore((s) => s.appearance)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const reset = useAppStore((s) => s.resetAppearance)

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[60] bg-[hsl(var(--background)/0.45)] backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
          />
          <motion.aside
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className="fixed right-0 top-0 z-[61] flex h-full w-[min(94vw,380px)] flex-col border-l border-border bg-[hsl(var(--card)/0.96)] shadow-float backdrop-blur-2xl"
          >
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <div>
                <p className="text-[13.5px] font-semibold tracking-tight">外观与布局</p>
                <p className="text-[12px] text-muted-foreground">所有选项即时生效并自动保存</p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 scroll-area-thin">
              <section className="space-y-2">
                <p className="text-[12px] font-semibold text-muted-foreground/60">明暗模式</p>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: 'dark', label: '深色', icon: Moon },
                    { id: 'light', label: '浅色', icon: Sun },
                  ] as Array<{ id: Mode; label: string; icon: typeof Moon }>).map((item) => {
                    const active = appearance.mode === item.id
                    return (
                      <button
                        key={item.id}
                        onClick={() => setAppearance({ mode: item.id })}
                        className={cn(
                          'group relative overflow-hidden rounded-xl border p-2.5 text-left transition-colors',
                          active ? 'border-primary/60 bg-primary/[0.08]' : 'border-border/80 hover:border-border hover:bg-accent/40',
                        )}
                      >
                        <div
                          className={cn(
                            'mb-2 h-12 w-full overflow-hidden rounded-lg border',
                            item.id === 'dark' ? 'border-border bg-background' : 'border-border bg-card',
                          )}
                        >
                          <div className={cn('h-2.5 w-full', item.id === 'dark' ? 'bg-white/[0.06]' : 'bg-black/[0.05]')} />
                          <div className="flex gap-1 p-1.5">
                            <div className="h-1.5 w-6 rounded-full bg-primary" />
                            <div className={cn('h-1.5 flex-1 rounded-full', item.id === 'dark' ? 'bg-white/10' : 'bg-black/10')} />
                          </div>
                          <div className={cn('mx-1.5 h-1.5 w-2/3 rounded-full', item.id === 'dark' ? 'bg-white/10' : 'bg-black/10')} />
                        </div>
                        <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                          <item.icon className="h-3.5 w-3.5" /> {item.label}
                        </span>
                        {active && (
                          <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary" />
                        )}
                      </button>
                    )
                  })}
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-semibold text-muted-foreground/60">主题色</p>
                  <Badge variant="muted" className="gap-1">
                    <Sparkles className="h-2.5 w-2.5" /> 7 套
                  </Badge>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {THEMES.map((theme) => {
                    const active = appearance.theme === theme.id
                    return (
                      <button
                        key={theme.id}
                        onClick={() => setAppearance({ theme: theme.id })}
                        className={cn(
                          'group flex flex-col items-center gap-1.5 rounded-xl border p-2 transition-colors',
                          active ? 'border-primary/60 bg-primary/[0.08]' : 'border-transparent hover:border-border hover:bg-accent/40',
                        )}
                        title={theme.name}
                      >
                        <span
                          className={cn(
                            'relative grid h-8 w-8 place-items-center rounded-full transition-transform group-hover:scale-105',
                            active && 'ring-2 ring-offset-2 ring-offset-card',
                          )}
                          style={{
                            backgroundColor: theme.from,
                            boxShadow: active ? `0 0 0 2px hsl(var(--background)), 0 0 0 3px ${theme.from}` : undefined,
                            // ring color follows the swatch
                            ['--tw-ring-color' as string]: theme.from,
                          }}
                        >
                          {active && <span className="h-2 w-2 rounded-full bg-white/90" />}
                        </span>
                        <span className={cn('text-[11.5px]', active ? 'text-foreground' : 'text-muted-foreground')}>{theme.name}</span>
                      </button>
                    )
                  })}
                </div>
              </section>

              <Separator />

              <section>
                <OptionRow label="界面密度" hint="紧凑模式显示更多内容">
                  <Segmented<Density>
                    size="sm"
                    value={appearance.density}
                    onChange={(density) => setAppearance({ density })}
                    options={[
                      { value: 'cozy', label: '宽松' },
                      { value: 'compact', label: '紧凑' },
                    ]}
                  />
                </OptionRow>
                <OptionRow label="圆角" hint={`${appearance.radius}px`}>
                  <div className="w-32">
                    <Slider
                      min={0}
                      max={20}
                      value={appearance.radius}
                      onValueChange={(radius) => setAppearance({ radius })}
                    />
                  </div>
                </OptionRow>
                <OptionRow label="背景特效" hint="极光 / 网格 / 噪点">
                  <Segmented<Effects>
                    size="sm"
                    value={appearance.effects}
                    onChange={(effects) => setAppearance({ effects })}
                    options={[
                      { value: 'full', label: '全效' },
                      { value: 'calm', label: '柔和' },
                      { value: 'off', label: '关闭' },
                    ]}
                  />
                </OptionRow>
              </section>

              <Separator />

              <section>
                <p className="mb-1 text-[12px] font-semibold text-muted-foreground/60">
                  代码与差异
                </p>
                <OptionRow label="差异布局" hint="并排或单列显示">
                  <Segmented<'unified' | 'split'>
                    size="sm"
                    value={appearance.diffLayout}
                    onChange={(diffLayout) => setAppearance({ diffLayout })}
                    options={[
                      { value: 'unified', label: '单列' },
                      { value: 'split', label: '并排' },
                    ]}
                  />
                </OptionRow>
                <OptionRow label="语法高亮" hint="关闭可提升超大文件性能">
                  <Switch
                    checked={appearance.diffHighlight}
                    onCheckedChange={(diffHighlight) => setAppearance({ diffHighlight })}
                  />
                </OptionRow>
                <OptionRow label="代码自动换行">
                  <Switch checked={appearance.codeWrap} onCheckedChange={(codeWrap) => setAppearance({ codeWrap })} />
                </OptionRow>
              </section>
            </div>

            <div className="flex items-center gap-2 border-t border-border/70 px-4 py-3">
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={reset}>
                <RotateCcw className="h-3.5 w-3.5" /> 恢复默认
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 gap-1.5"
                onClick={() => {
                  setOpen(false)
                  navigate('/settings')
                }}
              >
                <Monitor className="h-3.5 w-3.5" /> 完整设置
              </Button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
